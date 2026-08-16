/**
 * Chai-Kan 7.74 API server.
 *
 * Exposes the harness as a REST API:
 *   POST /solve   — submit a task, get a verified result back
 *   GET  /health  — liveness probe
 *
 * Requests go through the supervisor rather than a bare agent, because the
 * verification loop is the product. A bare `agent.run()` would return whatever
 * the model claimed it did, which is the thing this harness exists not to do.
 */

import express, { type Request, type Response } from "express";
import * as path from "node:path";
import { Agent } from "./agent.js";
import { DEFAULT_CONFIG, isKnownModel, EFFORTS, type AgentConfig, type Effort } from "./config.js";
import { runSupervised } from "./supervisor.js";

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

app.use(express.json());

interface SolveRequest {
  task?: unknown;
  model?: unknown;
  effort?: unknown;
  projectRoot?: unknown;
}

interface SolveResponse {
  success: boolean;
  task: string;
  result?: {
    /** verified | unverified | regressed | no-checks */
    verdict: string;
    output: string;
    turns: number;
    stoppedBecause: string;
    repairAttempts: number;
    checks: { name: string; passed: boolean }[];
    cost: string;
    cacheHitRate: string;
  };
  error?: string;
}

app.post("/solve", async (req: Request, res: Response<SolveResponse>) => {
  const body = (req.body ?? {}) as SolveRequest;
  const task = typeof body.task === "string" ? body.task : "";

  try {
    if (!task.trim()) {
      res.status(400).json({ success: false, task: "", error: "Missing or invalid 'task' field" });
      return;
    }

    const model = typeof body.model === "string" ? body.model : DEFAULT_CONFIG.model;
    if (!isKnownModel(model)) {
      res.status(400).json({ success: false, task, error: `Unknown model: ${model}` });
      return;
    }

    const effort = typeof body.effort === "string" ? body.effort : DEFAULT_CONFIG.effort;
    if (!EFFORTS.includes(effort as Effort)) {
      res.status(400).json({ success: false, task, error: `Unknown effort: ${effort}` });
      return;
    }

    const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot : PROJECT_ROOT;

    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      model,
      effort: effort as Effort,
      root: path.resolve(projectRoot),
      // Unattended: there is no operator to answer a prompt, so mutating tools
      // run without one. The path confinement in tools.ts is what keeps this
      // honest, not the approval mode.
      approval: "auto",
      verify: true,
    };

    // Streamed assistant text, accumulated so the caller gets the prose the
    // agent produced rather than only its final message.
    let output = "";
    const agent = new Agent(config, {
      onText: (delta) => {
        output += delta;
      },
    });

    const supervised = await runSupervised(agent, config, task, {
      maxRepairAttempts: config.repairAttempts,
      requireGreen: config.requireGreen,
    });

    const meter = agent.costMeter;
    const costUsd = meter.costUsd;

    res.json({
      // A run that regressed the suite is not a success, regardless of what
      // the model said about it.
      success: supervised.verdict === "verified" || supervised.verdict === "no-checks",
      task,
      result: {
        verdict: supervised.verdict,
        output: output || supervised.run.finalText,
        turns: supervised.run.turns,
        stoppedBecause: supervised.run.stoppedBecause,
        repairAttempts: supervised.repairAttempts,
        checks: (supervised.final ?? supervised.baseline)?.results.map((r) => ({
          name: r.name,
          passed: r.passed,
        })) ?? [],
        cost: costUsd === null ? "unpriced" : `$${costUsd.toFixed(4)}`,
        cacheHitRate: `${(meter.cacheHitRate * 100).toFixed(0)}%`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, task, error: message });
  }
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", version: "7.74" });
});

app.listen(PORT, () => {
  console.log(`Chai-Kan 7.74 API server listening on port ${PORT}`);
  console.log("POST /solve  — submit a task");
  console.log("GET  /health — health check");
});
