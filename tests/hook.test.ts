import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadPolySwarmConfig } from "../src/core/config.js";
import { PolySwarmDB } from "../src/core/db.js";
import { PolySwarmEngine } from "../src/core/engine.js";
import { evaluatePostInvocationHook, syncHookConversationTitles } from "../src/server/hook.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function seedBoundSwarm(dataDir: string, conversationId: string): Promise<{ swarmId: string }> {
  const cfgPath = path.join(dataDir, "backends.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ backends: {} }), "utf8");
  const config = loadPolySwarmConfig(cfgPath);
  const db = new PolySwarmDB(dataDir);
  const engine = new PolySwarmEngine({ db, config });
  try {
    const repo = path.join(dataDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const swarm = await engine.createSwarm({
      title: "Hook Test Swarm",
      repo_root: repo,
      conversation_id: conversationId,
    });
    await engine.addWorker({
      swarm_id: swarm.id,
      name: "coder",
      role: "author",
      backend: "mock",
      workspace_mode: "inherit",
      brief: `[MOCK:${JSON.stringify({ text: "done from coder", sleepMs: 0 })}]`,
    });
    await engine.addWorker({
      swarm_id: swarm.id,
      name: "reviewer",
      role: "verifier",
      backend: "mock",
      workspace_mode: "inherit",
      brief: `[MOCK:${JSON.stringify({ text: "review pass", sleepMs: 0 })}]`,
    });
    await new Promise((r) => setTimeout(r, 120));
    await engine.finishSwarm(swarm.id, "All done");
    return { swarmId: swarm.id };
  } finally {
    engine.shutdown();
    db.close();
  }
}

function writeTranscript(filePath: string, rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("PostInvocation fallback hook", () => {
  it("handles intermediate calls, explicit recap/dispatch, idle turns, idempotency, and shell wrapper", async () => {
    const dataDir = makeTempDir("poly-hook-");
    const conversationId = "conv-hook-1";
    const { swarmId } = await seedBoundSwarm(dataDir, conversationId);
    const transcriptPath = path.join(dataDir, "transcript.jsonl");
    const nowIso = new Date().toISOString();

    // 1. Intermediate PLANNER_RESPONSE with pending tool_calls -> {}
    writeTranscript(transcriptPath, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "mcp_poly-swarm_poly-swarm_poly_board_wait", args: {} }],
      },
    ]);
    assert.deepEqual(
      evaluatePostInvocationHook(
        { hookEventName: "PostInvocation", conversationId, transcriptPath },
        { dataDir },
      ),
      {},
    );

    // 2. Turn already ended with poly_swarm_recap (via call_mcp_tool) -> {}
    writeTranscript(transcriptPath, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [
          { name: "call_mcp_tool", args: { ServerName: "poly-swarm_poly-swarm", ToolName: "poly_swarm_recap" } },
        ],
      },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: nowIso, tool_calls: [] },
    ]);
    assert.deepEqual(
      evaluatePostInvocationHook(
        { hookEventName: "PostInvocation", conversationId, transcriptPath },
        { dataDir },
      ),
      {},
    );

    // 3. Turn's last tool call was poly_swarm_dispatch -> {}
    writeTranscript(transcriptPath, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "mcp_poly-swarm_poly-swarm_poly_swarm_dispatch", args: {} }],
      },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: nowIso, tool_calls: [] },
    ]);
    assert.deepEqual(
      evaluatePostInvocationHook(
        { hookEventName: "PostInvocation", conversationId, transcriptPath },
        { dataDir },
      ),
      {},
    );

    // 4. Turn called poly_swarm without poly_swarm_recap -> injects user_markdown with zero system text
    writeTranscript(transcriptPath, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "mcp_poly-swarm_poly-swarm_poly_swarm", args: { action: "finish" } }],
      },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: nowIso, tool_calls: [] },
    ]);
    const injected = evaluatePostInvocationHook(
      { hookEventName: "PostInvocation", conversationId, transcriptPath },
      { dataDir },
    ) as {
      injectSteps?: Array<{
        systemMessage?: { systemMessage?: string; metadata?: { user_markdown?: string } };
      }>;
    };
    assert.equal(injected.injectSteps?.length, 1);
    const sys = injected.injectSteps?.[0]?.systemMessage;
    assert.equal(sys?.systemMessage, "");
    const md = sys?.metadata?.user_markdown ?? "";
    assert.match(md, /2 位团队成员/);
    assert.ok(md.includes(swarmId));
    assert.match(md, /@coder/);
    assert.match(md, /@reviewer/);

    // 5. Re-running on the same turn hits idempotency dedupe lock -> {}
    assert.deepEqual(
      evaluatePostInvocationHook(
        { hookEventName: "PostInvocation", conversationId, transcriptPath },
        { dataDir },
      ),
      {},
    );

    // 6. Later unrelated pure-chat turn (user prompt after swarm update, no poly_* tools) -> {}
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    writeTranscript(transcriptPath, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "mcp_poly-swarm_poly-swarm_poly_swarm", args: {} }],
      },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: nowIso, tool_calls: [] },
      { step_index: 3, type: "USER_INPUT", created_at: futureIso },
      { step_index: 4, type: "PLANNER_RESPONSE", created_at: futureIso, tool_calls: [] },
    ]);
    assert.deepEqual(
      evaluatePostInvocationHook(
        { hookEventName: "PostInvocation", conversationId, transcriptPath },
        { dataDir },
      ),
      {},
    );

    // 7. Real shell wrapper + dist/hook.mjs execution end-to-end
    const stagePluginDir = makeTempDir("poly-hook-plugin-");
    fs.mkdirSync(path.join(stagePluginDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(stagePluginDir, "scripts"), { recursive: true });
    const builtHook = path.resolve(process.cwd(), "dist", "hook.mjs");
    assert.ok(fs.existsSync(builtHook), `Missing ${builtHook}; run build first`);
    fs.copyFileSync(builtHook, path.join(stagePluginDir, "dist", "hook.mjs"));
    const srcSh = path.resolve(process.cwd(), "plugin", "scripts", "post-invocation-hook.sh");
    const dstSh = path.join(stagePluginDir, "scripts", "post-invocation-hook.sh");
    fs.copyFileSync(srcSh, dstSh);
    fs.chmodSync(dstSh, 0o755);

    writeTranscript(transcriptPath, [
      { step_index: 10, type: "USER_INPUT", created_at: nowIso },
      {
        step_index: 11,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "mcp_poly-swarm_poly-swarm_poly_board_read", args: {} }],
      },
      { step_index: 12, type: "PLANNER_RESPONSE", created_at: nowIso, tool_calls: [] },
    ]);

    const res = spawnSync("/bin/sh", ["./scripts/post-invocation-hook.sh"], {
      cwd: stagePluginDir,
      env: { ...process.env, PLUGIN_DATA: dataDir },
      input: JSON.stringify({
        hookEventName: "PostInvocation",
        conversationId,
        transcriptPath,
      }),
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim()) as {
      injectSteps?: Array<{ systemMessage?: { metadata?: { user_markdown?: string } } }>;
    };
    assert.equal(parsed.injectSteps?.length, 1);
    assert.match(parsed.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown ?? "", /@coder/);
  });

  it("syncs host conversation titles in hook without overwriting custom_title and falls back to transcript user input", async () => {
    const dataDir = makeTempDir("poly-hook-title-");
    const cidHost = "conv-hook-host-1111";
    const cidCustom = "conv-hook-custom-2222";
    await seedBoundSwarm(dataDir, cidHost);
    await seedBoundSwarm(dataDir, cidCustom);

    const db = new PolySwarmDB(dataDir);
    db.upsertConversationMeta(cidCustom, { custom_title: "User Custom Alias" });
    db.close();

    const synced = await syncHookConversationTitles(
      { hookEventName: "PostInvocation", conversationId: cidHost },
      {
        dataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5999", ANTIGRAVITY_CSRF_TOKEN: "tok" },
        fetchImpl: (async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { conversationId?: string };
          return new Response(
            JSON.stringify({
              annotations: { title: `Title for ${body.conversationId}` },
              state: { summary: "Summary", runState: "RUN_STATE_IDLE" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
      },
    );
    assert.equal(synced, 2);

    const dbVerify = new PolySwarmDB(dataDir);
    try {
      const archives = dbVerify.listConversationArchives(cidHost);
      assert.equal(archives.sessions.find((s) => s.conversation_id === cidHost)?.title, `Title for ${cidHost}`);
      assert.equal(archives.sessions.find((s) => s.conversation_id === cidCustom)?.title, "User Custom Alias");
    } finally {
      dbVerify.close();
    }

    // Without host env, falls back to first USER_INPUT summary
    const dataDir2 = makeTempDir("poly-hook-fallback-");
    const cidFallback = "conv-hook-fallback-3333";
    await seedBoundSwarm(dataDir2, cidFallback);
    const transcriptPath = path.join(dataDir2, "transcript.jsonl");
    writeTranscript(transcriptPath, [
      { step_index: 1, type: "USER_INPUT", userInput: { items: [{ text: "请优化项目档案 UI 和 token 统计" }] } },
    ]);
    const syncedFallback = await syncHookConversationTitles(
      { hookEventName: "PostInvocation", conversationId: cidFallback, transcriptPath },
      { dataDir: dataDir2, env: {} },
    );
    assert.equal(syncedFallback, 1);
    const dbVerify2 = new PolySwarmDB(dataDir2);
    try {
      assert.equal(
        dbVerify2.listConversationArchives(cidFallback).sessions[0]?.title,
        "请优化项目档案 UI 和 token 统计",
      );
    } finally {
      dbVerify2.close();
    }
  });
});
