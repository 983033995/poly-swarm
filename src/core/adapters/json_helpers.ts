import {
  extractTextContent,
  numVal,
  safeJsonParse,
  strVal,
  type NormalizedEvent,
  type StreamTurnTracker,
  type UsageSummary,
} from "./base.js";

export function accumulateUsage(
  current: UsageSummary | null,
  delta: Partial<UsageSummary> & { accuracy?: UsageSummary["accuracy"] },
): UsageSummary {
  const base: UsageSummary = current ?? {
    accuracy: delta.accuracy ?? "exact",
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_usd: null,
  };
  const input = base.input_tokens + (delta.input_tokens ?? 0);
  const output = base.output_tokens + (delta.output_tokens ?? 0);
  const reasoning = (base.reasoning_tokens ?? 0) + (delta.reasoning_tokens ?? 0);
  const cacheRead = (base.cache_read_tokens ?? 0) + (delta.cache_read_tokens ?? 0);
  const cacheWrite = (base.cache_write_tokens ?? 0) + (delta.cache_write_tokens ?? 0);
  const total =
    delta.total_tokens !== undefined
      ? (base.total_tokens ?? 0) + delta.total_tokens
      : input + output + reasoning + cacheRead + cacheWrite;
  const cost =
    delta.cost_usd !== undefined && delta.cost_usd !== null
      ? (base.cost_usd ?? 0) + delta.cost_usd
      : base.cost_usd ?? null;

  return {
    accuracy: delta.accuracy ?? base.accuracy,
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: total,
    cost_usd: cost,
  };
}

export function extractSessionIdFromObj(obj: Record<string, unknown>): string | null {
  return (
    strVal(obj.session_id) ??
    strVal(obj.sessionID) ??
    strVal(obj.sessionId) ??
    strVal(obj.conversation_id) ??
    strVal(obj.conversationId) ??
    strVal(obj.thread_id) ??
    strVal(obj.threadId) ??
    null
  );
}

export function extractUsageFromObj(obj: Record<string, unknown>): UsageSummary | null {
  const u = (obj.usage ?? (obj.part as Record<string, unknown> | undefined)?.tokens) as
    | Record<string, unknown>
    | undefined;
  if (!u || typeof u !== "object") return null;

  const input =
    numVal(u.input_tokens) ?? numVal(u.inputTokens) ?? numVal(u.input) ?? numVal(u.prompt_tokens) ?? 0;
  const output =
    numVal(u.output_tokens) ??
    numVal(u.outputTokens) ??
    numVal(u.output) ??
    numVal(u.completion_tokens) ??
    0;
  const reasoning = numVal(u.reasoning_tokens) ?? numVal(u.thinking_tokens) ?? numVal(u.reasoning) ?? 0;
  const cacheObj = (u.cache ?? undefined) as Record<string, unknown> | undefined;
  const cacheRead =
    numVal(u.cache_read_tokens) ??
    numVal(u.cache_read_input_tokens) ??
    numVal(u.cached_input_tokens) ??
    numVal(cacheObj?.read) ??
    0;
  const cacheWrite =
    numVal(u.cache_write_tokens) ??
    numVal(u.cache_creation_input_tokens) ??
    numVal(cacheObj?.write) ??
    0;
  const total =
    numVal(u.total_tokens) ??
    numVal(u.total) ??
    input + output + reasoning + cacheRead + cacheWrite;
  const cost =
    numVal(obj.cost_usd) ??
    numVal(obj.total_cost_usd) ??
    numVal((obj.part as Record<string, unknown> | undefined)?.cost) ??
    numVal(u.cost_usd);

  if (input + output + reasoning + cacheRead + cacheWrite + (total || 0) === 0 && (cost === null || cost === 0)) {
    return null;
  }

  return {
    accuracy: "exact",
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: total,
    cost_usd: cost,
  };
}

export function handleGenericJsonLine(
  line: string,
  tracker: StreamTurnTracker,
  emit: (ev: NormalizedEvent) => void,
): boolean {
  const obj = safeJsonParse(line);
  if (!obj) return false;

  const sid = extractSessionIdFromObj(obj);
  if (sid) tracker.sessionId = sid;

  const usage = extractUsageFromObj(obj);
  if (usage) {
    tracker.usage = accumulateUsage(tracker.usage, usage);
    emit({
      kind: "usage",
      title: "Usage",
      content: `in=${usage.input_tokens} out=${usage.output_tokens}`,
      meta: usage as unknown as Record<string, unknown>,
    });
  }

  const type = (strVal(obj.type) ?? strVal(obj.event) ?? "").toLowerCase();
  const subtype = (strVal(obj.subtype) ?? "").toLowerCase();

  if (type === "error" || obj.is_error === true) {
    const errorsArr = Array.isArray(obj.errors)
      ? obj.errors.map((e) => strVal(e) ?? extractTextContent(e)).filter(Boolean)
      : [];
    const msg =
      (errorsArr.length > 0 ? errorsArr.join("; ") : null) ??
      strVal(obj.message) ??
      strVal((obj.error as Record<string, unknown> | undefined)?.message) ??
      strVal(obj.error) ??
      JSON.stringify(obj);
    tracker.lastErrorText = msg;
    tracker.hasFatalError = true;
    emit({ kind: "error", title: "Error", content: msg });
    return true;
  }

  if (type === "system" || type === "init") {
    const model = strVal(obj.model);
    if (model) tracker.actualModel = model;
    const perm = strVal(obj.permissionMode);
    const summary = [model ? `model=${model}` : "", perm ? `mode=${perm}` : ""]
      .filter(Boolean)
      .join(" ");
    emit({
      kind: "system",
      title: subtype || type || "system",
      content: summary || subtype || type || "system",
    });
    return true;
  }

  if (type.includes("think") || type.includes("reason") || type === "thought") {
    const content = extractTextContent(obj.text ?? obj.thinking ?? obj.content ?? obj.delta);
    if (content) emit({ kind: "thought", title: "Thinking", content });
    return true;
  }

  if (type === "tool_use" || type === "tool_call" || type === "tool") {
    tracker.toolCallsCount += 1;
    const toolName =
      strVal(obj.name) ??
      strVal(obj.tool) ??
      strVal((obj.tool_call as Record<string, unknown> | undefined)?.name) ??
      "tool";
    const input = obj.input ?? obj.arguments ?? obj.args ?? obj.tool_call ?? "";
    const content = typeof input === "string" ? input : JSON.stringify(input);
    emit({ kind: "tool_call", title: toolName, content: content.slice(0, 2000) });
    return true;
  }

  if (type === "tool_result") {
    const toolName = strVal(obj.name) ?? strVal(obj.tool) ?? "tool_result";
    const out = extractTextContent(obj.output ?? obj.result ?? obj.content);
    emit({
      kind: "tool_result",
      title: toolName,
      content: (out || JSON.stringify(obj)).slice(0, 2000),
    });
    return true;
  }

  if (type === "result" || type === "final") {
    const model = strVal(obj.model);
    if (model) tracker.actualModel = model;
    const resText =
      extractTextContent(obj.result ?? obj.text ?? obj.message ?? obj.output) || "";
    if (resText) {
      tracker.lastResultText = resText;
      if (tracker.textParts.length === 0) {
        emit({ kind: "text", title: "Result", content: resText });
      }
    }
    if (obj.structured_output !== undefined) {
      tracker.structuredJson = JSON.stringify(obj.structured_output);
    }
    return true;
  }

  const text = extractTextContent(obj.text ?? obj.delta ?? obj.message ?? obj.content);
  if (text) {
    tracker.textParts.push(text);
    emit({ kind: "text", content: text });
    return true;
  }

  emit({ kind: "raw", title: type || "event", content: line.slice(0, 1500) });
  return true;
}
