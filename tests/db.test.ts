import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { parseMessageSignals, PolySwarmDB } from "../src/core/db.js";

const tmpDirs: string[] = [];

function makeDb(): PolySwarmDB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-swarm-db-"));
  tmpDirs.push(dir);
  return new PolySwarmDB(dir);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PolySwarmDB", () => {
  it("rejects an ambiguous talent migration without overwriting either host or marking it imported", () => {
    const left = makeDb();
    const right = makeDb();
    const shared = { file: path.join(path.dirname(left.dbPath), "talent.db"), legacyFiles: [right.dbPath] };
    const id = "agy-" + "a".repeat(24);
    try {
      left.addAgyCompany(id, "Left company");
      right.addAgyCompany(id, "Right company");
      assert.throws(() => new PolySwarmDB(path.dirname(left.dbPath), shared), /Conflicting company records/);
      assert.equal(left.listAgyCompanies()[0]?.name, "Left company");
      assert.equal(right.listAgyCompanies()[0]?.name, "Right company");
      right.updateAgyCompany({ ...right.listAgyCompanies()[0]!, name: "Left company" });
      const retried = new PolySwarmDB(path.dirname(left.dbPath), shared);
      try {
        assert.equal(retried.listAgyCompanies()[0]?.name, "Left company");
      } finally {
        retried.close();
      }
    } finally {
      left.close();
      right.close();
    }
  });

  it("backfills legacy teams without inventing conversation bindings and persists bindings and app preferences", () => {
    const db = makeDb();
    const { dbPath } = db;
    const swarm = db.createSwarm({
      title: "Legacy release", repo_root: "/tmp/repo", policy: { routes: { author: ["mock"] } },
    });
    const workflow = db.createSwarm({ title: "Workflow: Legacy review", repo_root: "/tmp/repo" });
    db.updateSwarmStatus(swarm.id, "done");
    const conclusion = db.postBoardMessage({
      swarm_id: swarm.id, sender: "coordinator", tag: "done", text: "Reviewed release",
    }).message;
    db.close();

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        DROP INDEX idx_swarms_team;
        DROP INDEX IF EXISTS idx_swarms_conversation;
        DROP TABLE IF EXISTS conversation_archives;
        DROP TABLE session_bindings;
        DROP TABLE app_kv;
        DROP TABLE teams;
        ALTER TABLE swarms DROP COLUMN team_id;
        ALTER TABLE swarms DROP COLUMN conversation_id;
        ALTER TABLE swarms DROP COLUMN conversation_source;
        ALTER TABLE swarms DROP COLUMN wave_index;
        ALTER TABLE swarms DROP COLUMN auto_created_by_workflow;
      `);
    } finally {
      legacy.close();
    }

    const teamId = swarm.id.replace(/^sw-/, "tm-");
    const dir = path.dirname(dbPath);
    const migrated = new PolySwarmDB(dir);
    try {
      const migratedSwarm = migrated.getSwarm(swarm.id);
      assert.equal(migratedSwarm?.team_id, teamId);
      assert.equal(migratedSwarm?.conversation_id, null);
      assert.equal(migratedSwarm?.wave_index, 1);
      assert.deepEqual(migrated.getTeam(teamId), {
        id: teamId, name: swarm.title, goal: null, repo_root: swarm.repo_root, status: "paused",
        active_swarm_id: swarm.id, policy_json: swarm.policy_json,
        created_at: migratedSwarm?.created_at, updated_at: migratedSwarm?.updated_at,
      });
      assert.equal(migrated.listTeamBlackboard(teamId)[0]?.seq, conclusion.seq);
      assert.equal(migrated.getSwarm(workflow.id)?.auto_created_by_workflow, 1);
      assert.equal(migrated.getLatestRealActiveSwarm()?.id, swarm.id);
      assert.deepEqual(migrated.listSessionBindingsByTeam(teamId), []);
      assert.equal(migrated.getAppKv("ui_preferences"), null);

      migrated.upsertSessionBinding({
        conversation_id: "window-a", team_id: teamId, active_swarm_id: swarm.id,
        repo_root: "/tmp/repo", window_label: "Release", last_opened_at: 1,
      });
      migrated.upsertSessionBinding({
        conversation_id: "window-a", team_id: teamId, active_swarm_id: swarm.id,
        repo_root: "/tmp/repo", last_opened_at: 2,
      });
      migrated.setAppKv("ui_preferences", { theme: "dark" });
      migrated.setAppKv("ui_preferences", { theme: "light", language: "en" });
    } finally {
      migrated.close();
    }

    const reopened = new PolySwarmDB(dir);
    try {
      assert.equal(reopened.listTeams(10).length, 2);
      const binding = reopened.getSessionBinding("window-a");
      assert.equal(binding?.active_swarm_id, swarm.id);
      assert.equal(binding?.window_label, "Release");
      assert.equal(binding?.last_opened_at, 2);
      assert.equal(reopened.findLatestBindingByRepo("/tmp/repo")?.conversation_id, "window-a");
      const summary = reopened.listTeamSummaries(10, "window-a").find((item) => item.team.id === teamId);
      assert.equal(summary?.bound_conversations, 1);
      assert.equal(summary?.is_bound_to_current, true);
      assert.deepEqual(reopened.getAppKv("ui_preferences"), { theme: "light", language: "en" });
    } finally {
      reopened.close();
    }
  });

  it("migrates existing turns without effort and preserves both old and new rows across reopen", () => {
    const db = makeDb();
    const { dbPath } = db;
    const swarm = db.createSwarm({ title: "Legacy", repo_root: "/tmp/repo" });
    const input = {
      swarm_id: swarm.id, worker_name: "dev", backend: "mock",
      mode: "write", prompt_preview: "test",
    } as const;
    const legacyTurn = db.createTurn(input);
    db.close();

    const legacyDb = new DatabaseSync(dbPath);
    try {
      legacyDb.exec("ALTER TABLE turns DROP COLUMN effort");
    } finally {
      legacyDb.close();
    }

    const dir = path.dirname(dbPath);
    const migrated = new PolySwarmDB(dir);
    let newTurnId: string;
    try {
      assert.equal(migrated.getTurn(legacyTurn.id)?.effort, null);
      newTurnId = migrated.createTurn({ ...input, effort: "high" }).id;
    } finally {
      migrated.close();
    }
    const reopened = new PolySwarmDB(dir);
    try {
      assert.equal(reopened.getTurn(newTurnId)?.effort, "high");
      assert.equal(reopened.listWorkerTurns(swarm.id, "dev").length, 2);
    } finally {
      reopened.close();
    }
  });

  it("retains effort when omitted and clears old effort and session on backend switch", () => {
    const db = makeDb();
    try {
      const swarm = db.createSwarm({ title: "Switch", repo_root: "/tmp/repo" });
      for (const resolvedPolicyJson of [undefined, "{}"]) {
        const name = resolvedPolicyJson ? "with-policy" : "without-policy";
        db.addWorker({
          swarm_id: swarm.id, name, role: "author", capability: "author",
          backend: "codex", effort: "high", workspace_mode: "inherit", workspace_path: "/tmp/repo",
        });
        db.updateWorkerBackend(swarm.id, name, "codex", "gpt-5");
        assert.equal(db.getWorker(swarm.id, name)?.effort, "high");
        db.updateWorkerSession(swarm.id, name, "old-session", false);
        db.updateWorkerBackend(swarm.id, name, "grok", "grok-4", null, resolvedPolicyJson);
        const switched = db.getWorker(swarm.id, name)!;
        assert.equal(switched.effort, null);
        assert.equal(switched.session_id, null);
        assert.equal(switched.needs_handoff, 1);
        assert.equal(switched.resolved_policy_json, resolvedPolicyJson ?? null);
      }
    } finally {
      db.close();
    }
  });

  it("parses @mentions, @#channels, @all, #seq refs (including CJK prefixes), ignores code blocks, and recovers stale running state", () => {
    const s = parseMessageSignals(
      "@alice please check #12 and #34, then notify @#backend or @all (not email@foo.com). 请@grok复核#56或@#frontend。",
    );
    assert.deepEqual(s.mentions, ["alice", "all", "grok"]);
    assert.deepEqual(s.channelMentions, ["backend", "frontend"]);
    assert.deepEqual(s.refs, [12, 34, 56]);
    assert.equal(s.hasAll, true);

    const codeStripped = parseMessageSignals(
      [
        "示例 `@#main` 与 ```\n@peer-a #99\n```",
        "~~~ts\n@peer-b #88\n~~~",
        "``双反引号里 `嵌套` 和 @peer-c``",
        "`跨行行内\n@peer-d #77`",
        "未闭合孤立反引号 `后接真实 @grok 和 #12",
      ].join("\n"),
    );
    assert.deepEqual(codeStripped.channelMentions, []);
    assert.deepEqual(codeStripped.mentions, ["grok"]);
    assert.deepEqual(codeStripped.refs, [12]);

    const unclosedFence = parseMessageSignals("前置 @alice\n```md\n@peer-z #55");
    assert.deepEqual(unclosedFence.mentions, ["alice"]);
    assert.deepEqual(unclosedFence.refs, []);

    const db = makeDb();
    try {
      const swarm = db.createSwarm({ title: "Recovery Test", repo_root: "/tmp/repo" });
      db.addWorker({
        swarm_id: swarm.id,
        name: "w-crash",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: "/tmp/repo",
      });
      db.addWorker({
        swarm_id: swarm.id,
        name: "w-live",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: "/tmp/repo",
      });

      const liveInstId = "inst-live-1";
      const deadInstId = "inst-dead-2";
      const now = Date.now();
      db.registerInstance(liveInstId, process.pid, now);
      db.registerInstance(deadInstId, 999999, now - 10_000);

      db.updateWorkerState(swarm.id, "w-crash", "working", null, deadInstId);
      db.updateWorkerState(swarm.id, "w-live", "working", null, liveInstId);
      const tDead = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "w-crash",
        backend: "mock",
        mode: "write",
        prompt_preview: "in dead instance",
        owner_instance_id: deadInstId,
      });
      const tLive = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "w-live",
        backend: "mock",
        mode: "write",
        prompt_preview: "in live instance",
        owner_instance_id: liveInstId,
      });

      const rec = db.recoverStaleRunningState({
        currentInstanceId: "inst-new-3",
        now,
        isPidAlive: (pid) => pid === process.pid,
      });
      assert.equal(rec.recoveredWorkers, 1);
      assert.equal(rec.recoveredTurns, 1);
      assert.equal(db.getWorker(swarm.id, "w-crash")?.state, "stopped");
      assert.equal(db.getTurn(tDead.id)?.status, "failed");
      assert.equal(db.getTurn(tDead.id)?.error_kind, "cancelled");
      // Live peer instance's running worker & turn must NOT be disturbed
      assert.equal(db.getWorker(swarm.id, "w-live")?.state, "working");
      assert.equal(db.getTurn(tLive.id)?.status, "running");

      const supMsg = db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "coordinator",
        tag: "system",
        text: "[switch] @w-crash",
        suppress_wake: true,
      });
      assert.equal(supMsg.message.suppress_wake, 1);
    } finally {
      db.close();
    }
  });

  it("initializes WAL, channels, board messages, events, and usage aggregation", () => {
    const db = makeDb();
    try {
      const modeRow = db.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(modeRow.journal_mode.toLowerCase(), "wal");

      const swarm = db.createSwarm({ title: "DB Test", repo_root: "/tmp/repo", base_branch: "main" });
      assert.equal(swarm.status, "active");

      const channels = db.listChannels(swarm.id);
      assert.equal(channels.length, 1);
      assert.equal(channels[0]!.name, "main");

      db.createChannel(swarm.id, "#frontend", "UI work");
      assert.equal(db.listChannels(swarm.id).length, 2);

      const worker = db.addWorker({
        swarm_id: swarm.id,
        name: "fe",
        role: "author",
        capability: "author",
        backend: "cursor",
        workspace_mode: "share",
        workspace_path: "/tmp/repo/.poly-swarm/worktrees/1/fe",
        worktree_branch: "poly-swarm/1/fe",
        channels: ["frontend"],
      });
      assert.equal(worker.state, "waiting");

      const m1 = db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "coordinator",
        channel: "frontend",
        tag: "brief",
        text: "@fe build panel",
      });
      const m2 = db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "fe",
        channel: "main",
        tag: "done",
        text: "@coordinator [done] built #1",
      });
      assert.equal(m2.message.seq > m1.message.seq, true);

      const feOnly = db.readBoardMessages({ swarm_id: swarm.id, since: 0, channel: "frontend" });
      assert.equal(feOnly.length, 1);
      assert.equal(feOnly[0]!.seq, m1.message.seq);

      const turn1 = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "fe",
        backend: "opencode",
        model: "gpt-5",
        mode: "write",
        trigger_seq: m1.message.seq,
        prompt_preview: "build panel",
      });
      const evId = db.insertEvent({
        turn_id: turn1.id,
        swarm_id: swarm.id,
        worker_name: "fe",
        seq_in_turn: 1,
        kind: "tool_call",
        title: "write_file",
        content: "panel.tsx",
      });
      assert.ok(evId > 0);
      assert.equal(db.listTurnEvents(turn1.id, 0).length, 1);
      assert.equal(db.listTurnEvents(turn1.id, evId).length, 0);

      db.insertUsage({
        turn_id: turn1.id,
        swarm_id: swarm.id,
        worker_name: "fe",
        backend: "opencode",
        model: "gpt-5",
        accuracy: "exact",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 500,
        cost_usd: 0.015,
        duration_ms: 1200,
        tool_calls_count: 2,
      });

      const turn2 = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "rev",
        backend: "cursor",
        mode: "readonly",
        prompt_preview: "review",
      });
      db.insertUsage({
        turn_id: turn2.id,
        swarm_id: swarm.id,
        worker_name: "rev",
        backend: "cursor",
        accuracy: "estimated",
        input_tokens: 400,
        output_tokens: 100,
        duration_ms: 800,
        tool_calls_count: 1,
      });

      const total = db.aggregateUsage(swarm.id, "all")[0]!;
      assert.equal(total.turns, 2);
      assert.equal(total.input_tokens, 1400);
      assert.equal(total.output_tokens, 300);
      assert.equal(total.cache_read_tokens, 500);
      assert.equal(total.exact_turns, 1);
      assert.equal(total.estimated_turns, 1);

      const other = db.createSwarm({ title: "Other swarm", repo_root: "/tmp/repo" });
      const zeroCost = db.createTurn({
        swarm_id: other.id, worker_name: "rev", backend: "cursor", mode: "readonly",
        prompt_preview: "free call",
      });
      db.insertUsage({
        turn_id: zeroCost.id, swarm_id: other.id, worker_name: "rev", backend: "cursor",
        accuracy: "exact", input_tokens: 0, output_tokens: 0,
        cost_usd: 0, duration_ms: 0, tool_calls_count: 0,
      });
      const costs = ({ known_cost_usd, priced_turns, unpriced_turns }: typeof total) =>
        [known_cost_usd, priced_turns, unpriced_turns];
      assert.deepEqual(costs(total), [0.015, 1, 1]);
      assert.deepEqual(costs(db.aggregateUsage(swarm.id, "worker").find((r) => r.key === "rev")!), [0, 0, 1]);
      assert.deepEqual(costs(db.aggregateUsage(other.id, "backend")[0]!), [0, 1, 0]);
      assert.deepEqual(costs(db.aggregateGlobalUsageByBackend().find((r) => r.key === "cursor")!), [0, 1, 1]);
      const empty = db.createSwarm({ title: "Empty swarm", repo_root: "/tmp/repo" });
      db.updateWorkerState(swarm.id, "fe", "killed");
      const summaries = db.listSwarmBriefSummaries([swarm.id, other.id, swarm.id, empty.id]);
      assert.deepEqual(summaries[swarm.id], {
        worker_count: 1, active_worker_count: 0, backends: ["cursor"],
        known_cost_usd: 0.015, priced_turns: 1, unpriced_turns: 1, total_tokens: 2200,
      });
      assert.equal(summaries[other.id]?.priced_turns, 1);
      assert.deepEqual(summaries[empty.id], {
        worker_count: 0, active_worker_count: 0, backends: [],
        known_cost_usd: 0, priced_turns: 0, unpriced_turns: 0, total_tokens: 0,
      });

      const future = Date.now() + 60_000;
      db.setBackendCooldown("cursor", future, "429");
      assert.equal(db.isCoolingDown("cursor"), true);
      db.setBackendCooldown("cursor", Date.now() - 1000, null);
      assert.equal(db.isCoolingDown("cursor"), false);
    } finally {
      db.close();
    }
  });

  it("persists atomic wakes, recovers pending/uncertain dispatches by role, and migrates new schema columns", () => {
    const db = makeDb();
    const { dbPath } = db;
    let swarmId = "";
    try {
      const swarm = db.createSwarm({ title: "Durable Wake", repo_root: "/tmp/repo" });
      swarmId = swarm.id;
      for (const [name, role] of [
        ["ro-pending", "researcher"],
        ["ro-claimed", "verifier"],
        ["wr-incomplete", "author"],
        ["wr-completed", "author"],
        ["live-claimed", "author"],
      ] as const) {
        db.addWorker({
          swarm_id: swarm.id,
          name,
          role,
          capability: role === "verifier" ? "verifier" : role === "researcher" ? "research" : "author",
          backend: "mock",
          workspace_mode: "inherit",
          workspace_path: "/tmp/repo",
        });
      }

      const deadInst = "inst-dead-1";
      const liveInst = "inst-live-2";
      const now = Date.now();
      db.registerInstance(deadInst, 999999, now - 5_000);
      db.registerInstance(liveInst, process.pid, now);

      const post1 = db.postBoardMessageWithWakes(
        { swarm_id: swarm.id, sender: "coordinator", tag: "brief", text: "@ro-pending @ro-claimed @wr-incomplete work" },
        ["ro-pending", "ro-claimed", "wr-incomplete", "ro-pending"],
      );
      assert.equal(db.getPendingDispatch(swarm.id, "ro-pending")?.trigger_seq, post1.message.seq);
      assert.equal(db.getPendingDispatch(swarm.id, "ro-pending")?.status, "pending");

      // Lower seq must not overwrite higher trigger_seq
      db.enqueuePendingDispatch(swarm.id, "ro-pending", Math.max(1, post1.message.seq - 1));
      assert.equal(db.getPendingDispatch(swarm.id, "ro-pending")?.trigger_seq, post1.message.seq);

      const claimedRo = db.claimPendingDispatch(swarm.id, "ro-claimed", deadInst);
      assert.equal(claimedRo?.status, "claimed");
      const claimedWrInc = db.claimPendingDispatch(swarm.id, "wr-incomplete", deadInst);
      assert.equal(claimedWrInc?.status, "claimed");

      const post2 = db.postBoardMessageWithWakes(
        { swarm_id: swarm.id, sender: "coordinator", tag: "brief", text: "@wr-completed @live-claimed" },
        ["wr-completed", "live-claimed"],
      );
      db.claimPendingDispatch(swarm.id, "wr-completed", deadInst);
      db.claimPendingDispatch(swarm.id, "live-claimed", liveInst);
      const tDone = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "wr-completed",
        backend: "mock",
        mode: "write",
        trigger_seq: post2.message.seq,
        prompt_preview: "done before crash",
        owner_instance_id: deadInst,
      });
      db.completeTurn(tDone.id, {
        status: "completed",
        error_kind: "none",
        output_text: "ok",
        actual_model: "mock-actual-v1",
        duration_ms: 10,
        tool_calls_count: 0,
      });
      assert.equal(db.getTurn(tDone.id)?.actual_model, "mock-actual-v1");

      const rec = db.recoverStaleRunningState({
        currentInstanceId: "inst-new-3",
        now,
        isPidAlive: (pid) => pid === process.pid,
      });
      assert.equal(db.getPendingDispatch(swarm.id, "ro-pending")?.status, "pending");
      assert.equal(db.getPendingDispatch(swarm.id, "ro-claimed")?.status, "pending");
      assert.equal(db.getPendingDispatch(swarm.id, "wr-incomplete")?.status, "uncertain");
      assert.equal(db.getPendingDispatch(swarm.id, "wr-incomplete")?.owner_instance_id, null);
      assert.equal(db.getPendingDispatch(swarm.id, "wr-completed"), null);
      assert.equal(db.getPendingDispatch(swarm.id, "live-claimed")?.status, "claimed");
      assert.ok(rec.pendingDispatches.some((d) => d.worker_name === "ro-pending"));
      assert.ok(rec.pendingDispatches.some((d) => d.worker_name === "ro-claimed"));
      assert.ok(rec.uncertainDispatches.some((d) => d.worker_name === "wr-incomplete"));

      db.upsertBackendHealth({
        backend: "agy",
        installed: 1,
        binary_path: "/usr/local/bin/agy",
        version: "1.0.0",
        supports_acp: 0,
        cli_supports_acp: 1,
        active_protocol: "headless_cli",
        supports_headless: 1,
        supports_resume: 1,
        supports_exact_usage: 1,
        supports_strict_readonly: 1,
        last_checked_at: now,
      });
      const agyHealth = db.listBackendHealth().find((b) => b.backend === "agy")!;
      assert.equal(agyHealth.supports_acp, 0);
      assert.equal(agyHealth.cli_supports_acp, 1);
      assert.equal(agyHealth.active_protocol, "headless_cli");
    } finally {
      db.close();
    }

    // Legacy migration compatibility: drop new table & columns, reopen
    const rawDb = new DatabaseSync(dbPath);
    try {
      rawDb.exec(`
        DROP INDEX IF EXISTS idx_pending_dispatches_status;
        DROP TABLE IF EXISTS pending_dispatches;
        ALTER TABLE turns DROP COLUMN actual_model;
        ALTER TABLE backend_health DROP COLUMN cli_supports_acp;
        ALTER TABLE backend_health DROP COLUMN active_protocol;
      `);
    } finally {
      rawDb.close();
    }

    const migrated = new PolySwarmDB(path.dirname(dbPath));
    try {
      assert.deepEqual(migrated.listPendingDispatches(), []);
      assert.equal(migrated.listWorkerTurns(swarmId, "wr-completed")[0]?.actual_model, null);
      const cols = migrated.db
        .prepare("PRAGMA table_info(backend_health)")
        .all()
        .map((r) => (r as { name: string }).name);
      assert.ok(cols.includes("cli_supports_acp"));
      assert.ok(cols.includes("active_protocol"));
    } finally {
      migrated.close();
    }
  });

  it("aggregates conversation archives across repos/workflows, picks max seq signal, preserves custom title, and guards manual assignment", () => {
    const db = makeDb();
    try {
      const convA = "conv-alpha-123456";
      const convB = "conv-beta-654321";
      const teamA1 = db.createTeam({ name: "Team A1", repo_root: "/tmp/workspace/poly-swarm" });
      const teamA2 = db.createTeam({ name: "Team A2", repo_root: "/tmp/workspace/akb" });
      const s1 = db.createSwarm({
        title: "Wave 1",
        repo_root: "/tmp/workspace/poly-swarm",
        team_id: teamA1.id,
        conversation_id: convA,
        wave_index: 1,
      });
      const s2 = db.createSwarm({
        title: "Workflow: Cross Review",
        repo_root: "/tmp/workspace/akb",
        team_id: teamA2.id,
        conversation_id: convA,
        wave_index: 2,
        auto_created_by_workflow: true,
      });
      const legacy = db.createSwarm({
        title: "Legacy Call",
        repo_root: "/tmp/workspace/poly-swarm",
      });

      db.upsertSessionBinding({
        conversation_id: convA,
        team_id: teamA1.id,
        active_swarm_id: s1.id,
        repo_root: "/tmp/workspace/poly-swarm",
      });
      db.addWorker({
        swarm_id: s1.id,
        name: "dev",
        role: "author",
        capability: "author",
        backend: "codex",
        workspace_mode: "inherit",
        workspace_path: "/tmp/workspace/poly-swarm",
      });
      const m1 = db.postBoardMessage({ swarm_id: s1.id, sender: "coordinator", tag: "brief", text: "first" }).message;
      const m2 = db.postBoardMessage({ swarm_id: s1.id, sender: "dev", tag: "done", text: "second" }).message;
      const m3 = db.postBoardMessage({ swarm_id: s1.id, sender: "dev", tag: "review_pass", text: "third" }).message;
      assert.ok(m3.seq > m2.seq && m2.seq > m1.seq);

      const tCodex = db.createTurn({ swarm_id: s1.id, worker_name: "dev", backend: "codex", model: "gpt-6.2-sol", mode: "write", prompt_preview: "p1" });
      db.insertUsage({
        turn_id: tCodex.id, swarm_id: s1.id, worker_name: "dev", backend: "codex", model: "gpt-6.2-sol",
        accuracy: "exact", input_tokens: 1000, output_tokens: 100, cache_read_tokens: 900,
        cost_usd: null, duration_ms: 2000, tool_calls_count: 3,
      });
      const tGrok = db.createTurn({ swarm_id: s2.id, worker_name: "wf", backend: "grok", model: "grok-4.7", mode: "readonly", prompt_preview: "p2" });
      db.insertUsage({
        turn_id: tGrok.id, swarm_id: s2.id, worker_name: "wf", backend: "grok", model: "grok-4.7",
        accuracy: "exact", input_tokens: 200, output_tokens: 50, cache_read_tokens: 800,
        cost_usd: 0.02, duration_ms: 1000, tool_calls_count: 1,
      });

      db.upsertConversationMeta(convA, { host_title: "Host Window Title" });
      let archives = db.listConversationArchives(convA);
      assert.equal(archives.total_sessions, 1);
      assert.equal(archives.total_unassigned, 1);
      const sessA = archives.sessions[0]!;
      assert.equal(sessA.is_current, true);
      assert.equal(sessA.title, "Host Window Title");
      assert.equal(sessA.title_source, "host");
      assert.equal(sessA.wave_count, 2);
      assert.equal(sessA.real_wave_count, 1);
      assert.equal(sessA.workflow_wave_count, 1);
      assert.deepEqual(sessA.repo_roots.sort(), ["/tmp/workspace/akb", "/tmp/workspace/poly-swarm"]);
      assert.equal(sessA.latest_signal?.seq, m3.seq);
      assert.equal(sessA.latest_signal?.tag, "review_pass");
      // Usage normalization: codex inclusive (100 uncached + 900 cached + 100 out = 1100) + grok exclusive (200 + 800 + 50 = 1050) = 2150
      assert.equal(sessA.total_tokens, 2150);
      assert.equal(sessA.usage.uncached_input_tokens, 300);
      assert.equal(sessA.usage.cache_read_tokens, 1700);
      assert.equal(sessA.usage.output_tokens, 150);
      assert.equal(sessA.usage.total_input_tokens, 2000);
      assert.ok(Math.abs((sessA.usage.cache_hit_rate ?? 0) - 0.85) < 1e-6);
      assert.equal(sessA.usage.known_cost_usd, 0.02);
      assert.ok(sessA.usage.estimated_cost_usd > 0);
      assert.equal(sessA.usage.by_backend.length, 2);

      // Custom title takes precedence and host sync must not overwrite it
      db.upsertConversationMeta(convA, { custom_title: "My Pinned Name" });
      db.upsertConversationMeta(convA, { host_title: "New Host Title" });
      archives = db.listConversationArchives(convB);
      assert.equal(archives.sessions[0]!.title, "My Pinned Name");
      assert.equal(archives.sessions[0]!.is_current, false);

      // Manual assignment of unassigned swarm works and can be undone
      const assigned = db.assignSwarmConversation(legacy.id, convA);
      assert.equal(assigned.conversation_id, convA);
      assert.equal(assigned.conversation_source, "manual");
      archives = db.listConversationArchives(convA);
      assert.equal(archives.total_unassigned, 0);
      assert.equal(archives.sessions[0]!.wave_count, 3);

      // Cannot overwrite native conversation ownership
      assert.throws(() => db.assignSwarmConversation(s1.id, convB), /already belongs/);
      assert.throws(() => db.assignSwarmConversation(s1.id, null), /native conversation ownership/);

      // Undo manual assignment
      const unassigned = db.assignSwarmConversation(legacy.id, null);
      assert.equal(unassigned.conversation_id, null);
      assert.equal(unassigned.conversation_source, null);
      assert.equal(db.listConversationArchives(convA).total_unassigned, 1);
    } finally {
      db.close();
    }
  });

  it("queries per-turn swarm usage with turn metadata and vendor-level model breakdowns", () => {
    const db = new PolySwarmDB(":memory:");
    try {
      const swarm = db.createSwarm({ title: "Usage Breakdown Swarm", repo_root: "/tmp/repo-u" });
      db.addWorker({
        swarm_id: swarm.id,
        name: "dev",
        role: "author",
        capability: "author",
        backend: "codex",
        model: "gpt-6.2-sol",
        workspace_mode: "inherit",
        workspace_path: "/tmp/repo-u",
      });
      db.addWorker({
        swarm_id: swarm.id,
        name: "research",
        role: "researcher",
        capability: "research",
        backend: "grok",
        model: "grok-4.7",
        workspace_mode: "inherit",
        workspace_path: "/tmp/repo-u",
      });

      const tCodex = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "dev",
        backend: "codex",
        model: "gpt-6.2-sol",
        mode: "write",
        trigger_seq: 7,
        prompt_preview: "Implement vendor telemetry",
      });
      db.completeTurn(tCodex.id, { status: "completed", error_kind: "none", duration_ms: 4000, tool_calls_count: 5 });
      db.insertUsage({
        turn_id: tCodex.id,
        swarm_id: swarm.id,
        worker_name: "dev",
        backend: "codex",
        model: null,
        accuracy: "exact",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 800,
        cost_usd: null,
        duration_ms: 4000,
        tool_calls_count: 5,
      });

      const tGrok1 = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "research",
        backend: "grok",
        model: "grok-4.7",
        mode: "readonly",
        trigger_seq: 9,
        prompt_preview: "Audit cost tables",
      });
      db.completeTurn(tGrok1.id, { status: "completed", error_kind: "none", duration_ms: 2000, tool_calls_count: 2 });
      db.insertUsage({
        turn_id: tGrok1.id,
        swarm_id: swarm.id,
        worker_name: "research",
        backend: "grok",
        model: "grok-4.7",
        accuracy: "exact",
        input_tokens: 150,
        output_tokens: 60,
        reasoning_tokens: 40,
        cache_read_tokens: 850,
        cost_usd: 0.025,
        duration_ms: 2000,
        tool_calls_count: 2,
      });

      const tGrokDefault = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "research",
        backend: "grok",
        model: null,
        mode: "readonly",
        trigger_seq: 10,
        prompt_preview: "Default model check",
      });
      db.insertUsage({
        turn_id: tGrokDefault.id,
        swarm_id: swarm.id,
        worker_name: "research",
        backend: "grok",
        model: null,
        accuracy: "hook",
        input_tokens: 100,
        output_tokens: 30,
        cache_read_tokens: 0,
        cost_usd: 0.01,
        duration_ms: 1000,
        tool_calls_count: 1,
      });
      // Simulate worker without model override for third turn
      const swarmTurns = db.listSwarmUsageWithTurns(swarm.id, 10);
      assert.equal(swarmTurns.length, 3);
      const codexRow = swarmTurns.find((r) => r.turn_id === tCodex.id);
      assert.equal(codexRow?.turn_status, "completed");
      assert.equal(codexRow?.trigger_seq, 7);
      assert.equal(codexRow?.resolved_model, "gpt-6.2-sol");
      assert.equal(codexRow?.prompt_preview, "Implement vendor telemetry");

      const byVendor = db.listGlobalUsageByVendor();
      const codexVendor = byVendor.codex;
      assert.ok(codexVendor);
      // Codex inclusive: input=1000 includes 800 cache_read => uncached=200, output=200 => total=1200, hit=0.8
      assert.equal(codexVendor.totals.total_tokens, 1200);
      assert.equal(codexVendor.totals.uncached_input_tokens, 200);
      assert.equal(codexVendor.totals.cache_read_tokens, 800);
      assert.ok(Math.abs((codexVendor.totals.cache_hit_rate ?? 0) - 0.8) < 1e-6);
      assert.ok(codexVendor.totals.estimated_cost_usd > 0);
      assert.equal(codexVendor.models.length, 1);
      assert.equal(codexVendor.models[0]!.model, "gpt-6.2-sol");

      const grokVendor = byVendor.grok;
      assert.ok(grokVendor);
      assert.equal(grokVendor.totals.turns, 2);
      assert.equal(grokVendor.totals.known_cost_usd, 0.035);
      assert.equal(grokVendor.totals.reasoning_tokens, 40);
      // tGrokDefault joins workers.model ("grok-4.7") when u.model and t.model are null, so all grok turns roll into grok-4.7
      assert.equal(grokVendor.models.length, 1);
      assert.equal(grokVendor.models[0]!.model, "grok-4.7");
    } finally {
      db.close();
    }
  });
});
