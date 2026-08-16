#!/usr/bin/env node
/**
 * `npm run web` — serve the chat interface.
 *
 * The server hands whoever loads the page the ability to read, edit, and run
 * commands inside `--root`. It therefore binds to loopback by default, and
 * says so loudly when told to do otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  EFFORTS,
  HARNESS_NAME,
  HARNESS_VENDOR,
  HARNESS_VERSION,
  PRICING,
  isKnownModel,
  type Effort,
} from "./config.js";
import { startServer } from "./web/server.js";
import type { SessionMode, SessionSettings } from "./web/sessions.js";

const DEFAULT_PORT = 4174;

const HELP = `${HARNESS_NAME} ${HARNESS_VERSION} by ${HARNESS_VENDOR} — web interface

Serves a chat page that drives the agent against a project on this machine.

USAGE
  npm run web -- [options]

OPTIONS
  -p, --port <n>       port to listen on (default: ${DEFAULT_PORT}; 0 picks a free one)
      --host <addr>    interface to bind (default: 127.0.0.1)
  -r, --root <dir>     project the agent works in (default: current directory)
  -m, --model <id>     starting model (default: ${DEFAULT_CONFIG.model})
  -e, --effort <level> ${EFFORTS.join(" | ")} (default: ${DEFAULT_CONFIG.effort})
      --build          start in build mode (default: read-only)
      --no-verify      do not run the project's checks after a build run
  -h, --help           show this

SAFETY
  Anyone who can load the page can make the agent edit files and run shell
  commands inside --root. Binding anywhere other than 127.0.0.1 puts that on
  the network with no authentication in front of it; do not do it on a network
  you do not control.

  The page has two modes. "Read" cannot change anything. "Build" pre-approves
  writes and shell commands, because a browser has no terminal to answer an
  approval prompt — run it on a branch you can throw away.
`;

interface Options {
  root: string;
  port: number;
  host: string;
  settings: SessionSettings;
}

function parse(argv: string[]): Options | "help" {
  const options: Options = {
    root: process.cwd(),
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    settings: {
      model: DEFAULT_CONFIG.model,
      effort: DEFAULT_CONFIG.effort,
      mode: "read",
      verify: DEFAULT_CONFIG.verify,
    },
  };

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "-p":
      case "--port": {
        const value = Number(next(i, arg));
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new Error(`--port must be between 0 and 65535, got ${next(i, arg)}`);
        }
        options.port = value;
        i += 1;
        break;
      }
      case "--host":
        options.host = next(i, arg);
        i += 1;
        break;
      case "-r":
      case "--root":
        options.root = path.resolve(next(i, arg));
        i += 1;
        break;
      case "-m":
      case "--model": {
        const value = next(i, arg);
        if (!isKnownModel(value)) {
          throw new Error(`Unknown model "${value}". Known: ${Object.keys(PRICING).join(", ")}`);
        }
        options.settings.model = value;
        i += 1;
        break;
      }
      case "-e":
      case "--effort": {
        const value = next(i, arg) as Effort;
        if (!EFFORTS.includes(value)) {
          throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
        }
        options.settings.effort = value;
        i += 1;
        break;
      }
      case "--build":
        options.settings.mode = "build" satisfies SessionMode;
        break;
      case "--no-verify":
        options.settings.verify = false;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let options: Options | "help";
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\nRun with --help.\n`);
    process.exitCode = 2;
    return;
  }

  if (options === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    process.stderr.write(`Not a directory: ${options.root}\n`);
    process.exitCode = 2;
    return;
  }
  options.root = fs.realpathSync(options.root);

  if (!process.env["ANTHROPIC_API_KEY"]) {
    process.stderr.write(
      "Note: ANTHROPIC_API_KEY is not set. The page will load, but any request will\n"
      + "fail until a key is available (or an `ant auth login` profile exists).\n\n",
    );
  }

  const running = await startServer(options);
  const shown = options.host === "127.0.0.1" || options.host === "::1" ? "localhost" : options.host;

  process.stdout.write(
    `\n  ${HARNESS_NAME} ${HARNESS_VERSION}  ·  ${HARNESS_VENDOR}\n\n`
    + `  Open  http://${shown}:${running.port}\n\n`
    + `  project  ${options.root}\n`
    + `  model    ${options.settings.model}\n`
    + `  mode     ${options.settings.mode === "build" ? "build (writes pre-approved)" : "read-only"}\n\n`
    + "  Press Ctrl+C to stop.\n\n",
  );

  if (options.host !== "127.0.0.1" && options.host !== "::1" && options.host !== "localhost") {
    process.stderr.write(
      `  WARNING: bound to ${options.host}, not loopback. Anyone who can reach this\n`
      + `  port can make the agent run commands in ${options.root}.\n\n`,
    );
  }

  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
