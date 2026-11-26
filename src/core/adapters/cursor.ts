import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  buildEstimatedUsage,
  extractTextContent,
  findBinaryInPath,
  readCursorHookUsage,
  safeJsonParse,
  strVal,
  type AdapterCapabilities,
  type AdapterRunInput,
  type NormalizedEvent,
  type StreamTurnTracker,
  type UsageSummary,
} from "./base.js";
import { accumulateUsage, extractUsageFromObj } from "./json_helpers.js";
import {
  getStaticFallbackModels,
  mergeModelOptions,
  parseCursorModelsOutput,
  runCliListCmd,
} from "./models.js";

export class CursorAdapter extends BaseCliAdapter {
  readonly id = "cursor" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: false,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    defaultBinaryCandidates: ["cursor-agent", "agent"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    const fallback = getStaticFallbackModels("cursor", override);
    const bin = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    if (!bin) return fallback;
    const raw = await runCliListCmd(bin, ["--list-models"], 6000);
    if (!raw) return fallback;
    const detected = parseCursorModelsOutput(raw);
    if (detected.length === 0) return fallback;
    return mergeModelOptions(detected, fallback, override?.defaultModel, Date.now());
  }

  buildCommand(input: AdapterRunInput): { args: string[] } {
    const args: string[] = [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ];
    if (input.sessionId) {
      args.push("--resume", input.sessionId);
    }
    if (input.mode === "readonly") {
      args.push("--mode", "ask", "--trust", "--workspace", input.cwd);
    } else {
      args.push("-f", "--trust", "--workspace", input.cwd);
    }
    let model = input.model ?? input.override?.defaultModel;
    const effort = input.effort ?? input.override?.defaultEffort;
    const hasPresetEffortSuffix =
      typeof model === "string" &&
      /(?:^|-)(?:none|low|medium|high|xhigh|max)(?:-fast)?$/i.test(model);
    if (
      model &&
      effort &&
      model.toLowerCase() !== "auto" &&
      !hasPresetEffortSuffix &&
      !/\beffort\s*=/.test(model)
    ) {
      if (model.includes("[")) {
        model = model.replace(/\]$/, `,effort=${effort}]`);
      } else {
        model = `${model}[effort=${effort}]`;
      }
    }
    if (model) args.push("--model", model);
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

    const sid = strVal(obj.session_id) ?? strVal(obj.chat_id);
    if (sid) tracker.sessionId = sid;

    const usage = extractUsageFromObj(obj);
    if (usage) {
      tracker.usage = accumulateUsage(tracker.usage, usage);
    }

    const type = (strVal(obj.type) ?? "").toLowerCase();
    const subtype = (strVal(obj.subtype) ?? "").toLowerCase();

    if (type === "system") {
      const model = strVal(obj.model);
      if (model) tracker.actualModel = model;
      emit({
        kind: "system",
        title: subtype || "system",
        content: model ? `model=${model}` : line.slice(0, 300),
      });
      return;
    }

    if (type === "user") {
      emit({ kind: "system", title: "user", content: "prompt echoed" });
      return;
    }

    if (type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      if (blocks.length > 0) {
        for (const rawBlock of blocks) {
          if (!rawBlock || typeof rawBlock !== "object") continue;
          const b = rawBlock as Record<string, unknown>;
          const bType = (strVal(b.type) ?? "").toLowerCase();
          const bText = extractTextContent(b.text ?? b.thinking ?? b);
          if (!bText) continue;
          if (bType.includes("think") || bType.includes("reason")) {
            emit({ kind: "thought", title: "Thinking", content: bText });
          } else {
            tracker.textParts.push(bText);
            emit({ kind: "text", content: bText });
          }
        }
        return;
      }
      const txt = extractTextContent(obj.text ?? obj.delta ?? msg);
      if (txt) {
        tracker.textParts.push(txt);
        emit({ kind: "text", content: txt });
      }
      return;
    }

    if (type === "tool_call") {
      const tc = (obj.tool_call ?? {}) as Record<string, unknown>;
      const keys = Object.keys(tc);
      const toolKey = keys[0] ?? "tool";
      const payload = tc[toolKey] as Record<string, unknown> | undefined;
      if (subtype === "completed" || payload?.result !== undefined) {
        emit({
          kind: "tool_result",
          title: toolKey,
          content: JSON.stringify(payload?.result ?? tc).slice(0, 2000),
        });
      } else {
        tracker.toolCallsCount += 1;
        emit({
          kind: "tool_call",
          title: toolKey,
          content: JSON.stringify(payload?.args ?? tc).slice(0, 2000),
        });
      }
      return;
    }

    if (type === "result") {
      if (obj.is_error === true) {
        const errText = strVal(obj.result) ?? strVal(obj.error) ?? JSON.stringify(obj);
        tracker.lastErrorText = errText;
        tracker.hasFatalError = true;
        emit({ kind: "error", title: "Cursor Error", content: errText });
        return;
      }
      const resText = strVal(obj.result);
      if (resText) tracker.lastResultText = resText;
      return;
    }

    if (type === "error") {
      const errText = strVal(obj.message) ?? strVal(obj.error) ?? line;
      tracker.lastErrorText = errText;
      tracker.hasFatalError = true;
      emit({ kind: "error", title: "Error", content: errText });
      return;
    }

    emit({ kind: "raw", title: type || "cursor", content: line.slice(0, 1200) });
  }

  protected override resolveFinalUsage(
    input: AdapterRunInput,
    tracker: StreamTurnTracker,
    outputText: string,
  ): UsageSummary {
    const hookUsage = readCursorHookUsage(
      input.hookMetricsDir,
      tracker.sessionId ?? input.sessionId,
    );
    if (hookUsage) return hookUsage;
    return tracker.usage ?? buildEstimatedUsage(input.prompt, outputText);
  }
}
