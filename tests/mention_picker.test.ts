import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelRecord, WorkerSummary } from "../src/shared/types.js";
import {
  applyMentionSelection,
  buildMentionCandidates,
  detectMentionTrigger,
  filterMentionCandidates,
} from "../src/ui/mention_picker.js";

function makeWorker(overrides: Partial<WorkerSummary>): WorkerSummary {
  return {
    id: "w-1",
    swarm_id: "sw-1",
    name: "reg-grok",
    role: "verifier",
    capability: "verifier",
    backend: "grok",
    model: "grok-4.7-build-fast",
    effort: "low",
    workspace_mode: "inherit",
    workspace_path: "/tmp",
    worktree_branch: null,
    channels_json: '["main"]',
    review_of: null,
    state: "waiting",
    session_id: null,
    needs_handoff: 0,
    auto_fallback: 1,
    last_read_seq: 0,
    last_post_seq: 0,
    last_error: null,
    created_at: 1000,
    updated_at: 1000,
    channels: ["main"],
    latest_turn: null,
    latest_event: null,
    usage: {
      key: "reg-grok",
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      duration_ms: 0,
      tool_calls_count: 0,
      exact_turns: 0,
      hook_turns: 0,
      estimated_turns: 0,
    },
    ...overrides,
  };
}

function makeChannel(name: string, archived = 0, topic: string | null = null): ChannelRecord {
  return {
    id: 1,
    swarm_id: "sw-1",
    name,
    topic,
    archived,
    created_at: 1000,
  };
}

describe("Mention Picker (@ autocomplete)", () => {
  it("detects valid @ triggers (bare, post-space, post-CJK, channel) and ignores emails", () => {
    assert.deepEqual(detectMentionTrigger("@", 1), { start: 0, end: 1, query: "" });
    assert.deepEqual(detectMentionTrigger("hello @gr", 9), { start: 6, end: 9, query: "gr" });
    assert.deepEqual(detectMentionTrigger("请@gr核对", 4), { start: 1, end: 4, query: "gr" });
    assert.deepEqual(detectMentionTrigger("@reg-codex 请看 @#rev", 19), {
      start: 14,
      end: 19,
      query: "#rev",
    });
    assert.equal(detectMentionTrigger("user@example.com", 16), null);
    assert.equal(detectMentionTrigger("hello @reg ", 11), null);
  });

  it("builds @all first, excludes killed workers, and omits archived channels", () => {
    const candidates = buildMentionCandidates({
      workers: [
        makeWorker({ name: "reg-grok", backend: "grok", state: "waiting" }),
        makeWorker({ name: "dead-worker", backend: "cursor", state: "killed" }),
        makeWorker({ name: "dev-codex", backend: "codex", model: null, state: "working" }),
      ],
      channels: [
        makeChannel("main", 0, "主频道"),
        makeChannel("review", 0, "交叉评审"),
        makeChannel("old-tmp", 1, "已归档"),
      ],
      effectiveDefaults: { codex: { model: "gpt-6.2-sol", effort: "high" } },
      avatarFor: (b) => ({ letter: b[0]!.toUpperCase(), bg: "#111" }),
      stateLabel: (s) => s,
    });

    assert.equal(candidates[0]?.insertText, "@all");
    assert.ok(candidates[0]?.sublabel.includes("2 位"));
    const labels = candidates.map((c) => c.insertText);
    assert.deepEqual(labels, ["@all", "@reg-grok", "@dev-codex", "@#main", "@#review"]);
    assert.equal(labels.includes("@dead-worker"), false);
    assert.equal(labels.includes("@#old-tmp"), false);
  });

  it("filters candidates by keyword/channel prefix and ranks prefix matches ahead of substrings", () => {
    const candidates = buildMentionCandidates({
      workers: [
        makeWorker({ name: "my-grok-helper", backend: "opencode", model: "free" }),
        makeWorker({ name: "grok-lead", backend: "grok" }),
      ],
      channels: [makeChannel("main"), makeChannel("review")],
      avatarFor: (b) => ({ letter: b[0]!.toUpperCase(), bg: "#111" }),
      stateLabel: (s) => s,
    });

    const filteredGrok = filterMentionCandidates(candidates, "grok");
    assert.equal(filteredGrok[0]?.insertText, "@grok-lead");
    assert.equal(filteredGrok[1]?.insertText, "@my-grok-helper");

    const filteredChan = filterMentionCandidates(candidates, "#rev");
    assert.deepEqual(
      filteredChan.map((c) => c.insertText),
      ["@#review"],
    );

    assert.equal(filterMentionCandidates(candidates, "").length, candidates.length);
  });

  it("applies selected candidate without doubling trailing whitespace and returns exact cursor", () => {
    const trigger = detectMentionTrigger("请@gr", 4)!;
    const res1 = applyMentionSelection("请@gr", trigger, "@reg-grok");
    assert.equal(res1.nextValue, "请@reg-grok ");
    assert.equal(res1.nextCursor, "请@reg-grok ".length);

    const triggerMid = detectMentionTrigger("@gr 请查收", 3)!;
    const res2 = applyMentionSelection("@gr 请查收", triggerMid, "@reg-grok");
    assert.equal(res2.nextValue, "@reg-grok 请查收");
    assert.equal(res2.nextCursor, "@reg-grok".length);
  });
});
