import type { BoardMessage, EventKind, TurnRecord, WorkerEvent } from "../shared/types.js";

export interface CoalescedEvent {
  key: string;
  kind: EventKind;
  title: string | null;
  content: string;
  firstSeq: number;
  lastSeq: number;
  startedAt: number;
  endedAt: number;
  chunkCount: number;
  repeatCount: number;
}

export type ConversationBlock =
  | {
      type: "thought";
      key: string;
      text: string;
      chunkCount: number;
      durationMs: number;
    }
  | {
      type: "tool";
      key: string;
      name: string;
      input: string;
      output: string | null;
      completed: boolean;
      startedAt: number;
      endedAt: number;
    }
  | {
      type: "text";
      key: string;
      text: string;
    }
  | {
      type: "error";
      key: string;
      title: string;
      text: string;
    };

export interface ExtractedTurnPrompt {
  label: string;
  body: string;
  fullRaw: string;
}

export interface ToolStepSummary {
  actionLabel: string;
  targetSummary: string;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function shortenPath(rawPath: string): string {
  const parts = rawPath.trim().split(/[/\\]+/).filter(Boolean);
  if (parts.length === 0) return rawPath.trim();
  if (parts.length === 1) return parts[0]!;
  return parts.slice(-2).join("/");
}

function stripShellWrapper(raw: string): string {
  let s = raw.trim();
  const wrapperMatch = s.match(/^\/bin\/(?:z|ba)?sh\s+-[a-z]*c\s+([\s\S]+)$/i);
  if (wrapperMatch) {
    s = wrapperMatch[1]!.trim();
    if (
      (s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith('"') && s.endsWith('"'))
    ) {
      s = s.slice(1, -1).trim();
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Produces a human-readable Chinese action label and short target summary for a tool call.
 */
export function summarizeToolStep(name: string, input: string): ToolStepSummary {
  const norm = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let actionLabel = name || "工具调用";
  if (norm === "readfile" || norm === "read" || norm === "viewfile") {
    actionLabel = "读取文件";
  } else if (
    norm === "grep" ||
    norm === "grepsearch" ||
    norm === "ripgrep" ||
    norm === "search" ||
    norm === "findbycode"
  ) {
    actionLabel = "搜索代码";
  } else if (
    norm === "writefile" ||
    norm === "write" ||
    norm === "edit" ||
    norm === "editfile" ||
    norm === "multiedit" ||
    norm === "replacefilecontent"
  ) {
    actionLabel = "修改文件";
  } else if (
    norm === "commandexecution" ||
    norm === "bash" ||
    norm === "shell" ||
    norm === "runcommand" ||
    norm === "execute"
  ) {
    actionLabel = "执行命令";
  } else if (
    norm === "glob" ||
    norm === "listdir" ||
    norm === "listdirectory" ||
    norm === "findfiles"
  ) {
    actionLabel = "浏览目录";
  }

  let targetSummary = "";
  const trimmedInput = (input || "").trim();
  if (trimmedInput) {
    let parsedObj: Record<string, unknown> | null = null;
    if (trimmedInput.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmedInput) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedObj = parsed as Record<string, unknown>;
        }
      } catch {
        parsedObj = null;
      }
    }

    if (parsedObj) {
      const keys = [
        "target_file",
        "file_path",
        "AbsolutePath",
        "pattern",
        "query",
        "command",
        "cmd",
        "code",
        "path",
        "url",
      ] as const;
      for (const key of keys) {
        const val = parsedObj[key];
        if (typeof val !== "string" || !val.trim()) continue;
        if (
          key === "target_file" ||
          key === "file_path" ||
          key === "AbsolutePath" ||
          key === "path"
        ) {
          targetSummary = truncateText(shortenPath(val), 68);
        } else if (key === "pattern" || key === "query") {
          const clean = val.replace(/\s+/g, " ").trim();
          targetSummary = clean.length <= 48 ? `"${clean}"` : truncateText(clean, 68);
        } else if (key === "command" || key === "cmd" || key === "code") {
          const firstLine =
            val
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => l.length > 0) ?? val;
          targetSummary = truncateText(stripShellWrapper(firstLine), 68);
        } else {
          targetSummary = truncateText(val.replace(/\s+/g, " ").trim(), 68);
        }
        break;
      }
    }

    if (!targetSummary) {
      targetSummary = truncateText(stripShellWrapper(trimmedInput), 68);
    }
  }

  return { actionLabel, targetSummary };
}

function isByteArray(val: unknown): val is number[] {
  return (
    Array.isArray(val) &&
    val.length >= 8 &&
    val.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

function decodeByteArrays(val: unknown): unknown {
  if (isByteArray(val)) {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(val));
  }
  if (Array.isArray(val)) {
    return val.map((item) => decodeByteArrays(item));
  }
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = decodeByteArrays(v);
    }
    return out;
  }
  return val;
}

/**
 * Pretty-prints tool payloads, decoding UTF-8 byte arrays and unwrapping common
 * FileContent / GrepSearch wrappers for human inspection.
 */
export function formatToolPayload(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }

  const decoded = decodeByteArrays(parsed);
  if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
    const obj = decoded as Record<string, unknown>;
    const fileContent = obj.FileContent;
    if (
      fileContent &&
      typeof fileContent === "object" &&
      !Array.isArray(fileContent) &&
      typeof (fileContent as Record<string, unknown>).content === "string"
    ) {
      return (fileContent as Record<string, unknown>).content as string;
    }
    if (obj.type === "GrepSearch" && typeof obj.stdout === "string") {
      return obj.stdout;
    }
  }

  return JSON.stringify(decoded, null, 2);
}

/**
 * Coalesces high-frequency streaming delta chunks (adjacent `thought` / `text`
 * tokens and repeated adjacent `system` lines with the same title) while
 * preserving exact chronological boundaries across tools and errors.
 */
export function coalesceEvents(events: WorkerEvent[]): CoalescedEvent[] {
  const out: CoalescedEvent[] = [];

  for (const ev of events) {
    const prev = out[out.length - 1];
    const title = ev.title ?? null;

    if (prev && (ev.kind === "thought" || ev.kind === "text") && prev.kind === ev.kind) {
      prev.content += ev.content;
      prev.lastSeq = ev.seq_in_turn;
      prev.endedAt = ev.created_at;
      prev.chunkCount += 1;
      continue;
    }

    if (
      prev &&
      ev.kind === "system" &&
      prev.kind === "system" &&
      (prev.title ?? "") === (title ?? "")
    ) {
      if (ev.content) prev.content = ev.content;
      prev.lastSeq = ev.seq_in_turn;
      prev.endedAt = ev.created_at;
      prev.repeatCount += 1;
      continue;
    }

    out.push({
      key: `${ev.turn_id}:ev:${ev.seq_in_turn}`,
      kind: ev.kind,
      title,
      content: ev.content,
      firstSeq: ev.seq_in_turn,
      lastSeq: ev.seq_in_turn,
      startedAt: ev.created_at,
      endedAt: ev.created_at,
      chunkCount: 1,
      repeatCount: 1,
    });
  }

  return out;
}

function normToolKey(name: string | null | undefined): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findMatchingPendingTool(
  blocks: ConversationBlock[],
  pendingIndices: number[],
  resultTitle: string | null,
): number | null {
  if (pendingIndices.length === 0) return null;
  const target = normToolKey(resultTitle);
  if (target) {
    for (let i = pendingIndices.length - 1; i >= 0; i--) {
      const idx = pendingIndices[i]!;
      const block = blocks[idx];
      if (block?.type === "tool") {
        const callKey = normToolKey(block.name);
        if (callKey && (callKey === target || target.includes(callKey) || callKey.includes(target))) {
          pendingIndices.splice(i, 1);
          return idx;
        }
      }
    }
  }
  const fallbackIdx = pendingIndices.shift();
  return fallbackIdx !== undefined ? fallbackIdx : null;
}

/**
 * Converts a turn's raw events into clean chat-style blocks (thinking accordions,
 * paired tool call/result steps, readable prose paragraphs, and errors).
 */
export function buildConversationBlocks(
  turn: TurnRecord,
  events: WorkerEvent[],
): ConversationBlock[] {
  const coalesced = coalesceEvents(turn.backend === "cursor" ? events.map((event) => {
    if (event.kind !== "raw" || event.title !== "thinking") return event;
    try {
      const payload = JSON.parse(event.content) as { type?: unknown; subtype?: unknown; text?: unknown } | null;
      if (payload?.type === "thinking" && payload.subtype === "delta" && typeof payload.text === "string") {
        return { ...event, kind: "thought", title: "Thinking", content: payload.text };
      }
    } catch {
      // Older records can contain only a truncated raw payload.
    }
    return event;
  }) : events);
  const blocks: ConversationBlock[] = [];
  const pendingToolIndices: number[] = [];

  for (const ev of coalesced) {
    if (ev.kind === "thought") {
      const trimmed = ev.content.trim();
      if (!trimmed) continue;
      blocks.push({
        type: "thought",
        key: `${turn.id}:thought:${ev.firstSeq}`,
        text: trimmed,
        chunkCount: ev.chunkCount,
        durationMs: Math.max(0, ev.endedAt - ev.startedAt),
      });
      continue;
    }

    if (ev.kind === "tool_call") {
      const idx = blocks.length;
      blocks.push({
        type: "tool",
        key: `${turn.id}:tool:${ev.firstSeq}`,
        name: ev.title || "tool",
        input: ev.content,
        output: null,
        completed: false,
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
      });
      pendingToolIndices.push(idx);
      continue;
    }

    if (ev.kind === "tool_result") {
      const matchedIdx = findMatchingPendingTool(blocks, pendingToolIndices, ev.title);
      if (matchedIdx !== null) {
        const block = blocks[matchedIdx];
        if (block && block.type === "tool") {
          block.output = ev.content;
          block.completed = true;
          block.endedAt = ev.endedAt;
          continue;
        }
      }
      blocks.push({
        type: "tool",
        key: `${turn.id}:toolres:${ev.firstSeq}`,
        name: ev.title || "tool_result",
        input: "",
        output: ev.content,
        completed: true,
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
      });
      continue;
    }

    if (ev.kind === "text") {
      const trimmed = ev.content.trim();
      if (!trimmed) continue;
      blocks.push({
        type: "text",
        key: `${turn.id}:text:${ev.firstSeq}`,
        text: trimmed,
      });
      continue;
    }

    if (ev.kind === "error") {
      blocks.push({
        type: "error",
        key: `${turn.id}:err:${ev.firstSeq}`,
        title: ev.title || "错误",
        text: ev.content,
      });
    }
  }

  const finalOut = (turn.output_text ?? "").trim();
  if (finalOut) {
    const normWs = (s: string) => s.replace(/\s+/g, " ").trim();
    const compact = (s: string) => s.replace(/\s+/g, "");
    const joinedText = blocks
      .filter((b): b is Extract<ConversationBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!joinedText) {
      blocks.push({
        type: "text",
        key: `${turn.id}:final`,
        text: finalOut,
      });
    } else if (
      !normWs(joinedText).includes(normWs(finalOut)) &&
      !compact(joinedText).includes(compact(finalOut)) &&
      normWs(finalOut).length > normWs(joinedText).length
    ) {
      blocks.push({
        type: "text",
        key: `${turn.id}:final`,
        text: finalOut,
      });
    }
  }

  return blocks;
}

function stripLeadingMention(body: string, workerName?: string): string {
  const target = (workerName ?? "").trim();
  if (!target) return body;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^@${escaped}(?:\\s*[:：]\\s*|\\s+)`, "i");
  const stripped = body.replace(re, "").trim();
  return stripped || body;
}

/**
 * Extracts the human-readable task prompt sent to the worker for a given turn,
 * preferring the originating board message and falling back to stripping cold-boot boilerplate.
 */
export function extractTurnPrompt(
  turn: TurnRecord,
  triggerMsg?: BoardMessage | null,
  workerName?: string,
): ExtractedTurnPrompt {
  const fullRaw = turn.prompt_preview || "";
  const targetWorker = workerName ?? turn.worker_name;
  if (triggerMsg) {
    return {
      label: `#${triggerMsg.seq} · ${triggerMsg.sender}`,
      body: stripLeadingMention(triggerMsg.text, targetWorker),
      fullRaw,
    };
  }

  const marker = "New board messages for you:";
  const idx = fullRaw.indexOf(marker);
  let body = idx !== -1 ? fullRaw.slice(idx + marker.length).trim() : fullRaw.trim();

  if (idx !== -1) {
    const headerMatch = body.match(/^#\d+\s+\[[^\]]+\]\s+[^:]+:\s*/);
    if (headerMatch) {
      body = body.slice(headerMatch[0].length).trim();
    }
  }

  return {
    label: turn.trigger_seq ? `#${turn.trigger_seq} · coordinator` : "任务指令",
    body: stripLeadingMention(body || fullRaw, targetWorker),
    fullRaw,
  };
}
