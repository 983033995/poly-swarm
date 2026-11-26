import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AdapterRunInput, WorkerAdapter } from "../src/core/adapters/base.js";
import { AdapterRegistry, REAL_BACKEND_IDS } from "../src/core/adapters/registry.js";
import { AgyAccounts } from "../src/core/agy_accounts.js";
import type { BackendId } from "../src/shared/types.js";
import { loadPolySwarmConfig, type PolySwarmConfig } from "../src/core/config.js";
import { PolySwarmDB } from "../src/core/db.js";
import { PolySwarmEngine, truncateUtf8Bytes } from "../src/core/engine.js";
import { StallWatchdog } from "../src/core/watchdog.js";
import { WorkflowRunner } from "../src/core/workflow.js";
import { runGit } from "../src/core/worktree.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function initTempRepo(): Promise<string> {
  const dir = makeTempDir("poly-eng-repo-");
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Poly Test"]);
  await runGit(dir, ["config", "user.email", "poly@example.com"]);
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

async function waitForCondition(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("PolySwarmEngine, StallWatchdog, and WorkflowRunner", () => {
  it("binds only the four default AGY employees to an enabled main company", () => {
    const dir = makeTempDir("poly-staff-defaults-");
    const db = new PolySwarmDB(dir);
    const first = "agy-" + "a".repeat(24);
    const main = "agy-" + "b".repeat(24);
    db.addAgyCompany(first, "主账号 · 已停用");
    db.disableAgyCompany(first);
    db.addAgyCompany(main, "主号 · 默认");
    const engine = new PolySwarmEngine({ db, config: loadPolySwarmConfig(path.join(dir, "backends.json")) });
    try {
      const roster = engine.getStaffRoster();
      assert.equal(roster.length, 13);
      assert.ok(roster.every((member) => member.builtin && member.enabled));
      assert.deepEqual(roster.filter((member) => member.company_id).map(({ id, company_id }) => [id, company_id]), [
        ["agy-orch-neon", main], ["agy-orch-carbon", main], ["agy-neon", main], ["agy-carbon", main],
      ]);
      const tara = roster.find((member) => member.id === "trae-auto");
      assert.ok(tara);
      assert.equal(tara.backend, "trae");
      assert.equal(tara.model, "auto");
      assert.equal(tara.effort, null);
      assert.equal(tara.identity_id, "devops-sre");
      assert.equal(tara.capability, "enterprise");
      db.disableAgyCompany(main);
      assert.ok(engine.resetStaffRoster().every((member) => member.company_id === null));
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("falls back to the employee's execution role for stale templates but rejects invalid explicit identity", async () => {
    const dir = makeTempDir("poly-staff-stale-identity-");
    const repo = await initTempRepo();
    const fake = path.join(dir, "fake-trae");
    fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = --version ]; then echo fixture; exit 0; fi
[ "$1" = exec ] && [ "$2" = --json ] && [ "$6" = -s ] && [ "$7" = read-only ] || exit 2
cat >/dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Fixture review."}}'
`, { mode: 0o700 });
    const config = loadPolySwarmConfig(path.join(dir, "backends.json"));
    config.backends = Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { command: fake, enabled: id === "trae" }]));
    config.identities = { "disabled-review": { base_role: "verifier", enabled: false } };
    const db = new PolySwarmDB(dir);
    const engine = new PolySwarmEngine({ db, config });
    const missing = "missing-review";
    try {
      const swarm = await engine.createSwarm({ title: "Stale staff templates", repo_root: repo });
      for (const [name, identity] of [["stale", missing], ["disabled", "disabled-review"]] as const) {
        const staffId = "staff-" + name;
        engine.upsertStaffMember({
          id: staffId, name, backend: "trae", model: "auto", role: "verifier", identity_id: identity,
        });
        const { worker } = await engine.addWorker({ swarm_id: swarm.id, name, staff_id: staffId, brief: "Review fixture." });
        assert.equal(worker.staff_id, staffId);
        assert.equal(worker.identity_id, "verifier");
        assert.equal(worker.role, "verifier");
        assert.equal(worker.workspace_mode, "inherit");
        await waitForCondition(() => db.getLatestWorkerTurn(swarm.id, name)?.status === "completed");
        assert.equal(db.listStaffPerformance().find((item) => item.staff_id === staffId)?.completed_turns, 1);
      }
      await assert.rejects(() => engine.addWorker({
        swarm_id: swarm.id, name: "explicit", staff_id: "staff-stale", identity: missing, brief: "Invalid identity fixture.",
      }), /Unknown dispatch identity/);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("warns in an isolated worker brief when the main workspace has uncommitted changes", async () => {
    const repo = await initTempRepo();
    const dir = makeTempDir("poly-dirty-isolation-");
    const db = new PolySwarmDB(dir);
    const config = loadPolySwarmConfig(path.join(dir, "backends.json"));
    config.backends = Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }]));
    const engine = new PolySwarmEngine({ db, config });
    try {
      const swarm = await engine.createSwarm({ title: "Dirty isolation warning", repo_root: repo });
      fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
      const { worker, brief_message } = await engine.addWorker({
        swarm_id: swarm.id, name: "isolated", backend: "mock", role: "author", workspace_mode: "share",
        brief: "Check the committed fixture.",
      });
      assert.match(brief_message.text, /【工作区提示】[^\n]*HEAD/);
      assert.match(brief_message.text, /Check the committed fixture\./);
      assert.equal(fs.readFileSync(path.join(worker.workspace_path, "app.ts"), "utf8"), "export const v = 1;\n");
      assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf8"), "export const v = 2;\n");
      await waitForCondition(() => db.getLatestWorkerTurn(swarm.id, "isolated")?.status === "completed");
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("migrates legacy seats and keeps AGY company settings, execution and usage separate", { skip: process.platform !== "darwin" }, async () => {
    const dataDir = makeTempDir("poly-agy-");
    const source = fs.realpathSync(makeTempDir("poly-agy-vault-"));
    const repo = await initTempRepo();
    const ids = ["fixture-a", "fixture-b"].map((name) => {
      const email = `${name}@example.invalid`;
      const id = createHash("sha256").update(email).digest("hex").slice(0, 24);
      fs.writeFileSync(path.join(source, id + ".json"), JSON.stringify({
        id, email, verifiedAt: "2026-01-01T00:00:00Z", credential: { refresh_token: name },
      }), { mode: 0o600 });
      return id;
    });
    const fake = path.join(dataDir, "fake-agy.mjs");
    fs.writeFileSync(fake, `#!${process.execPath}
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const file = ".gemini/antigravity-cli/antigravity-oauth-token";
const token = JSON.parse(fs.readFileSync(path.join(process.env.HOME, file)));
const login = token.token.refresh_token;
const args = process.argv.slice(2);
const i = args.indexOf("--conversation");
assert.equal(process.env.GEMINI_API_KEY, undefined);
assert(!args.includes("--inherited-fixture"));
assert.throws(() => fs.readFileSync(${JSON.stringify(path.join(source, ids[0]! + ".json"))}));
const otherId = login === "fixture-a" ? ${JSON.stringify(ids[1])} : ${JSON.stringify(ids[0])};
assert.throws(() => fs.readFileSync(path.join(process.env.HOME, "..", otherId, file)));
if (args[0] === "models") {
  assert.deepEqual(args, ["models"]);
  assert.equal(process.env.HTTPS_PROXY, "http://example.invalid:4567");
  if (fs.existsSync(path.join(process.env.HOME, "catalog-auth-error"))) {
    console.error("Please sign in to view available models");
    process.exit(1);
  }
  console.error("foreign-model\tShould not parse stderr");
  console.log(login + "-model\tAccount model");
  process.exit(0);
}
if (i >= 0) assert.equal(args[i + 1], login);
const prompt = args[args.indexOf("-p") + 1] ?? "";
if (prompt.includes("test-quota")) {
  console.error("429 quota exhausted");
  process.exit(1);
}
if (prompt.includes("test-disabled")) {
  console.error("403 PERMISSION_DENIED: This service has been disabled in this account.");
  process.exit(1);
}
console.log(JSON.stringify({type:"result", conversation_id:login, result: "@coordinator [done] " + login + (i >= 0 ? " resumed" : " started")}));
`, { mode: 0o700 });
    const config = loadPolySwarmConfig(path.join(dataDir, "backends.json"));
    config.backends.agy = { command: fake, enabled: false, defaultModel: "legacy-model", env: { GEMINI_API_KEY: "fake-inherited-key", HTTPS_PROXY: "http://example.invalid:4567" }, extraArgs: ["--inherited-fixture"] };
    const db = new PolySwarmDB(dataDir);
    db.setAppKv("staff_roster", [
      { id: "person-0", name: "person-0", backend: "agy", role: "worker", agy_account_id: ids[0] },
      { id: "legacy", name: "legacy-employee", backend: "agy", role: "worker" },
    ]);
    const accounts = new AgyAccounts(dataDir, source);
    const engine = new PolySwarmEngine({ db, config, agyAccounts: accounts });
    try {
      assert.deepEqual(engine.listAgyAccounts(), ids.map((id, index) => ({
        id, email: `fixture-${index === 0 ? "a" : "b"}@example.invalid`,
      })));
      const [companyA, companyB] = ids.map((id) => `agy-${id}`) as [string, string];
      assert.deepEqual(engine.getAgyCompanies().map((entry) => entry.id), [companyA]);
      assert.equal(engine.getStaffRoster().find((entry) => entry.id === "person-0")?.company_id, companyA);
      assert.equal(engine.getStaffRoster().find((entry) => entry.id === "legacy")?.company_id, null);
      engine.addAgyCompanies([ids[0]!, ids[1]!, ids[1]!]);
      assert.deepEqual(engine.getAgyCompanies().map((entry) => entry.id), [companyA, companyB]);
      const models = (list: Awaited<ReturnType<typeof engine.listAgyCompanyModels>>) => list.map((item) => item.id);
      const catalogs = await Promise.all([engine.listAgyCompanyModels(companyA), engine.listAgyCompanyModels(companyB)]);
      assert.deepEqual(catalogs.map(models), [["fixture-a-model"], ["fixture-b-model"]]);
      fs.writeFileSync(path.join(accounts.prepare(ids[1]!).home, "catalog-auth-error"), "");
      await assert.rejects(engine.listAgyCompanyModels(companyB, true), /登录验证/);
      await assert.rejects(engine.listAgyCompanyModels(companyB), /登录验证/);
      assert.deepEqual(models(await engine.listAgyCompanyModels(companyA)), ["fixture-a-model"]);
      const companySettings = { name: "Studio B", default_model: "company-b-model", default_effort: "low" };
      engine.updateAgyCompany(companyB, { ...companySettings, enabled: false });
      engine.upsertStaffMember({
        id: "person-1", name: "person-1", backend: "agy", role: "worker", company_id: companyB,
      });
      const swarm = await engine.createSwarm({ title: "Two isolated logins", repo_root: repo });
      await assert.rejects(engine.addWorker({
        swarm_id: swarm.id, name: "disabled-seat", company_id: companyB, brief: "Start", workspace_mode: "inherit",
      }), /company is disabled/);
      engine.updateAgyCompany(companyB, { ...companySettings, enabled: true });
      const first = await engine.addWorker({
        swarm_id: swarm.id, name: "seat-a", staff_id: "person-0", workspace_mode: "inherit", brief: "Start",
      });
      const second = await engine.addWorker({
        swarm_id: swarm.id, name: "person-1", backend: "agy", workspace_mode: "inherit", brief: "Start",
      });
      assert.equal(first.worker.agy_account_id, ids[0]);
      assert.equal(second.worker.agy_account_id, ids[1]);
      assert.equal(second.worker.model, "company-b-model");
      assert.equal(second.worker.effort, "low");
      assert.equal(first.worker.auto_fallback, 0);
      const posted = (message: string) => db.readBoardTail(swarm.id).some((item) => item.text.includes(message));
      await waitForCondition(() => posted("fixture-a started") && posted("fixture-b started"));
      assert.deepEqual(db.aggregateAgyCompanyUsage().map((row) => [row.key, row.turns]).sort(), [[companyA, 1], [companyB, 1]].sort());
      engine.upsertStaffMember({
        id: "person-0", name: "person-0", backend: "agy", role: "worker", company_id: companyB,
      });
      await engine.postMessage({ swarm_id: swarm.id, sender: "coordinator", text: "@seat-a Resume" });
      await waitForCondition(() => posted("fixture-a resumed"));
      await assert.rejects(engine.switchWorkerBackend({ swarm_id: swarm.id, name: "seat-a", backend: "codex" }), /bound/);
      fs.unlinkSync(path.join(source, ids[0]! + ".json"));
      await engine.postMessage({ swarm_id: swarm.id, sender: "coordinator", text: "@seat-a Try again" });
      await waitForCondition(() => db.getWorker(swarm.id, "seat-a")?.last_error?.includes("bound AGY account is unavailable") === true);
      assert.equal(db.getWorker(swarm.id, "seat-a")?.backend, "agy");
      await engine.addWorker({
        swarm_id: swarm.id, name: "blocked-seat", company_id: companyB, workspace_mode: "inherit", brief: "test-disabled",
      });
      await waitForCondition(() => db.getWorker(swarm.id, "blocked-seat")?.state === "error");
      assert.equal(db.listAgyCompanies().find((entry) => entry.id === companyA)?.enabled, true);
      assert.equal(db.listAgyCompanies().find((entry) => entry.id === companyB)?.enabled, false);
      await assert.rejects(engine.addWorker({
        swarm_id: swarm.id, name: "another-seat", company_id: companyB, brief: "Start",
      }), /company is disabled/);
      engine.updateAgyCompany(companyB, { ...companySettings, enabled: true });
      const quotaWorker = await engine.addWorker({
        swarm_id: swarm.id, name: "quota-seat", company_id: companyB, workspace_mode: "inherit", brief: "test-quota",
      });
      assert.equal(quotaWorker.worker.agy_account_id, ids[1]);
      await waitForCondition(() => (db.listAgyCompanies().find((entry) => entry.id === companyB)?.cooldown_until ?? 0) > Date.now());
      assert.equal(db.listAgyCompanies().find((entry) => entry.id === companyA)?.cooldown_until, null);
      assert.equal(db.listBackendHealth().find((entry) => entry.backend === "agy")?.cooldown_until ?? null, null);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("resolves explicit, conversation, repo, workbench focus, and latest targets in priority order", async () => {
    const dataDir = makeTempDir("poly-eng-match-");
    const repoA = makeTempDir("poly-eng-match-a-");
    const repoB = makeTempDir("poly-eng-match-b-");
    const repoC = makeTempDir("poly-eng-match-c-");
    const db = new PolySwarmDB(dataDir);
    const engine = new PolySwarmEngine({ db, config: loadPolySwarmConfig(path.join(dataDir, "backends.json")) });
    try {
      assert.equal(engine.resolveSessionTarget().matchReason, "none");
      const a = await engine.createSwarm({ title: "Conversation A", repo_root: repoA, conversation_id: "chat-a" });
      const b = await engine.createSwarm({ title: "Repository B", repo_root: repoB });
      const workflow = await engine.createSwarm({
        title: "Workflow: Temporary", repo_root: repoC, auto_created_by_workflow: true,
      });
      const expectTarget = (
        opts: Parameters<PolySwarmEngine["resolveSessionTarget"]>[0],
        id: string | null,
        reason: ReturnType<PolySwarmEngine["resolveSessionTarget"]>["matchReason"],
      ) => {
        const target = engine.resolveSessionTarget(opts);
        assert.equal(target.swarm?.id ?? null, id);
        assert.equal(target.matchReason, reason);
      };

      // Strict session isolation by default; explicit autoSelect: true preserves fallback hierarchy
      expectTarget({}, null, "none");
      expectTarget({ repoRoot: repoC }, null, "none");
      expectTarget({ conversationId: "new-chat", repoRoot: repoA }, null, "none");
      expectTarget({ conversationId: "new-chat", repoRoot: repoB }, null, "none");
      expectTarget({ repoRoot: repoC, autoSelect: true }, b.id, "recent_active_team");
      engine.setUiFocus({ swarm_id: a.id, tab: "detail" });
      expectTarget({}, null, "none");
      expectTarget({ autoSelect: true }, a.id, "recent_workbench_focus");
      engine.setUiFocus({ swarm_id: workflow.id, tab: "detail" });
      expectTarget({ autoSelect: true }, a.id, "recent_workbench_focus");
      expectTarget({ conversationId: "new-chat", repoRoot: repoB, autoSelect: true }, b.id, "repo_match");
      assert.equal(db.getSessionBinding("new-chat"), null);
      // Bound conversation ignores unrelated repo/focus overrides
      engine.setUiFocus({ swarm_id: b.id, tab: "board" });
      expectTarget({ conversationId: "chat-a", repoRoot: repoB }, a.id, "conversation_binding");
      expectTarget({ teamId: b.team_id, conversationId: "chat-a", repoRoot: repoA }, b.id, "explicit_team");
      expectTarget({ swarmId: workflow.id, teamId: b.team_id, conversationId: "chat-a" }, workflow.id, "explicit_swarm");
      expectTarget({ swarmId: "missing", repoRoot: repoB }, null, "none");
      expectTarget({ autoSelect: false }, null, "none");
      expectTarget({ surface: "global" }, null, "none");
      expectTarget({ surface: "global", autoSelect: true }, b.id, "recent_workbench_focus");
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("attaches a second window to the same team, reopens a wave, and starts a new wave independently", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-team-");
    const db = new PolySwarmDB(dataDir);
    const engine = new PolySwarmEngine({ db, config: loadPolySwarmConfig(path.join(dataDir, "backends.json")) });
    try {
      const first = await engine.createSwarm({
        title: "First release", team_name: "Release team", repo_root: repo, conversation_id: "chat-1",
      });
      const teamId = first.team_id!;
      db.addWorker({
        swarm_id: first.id, name: "dev", role: "author", capability: "author",
        backend: "mock", workspace_mode: "inherit", workspace_path: repo,
      });
      await engine.finishSwarm(first.id, "First wave accepted");
      const readOnly = await engine.attachSessionToTeam({
        team_id: teamId, conversation_id: "chat-2", reopen: false,
      });
      assert.equal(readOnly.swarm?.status, "done");
      assert.equal(readOnly.team.status, "paused");
      assert.equal(readOnly.snapshot.workers[0]?.name, "dev");
      assert.match(readOnly.handoff_context, /First wave accepted/);
      assert.equal(readOnly.binding?.active_swarm_id, first.id);
      assert.equal(db.listSessionBindingsByTeam(teamId).length, 2);

      assert.equal((await engine.reopenSwarm(first.id)).status, "active");
      assert.equal((await engine.reopenSwarm(first.id)).status, "active");
      const reopenPosts = db.readBoardTail(first.id).filter((msg) => msg.text.includes("已重新打开"));
      assert.equal(reopenPosts.length, 1);
      assert.equal(reopenPosts[0]?.suppress_wake, 1);
      await engine.finishSwarm(first.id, "Ready for a new wave");
      const second = await engine.startNewWave({ team_id: teamId, title: "Second release", conversation_id: "chat-2" });
      assert.equal(second.team_id, teamId);
      assert.equal(second.wave_index, 2);
      assert.equal(db.getTeam(teamId)?.active_swarm_id, second.id);
      assert.equal(engine.resolveSessionTarget({ conversationId: "chat-1" }).swarm?.id, first.id);
      assert.equal(engine.resolveSessionTarget({ conversationId: "chat-2" }).swarm?.id, second.id);
      assert.equal(engine.resolveSessionTarget({ teamId }).swarm?.id, second.id);
      assert.deepEqual(db.listWorkers(second.id), []);
      assert.deepEqual(db.readBoardTail(second.id), []);

      const historical = await engine.attachSessionToTeam({
        team_id: teamId, swarm_id: first.id, conversation_id: "chat-3", reopen: false,
      });
      assert.equal(historical.binding?.active_swarm_id, first.id);
      assert.equal(engine.resolveSessionTarget({ teamId }).swarm?.id, second.id);

      db.updateSwarmStatus(first.id, "archived");
      await assert.rejects(() => engine.reopenSwarm(first.id), /archived/);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("orchestrates multi-turn mock workers, enforces readonly verifier rollback, and merges", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-data-");
    const db = new PolySwarmDB(dataDir);
    const config = loadPolySwarmConfig("/nonexistent-path");
    const engine = new PolySwarmEngine({ db, config });

    try {
      const swarm = await engine.createSwarm({ title: "Feature X", repo_root: repo });
      const { worker: author } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "dev",
        role: "author",
        backend: "mock",
        workspace_mode: "share",
        brief:
          'Implement greet.ts [MOCK:{"thought":"planning greet.ts","tool":{"name":"read_file","args":"app.ts"},"writeFile":{"path":"greet.ts","content":"export const hi = 1;\\n"},"text":"@coordinator [done] created greet.ts","sessionId":"ses-dev-1"}]',
      });

      await waitForCondition(() => {
        const w = db.getWorker(swarm.id, "dev");
        return Boolean(w && w.state === "waiting" && w.last_post_seq > 1);
      });

      const updatedAuthor = db.getWorker(swarm.id, "dev")!;
      assert.equal(updatedAuthor.session_id, "ses-dev-1");
      assert.ok(fs.existsSync(path.join(author.workspace_path, "greet.ts")));

      // Second turn resumes session_id
      await engine.postMessage({
        swarm_id: swarm.id,
        sender: "coordinator",
        text: '@dev follow up [MOCK:{"text":"@coordinator I will use `[done]` once verified."}]',
      });
      await waitForCondition(() => db.readBoardTail(swarm.id).some((m) => m.sender === "dev" && m.text.includes("once verified")));
      const turns = db.listWorkerTurns(swarm.id, "dev");
      assert.equal(turns[0]!.session_id_used, "ses-dev-1");
      assert.equal(db.readBoardTail(swarm.id).find((m) => m.sender === "dev" && m.text.includes("once verified"))?.tag, "update");

      // Verifier attempting unauthorized write in its private worktree must be rolled back
      const { worker: reviewer } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "rev",
        role: "verifier",
        backend: "mock",
        workspace_mode: "share",
        brief:
          'Review repo [MOCK:{"writeFile":{"path":"rogue.txt","content":"bad"},"text":"[review_pass]"}]',
      });

      await waitForCondition(() => db.getWorker(swarm.id, "rev")?.state === "error");
      assert.equal(fs.existsSync(path.join(reviewer.workspace_path, "rogue.txt")), false);
      const revTurn = db.getLatestWorkerTurn(swarm.id, "rev")!;
      assert.equal(revTurn.error_kind, "unauthorized_write");

      // Merge author branch cleanly
      const merge = await engine.mergeWorker(swarm.id, "dev");
      assert.equal(merge.ok, true);
      assert.ok(fs.existsSync(path.join(repo, "greet.ts")));
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("preserves files changed outside the engine during readonly review in a shared checkout", async () => {
    const repo = await initTempRepo();
    const db = new PolySwarmDB(makeTempDir("poly-readonly-shared-"));
    const registry = new AdapterRegistry();
    const mock = registry.get("mock");
    let started = false;
    let finish!: () => void;
    const allowFinish = new Promise<void>((resolve) => { finish = resolve; });
    class ReadonlyRegistry extends AdapterRegistry {
      override get(id: BackendId): WorkerAdapter {
        if (id !== "mock") return super.get(id);
        return {
          id: mock.id, capabilities: mock.capabilities,
          buildCommand: mock.buildCommand.bind(mock), checkHealth: mock.checkHealth.bind(mock),
          async runTurn(input) {
            started = true;
            await allowFinish;
            return mock.runTurn(input);
          },
        };
      }
    }
    const engine = new PolySwarmEngine({
      db, config: loadPolySwarmConfig("/nonexistent-path"), registry: new ReadonlyRegistry(),
    });
    try {
      const swarm = await engine.createSwarm({ title: "Concurrent coordinator edits", repo_root: repo });
      await engine.addWorker({
        swarm_id: swarm.id, name: "reviewer", backend: "mock", role: "verifier", workspace_mode: "inherit",
        brief: '[MOCK:{"text":"@coordinator [review_fail] check A"}]',
      });
      await waitForCondition(() => started);
      fs.writeFileSync(path.join(repo, "handoff.md"), "created by coordinator");
      fs.writeFileSync(path.join(repo, "app.ts"), "edited by coordinator");
      finish();
      await waitForCondition(() => db.getWorker(swarm.id, "reviewer")?.state === "waiting");
      assert.equal(fs.readFileSync(path.join(repo, "handoff.md"), "utf8"), "created by coordinator");
      assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf8"), "edited by coordinator");
      const turn = db.getLatestWorkerTurn(swarm.id, "reviewer")!;
      assert.equal(turn.status, "completed");
      assert.ok(db.listTurnEvents(turn.id).some((event) =>
        event.title === "Concurrent Workspace Edits Observed (Preserved)" && event.content?.includes("handoff.md")));
    } finally {
      finish();
      engine.shutdown();
      db.close();
    }
  });

  it("keeps Codex credential errors blocked on peer mentions but accepts an explicit coordinator retry", async () => {
    const repo = await initTempRepo();
    const dir = makeTempDir("poly-codex-credential-block-");
    const cli = path.join(dir, "fake-codex");
    fs.writeFileSync(cli, `#!${process.execPath}
import fs from "node:fs";
if (process.argv.includes("--version")) { process.stdout.write("test\u005cn"); process.exit(0); }
const input = fs.readFileSync(0, "utf8");
if (input.includes("explicit retry after fix")) {
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"recovered"}}) + "\u005cn");
} else {
  process.stderr.write("Missing environment variable: POLY_TEST_KEY.\u005cn");
  process.exit(1);
}
`, { mode: 0o700 });
    const config = loadPolySwarmConfig(path.join(dir, "backends.json"));
    config.backends.codex = { command: cli };
    const db = new PolySwarmDB(dir);
    const engine = new PolySwarmEngine({ db, config });
    try {
      const swarm = await engine.createSwarm({ title: "Missing credential", repo_root: repo });
      await engine.addWorker({ swarm_id: swarm.id, name: "leo", backend: "codex", brief: "start" });
      await waitForCondition(() => db.getWorker(swarm.id, "leo")?.state === "error");
      assert.equal(db.getLatestWorkerTurn(swarm.id, "leo")?.error_kind, "config_error");
      const peer = await engine.postMessage({ swarm_id: swarm.id, sender: "peer", text: "For @leo" });
      assert.deepEqual(peer.woken, []);
      const retry = await engine.postMessage({
        swarm_id: swarm.id, sender: "coordinator", tag: "brief", text: "@leo explicit retry after fix",
      });
      assert.deepEqual(retry.woken, ["leo"]);
      await waitForCondition(() => db.getWorker(swarm.id, "leo")?.state === "waiting");
      assert.equal(db.listWorkerTurns(swarm.id, "leo").length, 2);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("retries Cursor reconnect failure once with a fresh readonly session and never replays writes", async () => {
    const repo = await initTempRepo();
    const dir = makeTempDir("poly-cursor-reconnect-");
    const cli = path.join(dir, "fake-cursor");
    fs.writeFileSync(cli, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("test\u005cn"); process.exit(0); }
const fs = require("node:fs");
const startupMarker = require("node:path").join(__dirname, "cursor-retried");
if (args.some((arg) => arg.includes("synthetic unavailable")) && !fs.existsSync(startupMarker)) {
  fs.writeFileSync(startupMarker, "");
  process.stderr.write("Error: [unavailable]\u005cn");
  process.exit(1);
}
if (args.includes("--resume") || !args.includes("--mode")) {
  process.stderr.write("RetriableError: Agent turn stopped after repeated resume attempts made no progress\u005cn");
  process.exit(1);
}
process.stdout.write(JSON.stringify({type:"result",session_id:"cursor-session",result:"connected"}) + "\u005cn");
`, { mode: 0o700 });
    const config = loadPolySwarmConfig(path.join(dir, "backends.json"));
    config.backends.cursor = { command: cli };
    const db = new PolySwarmDB(dir);
    const engine = new PolySwarmEngine({ db, config });
    try {
      const swarm = await engine.createSwarm({ title: "Cursor connection", repo_root: repo });
      await engine.addWorker({ swarm_id: swarm.id, name: "read", backend: "cursor", role: "researcher", brief: "start with synthetic unavailable", auto_fallback: false });
      await waitForCondition(() => db.getWorker(swarm.id, "read")?.session_id === "cursor-session");
      const [startupRecovered, startupFailure] = db.listWorkerTurns(swarm.id, "read");
      assert.equal(startupFailure?.error_kind, "connection_error");
      assert.equal(startupRecovered?.trigger_seq, startupFailure?.trigger_seq);
      assert.equal(startupRecovered?.backend, "cursor");
      await engine.postMessage({ swarm_id: swarm.id, sender: "coordinator", tag: "brief", text: "@read follow up" });
      await waitForCondition(() => {
        const t = db.listWorkerTurns(swarm.id, "read");
        return t.length === 4 && t[0]?.status === "completed";
      });
      const [fresh, failed] = db.listWorkerTurns(swarm.id, "read");
      assert.equal(failed?.session_id_used, "cursor-session");
      assert.equal(failed?.error_kind, "connection_error");
      assert.equal(fresh?.session_id_used, null);
      assert.equal(fresh?.trigger_seq, failed?.trigger_seq);

      await engine.addWorker({ swarm_id: swarm.id, name: "write", backend: "cursor", role: "author", brief: "start", auto_fallback: true });
      await waitForCondition(() => db.getWorker(swarm.id, "write")?.state === "error");
      assert.equal(db.listWorkerTurns(swarm.id, "write").length, 1);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("routes reviews independently and snapshots write-seat WIP before 429 fallback runs", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-fb-data-");
    const binDir = makeTempDir("poly-fb-bin-");

    // Create two fake CLIs: cursor (returns 429 quota error) and grok (succeeds)
    const fakeCursor = path.join(binDir, "fake-cursor.mjs");
    fs.writeFileSync(
      fakeCursor,
      `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] === "--version") {
  console.log("test 1.0");
  process.exit(0);
}
if (process.argv.includes("--mode")) {
  console.log(JSON.stringify({ type: "result", result: "@coordinator [review_pass] clean" }));
  process.exit(0);
}
fs.writeFileSync("wip.ts", "export const saved = true;\\n");
console.error("HTTP 429 rate limit exceeded / quota exhausted");
process.exit(1);
`,
      { mode: 0o755 },
    );

    const fakeGrok = path.join(binDir, "fake-grok.mjs");
    fs.writeFileSync(
      fakeGrok,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
if (fs.existsSync("wip.ts")) {
  const committed = execFileSync("git", ["show", "HEAD:wip.ts"], { encoding: "utf8" });
  if (committed !== fs.readFileSync("wip.ts", "utf8")) throw new Error("WIP was not committed before takeover");
}
console.log(JSON.stringify({ type: "step_start", session_id: "grok-ses-1" }));
console.log(JSON.stringify({ type: "text", text: "@coordinator [done] rescued by grok" }));
console.log(JSON.stringify({ type: "step_finish", usage: { input_tokens: 50, output_tokens: 20 }, cost_usd: 0.001 }));
`,
      { mode: 0o755 },
    );

    const fakeAgy = path.join(binDir, "fake-agy.mjs");
    fs.writeFileSync(
      fakeAgy,
      `#!/usr/bin/env node
console.log(JSON.stringify({ type: "result", conversation_id: "agy-ses-1", result: "@coordinator [review_pass] clean" }));
`,
      { mode: 0o755 },
    );

    const config: PolySwarmConfig = {
      ...loadPolySwarmConfig("/nonexistent-path"),
      routes: {
        architect: ["agy", "grok", "cursor"],
        author: ["cursor", "grok", "agy"],
        verifier: ["cursor", "agy", "grok"], // Intentionally put cursor first to test exclusion
        research: ["grok", "agy"],
        enterprise: ["agy"],
        fanout: ["grok", "agy"],
      },
      backends: {
        cursor: { command: fakeCursor, defaultEffort: "high" },
        grok: { command: fakeGrok },
        agy: { command: fakeAgy },
        opencode: { enabled: false },
        codex: { enabled: false },
        qoder: { enabled: false },
        codebuddy: { enabled: false },
      },
    };

    const db = new PolySwarmDB(dataDir);
    const engine = new PolySwarmEngine({ db, config });
    try {
      await engine.refreshBackends();
      const swarm = await engine.createSwarm({ title: "Fallback Swarm", repo_root: repo });

      // Cross-vendor verifier check: if author uses 'agy', verifier must NOT pick 'agy' when 'grok' is healthy
      const { worker: a1 } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "author-agy",
        role: "author",
        backend: "agy",
        brief: "do work",
      });
      await waitForCondition(() => db.getWorker(swarm.id, "author-agy")?.state === "waiting");

      const { worker: v1 } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "rev-cross",
        role: "verifier",
        review_of: a1.name,
        brief: "review author-agy",
      });
      assert.notEqual(v1.backend, "agy");
      await waitForCondition(() => db.getWorker(swarm.id, "rev-cross")?.state === "waiting");

      // 429 quota_exhausted on cursor -> auto-fallback to grok
      const { worker: coder } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "coder",
        role: "author",
        backend: "cursor",
        auto_fallback: true,
        brief: "write module",
      });

      await waitForCondition(() => {
        const w = db.getWorker(swarm.id, "coder");
        return w?.state === "error" || (w?.backend === "grok" && w.state === "waiting" &&
          db.getLatestWorkerTurn(swarm.id, "coder")?.status === "completed");
      });

      assert.equal(db.getWorker(swarm.id, "coder")?.state, "waiting", db.getWorker(swarm.id, "coder")?.last_error ?? undefined);
      assert.equal(db.isCoolingDown("cursor"), true);
      const { stdout: saved } = await runGit(coder.workspace_path, ["show", "HEAD:wip.ts"]);
      assert.equal(saved, "export const saved = true;\n");
      assert.equal(fs.existsSync(path.join(repo, "wip.ts")), false);
      assert.equal((await runGit(coder.workspace_path, ["status", "--porcelain"])).stdout, "");
      assert.match((await runGit(coder.workspace_path, ["log", "-1", "--format=%s"])).stdout, /wip handoff snapshot/);
      assert.deepEqual(db.listWorkerTurns(swarm.id, "coder").map((turn) =>
        [turn.backend, turn.effort, turn.error_kind]), [
        ["grok", null, "none"], ["cursor", "high", "quota_exhausted"],
      ]);
      const boardMsgs = db.readBoardMessages({ swarm_id: swarm.id, since: 0 });
      assert.ok(boardMsgs.some((m) => m.text.includes("rescued by grok")));
      assert.ok(boardMsgs.some((m) => m.text.includes("auto-switched to 'grok'")));
      const dash = await engine.getDashboardSnapshot(swarm.id);
      assert.deepEqual(dash.secondment_history?.map((r) =>
        [r.worker_name, r.from_backend, r.to_backend, r.auto, r.reason]), [
        ["coder", "cursor", "grok", true, "quota_exhausted"],
      ]);
      assert.equal(dash.deliverables?.coder?.dirty, false);
      assert.equal(dash.deliverables?.coder?.target_branch, "main");
      assert.ok(dash.blackboard_messages?.some((m) => m.tag === "done" && m.sender === "coder"));
      assert.ok(!dash.blackboard_messages?.some((m) => m.tag === "system"));
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("reports G1/G2/G4/G6 and blocks same-vendor reviewer dispatch, manual switch and 429 fallback", async () => {
    const dir = makeTempDir("poly-g6-");
    const quota = path.join(dir, "quota");
    fs.writeFileSync(quota, '#!/bin/sh\nif [ "$1" = --version ]; then echo "test 1.0"; exit 0; fi\necho "HTTP 429 quota exhausted" >&2\nexit 1\n', {
      mode: 0o700,
    });
    const config = loadPolySwarmConfig(path.join(dir, "backends.json"));
    config.routes.verifier = ["cursor", "codex", "opencode", "agy", "grok", "codebuddy"];
    config.backends = {
      ...Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
      codex: { command: quota, defaultModel: "gpt-6.2-sol" },
      cursor: { command: quota, defaultModel: "openai/gpt-6.2-sol" },
      opencode: { command: quota, defaultModel: "deepseek-v4-pro" },
      agy: { command: quota, defaultModel: "gemini-3.8-flash" },
      grok: { command: quota, defaultModel: "grok-4", defaultEffort: "high" },
      codebuddy: { enabled: false, defaultModel: "kimi-k3.1-pro" },
    };
    const db = new PolySwarmDB(dir);
    const engine = new PolySwarmEngine({ db, config });
    try {
      await engine.refreshBackends();
      const swarm = await engine.createSwarm({ title: "G6", repo_root: dir });
      db.addWorker({
        swarm_id: swarm.id, name: "dev", role: "author", capability: "author",
        backend: "codex", model: "gpt-6.2-sol", workspace_mode: "inherit", workspace_path: dir,
      });
      const input = { swarmId: swarm.id, capability: "verifier", reviewOf: "@DEV" } as const;
      const review = { swarm_id: swarm.id, name: "reviewer", role: "verifier", review_of: "dev", brief: "review" } as const;
      db.setBackendCooldown("agy", Date.now() + 60_000, "test");

      const candidates = await engine.evaluateCandidates(input);
      assert.deepEqual(candidates.map((c) => [c.backend, c.gate_failures.map((g) => g.gate)]), [
        ["cursor", ["G6"]], ["codex", ["G6"]], ["opencode", ["G4"]], ["agy", ["G2"]],
        ["grok", []], ["codebuddy", ["G1"]],
      ]);
      assert.deepEqual(candidates.filter((c) => c.recommended).map((c) =>
        [c.backend, c.model, c.effort, c.vendor_family]), [["grok", "grok-4", "high", "xai"]]);
      assert.equal(candidates[0]?.vendor_family, "openai");
      assert.equal(candidates[0]?.eligible, false);
      assert.ok(candidates[0]?.reasons[0]?.includes("@dev"));
      assert.equal(db.listWorkers(swarm.id).length, 1);
      await assert.rejects(engine.addWorker({ ...review, backend: "cursor" }), /G6.*@dev/);
      assert.equal(db.getWorker(swarm.id, review.name), null);

      const { worker } = await engine.addWorker(review);
      assert.equal(worker.backend, "grok");
      await waitForCondition(() => db.getWorker(swarm.id, review.name)?.state === "error");
      const turns = db.listWorkerTurns(swarm.id, review.name);
      assert.deepEqual(turns.map((turn) => [turn.backend, turn.mode, turn.error_kind]), [
        ["grok", "readonly", "quota_exhausted"],
      ]);
      assert.match(db.getWorker(swarm.id, review.name)?.last_error ?? "", /No independent cross-vendor/);
      assert.ok(db.readBoardTail(swarm.id).some((m) => m.tag === "blocked" && m.suppress_wake === 1));
      const exhausted = await engine.evaluateCandidates(input);
      assert.ok(exhausted.every((c) => !c.eligible && !c.recommended));
      await assert.rejects(engine.addWorker({ ...review, name: "second-review" }), /No independent cross-vendor/);
      await assert.rejects(engine.switchWorkerBackend({
        swarm_id: swarm.id, name: review.name, backend: "cursor",
      }), /G6.*@dev/);
      assert.equal(db.getWorker(swarm.id, review.name)?.backend, "grok");
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("rejects swarm mutations and scheduling after finishing while keeping the board readable", async () => {
    const dir = makeTempDir("poly-readonly-");
    const db = new PolySwarmDB(dir);
    const engine = new PolySwarmEngine({ db, config: loadPolySwarmConfig(path.join(dir, "backends.json")) });
    try {
      const swarm = await engine.createSwarm({ title: "Finished", repo_root: dir });
      const id = swarm.id;
      const name = "dev";
      assert.equal(engine.assertSwarmWritable(id).id, id);
      assert.throws(() => engine.assertSwarmWritable("missing"), /not found/);
      db.addWorker({
        swarm_id: id, name, role: "author", capability: "author",
        backend: "mock", workspace_mode: "inherit", workspace_path: dir,
      });
      await engine.finishSwarm(id, "finished @dev");
      const [finished] = db.readBoardTail(id);
      assert.equal(db.getSwarm(id)?.status, "done");
      assert.equal(finished?.tag, "done");
      assert.equal(finished?.suppress_wake, 1);
      assert.throws(() => engine.assertSwarmWritable(id), /done and read-only/);
      assert.throws(() => engine.cancelWorkerTurn(id, name), /read-only/);
      for (const mutate of [
        () => engine.postMessage({ swarm_id: id, sender: "coordinator", text: "@dev wake" }),
        () => engine.addWorker({ swarm_id: id, name: "second", backend: "mock", brief: "work" }),
        () => engine.switchWorkerBackend({ swarm_id: id, name, backend: "grok" }),
        () => engine.mergeWorker(id, name),
        () => engine.killWorker(id, name),
        () => engine.updateDispatchPolicy({ scope: "session", swarm_id: id, reset: true }),
        () => engine.finishSwarm(id),
      ]) {
        await assert.rejects(mutate, /read-only/);
      }
      engine.scheduleWorkerRun(id, name, finished!.seq);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(db.listWorkerTurns(id, name), []);
      assert.deepEqual(db.readBoardTail(id), [finished]);
      assert.equal(db.getWorker(id, name)?.state, "waiting");
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("lets claimed dispatches wait for a global slot without reporting an unanswered mention", async () => {
    const repo = await initTempRepo();
    const db = new PolySwarmDB(makeTempDir("poly-watchdog-queue-"));
    const engine = new PolySwarmEngine({
      db,
      config: { ...loadPolySwarmConfig("/nonexistent-path"), maxConcurrency: 1, stallThresholdMs: 50 },
    });
    const watchdog = new StallWatchdog(engine);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = engine.runWithConcurrencySlot(() => hold);
    try {
      const swarm = await engine.createSwarm({ title: "Queued dispatch", repo_root: repo });
      db.addWorker({
        swarm_id: swarm.id, name: "queued", role: "researcher", capability: "research",
        backend: "mock", workspace_mode: "inherit", workspace_path: repo,
      });
      const { message } = await engine.postMessage({
        swarm_id: swarm.id, sender: "coordinator", tag: "brief",
        text: '@queued [MOCK:{"text":"[done] answered after a slot opened"}]',
      });
      assert.equal(db.getWorker(swarm.id, "queued")?.state, "waiting");
      assert.equal(db.getPendingDispatch(swarm.id, "queued")?.status, "claimed");
      assert.equal(db.listWorkerTurns(swarm.id, "queued").length, 0);
      await engine.postMessage({
        swarm_id: swarm.id, sender: "coordinator", tag: "update", text: "The dispatch is waiting for a slot.",
      });
      assert.deepEqual(await watchdog.tick(Date.now() + 100), []);
      release();
      await inFlight;
      await waitForCondition(() => db.listWorkerTurns(swarm.id, "queued").some((turn) => turn.status === "completed"));
      assert.equal(db.listWorkerTurns(swarm.id, "queued")[0]?.trigger_seq, message.seq);
      assert.equal(db.readBoardTail(swarm.id, 10).some((item) => item.sender === "watchdog"), false);
    } finally {
      release();
      await inFlight;
      engine.shutdown();
      db.close();
    }
  });

  it("alerts once on stalled swarm via StallWatchdog and executes multi-phase WorkflowRunner", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-wf-data-");
    const db = new PolySwarmDB(dataDir);
    const config: PolySwarmConfig = {
      ...loadPolySwarmConfig("/nonexistent-path"),
      stallThresholdMs: 50,
    };
    const engine = new PolySwarmEngine({ db, config });
    const watchdog = new StallWatchdog(engine);

    try {
      const swarm = await engine.createSwarm({ title: "Stall & Workflow", repo_root: repo });
      db.addWorker({
        swarm_id: swarm.id,
        name: "w1",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: repo,
      });
      // Post an unaddressed message that nobody owns and backdate it past stallThresholdMs
      const { message } = db.postBoardMessage({
        swarm_id: swarm.id,
        sender: "w1",
        tag: "update",
        text: "Finished step without tagging anyone",
      });
      db.db
        .prepare("UPDATE board_messages SET created_at = ? WHERE seq = ?")
        .run(Date.now() - 5000, message.seq);

      const alerts1 = await watchdog.tick();
      assert.equal(alerts1.length, 1);
      assert.ok(alerts1[0]!.reason.includes("[stall]"));

      // Second tick on same board head must deduplicate
      const alerts2 = await watchdog.tick();
      assert.equal(alerts2.length, 0);

      // Run 2-phase workflow with template interpolation and JSON Schema validation
      const runner = new WorkflowRunner(engine);
      const wfOk = await runner.run({
        description: "Parallel reviews then JSON summary",
        swarm_id: swarm.id,
        phases: [
          {
            name: "Parallel Review",
            mode: "parallel",
            steps: [
              { id: "r1", backend: "mock", prompt: '[MOCK:{"text":"issue A"}]' },
              { id: "r2", backend: "mock", prompt: '[MOCK:{"text":"issue B"}]' },
            ],
          },
          {
            name: "Synthesize",
            mode: "pipeline",
            steps: [
              {
                id: "summary",
                backend: "mock",
                prompt:
                  'Combine {{r1}} and {{r2}} [MOCK:{"text":"{\\"issues\\": [\\"issue A\\", \\"issue B\\"], \\"count\\": 2}"}]',
                json_schema: {
                  type: "object",
                  required: ["issues", "count"],
                  properties: {
                    issues: { type: "array", items: { type: "string" } },
                    count: { type: "integer" },
                  },
                },
              },
            ],
          },
        ],
      });
      assert.equal(wfOk.status, "completed");
      const parsed = JSON.parse(wfOk.results_json || "{}") as { summary: { count: number } };
      assert.equal(parsed.summary.count, 2);

      // Failing schema validation must mark workflow as failed
      const wfBad = await runner.run({
        description: "Bad schema test",
        swarm_id: swarm.id,
        phases: [
          {
            name: "Single",
            mode: "pipeline",
            steps: [
              {
                id: "bad",
                backend: "mock",
                prompt: '[MOCK:{"text":"{\\"count\\": \\"not-an-int\\"}"}]',
                json_schema: {
                  type: "object",
                  required: ["count"],
                  properties: { count: { type: "integer" } },
                },
              },
            ],
          },
        ],
      });
      assert.equal(wfBad.status, "failed");
      assert.ok(wfBad.error?.includes("schema validation failed"));
      assert.equal(db.getSwarm(swarm.id)?.status, "active");

      const standalone = await runner.run({
        description: "Run a team review without a wave ID",
        team_id: swarm.team_id!,
        repo_root: repo,
        phases: [{
          name: "Review", mode: "pipeline",
          steps: [{ id: "r1", backend: "mock", prompt: '[MOCK:{"text":"Reviewed"}]' }],
        }],
      });
      const workflowSwarm = db.getSwarm(standalone.swarm_id!);
      assert.equal(standalone.status, "completed");
      assert.equal(workflowSwarm?.auto_created_by_workflow, 1);
      assert.equal(workflowSwarm?.status, "done");
      assert.equal(db.getTeam(swarm.team_id!)?.active_swarm_id, swarm.id);
      assert.equal(engine.resolveSessionTarget({ repoRoot: repo }).swarm?.id, swarm.id);
    } finally {
      watchdog.stop();
      engine.shutdown();
      db.close();
    }
  });

  it("enforces readonly mode for researcher, persists backend config updates, and gates workbench_alive by surface", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-cfg-data-");
    const cfgPath = path.join(dataDir, "backends.json");
    const db = new PolySwarmDB(dataDir);
    const config = loadPolySwarmConfig(cfgPath);
    const engine = new PolySwarmEngine({ db, config });

    try {
      const swarm = await engine.createSwarm({ title: "Cfg & Readonly", repo_root: repo });
      // Researcher attempting write must be caught and rolled back
      const { worker: researcher } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "res1",
        role: "researcher",
        backend: "mock",
        workspace_mode: "share",
        brief: 'Inspect [MOCK:{"writeFile":{"path":"bad.txt","content":"nope"},"text":"done"}]',
      });
      await waitForCondition(() => db.getWorker(swarm.id, "res1")?.state === "error");
      assert.equal(fs.existsSync(path.join(researcher.workspace_path, "bad.txt")), false);

      // Update backend config & persist
      const updated = await engine.updateBackendConfigs([
        { backend: "codebuddy", enabled: true, defaultModel: "hy4flash-free", defaultEffort: "high" },
        { backend: "qoder", enabled: false },
      ]);
      assert.equal(updated.codebuddy?.defaultModel, "hy4flash-free");
      assert.equal(updated.codebuddy?.defaultEffort, "high");
      assert.equal(updated.qoder?.enabled, false);
      assert.ok(fs.existsSync(cfgPath));

      const reloaded = loadPolySwarmConfig(cfgPath);
      assert.equal(reloaded.backends.codebuddy?.defaultModel, "hy4flash-free");
      assert.equal(reloaded.backends.codebuddy?.defaultEffort, "high");
      assert.equal(reloaded.backends.qoder?.enabled, false);

      await assert.rejects(
        () =>
          engine.addWorker({
            swarm_id: swarm.id,
            name: "q1",
            backend: "qoder",
            brief: "test disabled",
          }),
        /disabled/,
      );

      // global surface should NOT mark workbench_alive
      const globalSnap = await engine.getDashboardSnapshot(swarm.id, { surface: "global" });
      assert.equal(globalSnap.ui_focus.workbench_alive, false);
      assert.equal(globalSnap.backend_configs.codebuddy?.defaultModel, "hy4flash-free");

      const wbSnap = await engine.getDashboardSnapshot(swarm.id, { surface: "workbench" });
      assert.equal(wbSnap.ui_focus.workbench_alive, true);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("keeps in-memory backend config clean and removes temp files when atomic config save fails", async () => {
    const dataDir = makeTempDir("poly-cfg-fail-data-");
    const cfgDir = makeTempDir("poly-cfg-fail-dir-");
    const cfgAsDirPath = path.join(cfgDir, "backends.json");
    // Create a directory at target file path so writeFileSync succeeds and renameSync fails
    fs.mkdirSync(cfgAsDirPath);

    const db = new PolySwarmDB(dataDir);
    const config = loadPolySwarmConfig(path.join(cfgDir, "initial-missing.json"));
    config.configPath = cfgAsDirPath;
    config.backends.codebuddy = { enabled: true, defaultModel: "hy4flash-free" };
    const engine = new PolySwarmEngine({ db, config });

    try {
      await assert.rejects(
        () =>
          engine.updateBackendConfigs([
            { backend: "codebuddy", enabled: false, defaultModel: "wrong-model" },
          ]),
      );
      assert.equal(engine.config.backends.codebuddy?.enabled, true);
      assert.equal(engine.config.backends.codebuddy?.defaultModel, "hy4flash-free");
      const leftoverTmp = fs.readdirSync(cfgDir).filter((f) => f.endsWith(".tmp"));
      assert.deepEqual(leftoverTmp, []);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("isolates uiFocus per swarm_id, suppresses wake on suppressWake system posts, and detects waiting stall per worker", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-iso-data-");
    const db = new PolySwarmDB(dataDir);
    const config: PolySwarmConfig = {
      ...loadPolySwarmConfig("/nonexistent-path"),
      stallThresholdMs: 30,
    };
    const engine = new PolySwarmEngine({ db, config });
    const watchdog = new StallWatchdog(engine);

    try {
      const swA = await engine.createSwarm({ title: "Swarm A", repo_root: repo });
      const swB = await engine.createSwarm({ title: "Swarm B", repo_root: repo });

      // Default snapshot without swarm_id MUST NOT auto-select Swarm A or Swarm B
      const blankSnap = await engine.getDashboardSnapshot(null, { surface: "workbench" });
      assert.equal(blankSnap.swarm, null);
      assert.equal(blankSnap.swarms.length, 2);

      // With autoSelectLatest: true, returns latest swarm
      const latestSnap = await engine.getDashboardSnapshot(null, { autoSelectLatest: true });
      assert.equal(latestSnap.swarm?.id, swB.id);

      // Cross-swarm focus & heartbeat isolation
      engine.recordWorkbenchHeartbeat(swA.id);
      engine.setUiFocus({ swarm_id: swA.id, worker_name: "w-a", tab: "board" });
      const focusA = engine.getUiFocus(swA.id);
      const focusB = engine.getUiFocus(swB.id);
      assert.equal(focusA.worker_name, "w-a");
      assert.equal(focusA.workbench_alive, true);
      assert.equal(focusB.worker_name, null);
      assert.equal(focusB.workbench_alive, false);

      // suppressWake prevents triggering worker runs
      db.addWorker({
        swarm_id: swA.id,
        name: "w-a",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: repo,
      });
      const sysRes = await engine.postMessage({
        swarm_id: swA.id,
        sender: "coordinator",
        tag: "system",
        text: "[switch] @w-a switched",
        suppressWake: true,
      });
      assert.deepEqual(sysRes.woken, []);
      assert.equal(db.listWorkerTurns(swA.id, "w-a").length, 0);

      // Watchdog: even if w-busy is working, waiting worker w-a with unanswered aged @w-a triggers alert without erroring
      db.addWorker({
        swarm_id: swA.id,
        name: "w-busy",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: repo,
      });
      db.updateWorkerState(swA.id, "w-busy", "working", null);
      const mPing = db.postBoardMessage({
        swarm_id: swA.id,
        sender: "coordinator",
        tag: "update",
        text: "@w-a please respond",
      });
      db.db
        .prepare("UPDATE board_messages SET created_at = ? WHERE seq = ?")
        .run(Date.now() - 5000, mPing.message.seq);

      const alerts = await watchdog.tick();
      assert.equal(alerts.length, 1);
      assert.ok(alerts[0]!.reason.includes("w-a"));
      assert.equal(db.listWorkerTurns(swA.id, "w-a").length, 0);

      // Aged suppressWake post must NOT trigger false stall alert
      const supPost = await engine.postMessage({
        swarm_id: swA.id,
        sender: "coordinator",
        tag: "system",
        text: "[switch] @w-a switched silently",
        suppressWake: true,
      });
      db.db
        .prepare("UPDATE board_messages SET created_at = ? WHERE seq = ?")
        .run(Date.now() - 5000, supPost.message.seq);
      const alertsAfterSup = await watchdog.tick();
      assert.equal(alertsAfterSup.length, 0);
    } finally {
      watchdog.stop();
      engine.shutdown();
      db.close();
    }
  });

  it("enforces UTF-8 byte cap, rejects non-strict-readonly backends for readonly roles, and enforces workflow pool & cancel", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-p0-data-");
    const db = new PolySwarmDB(dataDir);
    const config: PolySwarmConfig = {
      ...loadPolySwarmConfig("/nonexistent-path"),
      maxConcurrency: 1,
    };
    const engine = new PolySwarmEngine({ db, config });

    try {
      const swarm = await engine.createSwarm({ title: "P0 Guard", repo_root: repo });

      // UTF-8 byte truncation never exceeds byte budget on 3-byte CJK chars
      const cjkSample = "中文边界测试".repeat(5000);
      const cut = truncateUtf8Bytes(cjkSample, 1024, "...[cut]");
      assert.ok(Buffer.byteLength(cut, "utf8") <= 1024);

      const longMsg = "汉".repeat(50_000);
      const { prompt } = (
        engine as unknown as {
          buildWorkerPrompt: (
            s: typeof swarm,
            w: ReturnType<typeof db.addWorker>,
            t?: ReturnType<typeof db.postBoardMessage>["message"],
          ) => { prompt: string; maxSeqSeen: number };
        }
      ).buildWorkerPrompt(
        swarm,
        db.addWorker({
          swarm_id: swarm.id,
          name: "w-cjk",
          role: "author",
          capability: "author",
          backend: "mock",
          workspace_mode: "inherit",
          workspace_path: repo,
        }),
        db.postBoardMessage({
          swarm_id: swarm.id,
          sender: "coordinator",
          text: longMsg,
        }).message,
      );
      assert.ok(Buffer.byteLength(prompt, "utf8") <= 96 * 1024);

      // opencode lacks strict readonly enforcement -> rejected for researcher/verifier
      await assert.rejects(
        () =>
          engine.addWorker({
            swarm_id: swarm.id,
            name: "ro-oc",
            role: "researcher",
            backend: "opencode",
            brief: "inspect",
          }),
        /strict readonly/,
      );

      const runner = new WorkflowRunner(engine);
      // Workflow write steps disabled in v0.5
      await assert.rejects(
        () =>
          runner.run({
            description: "Write step blocked",
            swarm_id: swarm.id,
            phases: [
              {
                name: "Write",
                mode: "pipeline",
                steps: [{ id: "w1", backend: "mock", readonly: false, prompt: "edit" }],
              },
            ],
          }),
        /disabled in v0\.5/,
      );

      // Parallel phase failure cancels sibling running steps and retains succeeded step output
      const startedAt = Date.now();
      const wfCancel = await runner.run({
        description: "Parallel cancel test",
        swarm_id: swarm.id,
        phases: [
          {
            name: "Parallel",
            mode: "parallel",
            steps: [
              { id: "fast-ok", backend: "mock", prompt: '[MOCK:{"text":"ok1"}]' },
              {
                id: "fast-fail",
                backend: "mock",
                prompt: '[MOCK:{"errorKind":"unknown","errorMessage":"boom"}]',
              },
              {
                id: "slow-cancel",
                backend: "mock",
                prompt: '[MOCK:{"sleepMs":4000,"text":"too slow"}]',
              },
            ],
          },
        ],
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(wfCancel.status, "failed");
      assert.ok(elapsed < 3000, `Expected aborted slow step quickly, took ${elapsed}ms`);
      const partial = JSON.parse(wfCancel.results_json || "{}") as Record<string, unknown>;
      assert.equal(partial["fast-ok"], "ok1");
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("applies four-layer weighted policy (project disable + session identity prompt append) inside engine execution", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-pol-eng-");
    const db = new PolySwarmDB(dataDir);
    const cfgPath = path.join(dataDir, "backends.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        backends: {
          agy: { enabled: false },
          cursor: { enabled: false },
          grok: { enabled: false },
          opencode: { enabled: false },
          codex: { enabled: false },
          codebuddy: { enabled: false },
        },
        identities: {
          "sec-audit": {
            label: "安全审计",
            base_role: "verifier",
            capability: "verifier",
            system_prompt: "L2 base security rule.",
          },
        },
      }),
      "utf8",
    );
    const config = loadPolySwarmConfig(cfgPath);
    const engine = new PolySwarmEngine({ db, config });

    try {
      await engine.refreshBackends(true);
      const swarm = await engine.createSwarm({ title: "Policy Execution", repo_root: repo });
      // Project layer disables mock? No, disable qoder & append prompt on sec-audit
      await engine.updateDispatchPolicy({
        scope: "project",
        repo_root: repo,
        patch: {
          backends: { qoder: { enabled: false } },
          identities: {
            "sec-audit": {
              prompt_mode: "append",
              system_prompt: "L3 project checklist.",
            },
          },
        },
      });
      await engine.updateDispatchPolicy({
        scope: "session",
        swarm_id: swarm.id,
        patch: {
          identities: {
            "sec-audit": {
              preferred_backends: ["mock"],
              model: "mock-sec-v2",
              skill_paths: [".agents/skills/code-review/SKILL.md"],
            },
          },
        },
      });

      // Adding worker using disabled backend in project layer fails
      await assert.rejects(
        () =>
          engine.addWorker({
            swarm_id: swarm.id,
            name: "blocked-qoder",
            role: "author",
            backend: "qoder",
            brief: "test",
          }),
        /disabled in Poly Swarm policy \(project\)/,
      );

      // Adding worker with custom identity picks preferred backend/model and injects merged prompt
      const { worker } = await engine.addWorker({
        swarm_id: swarm.id,
        name: "auditor",
        identity: "sec-audit",
        brief: '[MOCK:{"text":"@coordinator [review_pass] ok"}]',
      });
      assert.equal(worker.backend, "mock");
      assert.equal(worker.model, "mock-sec-v2");
      assert.equal(worker.identity_id, "sec-audit");
      assert.equal(worker.role, "verifier");
      assert.equal(worker.policy_source, "session");

      await waitForCondition(() => db.getWorker(swarm.id, "auditor")?.state === "waiting");
      const turn = db.getLatestWorkerTurn(swarm.id, "auditor")!;
      assert.ok(turn.prompt_preview.includes("L2 base security rule."));
      assert.ok(turn.prompt_preview.includes("L3 project checklist."));
      assert.ok(turn.prompt_preview.includes(".agents/skills/code-review/SKILL.md"));
      assert.ok(turn.prompt_preview.includes("STRICT READONLY VERIFIER RULE"));

      await engine.addWorker({ swarm_id: swarm.id, name: "researcher", role: "researcher", backend: "mock", brief: "Summarize the code." });
      await waitForCondition(() => db.getWorker(swarm.id, "researcher")?.state === "waiting");
      assert.equal(db.getLatestWorkerTurn(swarm.id, "researcher")?.prompt_preview.includes("code-review/SKILL.md"), false);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("preserves readonly codex researcher output and committed files when git HEAD advances mid-turn", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-head-data-");
    const binDir = makeTempDir("poly-eng-head-bin-");
    const startedFile = path.join(dataDir, "worker-started.flag");
    const releaseFile = path.join(dataDir, "worker-release.flag");

    const fakeCodex = path.join(binDir, "fake-codex.mjs");
    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.171.0-mock");
  process.exit(0);
}
if (!process.argv.includes('approval_policy="never"')) {
  console.error("missing approval_policy=never");
  process.exit(2);
}
fs.writeFileSync(process.env.POLY_TEST_STARTED_FILE, "1", "utf8");
const deadline = Date.now() + 4000;
while (!fs.existsSync(process.env.POLY_TEST_RELEASE_FILE) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15));
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "th-ro-1" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "@coordinator [done] readonly audit completed" },
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
}));
`,
      { mode: 0o755 },
    );

    const db = new PolySwarmDB(dataDir);
    const config: PolySwarmConfig = {
      ...loadPolySwarmConfig("/nonexistent-path"),
      backends: {
        codex: {
          command: fakeCodex,
          env: {
            POLY_TEST_STARTED_FILE: startedFile,
            POLY_TEST_RELEASE_FILE: releaseFile,
          },
        },
      },
    };
    const engine = new PolySwarmEngine({ db, config });

    try {
      await engine.refreshBackends(true);
      const swarm = await engine.createSwarm({ title: "Concurrent Commit Guard", repo_root: repo });
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "codex-researcher",
        role: "researcher",
        backend: "codex",
        workspace_mode: "inherit",
        brief: "Inspect repository while external commits happen",
      });

      await waitForCondition(() => fs.existsSync(startedFile));
      fs.writeFileSync(path.join(repo, "committed.ts"), "export const ok = true;\n", "utf8");
      await runGit(repo, ["add", "committed.ts"]);
      await runGit(repo, ["commit", "-m", "external concurrent commit"]);
      fs.writeFileSync(releaseFile, "go", "utf8");

      await waitForCondition(() => db.getWorker(swarm.id, "codex-researcher")?.state === "waiting");
      const turn = db.getLatestWorkerTurn(swarm.id, "codex-researcher")!;
      assert.equal(turn.status, "completed");
      assert.equal(turn.error_kind, "none");
      assert.equal(fs.readFileSync(path.join(repo, "committed.ts"), "utf8"), "export const ok = true;\n");

      const events = db.listTurnEvents(turn.id);
      assert.ok(events.some((ev) => ev.kind === "system" && ev.title === "Concurrent Git HEAD Changed — Rollback Skipped"));
      const msgs = db.readBoardTail(swarm.id);
      assert.ok(msgs.some((m) => m.tag === "done" && m.text.includes("readonly audit completed")));
      assert.equal(msgs.some((m) => m.text.includes("unauthorized_write")), false);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("resumes pending dispatches on restart while warning instead of re-running uncertain write dispatches", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-resume-data-");
    let swarmId = "";

    const db1 = new PolySwarmDB(dataDir);
    try {
      const swarm = db1.createSwarm({ title: "Restart Recovery", repo_root: repo });
      swarmId = swarm.id;
      db1.addWorker({
        swarm_id: swarm.id,
        name: "ro-resume",
        role: "researcher",
        capability: "research",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: repo,
      });
      db1.addWorker({
        swarm_id: swarm.id,
        name: "wr-uncertain",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: repo,
      });
      db1.registerInstance("inst-dead-crash", 999999, Date.now() - 10_000);
      db1.postBoardMessageWithWakes(
        {
          swarm_id: swarm.id,
          sender: "coordinator",
          tag: "brief",
          text: '@ro-resume [MOCK:{"text":"@coordinator [done] resumed readonly"}] @wr-uncertain [MOCK:{"text":"should not rerun"}]',
        },
        ["ro-resume", "wr-uncertain"],
      );
      // Mark write task as claimed by crashed instance
      db1.claimPendingDispatch(swarm.id, "wr-uncertain", "inst-dead-crash");
    } finally {
      db1.close();
    }

    const db2 = new PolySwarmDB(dataDir);
    const engine = new PolySwarmEngine({ db: db2, config: loadPolySwarmConfig("/nonexistent-path") });
    try {
      await waitForCondition(
        () =>
          db2.listWorkerTurns(swarmId, "ro-resume").some((t) => t.status === "completed") &&
          db2.readBoardTail(swarmId, 20).some((m) => m.text.includes("[recovery]")),
      );
      assert.equal(db2.listWorkerTurns(swarmId, "wr-uncertain").length, 0);
      assert.equal(db2.getPendingDispatch(swarmId, "ro-resume"), null);
      assert.equal(db2.getPendingDispatch(swarmId, "wr-uncertain"), null);
    } finally {
      engine.shutdown();
      db2.close();
    }
  });

  it("delivers triggerMessage past >80 mixed-channel backlog and holds last_read_seq before omitted visible seqs", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-prompt-");
    const db = new PolySwarmDB(dataDir);
    const capturedPrompts: string[] = [];
    const registry = new AdapterRegistry();
    const baseMock = registry.get("mock");
    const spyMock: WorkerAdapter = {
      id: baseMock.id,
      capabilities: baseMock.capabilities,
      buildCommand: baseMock.buildCommand.bind(baseMock),
      checkHealth: baseMock.checkHealth.bind(baseMock),
      async runTurn(input: AdapterRunInput) {
        capturedPrompts.push(input.prompt);
        return baseMock.runTurn(input);
      },
    };
    class SpyRegistry extends AdapterRegistry {
      override get(id: BackendId): WorkerAdapter {
        return id === "mock" ? spyMock : super.get(id);
      }
    }

    const engine = new PolySwarmEngine({
      db,
      config: loadPolySwarmConfig("/nonexistent-path"),
      registry: new SpyRegistry(),
    });
    try {
      const swarm = await engine.createSwarm({ title: "Backlog Prompt Test", repo_root: repo });
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "fe",
        role: "author",
        backend: "mock",
        workspace_mode: "inherit",
        channels: ["frontend"],
        brief: '[MOCK:{"text":"@coordinator [done] initial ok"}]',
      });
      await waitForCondition(() => db.getWorker(swarm.id, "fe")?.state === "waiting");
      capturedPrompts.length = 0;

      // Flood 50 #backend noise + 45 large #frontend messages (>100 KiB total), silently via DB
      for (let i = 0; i < 50; i++) {
        db.postBoardMessage({
          swarm_id: swarm.id,
          sender: "coordinator",
          channel: "backend",
          tag: "update",
          text: `Noise backend msg ${i}`,
        });
      }
      const frontendSeqs: number[] = [];
      for (let i = 0; i < 45; i++) {
        const msg = db.postBoardMessage({
          swarm_id: swarm.id,
          sender: "coordinator",
          channel: "frontend",
          tag: "update",
          text: `Frontend context #${i}: ` + "详情数据 ".repeat(450),
        }).message;
        frontendSeqs.push(msg.seq);
      }
      const triggerPost = await engine.postMessage({
        swarm_id: swarm.id,
        sender: "coordinator",
        channel: "frontend",
        tag: "brief",
        text: '@fe MUST_DELIVER_TRIGGER [MOCK:{"text":"@coordinator [done] trigger delivered"}]',
      });
      await waitForCondition(() => capturedPrompts.length >= 1 && db.getWorker(swarm.id, "fe")?.state === "waiting");
      const deliveredPrompt = capturedPrompts[0]!;
      assert.ok(deliveredPrompt.includes(`Current Trigger Message (#${triggerPost.message.seq}):`));
      assert.ok(deliveredPrompt.includes("MUST_DELIVER_TRIGGER"));
      assert.ok(deliveredPrompt.includes("Omitted earlier board message seqs"));
      const workerAfter = db.getWorker(swarm.id, "fe")!;
      assert.ok(workerAfter.last_read_seq < frontendSeqs[0]!);
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("serializes same-path inherit writes via mutex and skips rollback when internal writer overlaps readonly turn", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-mutex-");
    const db = new PolySwarmDB(dataDir);
    let inFlightWrites = 0;
    let maxConcurrentWrites = 0;
    const registry = new AdapterRegistry();
    const baseMock = registry.get("mock");
    const wrappedMock: WorkerAdapter = {
      id: baseMock.id,
      capabilities: baseMock.capabilities,
      buildCommand: baseMock.buildCommand.bind(baseMock),
      checkHealth: baseMock.checkHealth.bind(baseMock),
      async runTurn(input: AdapterRunInput) {
        if (input.mode === "write") {
          inFlightWrites += 1;
          maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites);
          try {
            return await baseMock.runTurn(input);
          } finally {
            inFlightWrites -= 1;
          }
        }
        return baseMock.runTurn(input);
      },
    };
    class MutexSpyRegistry extends AdapterRegistry {
      override get(id: BackendId): WorkerAdapter {
        return id === "mock" ? wrappedMock : super.get(id);
      }
    }

    const engine = new PolySwarmEngine({
      db,
      config: loadPolySwarmConfig("/nonexistent-path"),
      registry: new MutexSpyRegistry(),
    });
    try {
      const swarm = await engine.createSwarm({ title: "Inherit Mutex Guard", repo_root: repo });
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "w1",
        role: "author",
        backend: "mock",
        workspace_mode: "inherit",
        brief: '[MOCK:{"writeFile":{"path":"shared-w1.txt","content":"by-w1\\n"},"sleepMs":150,"text":"@coordinator [done] w1"}]',
      });
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "w2",
        role: "author",
        backend: "mock",
        workspace_mode: "inherit",
        brief: '[MOCK:{"writeFile":{"path":"shared-w2.txt","content":"by-w2\\n"},"sleepMs":150,"text":"@coordinator [done] w2"}]',
      });
      await engine.addWorker({
        swarm_id: swarm.id,
        name: "ro-observer",
        role: "verifier",
        backend: "mock",
        workspace_mode: "inherit",
        brief: '[MOCK:{"sleepMs":320,"text":"@coordinator [review_pass] observed"}]',
      });

      await waitForCondition(
        () =>
          db.getWorker(swarm.id, "w1")?.state === "waiting" &&
          db.getWorker(swarm.id, "w2")?.state === "waiting" &&
          db.getWorker(swarm.id, "ro-observer")?.state === "waiting",
        8000,
      );

      assert.equal(maxConcurrentWrites, 1);
      assert.equal(fs.readFileSync(path.join(repo, "shared-w1.txt"), "utf8"), "by-w1\n");
      assert.equal(fs.readFileSync(path.join(repo, "shared-w2.txt"), "utf8"), "by-w2\n");

      const roTurn = db.getLatestWorkerTurn(swarm.id, "ro-observer")!;
      assert.equal(roTurn.status, "completed");
      assert.equal(roTurn.error_kind, "none");
      const roEvents = db.listTurnEvents(roTurn.id);
      assert.ok(
        roEvents.some(
          (ev) => ev.kind === "system" && ev.title === "Concurrent Internal Writer in Shared Workspace",
        ),
      );
    } finally {
      engine.shutdown();
      db.close();
    }
  });

  it("persists last_workbench_swarm_id across restart and supports curated staff roster CRUD", async () => {
    const repo = await initTempRepo();
    const dataDir = makeTempDir("poly-eng-persist-");

    const db1 = new PolySwarmDB(dataDir);
    const engine1 = new PolySwarmEngine({
      db: db1,
      config: loadPolySwarmConfig("/nonexistent-path"),
    });
    let createdId = "";
    try {
      const swarm = await engine1.createSwarm({
        title: "Persistent Studio Team",
        repo_root: repo,
        conversation_id: "win-1",
      });
      createdId = swarm.id;
    } finally {
      engine1.shutdown();
      db1.close();
    }

    const db2 = new PolySwarmDB(dataDir);
    const engine2 = new PolySwarmEngine({
      db: db2,
      config: loadPolySwarmConfig("/nonexistent-path"),
    });
    let novaId = "";
    try {
      assert.equal(engine2.hasRecentWorkbenchFocus(), true);
      const restored = engine2.resolveSessionTarget({ autoSelect: true });
      assert.equal(restored.swarm?.id, createdId);
      assert.equal(restored.matchReason, "recent_workbench_focus");

      const isolated = engine2.resolveSessionTarget({ conversationId: "win-new", repoRoot: repo });
      assert.equal(isolated.swarm, null);
      assert.equal(isolated.matchReason, "none");

      const initialRoster = engine2.getStaffRoster();
      assert.equal(initialRoster.length, 13);
      assert.deepEqual(
        initialRoster.map((m) => m.name),
        ["Orion", "Caelum", "Aria", "Clara", "Astra", "Leo", "Terra", "Luna", "Theo", "Jules", "Tara", "Mia", "Echo"],
      );

      const addedRoster = engine2.upsertStaffMember({
        name: "Nova",
        title: "Motion Lead",
        avatar: "mia",
        backend: "codex",
        model: "gpt-6.2-sol",
        effort: "high",
        role: "author",
        capability: "author",
        bio: "Builds studio interactions",
        enabled: true,
      });
      assert.equal(addedRoster.length, 14);
      const nova = addedRoster.find((m) => m.name === "Nova");
      assert.ok(nova);
      novaId = nova.id;

      const updatedRoster = engine2.upsertStaffMember({
        id: initialRoster[0]!.id,
        name: "Aria-V2",
        title: "Chief Architect",
        avatar: "aria",
        backend: initialRoster[0]!.backend,
        model: initialRoster[0]!.model,
        effort: initialRoster[0]!.effort,
        role: "verifier",
        capability: "architect",
        bio: "Updated bio",
        enabled: false,
      });
      assert.equal(updatedRoster.length, 14);
      assert.equal(updatedRoster.find((m) => m.id === initialRoster[0]!.id)?.name, "Aria-V2");
    } finally {
      engine2.shutdown();
      db2.close();
    }

    const db3 = new PolySwarmDB(dataDir);
    const engine3 = new PolySwarmEngine({
      db: db3,
      config: loadPolySwarmConfig("/nonexistent-path"),
    });
    try {
      const loaded = engine3.getStaffRoster();
      assert.equal(loaded.length, 14);
      assert.ok(loaded.some((m) => m.name === "Nova" && m.id === novaId));

      const afterDelete = engine3.deleteStaffMember(novaId);
      assert.equal(afterDelete.length, 13);
      assert.equal(afterDelete.some((m) => m.id === novaId), false);

      const afterReset = engine3.resetStaffRoster();
      assert.equal(afterReset.length, 13);
      assert.deepEqual(
        afterReset.map((m) => m.name),
        ["Orion", "Caelum", "Aria", "Clara", "Astra", "Leo", "Terra", "Luna", "Theo", "Jules", "Tara", "Mia", "Echo"],
      );
    } finally {
      engine3.shutdown();
      db3.close();
    }
  });
});
