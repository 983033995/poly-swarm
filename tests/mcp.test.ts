import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { REAL_BACKEND_IDS } from "../src/core/adapters/registry.js";
import { loadPolySwarmConfig } from "../src/core/config.js";
import { PolySwarmDB } from "../src/core/db.js";
import { PolySwarmEngine } from "../src/core/engine.js";
import { fetchHostConversationMeta } from "../src/core/host_conversations.js";
import { runGit, WorkspaceManager } from "../src/core/worktree.js";
import { startDashboardHttpServer } from "../src/server/http.js";
import type { AgyCompanyView, BackendModelOption, BoardMessage, CandidateEvaluation, DashboardSnapshot, StaffRosterMember, TeamAttachResult, TeamSummary, UiPreferencesRecord } from "../src/shared/types.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

class StdioMcpClient {
  private proc: ReturnType<typeof spawn>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(serverPath: string, dataDir: string, configPath: string, extraArgs: string[] = [], env?: NodeJS.ProcessEnv) {
    this.proc = spawn(
      process.execPath,
      [serverPath, "--data-dir", dataDir, "--config", configPath, ...extraArgs],
      { stdio: ["pipe", "pipe", "pipe"], env },
    );
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
  }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

it("imports both hosts' talent once and shares later edits without sharing their task data", async () => {
  const home = makeTempDir("poly-shared-talent-");
  const codexHome = path.join(home, ".codex");
  const codexDir = path.join(codexHome, "poly-swarm", "data");
  const agyDir = path.join(home, ".gemini", "antigravity", "plugin_data", "poly-swarm");
  const config = path.join(home, "backends.json");
  fs.writeFileSync(config, JSON.stringify({ backends: Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])) }));
  const company = "agy-" + "a".repeat(24);
  const member = { id: "aria", name: "Aria", backend: "agy", role: "researcher", company_id: company };
  const codexLegacy = new PolySwarmDB(codexDir);
  const agyLegacy = new PolySwarmDB(agyDir);
  codexLegacy.addAgyCompany(company, "Codex account company");
  codexLegacy.setAppKv("staff_roster", [member]);
  codexLegacy.setAppKv("ui_preferences", { theme: "dark" });
  agyLegacy.setAppKv("staff_roster", [{ id: "nova", name: "Nova", backend: "codex", role: "author" }]);
  const agyTask = agyLegacy.createSwarm({ title: "Antigravity task", repo_root: home });
  codexLegacy.close();
  agyLegacy.close();

  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  const connect = async (dir: string) => {
    const client = new StdioMcpClient(path.resolve("dist/server.mjs"), dir, config, ["--share-talent"], env);
    clients.push(client);
    await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    client.notify("notifications/initialized");
    return client;
  };
  const call = async <T>(client: StdioMcpClient, name: string, args: Record<string, unknown>) => {
    const result = await client.request("tools/call", { name, arguments: args }) as { isError?: boolean; structuredContent: T };
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  const roster = async (client: StdioMcpClient) =>
    (await call<{ staff_roster: StaffRosterMember[] }>(client, "app_staff_roster", { op: "list" })).staff_roster;
  const clients: StdioMcpClient[] = [];
  try {
    // Antigravity starts first, but imports the Codex company and preserves employee bindings.
    const agy = await connect(agyDir);
    const codex = await connect(codexDir);
    assert.deepEqual((await roster(agy)).map(({ id, company_id }) => [id, company_id]), [["aria", company], ["nova", null]]);
    const models = { name: "Shared company", enabled: false, default_model: "test-model", default_effort: "high" };
    await call(agy, "app_agy_companies", { op: "update", id: company, config: models });
    const { agy_companies } = await call<{ agy_companies: AgyCompanyView[] }>(codex, "app_agy_companies", { op: "list" });
    assert.deepEqual(agy_companies.map(({ name, enabled, default_model, default_effort }) => ({ name, enabled, default_model, default_effort })), [models]);
    await Promise.all([
      call(codex, "app_staff_roster", { op: "upsert", member: { ...member, title: "Research lead" } }),
      call(agy, "app_staff_roster", { op: "upsert", member: { id: "leo", name: "Leo", backend: "codex", role: "author" } }),
    ]);
    assert.equal((await roster(agy)).find(({ id }) => id === "aria")?.title, "Research lead");
    assert.equal((await roster(codex)).find(({ id }) => id === "leo")?.name, "Leo");
    await call(codex, "app_staff_roster", { op: "delete", id: "nova" });
    assert.deepEqual((await roster(await connect(agyDir))).map(({ id }) => id), ["aria", "leo"]);

    const codexDb = new PolySwarmDB(codexDir);
    const agyDb = new PolySwarmDB(agyDir);
    try {
      assert.equal(codexDb.getSwarm(agyTask.id), null);
      assert.equal(agyDb.getSwarm(agyTask.id)?.title, "Antigravity task");
      assert.deepEqual(codexDb.getAppKv("staff_roster"), [member]);
      assert.equal(agyDb.getAppKv("ui_preferences"), null);
    } finally {
      codexDb.close();
      agyDb.close();
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

it("keeps Codex chat tasks isolated and recoverable across MCP disconnect and service restart", async () => {
  const dir = makeTempDir("poly-codex-");
  const bundle = path.resolve("dist/server.mjs");
  const config = path.join(dir, "backends.json");
  const socket = path.join(dir, "mcp.sock");
  const repo = path.join(dir, "workspace");
  fs.mkdirSync(repo);
  const fake = path.join(dir, "fake-cli");
  fs.writeFileSync(fake, "#!/bin/sh\nprintf 'test-cli 1.0\n'\n", { mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ backends: Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { command: fake }])) }));

  let daemon: ReturnType<typeof spawn> | undefined;
  let client: StdioMcpClient | undefined;
  const stop = async () => {
    await client?.close();
    client = undefined;
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const done = once(daemon, "exit");
      daemon.kill("SIGTERM");
      await done;
    }
  };
  const connect = async () => {
    const bridge = new StdioMcpClient(bundle, dir, config, ["--mcp-connect", socket]);
    client = bridge;
    await bridge.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "poly-codex-test", version: "1.0.0" },
    });
    bridge.notify("notifications/initialized");
  };
  const start = async (port: string) => {
    daemon = spawn(process.execPath, [bundle, "--mcp-socket", socket, "--http-port", port, "--data-dir", dir, "--config", config],
      { stdio: ["ignore", "ignore", "pipe"] });
    const child = daemon;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let output = "";
    try {
      while (!output.includes("Codex service ready")) {
        const [chunk] = await once(child.stderr!, "data", { signal: controller.signal });
        output += chunk.toString();
      }
    } catch (err) {
      throw new Error(`Codex service did not start: ${output}`, { cause: err });
    } finally { clearTimeout(timer); }
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    await connect();
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await client!.request("tools/call", { name, arguments: args }) as {
      isError?: boolean; content: { text?: string }[];
      structuredContent?: { swarm?: { id: string } | null; workbench_url?: string; surface?: string };
    };
  const http = (url: string, init?: RequestInit) => fetch(url, { signal: AbortSignal.timeout(5000), ...init });
  const dispatch = (chat: string, worker: string, sleepMs: number) => call("poly_swarm_dispatch", {
    conversation_id: chat, repo_root: repo, title: chat,
    workers: [{ name: worker, backend: "mock", role: "verifier", workspace_mode: "inherit", auto_fallback: false,
      brief: `[MOCK:${JSON.stringify({ text: `answer from ${worker}`, sleepMs })}]` }],
  });

  try {
    await start("0");
    const a = await dispatch("chat-a", "alpha", 1000);
    assert.equal(a.isError, undefined, JSON.stringify(a));
    const aId = a.structuredContent!.swarm!.id;
    const aUrl = new URL(a.structuredContent!.workbench_url!);
    assert.match(a.content[0]!.text!, /@alpha · mock · verifier/);
    assert.ok(a.content[0]!.text!.includes(`[打开本次工作台](${aUrl.href})`));

    await client!.close();
    await connect();
    const b = await dispatch("chat-b", "bravo", 0);
    assert.equal(b.isError, undefined, JSON.stringify(b));
    const bId = b.structuredContent!.swarm!.id;
    assert.notEqual(aId, bId);
    const inlineResource = await client!.request("resources/read", { uri: "ui://poly-swarm/inline-nodes.html" }) as {
      contents: { text: string }[];
    };
    assert.match(inlineResource.contents[0]!.text, /id="inline-workbench" hidden/);
    const expanded = await call("app_get_dashboard", { swarm_id: aId, surface: "workbench", auto_select: false });
    assert.equal(expanded.structuredContent?.swarm?.id, aId);
    assert.equal(expanded.structuredContent?.surface, "workbench");
    assert.equal((await call("poly_swarm_dispatch", { conversation_id: "chat-b", swarm_id: aId })).isError, true);
    assert.equal((await call("poly_swarm_open", { conversation_id: "chat-b", swarm_id: aId })).structuredContent?.swarm?.id, aId);
    assert.equal((await call("poly_swarm_open", { conversation_id: "chat-b" })).structuredContent?.swarm?.id, bId);
    assert.equal((await call("poly_swarm_open", { conversation_id: "other", repo_root: repo, auto_select: true })).structuredContent?.swarm, null);

    const detailUrl = `${aUrl.origin}/api/worker?swarm_id=${aId}&name=alpha`;
    const deadline = Date.now() + 5000;
    let turns: { status: string; output_text: string }[];
    do {
      turns = (await (await http(detailUrl)).json()).turns;
      if (turns[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(turns?.length, 1);
    assert.equal(turns[0]?.status, "completed");
    assert.match(turns[0]!.output_text, /answer from alpha/);

    const hub = await call("poly_swarm_hub");
    const hubUrl = `${aUrl.origin}/?surface=global`;
    assert.equal(hub.structuredContent?.workbench_url, hubUrl);
    assert.equal(hub.structuredContent?.swarm, null);
    assert.equal((await http(hubUrl)).status, 200);
    const preference = await http(`${aUrl.origin}/api/preferences`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patch: { theme: "light" } }),
    });
    assert.equal(preference.status, 200);

    await stop();
    await start(aUrl.port);
    assert.equal((await call("poly_swarm_open", { conversation_id: "chat-a" })).structuredContent?.workbench_url, aUrl.href);
    assert.equal((await call("poly_swarm_open", { conversation_id: "chat-b" })).structuredContent?.swarm?.id, bId);
    const redirect = await http(`${aUrl.origin}/codex?conversation_id=chat-a`, { redirect: "manual" });
    assert.equal(redirect.headers.get("location"), `${aUrl.pathname}${aUrl.search}`);
    assert.equal((await http(aUrl.href)).status, 200);
    assert.equal((await (await http(detailUrl)).json()).turns.length, 1);
    assert.equal((await (await http(`${aUrl.origin}/api/preferences`)).json()).ui_preferences.theme, "light");

    const recapReadonly = await call("poly_swarm_recap", { conversation_id: "chat-a", finish: false });
    assert.equal(recapReadonly.isError, undefined);
    assert.match(recapReadonly.content[0]!.text!, /@alpha · mock/);
    assert.equal((recapReadonly.structuredContent as { default_collapsed?: boolean })?.default_collapsed, true);
    assert.equal((await call("poly_swarm_recap", { conversation_id: "chat-b", swarm_id: aId, finish: true })).isError, true);
    const recapFinish = await call("poly_swarm_recap", { conversation_id: "chat-a", finish: true, summary: "Codex recap done" });
    assert.equal(recapFinish.isError, undefined);
    assert.match(recapFinish.content[0]!.text!, /已完成/);
    assert.ok(recapFinish.content[0]!.text!.includes(`[打开本次工作台](${aUrl.href})`));
  } finally { await stop(); }
});

describe("MCP Server Stdio E2E", () => {
  it("exposes UI resource, model tools, v0.3 tabs, isolated config, and queue-free inline UI", async () => {
    const serverBundle = path.resolve(process.cwd(), "dist", "server.mjs");
    assert.ok(fs.existsSync(serverBundle), `Missing ${serverBundle}; run build first`);

    const dataDir = makeTempDir("poly-mcp-e2e-");
    const cfgPath = path.join(dataDir, "backends.json");
    const fakeCli = path.join(dataDir, "fake-cli");
    fs.writeFileSync(fakeCli, '#!/bin/sh\nif [ "$1" = --version ]; then echo "poly-swarm-test 1.0.0"; else echo "[]"; fi\n', { mode: 0o700 });
    const fakeCodex = path.join(dataDir, "fake-codex");
    const fakeEnvFile = path.join(dataDir, "codex-catalog-key");
    const failCatalog = path.join(dataDir, "fail-catalog");
    fs.writeFileSync(fakeEnvFile, "fixture-only\n", { mode: 0o600 });
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv[2] === "app-server") {
  const read = require("node:readline").createInterface({ input: process.stdin });
  const fs = require("node:fs");
  const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
  let initialized = false;
  read.on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === "initialize") return send(id, {});
    if (method === "initialized") { initialized = true; return; }
    if (method !== "model/list" || !initialized || params.includeHidden !== false ||
        process.env.POLY_TEST_CODEX_KEY !== "fixture-only" || fs.existsSync(${JSON.stringify(failCatalog)})) process.exit(1);
    if (params.cursor === "next") return send(id, { data: [{ model: "provider-model-b" }], nextCursor: null });
    send(id, { data: [
      { id: "picker-key", model: "provider-model-a", displayName: "Provider Model A" },
      { model: "private-hidden-model", hidden: true },
    ], nextCursor: "next" });
  });
} else process.stdout.write(process.argv[2] === "--version" ? "poly-swarm-test 1.0.0\\n" : "[]\\n");
`, { mode: 0o700 });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        backends: {
          ...Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { command: fakeCli }])),
          codex: { command: fakeCodex, defaultModel: "gpt-6.2-sol", envFiles: { POLY_TEST_CODEX_KEY: fakeEnvFile } },
          cursor: { command: fakeCli, defaultModel: "openai/gpt-6.2-sol" },
          qoder: { command: fakeCli, enabled: false },
        },
      }),
      "utf8",
    );
    const client = new StdioMcpClient(serverBundle, dataDir, cfgPath);

    try {
      const init = (await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "poly-swarm-test", version: "1.0.0" },
      })) as { capabilities?: { tools?: unknown; resources?: unknown } };

      assert.ok(init.capabilities?.tools);
      assert.ok(init.capabilities?.resources);
      client.notify("notifications/initialized");

      const toolsRes = (await client.request("tools/list")) as {
        tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
      };
      const byName = new Map(toolsRes.tools.map((t) => [t.name, t]));

      for (const expectedModelTool of [
        "poly_swarm_open",
        "poly_swarm_hub",
        "poly_swarm_dispatch",
        "poly_swarm_recap",
        "poly_swarm",
        "poly_board_post",
        "poly_board_read",
        "poly_board_wait",
        "poly_worker_inspect",
        "poly_workflow",
      ]) {
        assert.ok(byName.has(expectedModelTool), `Missing model tool: ${expectedModelTool}`);
      }

      const recapMeta = byName.get("poly_swarm_recap")?._meta as
        | {
            ui?: { resourceUri?: string };
            "com.google.antigravity/ui"?: unknown;
            "openai/ui"?: { preferredModelDisplayMode?: string };
          }
        | undefined;
      assert.equal(recapMeta?.ui?.resourceUri, "ui://poly-swarm/inline-nodes.html");
      assert.equal(recapMeta?.["com.google.antigravity/ui"], undefined);
      assert.equal(recapMeta?.["openai/ui"]?.preferredModelDisplayMode, "inline");

      const openMeta = byName.get("poly_swarm_open")?._meta as
        | {
            ui?: { resourceUri?: string };
            "com.google.antigravity/ui"?: { entrypoints?: Array<{ type: string; title: string }> };
          }
        | undefined;
      assert.equal(openMeta?.ui?.resourceUri, "ui://poly-swarm/dashboard.html");
      const entryTypes = openMeta?.["com.google.antigravity/ui"]?.entrypoints?.map((e) => e.type) ?? [];
      assert.ok(entryTypes.includes("aux_pane"));
      assert.equal(entryTypes.includes("global"), false);

      const hubMeta = byName.get("poly_swarm_hub")?._meta as
        | {
            ui?: { resourceUri?: string };
            "com.google.antigravity/ui"?: { entrypoints?: Array<{ type: string; title: string }> };
          }
        | undefined;
      assert.equal(hubMeta?.ui?.resourceUri, "ui://poly-swarm/dashboard.html");
      const hubEntryTypes = hubMeta?.["com.google.antigravity/ui"]?.entrypoints?.map((e) => e.type) ?? [];
      assert.deepEqual(hubEntryTypes, ["global"]);

      const hubCall = (await client.request("tools/call", {
        name: "poly_swarm_hub",
        arguments: {},
      })) as {
        isError?: boolean;
        structuredContent?: { surface?: string; swarm?: unknown; ui_focus?: { workbench_alive?: boolean } };
      };
      assert.notEqual(hubCall.isError, true);
      assert.equal(hubCall.structuredContent?.surface, "global");
      assert.equal(hubCall.structuredContent?.swarm, null);
      assert.equal(hubCall.structuredContent?.ui_focus?.workbench_alive, false);

      const dispatchMeta = byName.get("poly_swarm_dispatch")?._meta as
        | {
            ui?: { resourceUri?: string };
            "com.google.antigravity/ui"?: unknown;
            "openai/ui"?: { preferredModelDisplayMode?: string };
          }
        | undefined;
      assert.equal(dispatchMeta?.ui?.resourceUri, "ui://poly-swarm/inline-nodes.html");
      assert.equal(dispatchMeta?.["com.google.antigravity/ui"], undefined);
      assert.equal(dispatchMeta?.["openai/ui"]?.preferredModelDisplayMode, "inline");

      const swarmControlMeta = byName.get("poly_swarm")?._meta as
        | { ui?: { resourceUri?: string } }
        | undefined;
      assert.equal(swarmControlMeta?.ui?.resourceUri, undefined);

      for (const appTool of [
        "app_get_dashboard",
        "app_team_action",
        "app_preferences",
        "app_focus_worker",
        "app_get_worker_detail",
        "app_get_turn_events",
        "app_board_post",
        "app_worker_action",
        "app_evaluate_candidates",
        "app_list_backend_models",
        "app_update_backend_config",
        "app_get_dispatch_graph",
        "app_get_dispatch_policy",
        "app_update_dispatch_policy",
      ]) {
        const meta = byName.get(appTool)?._meta as { ui?: { visibility?: string[] } } | undefined;
        assert.deepEqual(meta?.ui?.visibility, ["app"], `Tool ${appTool} must be app-only`);
      }

      for (const resUri of [
        "ui://poly-swarm/dashboard.html",
        "ui://poly-swarm/inline-nodes.html",
      ]) {
        const resRead = (await client.request("resources/read", {
          uri: resUri,
        })) as {
          contents: Array<{ uri: string; mimeType: string; text: string }>;
        };
        const htmlItem = resRead.contents[0]!;
        assert.equal(htmlItem.mimeType, "text/html;profile=mcp-app");
        assert.ok(htmlItem.text.includes("Poly Swarm"));
        const maxBytes = resUri.endsWith("/dashboard.html") ? 2 * 1024 * 1024 : 1024 * 1024;
        assert.ok(Buffer.byteLength(htmlItem.text, "utf8") < maxBytes);
        assert.equal(/<script[^>]+src=["']https?:/i.test(htmlItem.text), false);
        if (resUri === "ui://poly-swarm/inline-nodes.html") {
          assert.equal(
            htmlItem.text.includes("请调用 poly_swarm_open"),
            false,
            "inline UI must not auto-send poly_swarm_open prompts into chat queue",
          );
        }
        if (resUri === "ui://poly-swarm/dashboard.html") {
          assert.ok(htmlItem.text.includes("工作台"));
          assert.ok(htmlItem.text.includes("流程"));
          assert.ok(htmlItem.text.includes("群聊"));
          assert.ok(htmlItem.text.includes("人力"));
          assert.ok(htmlItem.text.includes("人力资源"));
          assert.ok(htmlItem.text.includes("项目组历史"));
          assert.ok(htmlItem.text.includes("设置"));
        }
      }

      // Local-only CLI detection + explicit disabled state wording (zero model calls)
      const backendsCall = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "backends" },
      })) as {
        content?: Array<{ text?: string }>;
        structuredContent?: {
          backends?: Array<{ backend: string; installed: number }>;
        };
      };
      const backendsText = backendsCall.content?.[0]?.text ?? "";
      assert.ok(
        backendsText.includes("- qoder: disabled (in config)"),
        `Expected disabled wording in:\n${backendsText}`,
      );
      const health = backendsCall.structuredContent?.backends ?? [];
      assert.equal(health.length, 8);
      const installedIds = health.filter((b) => b.installed === 1).map((b) => b.backend);
      for (const expectedInstalled of ["agy", "cursor", "grok", "opencode", "trae"]) {
        assert.ok(
          installedIds.includes(expectedInstalled),
          `Expected '${expectedInstalled}' to be detected locally; got: ${installedIds.join(",")}`,
        );
      }

      // Verify global surface does not claim workbench_alive before workbench opens
      const globalDashRes = (await client.request("tools/call", {
        name: "app_get_dashboard",
        arguments: { surface: "global" },
      })) as { isError?: boolean; structuredContent?: { ui_focus?: { workbench_alive?: boolean } } };
      assert.notEqual(globalDashRes.isError, true);
      assert.equal(globalDashRes.structuredContent?.ui_focus?.workbench_alive, false);

      // An empty workbench starts unbound when no swarms exist.
      const openEmptyRes = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: {},
      })) as {
        isError?: boolean;
        structuredContent?: { swarm?: unknown; backends?: unknown[]; ui_focus?: { tab?: string } };
      };
      assert.notEqual(openEmptyRes.isError, true);
      assert.equal(openEmptyRes.structuredContent?.swarm, null);
      assert.equal(openEmptyRes.structuredContent?.backends?.length, 8);
      assert.equal(openEmptyRes.structuredContent?.ui_focus?.tab, "detail");

      // The SDK exposes the JSON-RPC request's _meta in the tool callback.
      const createdRes = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "create", title: "Session A" },
        _meta: { conversationId: "host-chat", workspacePath: pathToFileURL(dataDir).href },
      })) as { isError?: boolean; structuredContent?: DashboardSnapshot };
      assert.notEqual(createdRes.isError, true);
      const swId = createdRes.structuredContent?.swarm?.id;
      const teamId = createdRes.structuredContent?.team?.id;
      assert.ok(swId);
      assert.ok(teamId);
      assert.equal(createdRes.structuredContent?.swarm?.repo_root, dataDir);
      assert.equal(createdRes.structuredContent?.active_conversation_id, "host-chat");

      const defaultWorkbenchAfterCreate = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: {},
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(defaultWorkbenchAfterCreate.structuredContent?.swarm?.id, swId);
      assert.equal(defaultWorkbenchAfterCreate.structuredContent?.match_reason, "recent_active_team");

      const disabledAutoAfterCreate = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: { auto_select: false },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(disabledAutoAfterCreate.structuredContent?.swarm, null);
      assert.equal(disabledAutoAfterCreate.structuredContent?.match_reason, "none");
      assert.ok((disabledAutoAfterCreate.structuredContent?.teams?.length ?? 0) >= 1);

      const autoSelectAfterCreate = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: { auto_select: true },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(autoSelectAfterCreate.structuredContent?.swarm?.id, swId);
      assert.equal(autoSelectAfterCreate.structuredContent?.match_reason, "recent_active_team");
      assert.deepEqual(autoSelectAfterCreate.structuredContent?.swarms, []);

      // Unbound new conversation must stay isolated even when same workspace exists
      const unboundOpen = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: {},
        _meta: { conversationId: "unbound-chat", workspacePath: pathToFileURL(dataDir).href },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(unboundOpen.structuredContent?.swarm, null);
      assert.equal(unboundOpen.structuredContent?.match_reason, "none");

      // Namespaced host metadata resolves bound session accurately
      const namespacedOpen = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: {},
        _meta: { "com.google.antigravity/conversationId": "host-chat" },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(namespacedOpen.structuredContent?.swarm?.id, swId);
      assert.equal(namespacedOpen.structuredContent?.match_reason, "conversation_binding");

      const globalAfterCreate = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: { surface: "global" },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(globalAfterCreate.structuredContent?.swarm, null);
      assert.equal(globalAfterCreate.structuredContent?.teams?.[0]?.team.id, teamId);

      const boundOpen = (await client.request("tools/call", {
        name: "poly_swarm_open",
        arguments: { conversation_id: "host-chat", auto_select: false },
        _meta: { conversationId: "different-chat" },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(boundOpen.structuredContent?.active_conversation_id, "host-chat");
      assert.equal(boundOpen.structuredContent?.swarm?.id, swId);
      assert.equal(boundOpen.structuredContent?.match_reason, "conversation_binding");

      const attached = (await client.request("tools/call", {
        name: "app_team_action",
        arguments: { action: "attach", team_id: teamId },
        _meta: { threadId: "second-window" },
      })) as { isError?: boolean; structuredContent?: TeamAttachResult };
      assert.notEqual(attached.isError, true);
      assert.equal(attached.structuredContent?.binding?.conversation_id, "second-window");
      assert.equal(attached.structuredContent?.snapshot.swarm?.id, swId);

      const teamList = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "teams", conversation_id: "second-window" },
      })) as { structuredContent?: { teams: TeamSummary[] } };
      const team = teamList.structuredContent?.teams.find((item) => item.team.id === teamId);
      assert.equal(team?.is_bound_to_current, true);
      assert.equal(team?.bound_conversations, 2);

      // Inspecting another swarm via app_get_dashboard must NOT overwrite existing window bindings
      const secondTeamCreate = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "create", title: "Session B", repo_root: dataDir },
      })) as { isError?: boolean; structuredContent?: DashboardSnapshot };
      assert.notEqual(secondTeamCreate.isError, true);
      const swB = secondTeamCreate.structuredContent?.swarm?.id;
      assert.ok(swB);
      const inspectOther = (await client.request("tools/call", {
        name: "app_get_dashboard",
        arguments: { swarm_id: swB, surface: "workbench" },
        _meta: { conversationId: "host-chat" },
      })) as { isError?: boolean; structuredContent?: DashboardSnapshot };
      assert.notEqual(inspectOther.isError, true);
      assert.equal(inspectOther.structuredContent?.swarm?.id, swB);
      const verifyBoundA = (await client.request("tools/call", {
        name: "app_get_dashboard",
        arguments: { surface: "workbench", auto_select: false },
        _meta: { conversationId: "host-chat" },
      })) as { structuredContent?: DashboardSnapshot };
      assert.equal(verifyBoundA.structuredContent?.swarm?.id, swId);
      assert.equal(verifyBoundA.structuredContent?.match_reason, "conversation_binding");

      const preferences = async (args: Record<string, unknown>) => (await client.request("tools/call", {
        name: "app_preferences", arguments: args,
      })) as { isError?: boolean; structuredContent?: { ui_preferences: UiPreferencesRecord } };
      assert.equal((await preferences({ op: "get" })).structuredContent?.ui_preferences.theme, "system");
      const changed = await preferences({ op: "set", patch: { theme: "dark", language: "en" } });
      assert.notEqual(changed.isError, true);
      assert.equal(changed.structuredContent?.ui_preferences.theme, "dark");
      assert.equal(changed.structuredContent?.ui_preferences.language, "en");
      assert.deepEqual((await preferences({ op: "get" })).structuredContent, changed.structuredContent);

      const staffList = (await client.request("tools/call", {
        name: "app_staff_roster",
        arguments: { op: "list" },
      })) as { isError?: boolean; structuredContent?: { staff_roster?: Array<{ id: string; name: string }> } };
      assert.notEqual(staffList.isError, true);
      assert.equal(staffList.structuredContent?.staff_roster?.length, 13);

      const staffAdded = (await client.request("tools/call", {
        name: "app_staff_roster",
        arguments: {
          op: "upsert",
          member: {
            name: "Nova",
            title: "Motion Lead",
            avatar: "mia",
            backend: "trae",
            model: "auto",
            effort: "high",
            role: "author",
            capability: "author",
            bio: "Animation lead",
            enabled: true,
          },
        },
      })) as { isError?: boolean; structuredContent?: { staff_roster?: Array<{ id: string; name: string }> } };
      assert.notEqual(staffAdded.isError, true);
      assert.equal(staffAdded.structuredContent?.staff_roster?.length, 14);
      const novaId = staffAdded.structuredContent?.staff_roster?.find((m) => m.name === "Nova")?.id;
      assert.ok(novaId);

      const staffDeleted = (await client.request("tools/call", {
        name: "app_staff_roster",
        arguments: { op: "delete", id: novaId },
      })) as { isError?: boolean; structuredContent?: { staff_roster?: Array<{ id: string; name: string }> } };
      assert.notEqual(staffDeleted.isError, true);
      assert.equal(staffDeleted.structuredContent?.staff_roster?.length, 13);

      const staffReset = (await client.request("tools/call", {
        name: "app_staff_roster",
        arguments: { op: "reset" },
      })) as { isError?: boolean; structuredContent?: { staff_roster?: Array<{ id: string; name: string }> } };
      assert.notEqual(staffReset.isError, true);
      assert.equal(staffReset.structuredContent?.staff_roster?.length, 13);

      for (const nextTab of ["detail", "graph", "board", "usage", "settings"] as const) {
        const res = (await client.request("tools/call", {
          name: "poly_swarm_open",
          arguments: { swarm_id: swId, tab: nextTab },
        })) as {
          isError?: boolean;
          structuredContent?: {
            projected?: boolean;
            board_tail?: unknown[];
            workflows?: unknown[];
            dispatch_policy?: unknown;
            dispatch_graph?: unknown;
            swarm?: { id?: string; plan_json?: string | null };
            ui_focus?: { swarm_id?: string; tab?: string };
          };
        };
        assert.notEqual(res.isError, true);
        assert.equal(res.structuredContent?.projected, true);
        assert.deepEqual(res.structuredContent?.board_tail, []);
        assert.deepEqual(res.structuredContent?.workflows, []);
        assert.equal(res.structuredContent?.dispatch_policy, null);
        assert.equal(res.structuredContent?.dispatch_graph, null);
        assert.equal(res.structuredContent?.swarm?.id, swId);
        assert.equal(res.structuredContent?.swarm?.plan_json, null);
        assert.equal(res.structuredContent?.ui_focus?.swarm_id, swId);
        assert.equal(res.structuredContent?.ui_focus?.tab, nextTab);
      }

      // Verify policy & graph actions on poly_swarm and app-only tools
      const setPolicyRes = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: {
          action: "policy",
          policy_op: "set",
          policy_scope: "session",
          swarm_id: swId,
          policy: {
            identities: {
              "qa-lead": { label: "QA 主审", base_role: "verifier", capability: "verifier", skill_paths: [".agents/skills/qa/SKILL.md"] },
            },
            topology: [{ from: "qa-lead", to: "w-slim", kind: "review" }],
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { policy?: { identities?: Record<string, { label?: string; skill_paths?: string[] }> } };
      };
      assert.notEqual(setPolicyRes.isError, true);
      assert.equal(setPolicyRes.structuredContent?.policy?.identities?.["qa-lead"]?.label, "QA 主审");
      assert.deepEqual(setPolicyRes.structuredContent?.policy?.identities?.["qa-lead"]?.skill_paths, [".agents/skills/qa/SKILL.md"]);

      const graphToolRes = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "graph", swarm_id: swId },
      })) as {
        isError?: boolean;
        structuredContent?: { graph?: { swarm_id?: string; edges?: unknown[] } };
      };
      assert.notEqual(graphToolRes.isError, true);
      assert.equal(graphToolRes.structuredContent?.graph?.swarm_id, swId);
      assert.ok((graphToolRes.structuredContent?.graph?.edges?.length ?? 0) >= 1);

      const dispatchSlimRes = (await client.request("tools/call", {
        name: "poly_swarm_dispatch",
        _meta: { conversationId: "host-chat" },
        arguments: {
          workers: [
            {
              name: "w-slim",
              role: "author",
              backend: "mock",
              workspace_mode: "inherit",
              brief: '[MOCK:{"text":"hi"}]',
            },
          ],
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          projected?: boolean;
          board_tail?: unknown[];
          swarm?: { id?: string };
          workers?: Array<{ name: string; latest_turn?: { output_text?: string | null } | null }>;
        };
      };
      assert.notEqual(dispatchSlimRes.isError, true);
      assert.equal(dispatchSlimRes.structuredContent?.projected, true);
      assert.deepEqual(dispatchSlimRes.structuredContent?.board_tail, []);
      assert.equal(dispatchSlimRes.structuredContent?.swarm?.id, swId);
      const wSlim = dispatchSlimRes.structuredContent?.workers?.find((w) => w.name === "w-slim");
      assert.ok(wSlim);
      if (wSlim.latest_turn) {
        assert.equal(wSlim.latest_turn.output_text, null);
      }

      const appDashRes = (await client.request("tools/call", {
        name: "app_get_dashboard",
        arguments: { surface: "workbench" },
        _meta: { conversationId: "second-window" },
      })) as { isError?: boolean; structuredContent?: DashboardSnapshot };
      assert.notEqual(appDashRes.isError, true);
      assert.equal(appDashRes.structuredContent?.swarm?.id, swId);
      assert.equal(appDashRes.structuredContent?.match_reason, "conversation_binding");
      assert.ok(typeof appDashRes.structuredContent?.generated_at === "number");

      const focusRes = (await client.request("tools/call", {
        name: "app_focus_worker",
        arguments: { swarm_id: swId, worker_name: "dev", tab: "board" },
      })) as {
        isError?: boolean;
        structuredContent?: { swarm_id?: string; worker_name?: string; tab?: string; workbench_alive?: boolean; seq?: number };
      };
      assert.notEqual(focusRes.isError, true);
      assert.equal(focusRes.structuredContent?.swarm_id, swId);
      assert.equal(focusRes.structuredContent?.worker_name, "dev");
      assert.equal(focusRes.structuredContent?.tab, "board");
      assert.equal(focusRes.structuredContent?.workbench_alive, true);
      assert.ok((focusRes.structuredContent?.seq ?? 0) >= 1);

      const listModels = async (refresh = false) => {
        const result = (await client.request("tools/call", {
          name: "app_list_backend_models", arguments: { refresh },
        })) as { isError?: boolean; structuredContent?: { models?: Record<string, BackendModelOption[]> } };
        assert.notEqual(result.isError, true);
        return result.structuredContent?.models;
      };
      const models = await listModels();
      assert.ok(Array.isArray(models?.codebuddy));
      assert.equal(models?.trae?.[0]?.id, "auto");
      assert.equal(models?.trae?.[0]?.source, "fallback");
      assert.deepEqual(models?.codex?.map(({ id, label, source }) => [id, label, source]), [
        ["provider-model-a", "Provider Model A", "detected"], ["provider-model-b", "provider-model-b", "detected"],
      ]);
      fs.writeFileSync(failCatalog, "");
      assert.deepEqual((await listModels(true))?.codex, []);

      const author = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: {
          action: "add", swarm_id: swId, name: "codex-dev", role: "author",
          backend: "codex", model: "gpt-6.2-sol", workspace_mode: "inherit", brief: "Local fixture only",
        },
      })) as { isError?: boolean };
      assert.notEqual(author.isError, true);
      const candidateRes = (await client.request("tools/call", {
        name: "app_evaluate_candidates",
        arguments: { swarm_id: swId, capability: "verifier", identity_id: "verifier", review_of: "@codex-dev" },
      })) as { isError?: boolean; structuredContent?: { candidates: CandidateEvaluation[] } };
      assert.notEqual(candidateRes.isError, true);
      const candidates = candidateRes.structuredContent?.candidates ?? [];
      assert.ok(candidates.find((c) => c.backend === "cursor")?.gate_failures.some((g) => g.gate === "G6"));
      assert.ok(candidates.find((c) => c.backend === "opencode")?.gate_failures.some((g) => g.gate === "G4"));
      assert.equal(candidates.filter((c) => c.recommended).length, 1);
      assert.equal(candidates.find((c) => c.recommended)?.eligible, true);

      const recapActiveRes = (await client.request("tools/call", {
        name: "poly_swarm_recap",
        _meta: { conversationId: "host-chat" },
        arguments: { swarm_id: swId },
      })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: {
          projected?: boolean;
          inline_mode?: string;
          default_collapsed?: boolean;
          swarm?: { id?: string; status?: string };
        };
      };
      assert.notEqual(recapActiveRes.isError, true);
      assert.equal(recapActiveRes.structuredContent?.projected, true);
      assert.equal(recapActiveRes.structuredContent?.inline_mode, "recap");
      assert.equal(recapActiveRes.structuredContent?.default_collapsed, true);
      assert.equal(recapActiveRes.structuredContent?.swarm?.id, swId);
      assert.equal(recapActiveRes.structuredContent?.swarm?.status, "active");
      assert.match(recapActiveRes.content?.[0]?.text ?? "", /@w-slim/);

      const silent = (await client.request("tools/call", {
        name: "app_board_post",
        arguments: { swarm_id: swId, text: "@all do not wake", suppress_wake: true },
      })) as { isError?: boolean; structuredContent?: { message: BoardMessage; woken: string[] } };
      assert.notEqual(silent.isError, true);
      assert.equal(silent.structuredContent?.message.suppress_wake, 1);
      assert.deepEqual(silent.structuredContent?.woken, []);

      const finish = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "finish", swarm_id: swId, summary: "Completed" },
      })) as { isError?: boolean; structuredContent?: { swarm?: { status: string } } };
      assert.notEqual(finish.isError, true);
      assert.equal(finish.structuredContent?.swarm?.status, "done");

      const recapDoneRes = (await client.request("tools/call", {
        name: "poly_swarm_recap",
        _meta: { conversationId: "host-chat" },
        arguments: { swarm_id: swId, finish: true, summary: "Stdio E2E recap finished" },
      })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: {
          swarm?: { id?: string; status?: string };
        };
      };
      assert.notEqual(recapDoneRes.isError, true);
      assert.equal(recapDoneRes.structuredContent?.swarm?.id, swId);
      assert.equal(recapDoneRes.structuredContent?.swarm?.status, "done");
      assert.match(recapDoneRes.content?.[0]?.text ?? "", /@w-slim/);

      const recapFinishB = (await client.request("tools/call", {
        name: "poly_swarm_recap",
        arguments: { swarm_id: swB, finish: true, summary: "Session B recap finished" },
      })) as {
        isError?: boolean;
        structuredContent?: {
          projected?: boolean;
          inline_mode?: string;
          default_collapsed?: boolean;
          swarm?: { id?: string; status?: string };
        };
      };
      assert.notEqual(recapFinishB.isError, true);
      assert.equal(recapFinishB.structuredContent?.projected, true);
      assert.equal(recapFinishB.structuredContent?.inline_mode, "recap");
      assert.equal(recapFinishB.structuredContent?.default_collapsed, true);
      assert.equal(recapFinishB.structuredContent?.swarm?.id, swB);
      assert.equal(recapFinishB.structuredContent?.swarm?.status, "done");

      const blockedChannel = (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "channel", swarm_id: swId, channel_op: "create", channel: "late" },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      assert.equal(blockedChannel.isError, true);
      assert.match(blockedChannel.content?.[0]?.text ?? "", /read-only/);
      const blockedBoard = (await client.request("tools/call", {
        name: "app_board_post",
        arguments: { swarm_id: swId, text: "late post", suppress_wake: true },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      assert.equal(blockedBoard.isError, true);
      assert.match(blockedBoard.content?.[0]?.text ?? "", /read-only/);
    } finally {
      await client.close();
    }
  });

  it("passes expected_sha from the coordinator MCP tool to the Git merge guard", async () => {
    const dataDir = makeTempDir("poly-mcp-merge-data-");
    const configPath = path.join(dataDir, "backends.json");
    fs.writeFileSync(configPath, JSON.stringify({
      backends: Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
    }));
    const repo = makeTempDir("poly-mcp-merge-repo-");
    await runGit(repo, ["init", "-b", "main"]);
    await runGit(repo, ["config", "user.name", "Poly Test"]);
    await runGit(repo, ["config", "user.email", "poly@example.com"]);
    await runGit(repo, ["commit", "--allow-empty", "-m", "base"]);
    const base = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const wm = new WorkspaceManager();
    const db = new PolySwarmDB(dataDir);
    let swarmId: string;
    let reviewedSha: string;
    try {
      const swarm = db.createSwarm({ title: "Reviewed merge", repo_root: repo, base_branch: "main" });
      swarmId = swarm.id;
      const work = await wm.prepareWorkspace(repo, swarm.id, "dev", "share");
      db.addWorker({
        swarm_id: swarm.id, name: "dev", role: "author", capability: "author", backend: "mock",
        workspace_mode: "share", workspace_path: work.workspacePath, worktree_branch: work.worktreeBranch,
      });
      fs.writeFileSync(path.join(work.workspacePath, "reviewed.txt"), "approved\n");
      await wm.commitAllIfDirty(work.workspacePath, "reviewed change");
      reviewedSha = (await runGit(work.workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
    } finally {
      db.close();
    }
    const client = new StdioMcpClient(path.resolve("dist/server.mjs"), dataDir, configPath);
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "poly-swarm-test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");
      const merge = async (expected_sha: string) => (await client.request("tools/call", {
        name: "poly_swarm",
        arguments: { action: "merge", swarm_id: swarmId, name: "dev", expected_sha },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      const stale = await merge(base);
      assert.equal(stale.isError, true);
      assert.match(stale.content?.[0]?.text ?? "", /does not match expected SHA/);
      assert.equal((await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(), base);
      assert.equal(fs.existsSync(path.join(repo, "reviewed.txt")), false);
      assert.notEqual((await merge(reviewedSha)).isError, true);
      assert.equal((await runGit(repo, ["rev-parse", "HEAD^2"])).stdout.trim(), reviewedSha);
    } finally {
      await client.close();
    }
  });

  it("enforces Origin/cross-site/Content-Type (including chunked POST) and backend enum validation on HTTP dashboard", async () => {
    const dataDir = makeTempDir("poly-http-sec-");
    const configPath = path.join(dataDir, "backends.json");
    fs.writeFileSync(configPath, JSON.stringify({
      backends: Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
    }));
    const db = new PolySwarmDB(dataDir);
    const config = loadPolySwarmConfig(configPath);
    const engine = new PolySwarmEngine({ db, config });
    const server = startDashboardHttpServer(engine, 0);

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const port = (server.address() as AddressInfo).port;

      const sendRawHttp = (opts: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: string;
      }): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              method: opts.method,
              path: opts.path,
              headers: opts.headers,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          if (opts.body !== undefined) req.write(opts.body);
          req.end();
        });

      const get = (path: string) => sendRawHttp({ method: "GET", path, headers: { Host: `127.0.0.1:${port}` } });
      const post = (path: string, body: Record<string, unknown>) => sendRawHttp({
        method: "POST", path, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const other = await engine.createSwarm({ title: "Other session", repo_root: dataDir });
      const active = await engine.createSwarm({ title: "Current session", repo_root: dataDir });
      const teamId = active.team_id!;
      db.addWorker({
        swarm_id: active.id, name: "dev", role: "author", capability: "author",
        backend: "codex", model: "gpt-6.2-sol", workspace_mode: "inherit", workspace_path: dataDir,
      });
      const postBoard = (text: string, suppress_wake: boolean) => sendRawHttp({
        method: "POST",
        path: "/api/board",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
        body: JSON.stringify({ swarm_id: active.id, text, suppress_wake }),
      });
      const silent = await postBoard("@dev quiet update", true);
      assert.equal(silent.status, 200);
      const posted = JSON.parse(silent.body) as { message: BoardMessage; woken: string[] };
      assert.equal(posted.message.suppress_wake, 1);
      assert.deepEqual(posted.woken, []);
      assert.deepEqual(db.listWorkerTurns(active.id, "dev"), []);

      assert.equal((await get("/api/candidates")).status, 400);
      assert.equal((await get("/api/candidates?capability=verifier&role=nope")).status, 400);
      await engine.finishSwarm(active.id);
      const attached = await post("/api/team-action", {
        action: "attach", team_id: teamId, conversation_id: "http-window", reopen: false,
      });
      assert.equal(attached.status, 200);
      const attachment = JSON.parse(attached.body) as TeamAttachResult;
      assert.equal(attachment.binding?.active_swarm_id, active.id);
      assert.equal(attachment.swarm?.status, "done");
      const teamList = await get("/api/teams?conversation_id=http-window");
      assert.equal(teamList.status, 200);
      const { teams } = JSON.parse(teamList.body) as { teams: TeamSummary[] };
      assert.equal(teams.find((item) => item.is_bound_to_current)?.team.id, teamId);
      for (const [query, reason] of [
        ["conversation_id=http-window", "conversation_binding"],
        [`team_id=${teamId}&conversation_id=http-window`, "explicit_team"],
        [`repo_root=${encodeURIComponent(dataDir)}`, "repo_match"],
      ]) {
        const matched = await get(`/api/dashboard?surface=workbench&auto_select=0&${query}`);
        assert.equal(matched.status, 200);
        const snapshot = JSON.parse(matched.body) as DashboardSnapshot;
        assert.equal(snapshot.swarm?.id, active.id);
        assert.equal(snapshot.match_reason, reason);
      }
      assert.equal((await post("/api/team-action", { action: "invalid" })).status, 400);
      assert.equal((await post("/api/team-action", { action: "attach", team_id: "missing" })).status, 404);

      const saved = await post("/api/preferences", { patch: { theme: "dark", animatedAvatars: false } });
      assert.equal(saved.status, 200);
      assert.equal((await post("/api/preferences", { patch: { theme: "invalid" } })).status, 400);
      const preferences = await get("/api/preferences");
      assert.equal(preferences.status, 200);
      const savedPreferences = JSON.parse(preferences.body) as { ui_preferences: UiPreferencesRecord };
      assert.deepEqual(savedPreferences, JSON.parse(saved.body));
      assert.equal(savedPreferences.ui_preferences.theme, "dark");
      assert.equal(savedPreferences.ui_preferences.animatedAvatars, false);

      const candidates = await get(`/api/candidates?swarm_id=${active.id}&capability=verifier&role=verifier&review_of=%40dev`);
      assert.equal(candidates.status, 200);
      const result = JSON.parse(candidates.body) as { candidates: CandidateEvaluation[] };
      assert.ok(result.candidates.find((c) => c.backend === "codex")?.gate_failures.some((g) => g.gate === "G6"));
      assert.ok(result.candidates.every((c) => !c.eligible && !c.recommended && c.gate_failures.some((g) => g.gate === "G1")));
      assert.match((await postBoard("late post", false)).body, /read-only/);
      assert.ok(!db.readBoardTail(active.id).some((m) => m.text === "late post"));
      assert.equal((await get("/codex")).status, 400);
      assert.equal((await get("/codex?swarm_id=unknown")).status, 404);
      const workbench = await get(`/codex?swarm_id=${active.id}`);
      assert.equal(workbench.status, 200);
      assert.equal(workbench.body, (await get("/")).body);
      assert.doesNotMatch(workbench.body, /<iframe\b/i);
      assert.ok(!workbench.body.includes(other.id));

      // 1. Chunked POST without Content-Length and non-JSON Content-Type -> 415
      const chunkedNonJson = await sendRawHttp({
        method: "POST",
        path: "/api/board",
        headers: {
          Host: `127.0.0.1:${port}`,
          "Transfer-Encoding": "chunked",
          "Content-Type": "text/plain",
        },
        body: '{"swarm_id":"x","text":"hi"}',
      });
      assert.equal(chunkedNonJson.status, 415);

      // 2. Cross-site Origin on POST -> 403
      const evilOrigin = await sendRawHttp({
        method: "POST",
        path: "/api/focus",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(evilOrigin.status, 403);

      // 3. Invalid backend on /api/backend-config -> 400
      const badCfgBackend = await sendRawHttp({
        method: "POST",
        path: "/api/backend-config",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ updates: [{ backend: "nope", enabled: false }] }),
      });
      assert.equal(badCfgBackend.status, 400);

      // 4. Invalid backend on /api/worker-action switch -> 400
      const badSwitchBackend = await sendRawHttp({
        method: "POST",
        path: "/api/worker-action",
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "switch", swarm_id: "s1", name: "w1", backend: "nope" }),
      });
      assert.equal(badSwitchBackend.status, 400);

      // 5. Invalid scope on /api/policy -> 400, and GET /api/policy works
      const badPolicyScope = await sendRawHttp({
        method: "POST",
        path: "/api/policy",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scope: "builtin" }),
      });
      assert.equal(badPolicyScope.status, 400);

      const getPolicyOk = await sendRawHttp({
        method: "GET",
        path: "/api/policy",
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(getPolicyOk.status, 200);
      assert.ok(getPolicyOk.body.includes("BUILTIN") || getPolicyOk.body.includes("builtin"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      engine.shutdown();
      db.close();
    }
  });

  it("enforces <= 28 KiB UTF-8 byte cap without lone surrogates and supports exact cursor pagination in MCP read/wait/inspect", async () => {
    const dataDir = makeTempDir("poly-mcp-budget-data-");
    const configPath = path.join(dataDir, "backends.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        backends: Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
      }),
    );

    const db = new PolySwarmDB(dataDir);
    let swarmId = "";
    let turnId = "";
    const postedSeqs: number[] = [];
    const expectedEventIds: number[] = [];
    try {
      const swarm = db.createSwarm({ title: "Budget Cap Test", repo_root: dataDir });
      swarmId = swarm.id;
      db.addWorker({
        swarm_id: swarm.id,
        name: "writer",
        role: "author",
        capability: "author",
        backend: "mock",
        workspace_mode: "inherit",
        workspace_path: dataDir,
      });

      const chunk = "中文边界🚀🔥测试内容".repeat(250);
      for (let i = 0; i < 16; i++) {
        const msg = db.postBoardMessage({
          swarm_id: swarm.id,
          sender: "coordinator",
          channel: "main",
          tag: "update",
          text: `@coordinator msg-${i} ${chunk}`,
        }).message;
        postedSeqs.push(msg.seq);
      }

      const turn = db.createTurn({
        swarm_id: swarm.id,
        worker_name: "writer",
        backend: "mock",
        mode: "write",
        trigger_seq: postedSeqs[0]!,
        prompt_preview: chunk,
      });
      turnId = turn.id;
      for (let i = 0; i < 40; i++) {
        const evId = db.insertEvent({
          turn_id: turn.id,
          swarm_id: swarm.id,
          worker_name: "writer",
          seq_in_turn: i + 1,
          kind: "text",
          title: `step-${i}`,
          content: `事件#${i} ${"表情🚀汉字测试".repeat(90)}`,
        });
        expectedEventIds.push(evId);
      }
      db.completeTurn(turn.id, {
        status: "completed",
        error_kind: "none",
        output_text: `OUT ${chunk}`,
        actual_model: "mock-v2",
        duration_ms: 120,
        tool_calls_count: 1,
      });
    } finally {
      db.close();
    }

    const BUDGET = 28 * 1024;
    const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    const client = new StdioMcpClient(path.resolve("dist/server.mjs"), dataDir, configPath);
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "poly-budget-test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");

      // Paginate poly_board_read
      const readSeqs: number[] = [];
      let since = 0;
      let boardPages = 0;
      while (true) {
        boardPages += 1;
        assert.ok(boardPages <= 30, "poly_board_read pagination exceeded safe iteration cap");
        const res = (await client.request("tools/call", {
          name: "poly_board_read",
          arguments: { swarm_id: swarmId, since, limit: 50 },
        })) as {
          isError?: boolean;
          content?: Array<{ type: string; text: string }>;
          structuredContent?: {
            messages: BoardMessage[];
            truncated: boolean;
            omitted_count: number;
            next_since: number;
          };
        };
        assert.notEqual(res.isError, true);
        const serialized = JSON.stringify({ content: res.content, structuredContent: res.structuredContent });
        assert.ok(Buffer.byteLength(serialized, "utf8") <= BUDGET);
        assert.equal(hasLoneSurrogate(serialized), false);
        const msgs = res.structuredContent?.messages ?? [];
        for (const m of msgs) readSeqs.push(m.seq);
        if (!res.structuredContent?.truncated || res.structuredContent.omitted_count === 0) break;
        assert.ok(res.structuredContent.next_since > since);
        since = res.structuredContent.next_since;
      }
      assert.deepEqual(readSeqs, postedSeqs);

      // poly_board_wait on existing oversized message stays within <= 28 KiB
      const waitRes = (await client.request("tools/call", {
        name: "poly_board_wait",
        arguments: { swarm_id: swarmId, since: postedSeqs[postedSeqs.length - 2]!, timeout_ms: 1000 },
      })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };
      assert.notEqual(waitRes.isError, true);
      const waitSerialized = JSON.stringify({ content: waitRes.content, structuredContent: waitRes.structuredContent });
      assert.ok(Buffer.byteLength(waitSerialized, "utf8") <= BUDGET);
      assert.equal(hasLoneSurrogate(waitSerialized), false);

      // Paginate poly_worker_inspect events with after_event_id
      const seenEventIds: number[] = [];
      let afterEventId = 0;
      let inspectPages = 0;
      while (true) {
        inspectPages += 1;
        assert.ok(inspectPages <= 30, "poly_worker_inspect pagination exceeded safe iteration cap");
        const res = (await client.request("tools/call", {
          name: "poly_worker_inspect",
          arguments: {
            swarm_id: swarmId,
            name: "writer",
            turn_id: turnId,
            after_event_id: afterEventId,
            include: "all",
          },
        })) as {
          isError?: boolean;
          content?: Array<{ type: string; text: string }>;
          structuredContent?: {
            events: Array<{ id: number; content: string }>;
            events_truncated: boolean;
            next_after_event_id: number | null;
          };
        };
        assert.notEqual(res.isError, true);
        const serialized = JSON.stringify({ content: res.content, structuredContent: res.structuredContent });
        assert.ok(Buffer.byteLength(serialized, "utf8") <= BUDGET);
        assert.equal(hasLoneSurrogate(serialized), false);
        const evs = res.structuredContent?.events ?? [];
        for (const ev of evs) seenEventIds.push(ev.id);
        if (!res.structuredContent?.events_truncated) break;
        const nextId = res.structuredContent.next_after_event_id;
        assert.ok(nextId !== null && nextId > afterEventId);
        afterEventId = nextId!;
      }
      assert.deepEqual(seenEventIds, expectedEventIds);
    } finally {
      await client.close();
    }
  });

  it("supports host conversation metadata sync (mocked) and HTTP rename_conversation / assign_conversation actions", async () => {
    assert.equal(await fetchHostConversationMeta("conv-none", { env: {} }), null);
    const meta = await fetchHostConversationMeta("conv-123", {
      env: { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5999", ANTIGRAVITY_CSRF_TOKEN: "tok" },
      fetchImpl: (async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers["x-antigravity-csrf-token"], "tok");
        return new Response(
          JSON.stringify({
            annotations: { title: "Synced Antigravity Title" },
            state: { summary: "Auto summary", runState: "RUN_STATE_IDLE" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });
    assert.deepEqual(meta, {
      title: "Synced Antigravity Title",
      summary: "Auto summary",
      runState: "RUN_STATE_IDLE",
    });

    const dataDir = makeTempDir("poly-conv-http-");
    const repoDir = makeTempDir("poly-conv-repo-");
    await runGit(repoDir, ["init"]);
    await runGit(repoDir, ["config", "user.name", "Test"]);
    await runGit(repoDir, ["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await runGit(repoDir, ["add", "."]);
    await runGit(repoDir, ["commit", "-m", "init"]);

    const configPath = path.join(dataDir, "backends.json");
    fs.writeFileSync(configPath, JSON.stringify({
      backends: Object.fromEntries(REAL_BACKEND_IDS.map((id) => [id, { enabled: false }])),
    }));
    const db = new PolySwarmDB(dataDir);
    const engine = new PolySwarmEngine({ db, config: loadPolySwarmConfig(configPath) });
    const sConv = await engine.createSwarm({
      title: "Main Chat Task",
      repo_root: repoDir,
      conversation_id: "conv-host-1",
    });
    const sLegacy = await engine.createSwarm({
      title: "Unassigned Call",
      repo_root: repoDir,
    });

    const srv = startDashboardHttpServer(engine, 0);
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once("listening", resolve);
        srv.once("error", reject);
      });
      const port = (srv.address() as AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      const renameRes = await fetch(`${origin}/api/team-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          action: "rename_conversation",
          conversation_id: "conv-other-caller",
          target_conversation_id: "conv-host-1",
          name: "Renamed Main Window",
        }),
      });
      assert.equal(renameRes.status, 200);
      const renamedBody = (await renameRes.json()) as { conversation_archives: { sessions: Array<{ conversation_id: string; title: string | null }> } };
      assert.equal(renamedBody.conversation_archives.sessions.find((s) => s.conversation_id === "conv-host-1")?.title, "Renamed Main Window");

      const assignRes = await fetch(`${origin}/api/team-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          action: "assign_conversation",
          swarm_id: sLegacy.id,
          target_conversation_id: "conv-host-1",
        }),
      });
      assert.equal(assignRes.status, 200);
      const assignBody = (await assignRes.json()) as { conversation_archives: { sessions: Array<{ wave_count: number }>; total_unassigned: number } };
      assert.equal(assignBody.conversation_archives.total_unassigned, 0);
      assert.equal(assignBody.conversation_archives.sessions[0]?.wave_count, 2);

      // Native swarm cannot be reassigned to another conversation
      const conflictRes = await fetch(`${origin}/api/team-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          action: "assign_conversation",
          swarm_id: sConv.id,
          target_conversation_id: "conv-other",
        }),
      });
      assert.equal(conflictRes.status, 409);
    } finally {
      srv.close();
      db.close();
    }
  });
});
