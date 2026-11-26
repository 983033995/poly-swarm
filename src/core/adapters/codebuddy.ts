import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  extractTextContent,
  findBinaryInPath,
  safeJsonParse,
  strVal,
  type AdapterCapabilities,
  type AdapterRunInput,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { extractSessionIdFromObj, extractUsageFromObj, handleGenericJsonLine } from "./json_helpers.js";
import {
  getStaticFallbackModels,
  mergeModelOptions,
  parseCodeBuddyModelsFromHelp,
  runCliListCmd,
} from "./models.js";

export class CodeBuddyAdapter extends BaseCliAdapter {
  readonly id = "codebuddy" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: true,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    defaultBinaryCandidates: ["codebuddy"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    const fallback = getStaticFallbackModels("codebuddy", override);
    const bin = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    if (!bin) return fallback;
    const raw = await runCliListCmd(bin, ["--help"], 6000);
    if (!raw) return fallback;
    const detected = parseCodeBuddyModelsFromHelp(raw);
    if (detected.length === 0) return fallback;
    return mergeModelOptions(detected, fallback, override?.defaultModel, Date.now());
  }

  buildCommand(input: AdapterRunInput): { args: string[] } {
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (input.sessionId) {
      args.push("-r", input.sessionId);
    }
    if (input.mode === "readonly") {
      args.push("--permission-mode", "plan");
    } else {
      args.push("-y");
    }
    const model = input.model ?? input.override?.defaultModel;
    if (model) args.push("--model", model);
    const effort = input.effort ?? input.override?.defaultEffort;
    if (effort) args.push("--effort", effort);
    if (input.jsonSchema) {
      args.push("--json-schema", JSON.stringify(input.jsonSchema));
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

    const sid = extractSessionIdFromObj(obj);
    if (sid) tracker.sessionId = sid;

    const type = (strVal(obj.type) ?? "").toLowerCase();

    if (type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const msgModel = strVal(msg?.model) ?? strVal(obj.model);
      if (msgModel) tracker.actualModel = msgModel;
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      for (const rawBlock of blocks) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const b = rawBlock as Record<string, unknown>;
        const bType = (strVal(b.type) ?? "").toLowerCase();
        if (bType === "thinking" || bType === "reasoning") {
          const thinking = extractTextContent(b.thinking ?? b.text ?? b);
          if (thinking) emit({ kind: "thought", title: "Thinking", content: thinking });
          continue;
        }
        if (bType === "tool_use") {
          tracker.toolCallsCount += 1;
          const toolName = strVal(b.name) ?? "tool";
          const input = b.input ?? "";
          emit({
            kind: "tool_call",
            title: toolName,
            content: (typeof input === "string" ? input : JSON.stringify(input)).slice(0, 2000),
          });
          continue;
        }
        if (bType === "text") {
          const txt = extractTextContent(b.text ?? b);
          if (txt) {
            tracker.textParts.push(txt);
            emit({ kind: "text", content: txt });
          }
        }
      }
      return;
    }

    if (type === "user") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      for (const rawBlock of blocks) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const b = rawBlock as Record<string, unknown>;
        const bType = (strVal(b.type) ?? "").toLowerCase();
        if (bType === "tool_result") {
          const out = extractTextContent(b.content ?? b.text ?? b);
          emit({
            kind: "tool_result",
            title: strVal(b.tool_use_id) ?? "tool_result",
            content: (out || JSON.stringify(b)).slice(0, 2000),
          });
        }
      }
      return;
    }

    if (type === "result") {
      const resModel = strVal(obj.model);
      if (resModel) tracker.actualModel = resModel;
      const usage = extractUsageFromObj(obj);
      if (usage) {
        tracker.usage = usage;
        emit({
          kind: "usage",
          title: "CodeBuddy Usage",
          content: `in=${usage.input_tokens} out=${usage.output_tokens} cache_r=${usage.cache_read_tokens ?? 0}`,
          meta: usage as unknown as Record<string, unknown>,
        });
      }
      if (obj.is_error === true) {
        const errorsArr = Array.isArray(obj.errors)
          ? obj.errors.map((e) => strVal(e) ?? extractTextContent(e)).filter(Boolean)
          : [];
        const errMsg =
          (errorsArr.length > 0 ? errorsArr.join("; ") : null) ??
          strVal(obj.result) ??
          strVal(obj.error) ??
          JSON.stringify(obj);
        tracker.lastErrorText = errMsg;
        tracker.hasFatalError = true;
        emit({ kind: "error", title: "CodeBuddy Error", content: errMsg });
        return;
      }
      const resText = extractTextContent(obj.result ?? obj.text ?? obj.output);
      if (resText) {
        tracker.lastResultText = resText;
        if (tracker.textParts.length === 0) {
          emit({ kind: "text", title: "Result", content: resText });
        }
      }
      if (obj.structured_output !== undefined) {
        tracker.structuredJson = JSON.stringify(obj.structured_output);
      }
      return;
    }

    if (!handleGenericJsonLine(line, tracker, emit)) {
      tracker.textParts.push(line);
      emit({ kind: "text", content: line });
    }
  }
}
