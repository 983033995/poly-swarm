import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  mergeModelOptions,
  parseAgyModelsOutput,
  parseCodeBuddyModelsFromHelp,
  parseCursorModelsOutput,
  parseQoderModelsOutput,
  parseTraeModelsOutput,
} from "../src/core/adapters/models.js";
import { AgyAdapter } from "../src/core/adapters/agy.js";
import { BaseCliAdapter, classifyError, createTurnTracker, spawnStreamingCli } from "../src/core/adapters/base.js";
import { CodeBuddyAdapter } from "../src/core/adapters/codebuddy.js";
import { CodexAdapter } from "../src/core/adapters/codex.js";
import { CursorAdapter } from "../src/core/adapters/cursor.js";
import { GrokAdapter } from "../src/core/adapters/grok.js";
import { MockAdapter } from "../src/core/adapters/mock.js";
import { OpenCodeAdapter } from "../src/core/adapters/opencode.js";
import { QoderAdapter } from "../src/core/adapters/qoder.js";
import { TraeAdapter } from "../src/core/adapters/trae.js";

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

describe("CLI Adapters & Stream Parsers", () => {
  it("builds TRAE stdin commands with an explicit sandbox on fresh turns and resume", () => {
    const adapter = new TraeAdapter();
    const base = {
      prompt: "fixture\nsecond line", cwd: "/tmp", mode: "readonly" as const,
      timeoutMs: 1000, hookMetricsDir: "/tmp", onEvent: () => {},
    };
    assert.deepEqual(adapter.buildCommand({ ...base, model: "auto" }), {
      args: ["exec", "--json", "-C", "/tmp", "--skip-git-repo-check", "-s", "read-only", "-c", 'approval_policy="never"', "-"],
      stdinText: base.prompt,
    });
    assert.deepEqual(adapter.buildCommand({ ...base, mode: "write", model: "doubao-seed-code", effort: "high" }).args, [
      "exec", "--json", "-C", "/tmp", "--skip-git-repo-check", "-s", "workspace-write",
      "-c", 'approval_policy="never"', "-m", "doubao-seed-code", "-c", 'model_reasoning_effort="high"', "-",
    ]);
    for (const [mode, sandbox] of [["readonly", "read-only"], ["write", "workspace-write"]] as const) {
      assert.deepEqual(adapter.buildCommand({ ...base, mode, sessionId: "tr-thread", override: { defaultModel: "auto" } }).args, [
        "exec", "resume", "tr-thread", "--json", "--skip-git-repo-check",
        "-c", `sandbox_mode="${sandbox}"`, "-c", 'approval_policy="never"', "-",
      ]);
    }
    assert.equal(adapter.capabilities.supportsStrictReadonly, true);
    assert.equal(adapter.capabilities.hasOsReadonlySandbox, true);
  });

  it("runs a local TRAE fixture through the shared stream parser and generic fallback", async () => {
    const dir = makeTempDir("poly-trae-stream-");
    const fake = path.join(dir, "trae-fixture.mjs");
    fs.writeFileSync(fake, `#!${process.execPath}
import assert from "node:assert/strict";
import fs from "node:fs";
const args = process.argv.slice(2);
assert.equal(args.at(-1), "-");
assert.equal(args[args.indexOf("-s") + 1], "read-only");
const prompt = fs.readFileSync(0, "utf8");
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (prompt === "fail") {
  emit({ type: "turn.failed", error: { message: "429 rate limit exceeded" } });
} else {
  assert.equal(prompt, "fixture\\ninput");
  emit({ type: "thread.started", thread_id: "tr-thread" });
  emit({ type: "turn.started", model: "doubao-seed-code" });
  emit({ type: "item.started", item: { type: "command_execution", command: "fixture-command" } });
  emit({ type: "item.completed", item: { type: "command_execution", aggregated_output: "fixture-output" } });
  emit({ type: "turn.completed", usage: { input_tokens: 240, cached_input_tokens: 200, output_tokens: 15 } });
  emit({ type: "result", result: "Fixture complete" });
}
`, { mode: 0o700 });
    const titles: Array<string | undefined> = [];
    const adapter = new TraeAdapter();
    const input = {
      cwd: dir, mode: "readonly" as const, model: "auto", timeoutMs: 5000,
      hookMetricsDir: dir, override: { command: fake }, onEvent: (event: { title?: string }) => titles.push(event.title),
    };
    const ok = await adapter.runTurn({ ...input, prompt: "fixture\ninput" });
    assert.equal(ok.ok, true);
    assert.equal(ok.sessionId, "tr-thread");
    assert.equal(ok.actualModel, "doubao-seed-code");
    assert.equal(ok.outputText, "Fixture complete");
    assert.equal(ok.toolCallsCount, 1);
    assert.equal(ok.usage.accuracy, "exact");
    assert.equal(ok.usage.cache_read_tokens, 200);
    assert.equal(ok.usage.total_tokens, 255);
    assert.ok(titles.includes("TRAE Usage"));

    const failed = await adapter.runTurn({ ...input, prompt: "fail" });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorKind, "quota_exhausted");
  });

  it("uses the TRAE catalog when available and falls back without an authenticated catalog", async () => {
    const dir = makeTempDir("poly-trae-models-");
    const fake = path.join(dir, "trae-fixture");
    fs.writeFileSync(fake, `#!/bin/sh
[ "$*" = 'models --json' ] || exit 2
[ "$POLY_TRAE_CATALOG" = yes ] || exit 1
echo '{"models":[{"id":"custom-trae","display_name":"TRAE Custom"}]}'
`, { mode: 0o700 });
    const adapter = new TraeAdapter();
    const detected = await adapter.listAvailableModels({ command: fake, env: { POLY_TRAE_CATALOG: "yes" } });
    assert.deepEqual(detected.map(({ id, source }) => [id, source]).slice(0, 2), [
      ["custom-trae", "detected"], ["auto", "fallback"],
    ]);
    const fallback = await adapter.listAvailableModels({ command: fake, env: { POLY_TRAE_CATALOG: "no" } });
    assert.equal(fallback[0]?.label, "Auto (TRAE 智能路由)");
    assert.ok(fallback.every((model) => model.source === "fallback"));
    assert.deepEqual(parseTraeModelsOutput("Available models:\nmodel-one\nseed-code\tSeed Code\nseed-code - duplicate"), [
      { id: "model-one", label: "model-one" }, { id: "seed-code", label: "Seed Code" },
    ]);
  });

  it("omits redundant or incompatible AGY effort for concrete catalog models", () => {
    const adapter = new AgyAdapter();
    const base = {
      prompt: "fixture", cwd: "/tmp", mode: "readonly" as const,
      timeoutMs: 1000, hookMetricsDir: "/tmp", onEvent: () => {},
    };
    assert.deepEqual(adapter.buildCommand({
      ...base, override: { defaultModel: "gemini-4-hydrogen-high", defaultEffort: "xhigh" },
    }).args.slice(-2), ["--model", "gemini-4-hydrogen-high"]);
    assert.deepEqual(adapter.buildCommand({
      ...base, model: "gemini-4-hydrogen-xhigh", effort: "high", sessionId: "resume",
    }).args.slice(-2), ["--model", "gemini-4-hydrogen-xhigh"]);
    assert.deepEqual(adapter.buildCommand({
      ...base, model: "gemini-pro-orchestrator-neon", effort: "xhigh",
    }).args.slice(-2), ["--model", "gemini-pro-orchestrator-neon"]);
    assert.deepEqual(adapter.buildCommand({
      ...base, model: "gemini-4-hydrogen", effort: "xhigh",
    }).args.slice(-4), ["--model", "gemini-4-hydrogen", "--effort", "xhigh"]);
  });

  it("distinguishes a denied read-only shell with no answer from a recovered AGY turn", async () => {
    const dir = makeTempDir("poly-agy-denied-");
    const fake = path.join(dir, "agy-fixture");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
assert.equal(args[args.indexOf("--mode") + 1], "plan");
assert.ok(!args.includes("--dangerously-skip-permissions"));
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const step = (step_update) => send({ event: "step_update", step_update });
const prompt = args[args.indexOf("-p") + 1];
if (prompt === "readonly-file") {
  step({ step_type: "tool", tool_name: "read_file", state: "error",
    tool_info: { error: { message: "permission check failed for read_file: user denied permission" } } });
  process.stderr.write('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
  process.exit(0);
}
step({ step_type: "agent_response", text_delta: "I will inspect the workspace." });
step({ step_type: "tool", tool_name: "run_command", state: "error",
  tool_info: { error: { message: "permission check failed for unsandboxed command" } } });
if (prompt === "recover") {
  step({ step_type: "tool", tool_name: "read_file", state: "done", result: "source read" });
  send({ event: "result", result: { status: "SUCCESS", response: "[done] Verified using read_file.", conversation_id: "agy-test" } });
} else if (prompt === "terminal-error") {
  send({ event: "result", result: { status: "ERROR", error: "invalid model selection" } });
} else {
  send({ event: "result", result: { status: "SUCCESS", response: "I will inspect the workspace." } });
}
`, { mode: 0o700 });
    const adapter = new AgyAdapter();
    const run = (prompt: string) => adapter.runTurn({
      prompt, cwd: dir, mode: "readonly", timeoutMs: 5_000, hookMetricsDir: dir,
      override: { command: fake }, onEvent: () => {},
    });
    const blocked = await run("blocked");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorKind, "permission_denied");
    assert.match(blocked.errorMessage ?? "", /no follow-up answer/);
    const fileDenied = await run("readonly-file");
    assert.equal(fileDenied.ok, false);
    assert.equal(fileDenied.errorKind, "permission_denied");
    assert.match(fileDenied.errorMessage ?? "", /permitted workspace inputs/);
    const recovered = await run("recover");
    assert.equal(recovered.ok, true);
    assert.equal(recovered.outputText, "[done] Verified using read_file.");
    assert.equal(recovered.sessionId, "agy-test");
    const failed = await run("terminal-error");
    assert.equal(failed.ok, false);
    assert.equal(failed.errorKind, "config_error");
  });

  it("builds accurate CLI flags for all 7 backends in readonly and write modes", () => {
    const baseInput = {
      cwd: "/tmp/proj",
      prompt: "hello",
      mode: "readonly" as const,
      sessionId: "ses-123",
      model: "test-model",
      effort: "high",
      jsonSchema: { type: "object" },
      timeoutMs: 10000,
      hookMetricsDir: "/tmp/hooks",
      onEvent: () => {},
    };

    const agyArgs = new AgyAdapter().buildCommand(baseInput).args;
    assert.ok(agyArgs.includes("--output-format") && agyArgs.includes("stream-json"));
    assert.ok(agyArgs.includes("--conversation") && agyArgs.includes("ses-123"));
    assert.ok(agyArgs.includes("--mode") && agyArgs.includes("plan"));
    assert.ok(agyArgs.includes("--json-schema"));

    const cursorWrite = new CursorAdapter().buildCommand({ ...baseInput, mode: "write" }).args;
    assert.ok(cursorWrite.includes("-f"));
    assert.ok(cursorWrite.includes("--trust"));
    assert.ok(cursorWrite.includes("--workspace") && cursorWrite.includes("/tmp/proj"));
    assert.ok(cursorWrite.includes("--resume") && cursorWrite.includes("ses-123"));

    const cursorRo = new CursorAdapter().buildCommand(baseInput).args;
    assert.ok(cursorRo.includes("--mode") && cursorRo.includes("ask"));
    assert.ok(cursorRo.includes("--trust"));
    assert.ok(cursorRo.includes("--workspace") && cursorRo.includes("/tmp/proj"));
    const curModelIdx = cursorRo.indexOf("--model");
    assert.ok(curModelIdx !== -1 && cursorRo[curModelIdx + 1] === "test-model[effort=high]");

    const cursorParam = new CursorAdapter().buildCommand({
      ...baseInput,
      model: "claude-opus-4-8[context=1m]",
      effort: "xhigh",
    }).args;
    const curParamIdx = cursorParam.indexOf("--model");
    assert.ok(
      curParamIdx !== -1 && cursorParam[curParamIdx + 1] === "claude-opus-4-8[context=1m,effort=xhigh]",
    );

    const cursorAuto = new CursorAdapter().buildCommand({
      ...baseInput,
      model: "auto",
      effort: "high",
    }).args;
    const curAutoIdx = cursorAuto.indexOf("--model");
    assert.ok(curAutoIdx !== -1 && cursorAuto[curAutoIdx + 1] === "auto");

    const cursorPreset = new CursorAdapter().buildCommand({
      ...baseInput,
      model: "grok-4.7-high-fast",
      effort: "high",
    }).args;
    const curPresetIdx = cursorPreset.indexOf("--model");
    assert.ok(curPresetIdx !== -1 && cursorPreset[curPresetIdx + 1] === "grok-4.7-high-fast");

    const grokArgs = new GrokAdapter().buildCommand(baseInput).args;
    assert.ok(grokArgs.includes("streaming-json"));
    assert.ok(grokArgs.includes("--permission-mode") && grokArgs.includes("plan"));
    assert.ok(grokArgs.includes("-r") && grokArgs.includes("ses-123"));

    const ocArgs = new OpenCodeAdapter().buildCommand({ ...baseInput, mode: "write" }).args;
    assert.deepEqual(ocArgs.slice(0, 4), ["run", "--format", "json", "--thinking"]);
    assert.equal(ocArgs.includes("--dir"), false);
    assert.equal(ocArgs.includes("--variant"), false);
    assert.ok(ocArgs.includes("--auto"));
    assert.ok(ocArgs.includes("-s") && ocArgs.includes("ses-123"));
    const mIdx = ocArgs.indexOf("-m");
    assert.ok(mIdx !== -1 && ocArgs[mIdx + 1] === "test-model#high");

    const codexNewCmd = new CodexAdapter().buildCommand({ ...baseInput, sessionId: null });
    const codexNew = codexNewCmd.args;
    assert.ok(codexNew.includes("exec") && codexNew.includes("--sandbox") && codexNew.includes("read-only"));
    assert.ok(codexNew.includes("--skip-git-repo-check"));
    assert.ok(codexNew.includes("--trust"));
    assert.ok(codexNew.includes('approval_policy="never"'));
    assert.ok(codexNew.includes("-c") && codexNew.includes('model_reasoning_effort="high"'));
    assert.equal(codexNew[codexNew.length - 1], "-");
    assert.equal(codexNewCmd.stdinText, "hello");

    const codexResumeCmd = new CodexAdapter().buildCommand(baseInput);
    const codexResume = codexResumeCmd.args;
    assert.deepEqual(codexResume.slice(0, 3), ["exec", "resume", "ses-123"]);
    assert.equal(codexResume.includes("-C"), false);
    assert.ok(codexResume.includes("--trust"));
    assert.ok(codexResume.includes('sandbox_mode="read-only"'));
    assert.ok(codexResume.includes('approval_policy="never"'));
    assert.ok(codexResume.includes("-c") && codexResume.includes('model_reasoning_effort="high"'));
    assert.equal(codexResume[codexResume.length - 1], "-");
    assert.equal(codexResumeCmd.stdinText, "hello");

    const codexResumeWrite = new CodexAdapter().buildCommand({ ...baseInput, mode: "write" }).args;
    assert.ok(codexResumeWrite.includes('sandbox_mode="workspace-write"'));
    assert.ok(codexResumeWrite.includes('approval_policy="never"'));

    assert.equal(new CodexAdapter().capabilities.supportsStrictReadonly, true);
    assert.equal(new CodexAdapter().capabilities.hasOsReadonlySandbox, true);
    assert.equal(new CursorAdapter().capabilities.supportsStrictReadonly, true);
    assert.equal(new OpenCodeAdapter().capabilities.supportsStrictReadonly, false);

    const qoderArgs = new QoderAdapter().buildCommand({ ...baseInput, mode: "write" }).args;
    assert.ok(qoderArgs.includes("--yolo"));
    assert.ok(qoderArgs.includes("-o") && qoderArgs.includes("stream-json"));
    assert.ok(qoderArgs.includes("-r") && qoderArgs.includes("ses-123"));
    assert.ok(qoderArgs.includes("-m") && qoderArgs.includes("test-model"));
    assert.ok(qoderArgs.includes("--reasoning-effort") && qoderArgs.includes("high"));

    const qoderRo = new QoderAdapter().buildCommand(baseInput).args;
    assert.ok(
      qoderRo.includes("--permission-mode") &&
        qoderRo.includes("dont_ask") &&
        qoderRo.includes("--disallowed-tools"),
    );

    const cbArgs = new CodeBuddyAdapter().buildCommand(baseInput).args;
    assert.ok(cbArgs.includes("-p") && cbArgs.includes("stream-json") && cbArgs.includes("--verbose"));
    assert.ok(cbArgs.includes("-r") && cbArgs.includes("ses-123"));
    assert.ok(cbArgs.includes("--permission-mode") && cbArgs.includes("plan"));
    assert.ok(cbArgs.includes("--model") && cbArgs.includes("test-model"));
    assert.ok(cbArgs.includes("--effort") && cbArgs.includes("high"));
    assert.ok(cbArgs.includes("--json-schema"));
  });

  it("parses opencode multi-step JSON stream with exact accumulated tokens and cost", () => {
    const adapter = new OpenCodeAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const tracker = createTurnTracker();
    const events: Array<{ kind: string; title?: string; content: string }> = [];
    const lines = [
      JSON.stringify({ type: "step_start", sessionID: "ses_oc_99", part: { snapshot: "s1" } }),
      JSON.stringify({ type: "thinking", sessionID: "ses_oc_99", part: { text: "inspecting..." } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_oc_99",
        part: { tool: "read", state: { input: { file: "a.ts" }, output: "content" } },
      }),
      JSON.stringify({ type: "text", sessionID: "ses_oc_99", part: { text: "All good." } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_oc_99",
        part: {
          reason: "stop",
          tokens: { total: 500, input: 100, output: 50, reasoning: 20, cache: { read: 300, write: 30 } },
          cost: 0.0025,
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_oc_99",
        part: {
          reason: "stop",
          tokens: { total: 200, input: 120, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.0015,
        },
      }),
    ];

    for (const line of lines) {
      adapter.handleStdoutLine(line, tracker, (e) => events.push(e as { kind: string; title?: string; content: string }));
    }

    assert.equal(tracker.sessionId, "ses_oc_99");
    assert.equal(tracker.toolCallsCount, 1);
    assert.equal(tracker.textParts.join(""), "All good.");
    assert.equal(tracker.usage?.accuracy, "exact");
    assert.equal(tracker.usage?.input_tokens, 220);
    assert.equal(tracker.usage?.output_tokens, 130);
    assert.equal(tracker.usage?.cache_read_tokens, 300);
    assert.ok(Math.abs((tracker.usage?.cost_usd ?? 0) - 0.004) < 1e-9);
    assert.ok(events.some((e) => e.kind === "thought"));
    assert.ok(events.some((e) => e.kind === "tool_call" && e.title === "read"));
  });

  it("parses codex JSON events and extracts thread_id and usage", () => {
    const adapter = new CodexAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const tracker = createTurnTracker();
    const events: unknown[] = [];

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "0199a213-thread" }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "PASS" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fixed bug." } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2400, cached_input_tokens: 2000, output_tokens: 150 },
      }),
    ];

    for (const l of lines) adapter.handleStdoutLine(l, tracker, (e) => events.push(e));
    assert.equal(tracker.sessionId, "0199a213-thread");
    assert.equal(tracker.toolCallsCount, 1);
    assert.equal(tracker.textParts.join(""), "Fixed bug.");
    assert.equal(tracker.usage?.input_tokens, 2400);
    assert.equal(tracker.usage?.cache_read_tokens, 2000);
    assert.equal(tracker.usage?.output_tokens, 150);
    assert.equal(tracker.usage?.total_tokens, 2550);
  });

  it("runs fake streaming CLI subprocess via CursorAdapter, consumes hook metrics, and supports abort", async () => {
    const workDir = makeTempDir("poly-cursor-sim-");
    const hookDir = makeTempDir("poly-cursor-hooks-");
    const fakeScript = path.join(workDir, "fake-cursor.mjs");
    fs.writeFileSync(
      fakeScript,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--slow")) {
  setTimeout(() => {}, 15000);
} else {
  console.log(JSON.stringify({ type: "system", session_id: "cur-ses-77", model: "sonnet-4" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "checking" }] } }));
  console.log(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "a.ts" } } } }));
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { result: { ok: true } } } }));
  console.log(JSON.stringify({ type: "result", session_id: "cur-ses-77", result: "[done] verified" }));
}
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      path.join(hookDir, "cursor-cur-ses-77.json"),
      JSON.stringify({ input_tokens: 888, output_tokens: 111, cache_read_tokens: 222, cost_usd: 0.005 }),
      "utf8",
    );

    const adapter = new CursorAdapter();
    const events: Array<{ kind: string }> = [];
    const res = await adapter.runTurn({
      cwd: workDir,
      prompt: "review",
      mode: "readonly",
      timeoutMs: 5000,
      hookMetricsDir: hookDir,
      override: { command: fakeScript },
      onEvent: (ev) => events.push(ev),
    });

    assert.equal(res.ok, true);
    assert.equal(res.sessionId, "cur-ses-77");
    assert.equal(res.outputText, "[done] verified");
    assert.equal(res.toolCallsCount, 1);
    assert.equal(res.usage.accuracy, "hook");
    assert.equal(res.usage.input_tokens, 888);
    assert.equal(res.usage.output_tokens, 111);
    assert.ok(events.some((e) => e.kind === "thought"));

    // Abort cancellation check
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const cancelledRes = await adapter.runTurn({
      cwd: workDir,
      prompt: "slow",
      mode: "readonly",
      timeoutMs: 10000,
      hookMetricsDir: hookDir,
      override: { command: fakeScript, extraArgs: ["--slow"] },
      signal: controller.signal,
      onEvent: () => {},
    });
    assert.equal(cancelledRes.ok, false);
    assert.equal(cancelledRes.errorKind, "cancelled");
  });

  it("classifies quota, auth, timeout, and cancellation errors reliably", () => {
    assert.equal(
      classifyError({ exitCode: 1, stderr: "HTTP 429 rate limit exceeded", timedOut: false, cancelled: false }),
      "quota_exhausted",
    );
    assert.equal(
      classifyError({ exitCode: 1, stderr: "401 Unauthorized: login required", timedOut: false, cancelled: false }),
      "auth_error",
    );
    assert.equal(
      classifyError({ exitCode: 1, stderr: "", timedOut: true, cancelled: false }),
      "timeout",
    );
    assert.equal(
      classifyError({ exitCode: 1, stderr: "", timedOut: false, cancelled: true }),
      "cancelled",
    );
  });

  it("classifies Codex missing environment and Cursor stalled reconnects separately", () => {
    const status = { exitCode: 1, stderr: "", timedOut: false, cancelled: false };
    assert.equal(classifyError({ ...status, lastErrorText: "Missing environment variable: `CLIPROXY_API_KEY`." }), "config_error");
    assert.equal(classifyError({ ...status, stderr: "RetriableError: Agent turn stopped after repeated resume attempts made no progress" }), "connection_error");
    assert.equal(classifyError({ ...status, stderr: "Error: [unavailable]" }), "connection_error");
    assert.equal(classifyError({ ...status, stderr: "Error: [unavailable] feature flag" }), "unknown");
  });

  it("passes an owner-only environment file to the worker and rejects an exposed file before starting it", async () => {
    const dir = makeTempDir("poly-codex-env-");
    const file = path.join(dir, "credential");
    const cli = path.join(dir, "fake-codex");
    fs.writeFileSync(file, "fixture-value\n", { mode: 0o600 });
    fs.writeFileSync(cli, `#!${process.execPath}
if (process.env.POLY_TEST_CREDENTIAL !== "fixture-value") process.exit(1);
process.stdout.write(JSON.stringify({ type:"item.completed", item:{type:"agent_message", text:"bridge ok"} }) + "\\n");
`, { mode: 0o700 });
    const input = {
      cwd: dir, prompt: "test", mode: "readonly" as const, timeoutMs: 5000, hookMetricsDir: dir,
      override: { command: cli, envFiles: { POLY_TEST_CREDENTIAL: file } }, onEvent: () => {},
    };
    const adapter = new CodexAdapter();
    const ok = await adapter.runTurn(input);
    assert.equal(ok.ok, true);
    assert.equal(ok.outputText, "bridge ok");
    assert.equal(process.env.POLY_TEST_CREDENTIAL, undefined);
    fs.chmodSync(file, 0o644);
    const blocked = await adapter.runTurn(input);
    assert.equal(blocked.errorKind, "config_error");
    assert.equal(blocked.exitCode, null);
    assert.match(blocked.errorMessage ?? "", /private environment file for POLY_TEST_CREDENTIAL/);
    assert.equal(blocked.errorMessage?.includes(file), false);
  });

  it("parses real grok streaming-json events with data chunks, tool_call_update, and end cumulative usage", () => {
    const adapter = new GrokAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const tracker = createTurnTracker();
    const events: Array<{ kind: string; title?: string; content: string }> = [];
    const lines = [
      JSON.stringify({ type: "available_commands", tools: ["read_file", "grep"], commands: ["compact"] }),
      JSON.stringify({ type: "text", data: "@coordinator " }),
      JSON.stringify({ type: "text", data: "[review_pass] ok" }),
      JSON.stringify({
        type: "usage",
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 50,
        },
      }),
      JSON.stringify({ type: "tool_call" }),
      JSON.stringify({
        type: "tool_call_update",
        toolCallId: "call-1",
        status: null,
        locations: [{ path: "/tmp/proj/package.json" }],
      }),
      JSON.stringify({
        type: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "{\"name\":\"poly-swarm\"}" } }],
        rawOutput: { type: "ReadFile" },
      }),
      JSON.stringify({
        type: "end",
        stopReason: "end_turn",
        sessionId: "grok-real-ses-1",
        usage: {
          input_tokens: 33435,
          cache_read_input_tokens: 34944,
          cache_creation_input_tokens: 0,
          output_tokens: 1657,
          reasoning_tokens: 1507,
          total_tokens: 70036,
        },
        total_cost_usd: 0.03205656,
      }),
    ];

    for (const line of lines) {
      adapter.handleStdoutLine(line, tracker, (e) =>
        events.push(e as { kind: string; title?: string; content: string }),
      );
    }

    assert.equal(tracker.sessionId, "grok-real-ses-1");
    assert.equal(tracker.toolCallsCount, 1);
    assert.equal(tracker.textParts.join(""), "@coordinator [review_pass] ok");
    assert.equal(events.some((e) => e.kind === "raw"), false);
    assert.ok(events.some((e) => e.kind === "tool_result" && e.title === "ReadFile"));
    assert.equal(tracker.usage?.input_tokens, 33435);
    assert.equal(tracker.usage?.cache_read_tokens, 34944);
    assert.equal(tracker.usage?.output_tokens, 1657);
    assert.equal(tracker.usage?.total_tokens, 70036);
    assert.ok(Math.abs((tracker.usage?.cost_usd ?? 0) - 0.03205656) < 1e-9);
  });

  it("parses opencode v2.3.2 retry rate-limit events into structured error events", () => {
    const adapter = new OpenCodeAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const tracker = createTurnTracker();
    const events: Array<{ kind: string; title?: string; content: string }> = [];
    adapter.handleStdoutLine(
      JSON.stringify({
        type: "retry",
        sessionID: "ses_oc_retry_1",
        attempt: 2,
        nextRetryAt: Date.now() + 30_000,
        error: {
          type: "provider.rate-limit",
          message: "Resource has been exhausted (e.g. check quota).",
          status: 429,
        },
      }),
      tracker,
      (e) => events.push(e as { kind: string; title?: string; content: string }),
    );

    assert.equal(tracker.sessionId, "ses_oc_retry_1");
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[0]?.title, "OpenCode Retry");
    assert.ok(tracker.lastErrorText?.includes("HTTP 429"));
    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: "",
        lastErrorText: tracker.lastErrorText,
        timedOut: false,
        cancelled: false,
      }),
      "quota_exhausted",
    );
  });

  it("parses codex turn.started/error notice and codebuddy system/errors without false quota cooldown", () => {
    const codexAdapter = new CodexAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const codexTracker = createTurnTracker();
    const codexEvents: Array<{ kind: string; title?: string }> = [];
    codexAdapter.handleStdoutLine(
      JSON.stringify({ type: "turn.started" }),
      codexTracker,
      (e) => codexEvents.push(e as { kind: string; title?: string }),
    );
    codexAdapter.handleStdoutLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "`[features].multi_agent` is deprecated." },
      }),
      codexTracker,
      (e) => codexEvents.push(e as { kind: string; title?: string }),
    );
    assert.equal(codexEvents[0]?.kind, "system");
    assert.equal(codexEvents[0]?.title, "turn.started");
    assert.equal(codexEvents[1]?.kind, "system");
    assert.equal(codexEvents[1]?.title, "codex.notice");

    const cbAdapter = new CodeBuddyAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const cbTracker = createTurnTracker();
    const cbEvents: Array<{ kind: string; title?: string; content: string }> = [];
    cbAdapter.handleStdoutLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cb-ses-1",
        model: "hy4-preview",
        permissionMode: "plan",
      }),
      cbTracker,
      (e) => cbEvents.push(e as { kind: string; title?: string; content: string }),
    );
    cbAdapter.handleStdoutLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "cb-ses-1",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        errors: ["Authentication required. Please use /login command to sign in to your account"],
        _meta: { creditStatus: "unknown" },
      }),
      cbTracker,
      (e) => cbEvents.push(e as { kind: string; title?: string; content: string }),
    );

    assert.equal(cbTracker.sessionId, "cb-ses-1");
    assert.equal(cbEvents[0]?.kind, "system");
    assert.equal(cbEvents[0]?.title, "init");
    assert.equal(cbEvents.some((e) => e.kind === "usage"), false);
    assert.equal(
      cbTracker.lastErrorText,
      "Authentication required. Please use /login command to sign in to your account",
    );
    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: "",
        lastErrorText: cbTracker.lastErrorText,
        timedOut: false,
        cancelled: false,
      }),
      "auth_error",
    );
  });

  it("ignores non-fatal MCP stderr warnings when exitCode is 0 and parses codebuddy assistant/user stream cleanly", () => {
    assert.equal(
      classifyError({
        exitCode: 0,
        stderr:
          '2026-11-23T03:13:03Z ERROR rmcp::transport::worker: when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer" })',
        lastErrorText: null,
        timedOut: false,
        cancelled: false,
      }),
      "none",
    );

    const cursorAdapter = new CursorAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const curTracker = createTurnTracker();
    const curEvents: Array<{ kind: string; title?: string }> = [];
    cursorAdapter.handleStdoutLine(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
      curTracker,
      (e) => curEvents.push(e as { kind: string; title?: string }),
    );
    assert.equal(curEvents[0]?.kind, "system");

    const cbAdapter = new CodeBuddyAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const cbTracker = createTurnTracker();
    const cbEvents: Array<{ kind: string; title?: string; content: string }> = [];
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "cb-ok-1", model: "fast-model", permissionMode: "plan" }),
      JSON.stringify({
        type: "assistant",
        session_id: "cb-ok-1",
        message: {
          content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "package.json" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: "cb-ok-1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"name":"poly-swarm"}' }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "cb-ok-1",
        message: {
          content: [
            { type: "thinking", thinking: "Verified package.json." },
            { type: "text", text: "@coordinator [review_pass] poly-swarm v0.1.0" },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        session_id: "cb-ok-1",
        result: "@coordinator [review_pass] poly-swarm v0.1.0",
        usage: { input_tokens: 76101, output_tokens: 151, cache_read_input_tokens: 50432 },
        total_cost_usd: 0,
      }),
    ];

    for (const line of lines) {
      cbAdapter.handleStdoutLine(line, cbTracker, (e) =>
        cbEvents.push(e as { kind: string; title?: string; content: string }),
      );
    }

    assert.equal(cbTracker.sessionId, "cb-ok-1");
    assert.equal(cbTracker.toolCallsCount, 1);
    assert.equal(cbTracker.lastResultText, "@coordinator [review_pass] poly-swarm v0.1.0");
    assert.equal(cbTracker.textParts.join(""), "@coordinator [review_pass] poly-swarm v0.1.0");
    assert.equal(cbEvents.some((e) => e.kind === "raw"), false);
    assert.ok(cbEvents.some((e) => e.kind === "thought"));
    assert.ok(cbEvents.some((e) => e.kind === "tool_call" && e.title === "Read"));
    assert.ok(cbEvents.some((e) => e.kind === "tool_result" && e.title === "call_1"));
    assert.equal(cbTracker.usage?.input_tokens, 76101);
    assert.equal(cbTracker.usage?.cache_read_tokens, 50432);
    assert.equal(cbTracker.usage?.output_tokens, 151);
  });

  it("parses real agy init and step_update stream with exact usage and tool calls", () => {
    const adapter = new AgyAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const tracker = createTurnTracker();
    const events: Array<{ kind: string; title?: string; content: string }> = [];
    const lines = [
      JSON.stringify({ event: "init", conversation_id: "agy-conv-1", init: { cwd: "/tmp/repo", tools: ["read_file", "run_command"] } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " } }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "Poly-Swarm",
          usage: { input_tokens: 1200, output_tokens: 80, thinking_tokens: 40, cache_read_tokens: 300 },
        },
      }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { parameters: { Path: "src/a.ts" } } } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { result: "ok" } } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 4, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { error: { message: "denied" } } } }),
    ];

    for (const line of lines) {
      adapter.handleStdoutLine(line, tracker, (e) => events.push(e as { kind: string; title?: string; content: string }));
    }

    assert.equal(tracker.sessionId, "agy-conv-1");
    assert.equal(tracker.textParts.join(""), "Hello Poly-Swarm");
    assert.equal(tracker.toolCallsCount, 1);
    assert.equal(tracker.usage?.accuracy, "exact");
    assert.equal(tracker.usage?.input_tokens, 1200);
    assert.equal(tracker.usage?.output_tokens, 80);
    assert.equal(tracker.usage?.reasoning_tokens, 40);
    assert.equal(tracker.usage?.cache_read_tokens, 300);
    assert.equal(events.some((e) => e.kind === "raw"), false);
    assert.ok(events.some((e) => e.kind === "error" && e.title === "run_command" && e.content === "denied"));
  });

  it("catches exit-0 fatal is_error (codebuddy 400), detects config_error, avoids 14013 false positive, and recovers opencode retry", async () => {
    const workDir = makeTempDir("poly-cb-err-");
    const fakeCb = path.join(workDir, "fake-cb.mjs");
    fs.writeFileSync(
      fakeCb,
      `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "cb-err-1", model: "primary-model" }));
console.log(JSON.stringify({ type: "result", is_error: true, session_id: "cb-err-1", result: "400 model [primary-model] service info not found" }));
`,
      { mode: 0o755 },
    );

    const cbRes = await new CodeBuddyAdapter().runTurn({
      cwd: workDir,
      prompt: "hi",
      mode: "readonly",
      timeoutMs: 5000,
      hookMetricsDir: workDir,
      override: { command: fakeCb },
      onEvent: () => {},
    });
    assert.equal(cbRes.ok, false);
    assert.equal(cbRes.errorKind, "config_error");

    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: 'Ambiguous model "DeepSeek-Flash". Specify a model key: dfmodel',
        timedOut: false,
        cancelled: false,
      }),
      "config_error",
    );

    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: "Build failed on line 14013",
        timedOut: false,
        cancelled: false,
      }),
      "unknown",
    );

    const oc = new OpenCodeAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const ocTracker = createTurnTracker();
    oc.handleStdoutLine(
      JSON.stringify({ type: "retry", error: { type: "rate-limit", status: 429, message: "retry" } }),
      ocTracker,
      () => {},
    );
    oc.handleStdoutLine(JSON.stringify({ type: "text", part: { text: "Recovered OK" } }), ocTracker, () => {});
    oc.handleStdoutLine(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }), ocTracker, () => {});
    assert.equal(
      classifyError({
        exitCode: 0,
        stderr: "",
        lastErrorText: ocTracker.lastErrorText,
        hasFatalError: ocTracker.hasFatalError,
        timedOut: false,
        cancelled: false,
      }),
      "none",
    );
  });

  it("parses model lists from agy, cursor, codebuddy, and qoder CLI outputs", () => {
    const agyModels = parseAgyModelsOutput("Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\n");
    assert.deepEqual(agyModels, [{ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" }]);

    const curModels = parseCursorModelsOutput("Available models\n\nauto - Auto (default)\ngrok-4.7-high-fast - Grok 4.7 High Fast\n");
    assert.equal(curModels.length, 2);
    assert.equal(curModels[1]?.id, "grok-4.7-high-fast");

    const cbModels = parseCodeBuddyModelsFromHelp("  --model <model>  Currently supported: (hy4std, hy4flash-free, glm-5.3)");
    assert.equal(cbModels.length, 3);
    assert.equal(cbModels[1]?.id, "hy4flash-free");

    const qoderModels = parseQoderModelsOutput("MODEL\nAuto\nDeepSeek-Flash\nDeepSeek-Flash\ngpt-6-luna (custom-id-1)\n");
    assert.ok(qoderModels.some((m) => m.id === "Auto"));
    assert.ok(qoderModels.some((m) => m.id === "dfmodel"));
    assert.ok(qoderModels.some((m) => m.id === "custom-id-1"));
  });

  it("classifies multiline 400 model errors as config_error, catches opencode step_finish error, and flags Workspace Trust", () => {
    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: "Workspace Trust Required\nDo you trust the contents of this directory?",
        timedOut: false,
        cancelled: false,
      }),
      "auth_error",
    );
    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: "Request failed with status 400\nBad Request: invalid model tier specified",
        timedOut: false,
        cancelled: false,
      }),
      "config_error",
    );

    const oc = new OpenCodeAdapter() as unknown as {
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const tracker = createTurnTracker();
    oc.handleStdoutLine(
      JSON.stringify({ type: "step_finish", part: { reason: "error" } }),
      tracker,
      () => {},
    );
    assert.equal(tracker.hasFatalError, true);
    assert.ok(tracker.lastErrorText);
    assert.notEqual(
      classifyError({
        exitCode: 0,
        stderr: "",
        lastErrorText: tracker.lastErrorText,
        hasFatalError: tracker.hasFatalError,
        timedOut: false,
        cancelled: false,
      }),
      "none",
    );

    // exitCode=0 with stderr 429 and empty output must be classified as quota_exhausted
    assert.equal(
      classifyError({
        exitCode: 0,
        stderr: "HTTP 429 rate limit exceeded",
        hasOutput: false,
        timedOut: false,
        cancelled: false,
      }),
      "quota_exhausted",
    );
    assert.equal(
      classifyError({
        exitCode: 0,
        stderr: "HTTP 429 warning but succeeded",
        hasOutput: true,
        timedOut: false,
        cancelled: false,
      }),
      "none",
    );
  });

  it("delivers large prompts via stdinText without ARG_MAX E2BIG errors", async () => {
    const dir = makeTempDir("poly-stdin-");
    const echoScript = path.join(dir, "echo-stdin.mjs");
    fs.writeFileSync(
      echoScript,
      `#!/usr/bin/env node
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => { process.stdout.write(String(Buffer.byteLength(data, "utf8"))); });
`,
      { mode: 0o755 },
    );

    const largeText = "中文测试载荷".repeat(4000);
    const lines: string[] = [];
    const res = await spawnStreamingCli({
      command: echoScript,
      args: ["-"],
      cwd: dir,
      stdinText: largeText,
      timeoutMs: 5000,
      onLine: (stream, line) => {
        if (stream === "stdout") lines.push(line);
      },
    });
    assert.equal(res.exitCode, 0);
    assert.equal(Number(lines.join("")), Buffer.byteLength(largeText, "utf8"));
  });

  it("mounts git common dir on Codex write worktrees and tracks file_change events", () => {
    const repo = makeTempDir("poly-codex-wt-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Poly Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "poly@example.com"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const wtDir = path.join(repo, ".poly-swarm-test-wt");
    execFileSync("git", ["worktree", "add", "-b", "feat/x", wtDir, "HEAD"], { cwd: repo });

    const adapter = new CodexAdapter() as unknown as {
      buildCommand: CodexAdapter["buildCommand"];
      handleStdoutLine: (l: string, t: ReturnType<typeof createTurnTracker>, emit: (e: unknown) => void) => void;
    };
    const writeCmd = adapter.buildCommand({
      cwd: wtDir,
      prompt: "edit",
      mode: "write",
      timeoutMs: 10000,
      hookMetricsDir: "/tmp/hooks",
      onEvent: () => {},
    }).args;
    const addDirIdx = writeCmd.indexOf("--add-dir");
    assert.ok(addDirIdx !== -1);
    assert.equal(
      fs.realpathSync(writeCmd[addDirIdx + 1]!),
      fs.realpathSync(path.join(repo, ".git")),
    );

    const roCmd = adapter.buildCommand({
      cwd: wtDir,
      prompt: "read",
      mode: "readonly",
      timeoutMs: 10000,
      hookMetricsDir: "/tmp/hooks",
      onEvent: () => {},
    }).args;
    assert.equal(roCmd.includes("--add-dir"), false);

    const tracker = createTurnTracker();
    adapter.handleStdoutLine(
      JSON.stringify({ type: "item.started", item: { type: "file_change" } }),
      tracker,
      () => {},
    );
    assert.equal(tracker.hadFileChange, true);
  });

  it("supports idle activity renewal, idle timeout precedence over stderr noise, and hard turn limit", async () => {
    const dir = makeTempDir("poly-timeout-");
    const fakeCli = path.join(dir, "fake-cli.mjs");
    fs.writeFileSync(
      fakeCli,
      `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === "heartbeat") {
  console.log(JSON.stringify({ text: "beat-0" }));
  let count = 0;
  const iv = setInterval(() => {
    count += 1;
    console.log(JSON.stringify({ text: "beat-" + count }));
    if (count >= 10) {
      clearInterval(iv);
      process.exit(0);
    }
  }, 180);
} else if (mode === "silent-with-stderr") {
  console.error("ERROR rmcp::transport::worker: AuthRequired unrelated MCP noise");
  setTimeout(() => process.exit(0), 4000);
} else if (mode === "endless-stdout") {
  console.log(JSON.stringify({ text: "tick-0" }));
  const iv = setInterval(() => console.log(JSON.stringify({ text: "tick" })), 60);
}
`,
      { mode: 0o755 },
    );

    class TestStreamAdapter extends BaseCliAdapter {
      readonly id = "mock" as const;
      readonly capabilities = {
        supportsAcp: false,
        supportsHeadless: true,
        supportsResume: false,
        supportsExactUsage: false,
        supportsStrictReadonly: true,
        defaultBinaryCandidates: [fakeCli],
      };
      buildCommand() {
        return { args: [] };
      }
      protected handleStdoutLine(line: string, tracker: ReturnType<typeof createTurnTracker>) {
        const parsed = JSON.parse(line) as { text?: string };
        if (parsed.text) tracker.textParts.push(parsed.text);
      }
    }

    const adapter = new TestStreamAdapter();

    // 1. Active stdout heartbeats reset idle timer and succeed beyond single idleTimeoutMs
    const okRes = await adapter.runTurn({
      cwd: dir,
      prompt: "hb",
      mode: "readonly",
      timeoutMs: 6000,
      idleTimeoutMs: 1400,
      hookMetricsDir: dir,
      override: { command: fakeCli, extraArgs: ["heartbeat"] },
      onEvent: () => {},
    });
    assert.equal(okRes.ok, true, okRes.errorMessage ?? "");
    assert.match(okRes.outputText, /beat-10/);

    // 2. Idle hang with noisy stderr fails with idle timeout message, not masked by stderr
    const idleRes = await adapter.runTurn({
      cwd: dir,
      prompt: "idle",
      mode: "readonly",
      timeoutMs: 4000,
      idleTimeoutMs: 350,
      hookMetricsDir: dir,
      override: { command: fakeCli, extraArgs: ["silent-with-stderr"] },
      onEvent: () => {},
    });
    assert.equal(idleRes.ok, false);
    assert.equal(idleRes.errorKind, "timeout");
    assert.match(idleRes.errorMessage ?? "", /idle limit 350ms with no stdout activity/);
    assert.equal(/rmcp::transport/.test(idleRes.errorMessage ?? ""), false);

    // 3. Endless stdout past hard wall-clock timeout fails with hard limit message
    const hardRes = await adapter.runTurn({
      cwd: dir,
      prompt: "hard",
      mode: "readonly",
      timeoutMs: 900,
      idleTimeoutMs: 750,
      hookMetricsDir: dir,
      override: { command: fakeCli, extraArgs: ["endless-stdout"] },
      onEvent: () => {},
    });
    assert.equal(hardRes.ok, false);
    assert.equal(hardRes.errorKind, "timeout");
    assert.match(hardRes.errorMessage ?? "", /Timed out after 900ms \(hard turn limit\)/);
  });

  it("reports honest supportsAcp/cliSupportsAcp/activeProtocol, preserves model provenance, and extracts actualModel only when reported", async () => {
    for (const adapter of [
      new AgyAdapter(),
      new CodeBuddyAdapter(),
      new GrokAdapter(),
      new OpenCodeAdapter(),
      new QoderAdapter(),
      new TraeAdapter(),
    ]) {
      assert.equal(adapter.capabilities.supportsAcp, false);
      assert.equal(adapter.capabilities.cliSupportsAcp, true);
      assert.equal(adapter.capabilities.activeProtocol, "headless_cli");
    }
    for (const adapter of [new CodexAdapter(), new CursorAdapter(), new MockAdapter()]) {
      assert.equal(adapter.capabilities.supportsAcp, false);
      assert.equal(adapter.capabilities.cliSupportsAcp, false);
      assert.equal(adapter.capabilities.activeProtocol, "headless_cli");
    }

    const detectedTs = 1_700_000_000_123;
    const merged = mergeModelOptions(
      [{ id: "live-m1", label: "Live 1" }],
      [{ id: "static-m1", label: "Static 1" }],
      "custom-cfg",
      detectedTs,
    );
    assert.deepEqual(merged[0], {
      id: "custom-cfg",
      label: "custom-cfg (当前配置)",
      source: "configured",
      detected_at: null,
    });
    assert.deepEqual(merged[1], {
      id: "live-m1",
      label: "Live 1",
      source: "detected",
      detected_at: detectedTs,
    });
    assert.deepEqual(merged[2], {
      id: "static-m1",
      label: "Static 1",
      source: "fallback",
      detected_at: null,
    });

    const dir = makeTempDir("poly-actual-model-");
    const fakeScript = path.join(dir, "fake-stream.mjs");
    fs.writeFileSync(
      fakeScript,
      `#!/usr/bin/env node
if (process.argv.includes("cursor")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-c", model: "gpt-5.6-sol-high" }));
  console.log(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
} else if (process.argv.includes("no-model")) {
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
  console.log(JSON.stringify({ type: "result", is_error: false, result: "hi" }));
}
`,
      { mode: 0o755 },
    );

    const cursorRes = await new CursorAdapter().runTurn({
      cwd: dir,
      prompt: "test",
      mode: "readonly",
      model: "requested-only",
      timeoutMs: 3000,
      hookMetricsDir: dir,
      override: { command: fakeScript, extraArgs: ["cursor"] },
      onEvent: () => {},
    });
    assert.equal(cursorRes.actualModel, "gpt-5.6-sol-high");

    const unknownRes = await new CursorAdapter().runTurn({
      cwd: dir,
      prompt: "test",
      mode: "readonly",
      model: "requested-only",
      timeoutMs: 3000,
      hookMetricsDir: dir,
      override: { command: fakeScript, extraArgs: ["no-model"] },
      onEvent: () => {},
    });
    assert.equal(unknownRes.actualModel, null);
  });

  it("handles traecli exec/resume flags, auto model omission, and grok cancelled permission denial", async () => {
    const trae = new TraeAdapter();
    const newCmd = trae.buildCommand({
      cwd: "/tmp/proj",
      prompt: "run checks",
      mode: "readonly",
      model: "auto",
      effort: "high",
      timeoutMs: 10000,
      hookMetricsDir: "/tmp/hooks",
      onEvent: () => {},
    });
    assert.ok(newCmd.args.includes("exec") && newCmd.args.includes("-s") && newCmd.args.includes("read-only"));
    assert.equal(newCmd.args.includes("-m"), false);
    assert.equal(newCmd.args.includes("--trust"), false);
    assert.equal(newCmd.args.at(-1), "-");
    assert.equal(newCmd.stdinText, "run checks");

    const resumeCmd = trae.buildCommand({
      cwd: "/tmp/proj",
      prompt: "continue",
      mode: "write",
      sessionId: "trae-ses-1",
      model: "doubao-seed-code",
      timeoutMs: 10000,
      hookMetricsDir: "/tmp/hooks",
      onEvent: () => {},
    });
    assert.deepEqual(resumeCmd.args.slice(0, 3), ["exec", "resume", "trae-ses-1"]);
    assert.ok(resumeCmd.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(resumeCmd.args.includes("-m") && resumeCmd.args.includes("doubao-seed-code"));

    assert.equal(
      classifyError({
        exitCode: 1,
        stderr: "Error: headless Codebase Git authentication failed",
        timedOut: false,
        cancelled: false,
      }),
      "auth_error",
    );

    const dir = makeTempDir("poly-grok-perm-");
    const fakeGrok = path.join(dir, "fake-grok");
    fs.writeFileSync(
      fakeGrok,
      `#!/usr/bin/env node
console.log(JSON.stringify({ type: "text", text: "Starting inspection..." }));
console.error("permission required: codegraph__codegraph_explore was not run, as a headless run cannot ask for approval");
console.log(JSON.stringify({ type: "end", stopReason: "cancelled", usage: { input_tokens: 10, output_tokens: 5 } }));
`,
      { mode: 0o755 },
    );
    const grokRes = await new GrokAdapter().runTurn({
      cwd: dir,
      prompt: "inspect",
      mode: "readonly",
      timeoutMs: 5000,
      hookMetricsDir: dir,
      override: { command: fakeGrok },
      onEvent: () => {},
    });
    assert.equal(grokRes.ok, false);
    assert.equal(grokRes.errorKind, "permission_denied");
    assert.match(grokRes.errorMessage ?? "", /required approval/);
  });
});
