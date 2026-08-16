/**
 * The agent's tool surface.
 *
 * Each tool is deliberately narrow rather than "just use bash", because a
 * typed tool call is something the harness can inspect, gate, and render. A
 * shell string is opaque — it cannot tell a `grep` apart from a `git push`.
 */

import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import fg from "fast-glob";
import { LIMITS, type AgentConfig } from "./config.js";
import { classifyCommand, confirm, resolveInRoot, SafetyError } from "./safety.js";

export interface ToolResult {
  content: string;
  isError: boolean;
  /**
   * Structured data for a consumer that renders richer UI than prose — e.g.
   * Eleanor's comparison cards. Never sent to the model; only `content` is.
   * Surfaced to the harness's caller via AgentEvents.onToolCard. Coding tools
   * never set this.
   */
  card?: Record<string, unknown>;
}

export interface ToolContext {
  config: AgentConfig;
  /**
   * Absolute path -> mtimeMs at the moment the agent last read it. An edit to
   * a file that is absent from this map, or whose mtime has moved since, is
   * rejected: the agent would be overwriting content it has not seen.
   */
  readFiles: Map<string, number>;
  /** Called before a mutating action so the UI can render it. */
  onNotice?: (message: string) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** True for tools with no side effects; these never prompt. */
  readOnly: boolean;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content, isError: true });

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new SafetyError(`\`${key}\` is required and must be a string`);
  }
  return value;
}

function optInt(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new SafetyError(`\`${key}\` must be a number`);
  }
  return Math.trunc(n);
}

function truncate(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters of ${label}]`;
}

function rel(ctx: ToolContext, absolute: string): string {
  return path.relative(ctx.config.root, absolute) || ".";
}

/** Record a file's current mtime so a later edit can detect drift. */
async function markRead(ctx: ToolContext, absolute: string): Promise<void> {
  try {
    const info = await fs.stat(absolute);
    ctx.readFiles.set(absolute, info.mtimeMs);
  } catch {
    ctx.readFiles.delete(absolute);
  }
}

/**
 * Refuse a mutation to a file the agent has not read, or that changed since it
 * did. Without this an agent that skims a file, thinks for six tool calls, and
 * then writes will silently clobber anything that landed in between.
 */
async function assertFresh(ctx: ToolContext, absolute: string): Promise<string | null> {
  if (!existsSync(absolute)) return null; // creating a new file is always fine
  const seen = ctx.readFiles.get(absolute);
  if (seen === undefined) {
    return `Refusing to modify ${rel(ctx, absolute)}: read it first so you are not overwriting unseen content.`;
  }
  const info = await fs.stat(absolute);
  if (info.mtimeMs !== seen) {
    return `Refusing to modify ${rel(ctx, absolute)}: it changed on disk since you read it. Read it again, then re-apply your change.`;
  }
  return null;
}

async function gateMutation(ctx: ToolContext, description: string): Promise<string | null> {
  if (ctx.config.approval === "readonly") {
    return `Refused: the agent is running in readonly mode, so it cannot ${description}.`;
  }
  if (ctx.config.approval === "auto") return null;
  ctx.onNotice?.(`about to ${description}`);
  const approved = await confirm(`Allow: ${description}?`);
  return approved ? null : `Denied by the operator: ${description}.`;
}

const IGNORED_DIRS = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];

// ---------------------------------------------------------------------------

const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a UTF-8 text file from the project. Returns 1-indexed numbered lines. "
    + "Read a file before editing it; edits to unread files are refused.",
  readOnly: true,
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root or absolute within it." },
      offset: { type: "integer", description: "1-indexed line to start from. Defaults to 1." },
      limit: { type: "integer", description: "Maximum number of lines to return. Defaults to the whole file." },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const target = resolveInRoot(ctx.config.root, str(input, "path"));
    if (!existsSync(target)) return fail(`No such file: ${rel(ctx, target)}`);

    const info = await fs.stat(target);
    if (info.isDirectory()) {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const listing = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n");
      return ok(`${rel(ctx, target)} is a directory:\n${listing}`);
    }
    if (info.size > LIMITS.maxFileBytes) {
      return fail(`File is ${info.size} bytes, over the ${LIMITS.maxFileBytes}-byte limit. Use grep or bash to inspect it.`);
    }

    const raw = await fs.readFile(target, "utf8");
    await markRead(ctx, target);

    const lines = raw.split("\n");
    const offset = Math.max(1, optInt(input, "offset") ?? 1);
    const limit = optInt(input, "limit");
    const end = limit === undefined ? lines.length : Math.min(lines.length, offset - 1 + limit);
    const slice = lines.slice(offset - 1, end);

    if (slice.length === 0) {
      return ok(`${rel(ctx, target)} has ${lines.length} lines; offset ${offset} is past the end.`);
    }

    const width = String(offset + slice.length - 1).length;
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(width, " ")}\t${line}`)
      .join("\n");

    const header = `${rel(ctx, target)} (lines ${offset}-${offset + slice.length - 1} of ${lines.length})`;
    return ok(`${header}\n${truncate(numbered, LIMITS.readChars, "file content")}`);
  },
};

const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create a file, or replace an existing file's entire contents. For a change to part of an "
    + "existing file prefer `edit`, which is cheaper and safer.",
  readOnly: false,
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root or absolute within it." },
      content: { type: "string", description: "Full contents to write." },
    },
    required: ["path", "content"],
  },
  async run(input, ctx) {
    const target = resolveInRoot(ctx.config.root, str(input, "path"));
    const content = str(input, "content");
    const existed = existsSync(target);

    const stale = await assertFresh(ctx, target);
    if (stale) return fail(stale);

    const denied = await gateMutation(ctx, `${existed ? "overwrite" : "create"} ${rel(ctx, target)}`);
    if (denied) return fail(denied);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    await markRead(ctx, target);

    const lines = content.split("\n").length;
    return ok(`${existed ? "Overwrote" : "Created"} ${rel(ctx, target)} (${lines} lines, ${content.length} bytes).`);
  },
};

const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string in a file. `old_string` must appear exactly once unless `replace_all` "
    + "is true. Include enough surrounding context to make the match unambiguous.",
  readOnly: false,
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root or absolute within it." },
      old_string: { type: "string", description: "Exact text to replace, including indentation." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(input, ctx) {
    const target = resolveInRoot(ctx.config.root, str(input, "path"));
    const oldString = str(input, "old_string");
    const newString = str(input, "new_string");
    const replaceAll = input["replace_all"] === true;

    if (!existsSync(target)) return fail(`No such file: ${rel(ctx, target)}`);
    if (oldString === newString) return fail("`old_string` and `new_string` are identical; nothing to do.");
    if (oldString === "") return fail("`old_string` must not be empty. Use `write` to create a file.");

    const stale = await assertFresh(ctx, target);
    if (stale) return fail(stale);

    const original = await fs.readFile(target, "utf8");
    const occurrences = original.split(oldString).length - 1;

    if (occurrences === 0) {
      return fail(
        `\`old_string\` was not found in ${rel(ctx, target)}. `
        + "It must match the file byte for byte, including leading whitespace — strip the line-number prefix that `read` adds.",
      );
    }
    if (occurrences > 1 && !replaceAll) {
      return fail(
        `\`old_string\` appears ${occurrences} times in ${rel(ctx, target)}. `
        + "Add surrounding context to make it unique, or pass replace_all: true.",
      );
    }

    const denied = await gateMutation(
      ctx,
      `edit ${rel(ctx, target)} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
    );
    if (denied) return fail(denied);

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);

    await fs.writeFile(target, updated, "utf8");
    await markRead(ctx, target);

    return ok(`Edited ${rel(ctx, target)}: ${occurrences} replacement${occurrences === 1 ? "" : "s"}.`);
  },
};

const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. `src/**/*.ts`). Returns paths sorted by modification time, "
    + "newest first. node_modules, .git, dist, and build are excluded.",
  readOnly: true,
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the project root." },
      path: { type: "string", description: "Directory to search within. Defaults to the project root." },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const pattern = str(input, "pattern");
    const base = input["path"] ? resolveInRoot(ctx.config.root, String(input["path"])) : ctx.config.root;

    const matches = await fg(pattern, {
      cwd: base,
      absolute: true,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: IGNORED_DIRS,
      suppressErrors: true,
    });

    // A glob can name a path outside the root via `../`; drop anything that
    // does not survive the same confinement check the other tools use.
    const inside = matches.filter((m) => {
      try {
        resolveInRoot(ctx.config.root, m);
        return true;
      } catch {
        return false;
      }
    });

    if (inside.length === 0) return ok(`No files match ${pattern}.`);

    const withTimes = inside.map((file) => {
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        /* raced with a delete; sort it last */
      }
      return { file, mtime };
    });
    withTimes.sort((a, b) => b.mtime - a.mtime);

    const shown = withTimes.slice(0, LIMITS.globPaths).map((m) => rel(ctx, m.file));
    const suffix = withTimes.length > shown.length ? `\n[${withTimes.length - shown.length} more not shown]` : "";
    return ok(`${shown.length} of ${withTimes.length} match(es):\n${shown.join("\n")}${suffix}`);
  },
};

const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns `path:line: text` for each "
    + "match. Prefer this over `bash grep` — it is confined to the project and never invokes a shell.",
  readOnly: true,
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression source." },
      glob: { type: "string", description: "Restrict to files matching this glob. Defaults to all files." },
      path: { type: "string", description: "Directory to search within. Defaults to the project root." },
      case_insensitive: { type: "boolean", description: "Match case-insensitively." },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const source = str(input, "pattern");
    let regex: RegExp;
    try {
      regex = new RegExp(source, input["case_insensitive"] === true ? "i" : "");
    } catch (error) {
      return fail(`Invalid regular expression: ${(error as Error).message}`);
    }

    const base = input["path"] ? resolveInRoot(ctx.config.root, String(input["path"])) : ctx.config.root;
    const pattern = typeof input["glob"] === "string" && input["glob"] ? input["glob"] : "**/*";

    const files = await fg(pattern, {
      cwd: base,
      absolute: true,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: IGNORED_DIRS,
      suppressErrors: true,
    });

    const hits: string[] = [];
    let scanned = 0;

    for (const file of files) {
      if (hits.length >= LIMITS.grepMatches) break;
      try {
        resolveInRoot(ctx.config.root, file);
        const info = await fs.stat(file);
        if (info.size > LIMITS.maxFileBytes) continue;
        const text = await fs.readFile(file, "utf8");
        // Skip anything that looks binary rather than emitting mojibake.
        if (text.includes("\0")) continue;
        scanned += 1;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          if (regex.test(line)) {
            hits.push(`${rel(ctx, file)}:${i + 1}: ${line.trim().slice(0, 300)}`);
            if (hits.length >= LIMITS.grepMatches) break;
          }
        }
      } catch {
        continue; // unreadable file, keep going
      }
    }

    if (hits.length === 0) return ok(`No matches for /${source}/ across ${scanned} file(s).`);
    const capped = hits.length >= LIMITS.grepMatches ? `\n[capped at ${LIMITS.grepMatches} matches]` : "";
    return ok(`${hits.length} match(es) across ${scanned} file(s):\n${hits.join("\n")}${capped}`);
  },
};

const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command from the project root. Use for builds, tests, git, and package managers. "
    + "Prefer `read`, `glob`, and `grep` for inspection — they are cheaper and need no approval.",
  readOnly: false,
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout_ms: { type: "integer", description: `Timeout in milliseconds. Default and max ${LIMITS.bashTimeoutMs}.` },
    },
    required: ["command"],
  },
  async run(input, ctx) {
    const command = str(input, "command");
    const verdict = classifyCommand(command, ctx.config.approval);

    if (!verdict.allowed) {
      return fail(`Command ${verdict.reason}: ${command}`);
    }
    if (verdict.needsPrompt) {
      ctx.onNotice?.(`about to run: ${command}`);
      const approved = await confirm(`Run: ${command}`);
      if (!approved) return fail(`Denied by the operator: ${command}`);
    }

    const requested = optInt(input, "timeout_ms") ?? LIMITS.bashTimeoutMs;
    const timeout = Math.min(Math.max(requested, 1_000), LIMITS.bashTimeoutMs);

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.config.root,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeout);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < LIMITS.bashChars * 2) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < LIMITS.bashChars * 2) stderr += chunk.toString("utf8");
      });

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.on("error", (error) => {
        finish(fail(`Failed to start command: ${error.message}`));
      });

      child.on("close", (code, signal) => {
        const body = [
          stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
          stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        if (signal === "SIGKILL") {
          finish(fail(truncate(`Command timed out after ${timeout}ms.\n\n${body}`, LIMITS.bashChars, "output")));
          return;
        }
        const header = `exit ${code ?? "unknown"}`;
        const text = truncate(body ? `${header}\n\n${body}` : `${header} (no output)`, LIMITS.bashChars, "output");
        finish(code === 0 ? ok(text) : fail(text));
      });
    });
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  readTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  bashTool,
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);
