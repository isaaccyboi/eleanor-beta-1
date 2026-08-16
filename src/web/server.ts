/**
 * Local HTTP front end.
 *
 * This server hands a browser the ability to read, write, and run shell
 * commands inside the project root, with no password in front of it. That is
 * the entire threat model, and it drives three decisions:
 *
 *  - It binds to loopback unless explicitly told otherwise, so nothing on the
 *    network can reach it.
 *  - It rejects requests whose `Host` header is not a loopback name, which is
 *    what stops a hostile web page from using DNS rebinding to drive the agent
 *    through your browser.
 *  - It rejects cross-origin requests outright, so no other page can talk to it
 *    even if it guesses the port.
 *
 * Streaming uses newline-delimited JSON rather than Server-Sent Events. The
 * browser reads it with `fetch` and a stream reader either way, and NDJSON has
 * no field grammar to get subtly wrong.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  EFFORTS,
  HARNESS_NAME,
  HARNESS_SHORT,
  HARNESS_VENDOR,
  HARNESS_VERSION,
  PRICING,
  isKnownModel,
  type Effort,
} from "../config.js";
import {
  SessionStore,
  type SessionAgentFactory,
  type SessionMode,
  type SessionSettings,
  type WebEvent,
} from "./sessions.js";

/** Request bodies are small JSON documents; anything larger is not one. */
const MAX_BODY_BYTES = 256 * 1024;

export interface ServerOptions {
  root: string;
  port: number;
  host: string;
  settings: SessionSettings;
  /** Injectable so the HTTP surface can be exercised without a model. */
  agentFactory?: SessionAgentFactory;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export function createServer(options: ServerOptions): http.Server {
  const sessions = new SessionStore(options.agentFactory);
  const html = loadApp();

  return http.createServer((req, res) => {
    void handle(req, res, options, sessions, html).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: (error as Error).message });
      } else {
        res.end();
      }
    });
  });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const server = createServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ServerOptions,
  sessions: SessionStore,
  html: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  const rejection = guard(req, options.host);
  if (rejection) {
    sendJson(res, 403, { error: rejection });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The page loads nothing from anywhere else, so say so.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      "x-content-type-options": "nosniff",
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      product: {
        vendor: HARNESS_VENDOR,
        name: HARNESS_NAME,
        version: HARNESS_VERSION,
        short: HARNESS_SHORT,
      },
      root: options.root,
      defaults: options.settings,
      efforts: EFFORTS,
      repairAttempts: DEFAULT_CONFIG.repairAttempts,
      models: Object.entries(PRICING).map(([id, price]) => ({
        id,
        input: price.input,
        output: price.output,
        note: price.note,
      })),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await readJson(req);
    const settings = coerceSettings(body?.["settings"], options.settings);
    const session = sessions.create(options.root, settings);
    sendJson(res, 200, {
      sessionId: session.id,
      root: session.root,
      checks: session.detectedChecks(),
      settings: session.currentSettings,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(req);
    const sessionId = typeof body?.["sessionId"] === "string" ? body["sessionId"] : "";
    const task = typeof body?.["task"] === "string" ? body["task"].trim() : "";

    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Unknown session. Reload the page to start a new one." });
      return;
    }
    if (task.length === 0) {
      sendJson(res, 400, { error: "Empty task." });
      return;
    }
    if (session.busy) {
      sendJson(res, 409, { error: "That session is already running a task." });
      return;
    }

    const settings = coerceSettings(body?.["settings"], session.currentSettings);
    const { historyReset } = session.applySettings(settings);

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });

    const write = (event: WebEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };

    if (historyReset) {
      write({
        type: "notice",
        text: "Model or mode changed, so this session started a fresh conversation.",
      });
    }

    await session.send(task, write);
    res.end();
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/session/")) {
    const id = url.pathname.slice("/api/session/".length);
    sendJson(res, 200, { deleted: sessions.delete(id) });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

/**
 * Reject anything that is not this page talking to its own server.
 *
 * `Host` is checked because a hostile domain can point its DNS at 127.0.0.1 and
 * then reach this server from a page the user merely visited; the `Host` header
 * still carries the attacker's name, so pinning it to loopback closes that.
 * `Origin` is checked because a cross-site `fetch` carries one and a same-origin
 * navigation from this page does not send a hostile value.
 */
function guard(req: http.IncomingMessage, boundHost: string): string | null {
  const isLoopbackBinding = boundHost === "127.0.0.1" || boundHost === "::1" || boundHost === "localhost";
  if (!isLoopbackBinding) return null; // operator explicitly opened it up; their call

  const host = (req.headers.host ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0] ?? "";
  const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (!loopbackNames.has(hostname)) {
    return `Refused: requests must address this server as localhost, not ${hostname || "(no host header)"}.`;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return "Refused: malformed Origin header.";
    }
    if (!loopbackNames.has(originHost) && originHost !== "127.0.0.1" && originHost !== "::1") {
      return "Refused: cross-origin request.";
    }
  }
  return null;
}

function coerceSettings(raw: unknown, fallback: SessionSettings): SessionSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const model = typeof input["model"] === "string" && isKnownModel(input["model"])
    ? (input["model"] as string)
    : fallback.model;
  const effort = EFFORTS.includes(input["effort"] as Effort)
    ? (input["effort"] as Effort)
    : fallback.effort;
  const mode: SessionMode = input["mode"] === "build" || input["mode"] === "read"
    ? input["mode"]
    : fallback.mode;
  const verify = typeof input["verify"] === "boolean" ? input["verify"] : fallback.verify;
  return { model, effort, mode, verify };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Request body was not valid JSON.");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

/**
 * The page lives beside this module in `src/`, and `tsc` emits only JavaScript,
 * so a compiled build has to reach back to the source tree for it.
 */
function loadApp(): string {
  const candidates = [
    path.join(import.meta.dirname, "app.html"),
    path.join(import.meta.dirname, "..", "..", "src", "web", "app.html"),
    path.join(import.meta.dirname, "..", "..", "..", "src", "web", "app.html"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  throw new Error(`Could not find app.html. Looked in:\n  ${candidates.join("\n  ")}`);
}
