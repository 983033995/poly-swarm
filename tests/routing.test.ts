import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { REAL_BACKEND_IDS } from "../src/core/adapters/registry.js";
import { loadPolySwarmConfig } from "../src/core/config.js";
import { PolySwarmDB } from "../src/core/db.js";
import { PolySwarmEngine } from "../src/core/engine.js";
import { rankRoutes, summarizeRoutingObservations } from "../src/core/routing.js";
import { runGit } from "../src/core/worktree.js";
import type { BackendId } from "../src/shared/types.js";

test("routing does not turn repeated attempts on one seat into sufficient evidence", () => {
  const repeated = Array.from({ length: 30 }, () => ({ swarm_id: "one", worker_name: "seat", status: "completed" as const }));
  assert.deepEqual(summarizeRoutingObservations(repeated), { observations: 30, seats: 1, completed: 1, score: null });
  const different = Array.from({ length: 5 }, (_, i) => ({
    swarm_id: "one", worker_name: "seat-" + i, status: "completed" as const,
  }));
  assert.equal(summarizeRoutingObservations(different).score, 7 / 9);
});

test("quota fallback uses history ranking after excluding the failed backend", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-routing-fallback-"));
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["-c", "user.name=Poly Test", "-c", "user.email=poly@example.com", "commit", "--allow-empty", "-m", "base"]);
  const cli = (name: string, body: string) => {
    const file = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(file, `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("fixture"); process.exit(0); }\n${body}\n`, { mode: 0o700 });
    return file;
  };
  const config = loadPolySwarmConfig(path.join(dir, "backends.json"));
  config.historyAwareRouting = true;
  config.routes.research = ["cursor", "codex", "grok"];
  config.backends = {
    ...Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
    cursor: { command: cli("cursor", 'console.error("HTTP 429 quota exhausted"); process.exit(1);'), defaultModel: "claude-test", defaultEffort: "high" },
    codex: { command: cli("codex", 'throw new Error("lower-ranked backend must not run");'), defaultModel: "gpt-test", defaultEffort: "high" },
    grok: { command: cli("grok", 'console.log(JSON.stringify({type:"text",text:"[done] recovered with history"}));'), defaultModel: "grok-test", defaultEffort: "high" },
  };
  const db = new PolySwarmDB(":memory:");
  const engine = new PolySwarmEngine({ db, config });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const swarm = await engine.createSwarm({ title: "fallback", repo_root: dir });
    for (const backend of ["codex", "grok"] as const) {
      for (let i = 0; i < 5; i++) {
        const name = `${backend}-${i}`;
        db.addWorker({ swarm_id: swarm.id, name, role: "researcher", capability: "research", backend,
          workspace_mode: "inherit", workspace_path: dir });
        const turn = db.createTurn({ swarm_id: swarm.id, worker_name: name, backend,
          model: config.backends[backend]!.defaultModel, effort: "high", mode: "readonly", prompt_preview: "" });
        db.completeTurn(turn.id, { status: backend === "grok" ? "completed" : "failed",
          error_kind: backend === "grok" ? "none" : "timeout", duration_ms: 1, tool_calls_count: 0 });
      }
    }
    const completed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("history-ranked fallback did not complete")), 10_000);
      engine.on("turn:completed", (event) => {
        if (event.workerName === "fallback" && event.ok) resolve();
      });
    });
    await engine.addWorker({ swarm_id: swarm.id, name: "fallback", backend: "cursor", role: "researcher",
      brief: "local fixture only", auto_fallback: true });
    await completed;
    assert.equal(db.getWorker(swarm.id, "fallback")?.backend, "grok");
    assert.deepEqual(db.listWorkerTurns(swarm.id, "fallback").map((turn) => [turn.backend, turn.status]),
      [["grok", "completed"], ["cursor", "failed"]]);
    assert.equal(db.isCoolingDown("cursor"), true);
  } finally {
    clearTimeout(timer);
    engine.shutdown();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history-aware routing ranks exact project profiles only after hard eligibility checks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-routing-"));
  const fake = path.join(dir, "fixture-cli");
  fs.writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = --version ] && { echo fixture; exit 0; }\nexit 1\n", { mode: 0o700 });
  const configFile = path.join(dir, "backends.json");
  fs.writeFileSync(configFile, JSON.stringify({ historyAwareRouting: true }));
  const config = loadPolySwarmConfig(configFile);
  assert.equal(config.historyAwareRouting, true);
  config.routes.research = ["codex", "grok", "cursor"];
  config.backends = {
    ...Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
    codex: { command: fake, defaultModel: "gpt-test", defaultEffort: "high" },
    grok: { command: fake, defaultModel: "grok-test", defaultEffort: "high" },
    cursor: { command: fake, defaultModel: "auto" },
  };
  const db = new PolySwarmDB(":memory:");
  const engine = new PolySwarmEngine({ db, config });
  try {
    const local = db.createSwarm({ title: "current", repo_root: dir });
    const other = db.createSwarm({ title: "other", repo_root: path.join(dir, "other") });
    const add = (swarm_id: string, backend: BackendId, model: string, name: string,
        status: "completed" | "failed" | "cancelled", effort = "high", mode: "readonly" | "write" = "readonly") => {
      db.addWorker({ swarm_id, name, role: "researcher", capability: "research", backend, model,
        workspace_mode: "inherit", workspace_path: dir });
      const turn = db.createTurn({ swarm_id, worker_name: name, backend, model, effort, mode, prompt_preview: "" });
      db.completeTurn(turn.id, {
        status, error_kind: status === "completed" ? "none" : status === "failed" ? "timeout" : "cancelled",
        duration_ms: 100, tool_calls_count: 0,
      });
    };
    for (let i = 0; i < 6; i++) {
      add(local.id, "codex", "gpt-test", "c" + i, i === 0 ? "completed" : "failed");
      add(local.id, "grok", "grok-test", "g" + i, "completed");
      add(other.id, "codex", "gpt-test", "o" + i, "completed");
      add(local.id, "codex", "gpt-test", "e" + i, "completed", "low");
      add(local.id, "grok", "grok-test", "x" + i, "cancelled");
    }
    const profile = (id: BackendId) => ({ model: config.backends[id]?.defaultModel ?? null, effort: config.backends[id]?.defaultEffort ?? null });
    const ranked = rankRoutes({ candidates: ["codex", "cursor", "grok"], db, repoRoot: dir,
      capability: "research", readonly: true, profile });
    assert.deepEqual(ranked.ordered, ["grok", "cursor", "codex"]);
    assert.equal(ranked.evidence.get("codex")?.completed, 1);
    assert.equal(ranked.evidence.get("grok")?.seats, 6);
    assert.equal(ranked.evidence.has("cursor"), false);

    await engine.refreshBackends();
    const select = { capability: "research", requireReadonly: true, repoRoot: dir } as const;
    config.historyAwareRouting = false;
    assert.equal(await engine.selectBackend(select), "codex");
    config.historyAwareRouting = true;
    assert.equal(await engine.selectBackend(select), "grok");
    assert.equal(await engine.selectBackend({ ...select, preferredBackends: ["codex"] }), "codex");
    const evaluated = await engine.evaluateCandidates({ swarmId: local.id, capability: "research" });
    assert.equal(evaluated.find((row) => row.recommended)?.backend, "grok");
    assert.match(evaluated.find((row) => row.backend === "grok")?.reasons.join(" ") ?? "", /6\/6 seats completed/);
    db.setBackendCooldown("grok", Date.now() + 60_000, "fixture");
    assert.equal(await engine.selectBackend(select), "codex");
    const cooled = await engine.evaluateCandidates({ swarmId: local.id, capability: "research" });
    assert.equal(cooled.find((row) => row.backend === "grok")?.eligible, false);
    assert.equal(cooled.find((row) => row.recommended)?.backend, "codex");
  } finally {
    engine.shutdown();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
