import {
  extractTextContent,
  numVal,
  safeJsonParse,
  strVal,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { accumulateUsage, handleGenericJsonLine } from "./json_helpers.js";

export function handleCodexStyleJsonLine(
  backend: "codex" | "trae",
  line: string,
  tracker: StreamTurnTracker,
  emit: (ev: NormalizedEvent) => void,
): void {
  const obj = safeJsonParse(line);
  if (!obj) {
    tracker.textParts.push(line);
    emit({ kind: "text", content: line });
    return;
  }

  const type = (strVal(obj.type) ?? "").toLowerCase();

  if (type === "thread.started") {
    const tid = strVal(obj.thread_id);
    if (tid) tracker.sessionId = tid;
    const m = strVal(obj.model);
    if (m) tracker.actualModel = m;
    emit({ kind: "system", title: "thread.started", content: tid ?? "started" });
    return;
  }

  if (type === "turn.started") {
    const m = strVal(obj.model);
    if (m) tracker.actualModel = m;
    emit({ kind: "system", title: "turn.started", content: "turn started" });
    return;
  }

  if (type === "item.started" || type === "item.completed") {
    const item = (obj.item ?? {}) as Record<string, unknown>;
    const itemType = (strVal(item.type) ?? "").toLowerCase();

    if (itemType === "error") {
      const msg = strVal(item.message) ?? JSON.stringify(item);
      emit({ kind: "system", title: `${backend}.notice`, content: msg.slice(0, 1200) });
      return;
    }

    if (itemType === "reasoning") {
      const text = extractTextContent(item.text ?? item.summary);
      if (text) emit({ kind: "thought", title: "Reasoning", content: text });
      return;
    }

    if (itemType === "command_execution" || itemType === "mcp_tool_call" || itemType === "file_change") {
      if (itemType === "file_change") {
        tracker.hadFileChange = true;
      }
      if (type === "item.started") {
        tracker.toolCallsCount += 1;
        const label = strVal(item.command) ?? strVal(item.tool) ?? itemType;
        emit({ kind: "tool_call", title: itemType, content: label.slice(0, 2000) });
      } else {
        const out =
          strVal(item.aggregated_output) ??
          strVal(item.output) ??
          JSON.stringify(item.changes ?? item.result ?? item);
        emit({ kind: "tool_result", title: itemType, content: out.slice(0, 2000) });
      }
      return;
    }

    if (itemType === "agent_message") {
      const text = extractTextContent(item.text ?? item.content);
      if (text) {
        tracker.textParts.push(text);
        emit({ kind: "text", content: text });
      }
      return;
    }
  }

  if (type === "turn.completed") {
    const m = strVal(obj.model);
    if (m) tracker.actualModel = m;
    const u = (obj.usage ?? {}) as Record<string, unknown>;
    const input = numVal(u.input_tokens) ?? 0;
    const cacheRead = numVal(u.cached_input_tokens) ?? 0;
    const output = numVal(u.output_tokens) ?? 0;
    tracker.usage = accumulateUsage(tracker.usage, {
      accuracy: "exact",
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      total_tokens: input + output,
    });
    emit({
      kind: "usage",
      title: backend === "trae" ? "TRAE Usage" : "Codex Usage",
      content: `in=${input} cached=${cacheRead} out=${output}`,
      meta: tracker.usage as unknown as Record<string, unknown>,
    });
    return;
  }

  if (type === "error" || type === "turn.failed") {
    const msg =
      strVal(obj.message) ??
      strVal((obj.error as Record<string, unknown> | undefined)?.message) ??
      line;
    tracker.lastErrorText = msg;
    tracker.hasFatalError = true;
    emit({ kind: "error", title: type, content: msg });
    return;
  }

  if (backend === "trae" && handleGenericJsonLine(line, tracker, emit)) return;
  emit({ kind: "raw", title: type || backend, content: line.slice(0, 1200) });
}
