/**
 * Environment sanitising for graded subprocesses.
 *
 * Both the verifier and the benchmark decide pass/fail from a child process's
 * exit code, which means anything that perturbs that exit code silently
 * corrupts the result — and a corrupted grader is worse than no grader, because
 * it produces confident numbers.
 *
 * The concrete failure that motivated this: Node sets `NODE_TEST_CONTEXT` when
 * running under `node --test`. A child that itself runs `node --test` inherits
 * it, switches into child-reporter mode, and **exits 0 even when its tests
 * fail**. Running the benchmark from inside a test suite therefore scored every
 * task as a pass. The same leak would hit anyone running the agent from a
 * harness or CI wrapper that sets these variables.
 */

/**
 * Variables removed before running any graded command.
 *
 * Deliberately narrow: only instrumentation that alters how a child process
 * reports or executes. Application configuration is left alone, because a real
 * project's tests routinely need it.
 */
const STRIPPED = [
  // Makes a nested `node --test` exit 0 regardless of failures.
  "NODE_TEST_CONTEXT",
  // Injects loaders (tsx, ts-node, coverage) into the graded process.
  "NODE_OPTIONS",
  // Redirects coverage output into the parent's collection directory.
  "NODE_V8_COVERAGE",
  // Pins a reporter that changes exit behaviour.
  "NODE_TEST_REPORTER",
  "NODE_TEST_REPORTER_DESTINATION",
] as const;

/**
 * Environment for a command whose exit code is a verdict.
 *
 * `CI=1` and the colour suppressors keep output parseable and stop interactive
 * prompts from hanging a run that nobody is watching.
 */
export function gradedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STRIPPED) {
    delete env[name];
  }
  return { ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
}

/** Exposed for tests. */
export const STRIPPED_VARIABLES: readonly string[] = STRIPPED;
