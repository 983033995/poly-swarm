import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardMessage, TurnRecord, WorkerEvent } from "../src/shared/types.js";
import {
  buildConversationBlocks,
  coalesceEvents,
  extractTurnPrompt,
  formatToolPayload,
  summarizeToolStep,
} from "../src/ui/trace_model.js";

function makeEvent(
  seq: number,
  kind: WorkerEvent["kind"],
  title: string | null,
  content: string,
  ts = 1000 + seq * 100,
): WorkerEvent {
  return {
    id: seq,
    turn_id: "turn-1",
    swarm_id: "sw-1",
    worker_name: "w1",
    seq_in_turn: seq,
    kind,
    title,
    content,
    meta_json: null,
    created_at: ts,
  };
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    swarm_id: "sw-1",
    worker_name: "w1",
    backend: "grok",
    model: "grok-4.7-build-fast",
    mode: "readonly",
    trigger_seq: 1,
    prompt_preview:
      "You are worker '@w1'...\n\nNew board messages for you:\n\n#1 [main] coordinator (brief): @w1 Read package.json",
    status: "completed",
    error_kind: "none",
    error_message: null,
    output_text: "@coordinator [review_pass] ok",
    structured_json: null,
    session_id_used: null,
    session_id_returned: "ses-1",
    duration_ms: 1200,
    tool_calls_count: 1,
    started_at: 1000,
    ended_at: 2200,
    ...overrides,
  };
}

describe("Trace Model (coalesceEvents, buildConversationBlocks, extractTurnPrompt)", () => {
  it("coalesces adjacent thought/text delta chunks and repeated adjacent system lines", () => {
    const events: WorkerEvent[] = [
      makeEvent(1, "system", "available_commands", "tools=26 commands=155"),
      makeEvent(2, "system", "available_commands", "tools=26 commands=155"),
      makeEvent(3, "system", "available_commands", "tools=215 commands=155"),
      makeEvent(4, "thought", "Thinking", "I am "),
      makeEvent(5, "thought", "Thinking", "acting as "),
      makeEvent(6, "thought", "Thinking", "verifier."),
      makeEvent(7, "tool_call", "read_file", '{"target_file":"package.json"}'),
      makeEvent(8, "tool_result", "ReadFile", '{"name":"poly-swarm"}'),
      makeEvent(9, "text", null, "Hello "),
      makeEvent(10, "text", null, "world"),
      makeEvent(11, "text", null, "!"),
    ];

    const coalesced = coalesceEvents(events);
    assert.equal(coalesced.length, 5);

    assert.equal(coalesced[0]!.kind, "system");
    assert.equal(coalesced[0]!.repeatCount, 3);
    assert.equal(coalesced[0]!.firstSeq, 1);
    assert.equal(coalesced[0]!.lastSeq, 3);
    assert.equal(coalesced[0]!.content, "tools=215 commands=155");

    assert.equal(coalesced[1]!.kind, "thought");
    assert.equal(coalesced[1]!.chunkCount, 3);
    assert.equal(coalesced[1]!.content, "I am acting as verifier.");

    assert.equal(coalesced[2]!.kind, "tool_call");
    assert.equal(coalesced[3]!.kind, "tool_result");

    assert.equal(coalesced[4]!.kind, "text");
    assert.equal(coalesced[4]!.chunkCount, 3);
    assert.equal(coalesced[4]!.content, "Hello world!");
  });

  it("pairs tool_call with tool_result and falls back to turn.output_text when stream lacks text", () => {
    const turn = makeTurn({ output_text: "@coordinator [review_pass] verified" });
    const events: WorkerEvent[] = [
      makeEvent(1, "thought", "Thinking", "Checking"),
      makeEvent(2, "tool_call", "read_file", '{"path":"package.json"}', 1200),
      makeEvent(3, "tool_result", "ReadFile", '{"name":"poly-swarm"}', 1500),
    ];

    const blocks = buildConversationBlocks(turn, events);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0]!.type, "thought");
    assert.equal(blocks[1]!.type, "tool");
    if (blocks[1]!.type === "tool") {
      assert.equal(blocks[1]!.name, "read_file");
      assert.equal(blocks[1]!.completed, true);
      assert.equal(blocks[1]!.output, '{"name":"poly-swarm"}');
    }
    assert.equal(blocks[2]!.type, "text");
    if (blocks[2]!.type === "text") {
      assert.equal(blocks[2]!.text, "@coordinator [review_pass] verified");
    }
  });

  it("restores recorded Cursor thinking between its surrounding chat and tool events", () => {
    const turn = makeTurn({ backend: "cursor", output_text: null });
    const blocks = buildConversationBlocks(turn, [
      makeEvent(1, "text", null, "I will inspect the files."),
      makeEvent(2, "raw", "thinking", '{"type":"thinking","subtype":"delta","text":"Check "}'),
      makeEvent(3, "raw", "thinking", '{"type":"thinking","subtype":"delta","text":"the inputs."}'),
      makeEvent(4, "raw", "thinking", '{"type":"thinking","subtype":"completed"}'),
      makeEvent(5, "tool_call", "read_file", '{"path":"package.json"}'),
      makeEvent(6, "tool_result", "read_file", "read result"),
      makeEvent(7, "text", null, "Done."),
    ]);
    assert.deepEqual(blocks.map((block) => block.type), ["text", "thought", "tool", "text"]);
    assert.ok(blocks[1]?.type === "thought");
    assert.equal(blocks[1].text, "Check the inputs.");
  });

  it("extracts prompt from trigger message first, strips cold-boot boilerplate and leading @worker", () => {
    const turn = makeTurn();
    const msg: BoardMessage = {
      seq: 1,
      swarm_id: "sw-1",
      channel: "main",
      sender: "coordinator",
      tag: "brief",
      text: "@w1 Check package.json only",
      mentions_json: '["w1"]',
      refs_json: "[]",
      turn_id: null,
      created_at: 900,
    };

    const fromBoard = extractTurnPrompt(turn, msg);
    assert.equal(fromBoard.label, "#1 · coordinator");
    assert.equal(fromBoard.body, "Check package.json only");

    const fromPreview = extractTurnPrompt(turn, null);
    assert.equal(fromPreview.body, "Read package.json");
    assert.ok(fromPreview.fullRaw.includes("You are worker '@w1'"));
  });

  it("summarizes tool steps and decodes UTF-8 byte arrays / FileContent wrappers", () => {
    const readSummary = summarizeToolStep(
      "read_file",
      '{"target_file":"/workspace/poly-swarm/package.json"}',
    );
    assert.equal(readSummary.actionLabel, "读取文件");
    assert.equal(readSummary.targetSummary, "poly-swarm/package.json");

    const grepSummary = summarizeToolStep(
      "grep",
      '{"pattern":"poly-swarm|board","path":"/tmp"}',
    );
    assert.equal(grepSummary.actionLabel, "搜索代码");
    assert.equal(grepSummary.targetSummary, '"poly-swarm|board"');

    const cmdSummary = summarizeToolStep(
      "command_execution",
      "/bin/zsh -lc 'rtk proxy cat package.json'",
    );
    assert.equal(cmdSummary.actionLabel, "执行命令");
    assert.equal(cmdSummary.targetSummary, "rtk proxy cat package.json");

    const grepBytes = Array.from(Buffer.from("<workspace_result>ok</workspace_result>", "utf8"));
    const decodedGrep = formatToolPayload(JSON.stringify({ type: "GrepSearch", stdout: grepBytes }));
    assert.equal(decodedGrep, "<workspace_result>ok</workspace_result>");

    const unwrappedFile = formatToolPayload(
      JSON.stringify({ type: "ReadFile", FileContent: { content: '{\n  "name": "poly-swarm"\n}' } }),
    );
    assert.equal(unwrappedFile, '{\n  "name": "poly-swarm"\n}');
  });

  it("does not duplicate turn.output_text when streaming text chunks differ only by whitespace", () => {
    const turn = makeTurn({
      output_text: "我先只读 package.json。@coordinator [review_pass] 完成。",
    });
    const events: WorkerEvent[] = [
      makeEvent(1, "text", null, "我先只读 package.json。", 1100),
      makeEvent(2, "tool_call", "read_file", '{"target_file":"package.json"}', 1200),
      makeEvent(3, "tool_result", "ReadFile", '{"FileContent":{"content":"{}"}}', 1300),
      makeEvent(4, "text", null, "@coordinator [review_pass] 完成。", 1400),
    ];

    const blocks = buildConversationBlocks(turn, events);
    const textBlocks = blocks.filter((b) => b.type === "text");
    assert.equal(textBlocks.length, 2);
  });
});
