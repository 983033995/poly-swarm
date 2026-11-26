import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  extractTextContent,
  findBinaryInPath,
  numVal,
  safeJsonParse,
  strVal,
  type AdapterCapabilities,
  type AdapterRunInput,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { accumulateUsage } from "./json_helpers.js";
import {
  getStaticFallbackModels,
  mergeModelOptions,
  parseOpenCodeModelsOutput,
  runCliListCmd,
} from "./models.js";

export class OpenCodeAdapter extends BaseCliAdapter {
  readonly id = "opencode" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: true,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: false,
    defaultBinaryCandidates: ["opencode"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    const fallback = getStaticFallbackModels("opencode", override);
    const bin = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    if (!bin) return fallback;
    const raw = await runCliListCmd(bin, ["models"], 6000);
    if (!raw) return fallback;
    const detected = parseOpenCodeModelsOutput(raw);
    if (detected.length === 0) return fallback;
    return mergeModelOptions(detected, fallback, override?.defaultModel, Date.now());
  }

  buildCommand(input: AdapterRunInput): { args: string[] } {
    const args: string[] = ["run", "--format", "json", "--thinking"];
    if (input.sessionId) {
      args.push("-s", input.sessionId);
    }
    if (input.mode === "write") {
      args.push("--auto");
    }
    const model = input.model ?? input.override?.defaultModel;
    const effort = input.effort ?? input.override?.defaultEffort;
    if (model) {
      const modelArg = effort && !model.includes("#") ? `${model}#${effort}` : model;
      args.push("-m", modelArg);
    }
    args.push(input.prompt);
    return { args };
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

    const sid = strVal(obj.sessionID) ?? strVal(obj.session_id);
    if (sid) tracker.sessionId = sid;

    const type = (strVal(obj.type) ?? "").toLowerCase();
    const part = (obj.part ?? {}) as Record<string, unknown>;
    const partModel = strVal(part.model) ?? strVal(part.modelID) ?? strVal(obj.model) ?? strVal(obj.modelID);
    if (partModel) tracker.actualModel = partModel;

    if (type === "step_start") {
      emit({ kind: "system", title: "step_start", content: strVal(part.snapshot) ?? "step started" });
      return;
    }

    if (type === "thinking" || type === "reasoning") {
      const content = extractTextContent(part.text ?? obj.text ?? part);
      if (content) emit({ kind: "thought", title: "Thinking", content });
      return;
    }

    if (type === "tool_use") {
      tracker.toolCallsCount += 1;
      const tool = strVal(part.tool) ?? strVal(obj.tool) ?? "tool";
      const state = (part.state ?? {}) as Record<string, unknown>;
      const inputStr = JSON.stringify(state.input ?? part.input ?? "");
      emit({ kind: "tool_call", title: tool, content: inputStr.slice(0, 2000) });
      if (state.output !== undefined || state.error !== undefined) {
        const outStr =
          strVal(state.output) ?? strVal(state.error) ?? JSON.stringify(state.output ?? state.error);
        emit({ kind: "tool_result", title: tool, content: outStr.slice(0, 2000) });
      }
      return;
    }

    if (type === "text") {
      const txt = extractTextContent(part.text ?? obj.text);
      if (txt) {
        if (!tracker.hasFatalError) {
          tracker.lastErrorText = null;
        }
        tracker.textParts.push(txt);
        emit({ kind: "text", content: txt });
      }
      return;
    }

    if (type === "step_finish") {
      if (strVal(part.reason) === "error") {
        tracker.hasFatalError = true;
        if (!tracker.lastErrorText) {
          tracker.lastErrorText = "opencode step finished with error";
        }
      } else if (!tracker.hasFatalError) {
        tracker.lastErrorText = null;
      }
      const tokens = (part.tokens ?? obj.tokens) as Record<string, unknown> | undefined;
      const cache = (tokens?.cache ?? {}) as Record<string, unknown>;
      if (tokens) {
        const input = numVal(tokens.input) ?? 0;
        const output = numVal(tokens.output) ?? 0;
        const reasoning = numVal(tokens.reasoning) ?? 0;
        const cacheRead = numVal(cache.read) ?? 0;
        const cacheWrite = numVal(cache.write) ?? 0;
        const total = numVal(tokens.total) ?? input + output + reasoning + cacheRead + cacheWrite;
        const cost = numVal(part.cost) ?? numVal(obj.cost);
        tracker.usage = accumulateUsage(tracker.usage, {
          accuracy: "exact",
          input_tokens: input,
          output_tokens: output,
          reasoning_tokens: reasoning,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          total_tokens: total,
          cost_usd: cost,
        });
        emit({
          kind: "usage",
          title: "OpenCode Usage",
          content: `in=${input} out=${output} cache_r=${cacheRead} cost=$${(cost ?? 0).toFixed(5)}`,
          meta: tracker.usage as unknown as Record<string, unknown>,
        });
      }
      return;
    }

    if (type === "error") {
      const msg = strVal(obj.error) ?? strVal(part.error) ?? strVal(obj.message) ?? line;
      tracker.lastErrorText = msg;
      tracker.hasFatalError = true;
      emit({ kind: "error", title: "OpenCode Error", content: msg });
      return;
    }

    if (type === "retry") {
      const errObj = (obj.error ?? {}) as Record<string, unknown>;
      const errType = strVal(errObj.type) ?? "retry";
      const errMsg = strVal(errObj.message) ?? strVal(obj.message) ?? line;
      const status = numVal(errObj.status);
      const attempt = numVal(obj.attempt);
      const nextRetryAt = numVal(obj.nextRetryAt);
      const waitSec = nextRetryAt ? Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000)) : null;
      const detail = `${errType}${status ? ` (HTTP ${status})` : ""}${attempt ? ` attempt=${attempt}` : ""}${waitSec !== null ? ` next=${waitSec}s` : ""}: ${errMsg}`;
      tracker.lastErrorText = detail;
      emit({ kind: "error", title: "OpenCode Retry", content: detail });
      return;
    }

    emit({ kind: "raw", title: type || "opencode", content: line.slice(0, 1200) });
  }
}
