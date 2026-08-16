/**
 * Trust boundary for tool inputs.
 *
 * Every path and command reaching this module is model output, which means it
 * is untrusted in exactly the same way user input is: it can be steered by
 * anything the model read along the way (a file, a web page, a CI log). The
 * checks here are the only thing standing between a prompt injection and the
 * user's filesystem, so they run before any fs or process call.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import type { ApprovalMode } from "./config.js";

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/**
 * Resolve a model-supplied path and prove it stays inside `root`.
 *
 * `fs.realpathSync` collapses symlinks, so a symlink inside the tree that
 * points outside it is caught. For paths that do not exist yet (a `write`
 * target) the nearest existing ancestor is resolved instead, which catches a
 * symlinked parent directory.
 */
export function resolveInRoot(root: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new SafetyError("path must be a non-empty string");
  }
  if (candidate.includes("\0")) {
    throw new SafetyError("path must not contain null bytes");
  }

  const absoluteRoot = fs.realpathSync(path.resolve(root));
  const absolute = path.resolve(absoluteRoot, candidate);

  // Walk up to the nearest existing ancestor so symlinked parents are resolved.
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  let realExisting: string;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    throw new SafetyError(`cannot resolve path: ${candidate}`);
  }

  // Re-attach the non-existent tail to the resolved ancestor.
  const tail = path.relative(existing, absolute);
  const resolved = tail ? path.join(realExisting, tail) : realExisting;

  const relative = path.relative(absoluteRoot, resolved);
  const escapes =
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);

  if (escapes) {
    throw new SafetyError(
      `path escapes the project root: ${candidate} resolves outside ${absoluteRoot}`,
    );
  }
  return resolved;
}

/**
 * Commands that are refused outright, in every approval mode.
 *
 * This is a backstop against catastrophic single commands, not a security
 * boundary — a shell is far too expressive to filter reliably. The real
 * boundary is `approval: "ask"` plus running the agent somewhere disposable.
 */
const HARD_DENY: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*\/(\s|$)/, why: "recursive delete of /" },
  { pattern: /\bmkfs(\.\w+)?\b/, why: "filesystem format" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/, why: "raw write to a block device" },
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, why: "fork bomb" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, why: "host power state change" },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/, why: "world-writable /" },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: "piping a download straight into a shell" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/, why: "redirect over a block device" },
];

/** Commands allowed without a prompt in `ask` mode: read-only inspection. */
const AUTO_ALLOW: ReadonlyArray<RegExp> = [
  /^\s*(ls|pwd|cat|head|tail|wc|file|stat|du|df|tree|which|type|echo)\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|describe|rev-parse|ls-files|blame)\b/,
  /^\s*(node|npm|npx|pnpm|yarn)\s+(--version|-v)\b/,
  /^\s*(rg|grep|find|sed\s+-n|awk)\b/,
];

export interface CommandVerdict {
  allowed: boolean;
  needsPrompt: boolean;
  reason?: string;
}

export function classifyCommand(command: string, mode: ApprovalMode): CommandVerdict {
  for (const { pattern, why } of HARD_DENY) {
    if (pattern.test(command)) {
      return { allowed: false, needsPrompt: false, reason: `refused (${why})` };
    }
  }
  if (mode === "readonly") {
    const readOnly = AUTO_ALLOW.some((p) => p.test(command));
    return readOnly
      ? { allowed: true, needsPrompt: false }
      : { allowed: false, needsPrompt: false, reason: "readonly mode: only inspection commands are permitted" };
  }
  if (mode === "auto") {
    return { allowed: true, needsPrompt: false };
  }
  // ask
  if (AUTO_ALLOW.some((p) => p.test(command))) {
    return { allowed: true, needsPrompt: false };
  }
  return { allowed: true, needsPrompt: true };
}

/**
 * Prompt the operator to approve an action.
 *
 * With no TTY there is nobody to answer, so the action is denied rather than
 * silently approved — an unattended run must not be able to talk its way past
 * a gate the operator asked for.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
