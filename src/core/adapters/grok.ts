import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  extractTextContent,
  safeJsonParse,
  strVal,
  type AdapterCapabilities,
  type AdapterRunInput,
  type AdapterRunResult,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { accumulateUsage, extractSessionIdFromObj, extractUsageFromObj } from "./json_helpers.js";
import { getStaticFallbackModels } from "./models.js";

export class GrokAdapter extends BaseCliAdapter {
  readonly id = "grok" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: true,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    defaultBinaryCandidates: ["grok"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    return getStaticFallbackModels("grok", override);
  }

  buildCommand(input: AdapterRunInput): { args: string[] } {
    const args: string[] = [
      "-p",
      input.prompt,
      "--output-format",
      "streaming-json",
      "--cwd",
      input.cwd,
      "--no-subagents",
    ];
    if (input.sessionId) {
      args.push("-r", input.sessionId);
    }
    if (input.mode === "readonly") {
      args.push("--permission-mode", "plan");
    } else {
      args.push("--permission-mode", "bypassPermissions");
    }
    const model = input.model ?? input.override?.defaultModel;
    if (model) args.push("-m", model);
    const effort = input.effort ?? input.override?.defaultEffort;
    if (effort) args.push("--effort", effort);
    if (input.jsonSchema) {
      args.push("--json-schema", JSON.stringify(input.jsonSchema));
    }
    return { args };
  }

  override async runTurn(input: AdapterRunInput): Promise<AdapterRunResult> {
    let permissionDenied = false;
    let stopCancelled = false;
    const result = await super.runTurn({
      ...input,
      onEvent: (ev) => {
        if (ev.kind === "raw" && ev.title === "stderr" && /permission required:.*headless run cannot ask for approval/i.test(ev.content)) {
          permissionDenied = true;
        }
        if (ev.kind === "system" && ev.title === "end" && /\bstopReason=cancelled\b/i.test(ev.content)) {
          stopCancelled = true;
        }
        input.onEvent(ev);
      },
    });
    if (stopCancelled && (result.ok || result.errorKind === "none" || result.errorKind === "unknown" || result.errorKind === "permission_denied")) {
      return {
        ...result,
        ok: false,
        errorKind: permissionDenied ? "permission_denied" : "cancelled",
        errorMessage: permissionDenied
          ? "Grok headless run cancelled because a tool required approval (use built-in read-only tools instead of external MCP tools)."
          : result.errorMessage || "Grok turn stopped with stopReason=cancelled.",
      };
    }
    return result;
  }

  protected handleStdoutLine(
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

    const sid = extractSessionIdFromObj(obj);
    if (sid) tracker.sessionId = sid;

    const type = (strVal(obj.type) ?? "").toLowerCase();

    if (type === "available_commands") {
      const tools = Array.isArray(obj.tools) ? obj.tools.length : 0;
      const cmds = Array.isArray(obj.commands) ? obj.commands.length : 0;
      emit({
        kind: "system",
        title: "available_commands",
        content: `tools=${tools} commands=${cmds}`,
      });
      return;
    }

    if (type === "end") {
      const m = strVal(obj.model);
      if (m) tracker.actualModel = m;
      const usage = extractUsageFromObj(obj);
      if (usage) {
        // `end` carries cumulative totals across the whole turn; overwrite step-level accumulator
        tracker.usage = usage;
        emit({
          kind: "usage",
          title: "Turn Usage",
          content: `in=${usage.input_tokens} out=${usage.output_tokens} cache_r=${usage.cache_read_tokens ?? 0}${usage.cost_usd != null ? ` cost=$${usage.cost_usd.toFixed(5)}` : ""}`,
          meta: usage as unknown as Record<string, unknown>,
        });
      }
      const stopReason = strVal(obj.stopReason) ?? "end_turn";
      emit({ kind: "system", title: "end", content: `stopReason=${stopReason}` });
      return;
    }

    const usage = extractUsageFromObj(obj);
    if (usage) {
      tracker.usage = accumulateUsage(tracker.usage, usage);
      emit({
        kind: "usage",
        title: "Step Usage",
        content: `in=${usage.input_tokens} out=${usage.output_tokens}`,
        meta: usage as unknown as Record<string, unknown>,
      });
      if (type === "usage") return;
    }

    if (type === "step_start") {
      emit({ kind: "system", title: "step_start", content: strVal(obj.step) ?? "step started" });
      return;
    }
    if (type === "step_finish") {
      emit({
        kind: "system",
        title: "step_finish",
        content: strVal(obj.reason) ?? "step finished",
      });
      return;
    }
    if (type === "thinking" || type === "reasoning" || type === "thought") {
      const t = extractTextContent(obj.data ?? obj.text ?? obj.thinking ?? obj.delta ?? obj.content);
      if (t) emit({ kind: "thought", title: "Thinking", content: t });
      return;
    }
    if (type === "tool_use" || type === "tool_call") {
      tracker.toolCallsCount += 1;
      const name = strVal(obj.title) ?? strVal(obj.name) ?? strVal(obj.tool) ?? strVal(obj.kind) ?? "tool";
      const input = obj.rawInput ?? obj.input ?? obj.arguments ?? obj.args ?? obj.locations ?? "";
      emit({
        kind: "tool_call",
        title: name,
        content: (typeof input === "string" ? input : JSON.stringify(input)).slice(0, 2000),
      });
      return;
    }
    if (type === "tool_call_update") {
      const status = strVal(obj.status);
      const rawOut = obj.rawOutput as Record<string, unknown> | undefined;
      const toolTitle = strVal(rawOut?.type) ?? strVal(obj.title) ?? strVal(obj.toolCallId) ?? "tool";
      if (status === "completed" || status === "failed" || rawOut || (Array.isArray(obj.content) && obj.content.length > 0)) {
        const out = extractTextContent(obj.content) || (rawOut ? JSON.stringify(rawOut) : JSON.stringify(obj));
        emit({ kind: "tool_result", title: toolTitle, content: out.slice(0, 2000) });
      } else {
        const loc = Array.isArray(obj.locations) ? JSON.stringify(obj.locations) : "";
        emit({ kind: "system", title: `tool_update:${toolTitle}`, content: loc || strVal(obj.toolCallId) || "running" });
      }
      return;
    }
    if (type === "tool_result") {
      const name = strVal(obj.name) ?? strVal(obj.tool) ?? "tool_result";
      const out = extractTextContent(obj.output ?? obj.result ?? obj.content);
      emit({ kind: "tool_result", title: name, content: out.slice(0, 2000) });
      return;
    }
    if (type === "error") {
      const msg = strVal(obj.message) ?? strVal(obj.error) ?? line;
      tracker.lastErrorText = msg;
      tracker.hasFatalError = true;
      emit({ kind: "error", title: "Grok Error", content: msg });
      return;
    }
    if (type === "result") {
      const m = strVal(obj.model);
      if (m) tracker.actualModel = m;
      const resText = extractTextContent(obj.result ?? obj.text ?? obj.output);
      if (resText) tracker.lastResultText = resText;
      if (obj.structured_output !== undefined) {
        tracker.structuredJson = JSON.stringify(obj.structured_output);
      }
      return;
    }
    if (type === "text") {
      const text = extractTextContent(obj.data ?? obj.text ?? obj.delta ?? obj.content);
      if (text) {
        tracker.textParts.push(text);
        emit({ kind: "text", content: text });
      }
      return;
    }

    const text = extractTextContent(obj.text ?? obj.delta ?? obj.content ?? obj.data);
    if (text) {
      tracker.textParts.push(text);
      emit({ kind: "text", content: text });
      return;
    }

    emit({ kind: "raw", title: type || "grok", content: line.slice(0, 1200) });
  }
}
