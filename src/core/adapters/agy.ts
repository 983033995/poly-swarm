import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import { agyProfileCommand, agyProxyEnv, type AgyLaunchProfile } from "../agy_accounts.js";
import {
  BaseCliAdapter,
  findBinaryInPath,
  safeJsonParse,
  spawnStreamingCli,
  strVal,
  type AdapterCapabilities,
  type AdapterRunInput,
  type AdapterRunResult,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import {
  accumulateUsage,
  extractSessionIdFromObj,
  extractUsageFromObj,
  handleGenericJsonLine,
} from "./json_helpers.js";
import {
  getStaticFallbackModels,
  mergeModelOptions,
  parseAgyModelsOutput,
  runCliListCmd,
} from "./models.js";

function agyModelOwnsEffort(model?: string | null): boolean {
  const id = model?.trim() ?? "";
  // The AGY catalog lists reasoning variants as distinct IDs. Orchestrator
  // IDs select a fixed mode and reject --effort altogether.
  return /-(?:low|medium|high|xhigh|max)$/i.test(id) || /^gemini-pro-orchestrator(?:-|$)/i.test(id);
}

export class AgyAdapter extends BaseCliAdapter {
  readonly id = "agy" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: true,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    defaultBinaryCandidates: ["agy"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig, profile?: AgyLaunchProfile): Promise<BackendModelOption[]> {
    const bin = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    if (profile) {
      if (!bin) throw new Error("找不到本机 Antigravity CLI。");
      const result = await spawnStreamingCli({
        ...agyProfileCommand(profile, bin, ["models"], override?.env),
        cwd: profile.home, timeoutMs: 20_000, onLine: () => {},
      });
      if (result.timedOut) throw new Error("查询该账号的模型超时，请重试。");
      if (result.exitCode !== 0) {
        if (/authenticat|unauth|credential|sign[ -]?in|log(?:ged)?[ -]?in/i.test(result.stderr)) {
          throw new Error("该账号未通过 Antigravity CLI 登录验证，请在「账号切换」中重新保存登录。");
        }
        throw new Error("Antigravity CLI 未能返回该账号的模型，请重试。");
      }
      const detected = parseAgyModelsOutput(result.stdout);
      if (!detected.length && result.stdout.trim()) throw new Error("Antigravity CLI 返回了无法识别的模型目录。");
      const now = Date.now();
      return [...new Map(detected.map((model) => [model.id, { ...model, source: "detected" as const, detected_at: now }])).values()];
    }
    const fallback = getStaticFallbackModels("agy", override);
    if (!bin) return fallback;
    const raw = await runCliListCmd(bin, ["models"], 12_000, { env: agyProxyEnv(override?.env), stdoutOnly: true });
    if (!raw) return fallback;
    const detected = parseAgyModelsOutput(raw);
    if (detected.length === 0) return fallback;
    return mergeModelOptions(detected, [], override?.defaultModel, Date.now());
  }

  buildCommand(input: AdapterRunInput): { args: string[] } {
    const args: string[] = ["-p", input.prompt, "--output-format", "stream-json"];
    if (input.sessionId) {
      args.push("--conversation", input.sessionId);
    }
    if (input.mode === "readonly") {
      args.push("--mode", "plan");
    } else {
      args.push("--mode", "accept-edits", "--dangerously-skip-permissions");
    }
    const model = input.model ?? input.override?.defaultModel;
    if (model) args.push("--model", model);
    const effort = input.effort ?? input.override?.defaultEffort;
    if (effort && !agyModelOwnsEffort(model)) args.push("--effort", effort);
    if (input.jsonSchema) {
      args.push("--json-schema", JSON.stringify(input.jsonSchema));
    }
    return { args };
  }

  override async runTurn(input: AdapterRunInput): Promise<AdapterRunResult> {
    if (input.mode !== "readonly") return super.runTurn(input);
    let permissionDeniedWithoutReply = false;
    const result = await super.runTurn({
      ...input,
      onEvent: (ev) => {
        if (ev.kind === "text" && ev.content.trim()) permissionDeniedWithoutReply = false;
        if (
          (ev.kind === "error" && /permission check failed for|user denied permission/i.test(ev.content)) ||
          (ev.kind === "raw" && ev.title === "stderr" && /no output produced.*required.*permission.*auto-denied/i.test(ev.content))
        ) permissionDeniedWithoutReply = true;
        input.onEvent(ev);
      },
    });
    if (permissionDeniedWithoutReply && (result.ok || result.errorKind === "unknown" || result.errorKind === "permission_denied")) {
      return {
        ...result, ok: false, errorKind: "permission_denied",
        errorMessage: "AGY denied a tool in read-only mode and returned no follow-up answer. Narrow the task to permitted workspace inputs.",
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

    const topSid = extractSessionIdFromObj(obj);
    if (topSid) tracker.sessionId = topSid;

    const evName = (strVal(obj.event) ?? "").toLowerCase();
    if (evName === "init") {
      const initObj = (obj.init ?? {}) as Record<string, unknown>;
      const initModel = strVal(initObj.model) ?? strVal(obj.model);
      if (initModel) tracker.actualModel = initModel;
      const toolCount = Array.isArray(initObj.tools) ? initObj.tools.length : 0;
      const cwd = strVal(initObj.cwd);
      emit({
        kind: "system",
        title: "init",
        content: [cwd ? `cwd=${cwd}` : "", toolCount ? `tools=${toolCount}` : ""]
          .filter(Boolean)
          .join(" ") || "initialized",
      });
      return;
    }

    if (evName === "result" && obj.result && typeof obj.result === "object") {
      const result = obj.result as Record<string, unknown>;
      const sessionId = extractSessionIdFromObj(result);
      if (sessionId) tracker.sessionId = sessionId;
      const status = strVal(result.status)?.toLowerCase();
      const error = strVal(result.error);
      if (error || status === "error" || status === "failed" || status === "cancelled") {
        const message = error || `AGY reported terminal status '${status}'.`;
        tracker.hasFatalError = true;
        tracker.lastErrorText = message;
        emit({ kind: "error", title: "AGY Result", content: message });
        return;
      }
      const response = strVal(result.response);
      if (response?.trim()) {
        tracker.lastResultText = response;
        if (response.trim() !== tracker.textParts.join("").trim()) {
          emit({ kind: "text", title: "Result", content: response });
        }
        return;
      }
    }

    if (evName === "step_update" && obj.step_update && typeof obj.step_update === "object") {
      const su = obj.step_update as Record<string, unknown>;
      const suSid = extractSessionIdFromObj(su);
      if (suSid) tracker.sessionId = suSid;
      const suModel = strVal(su.model) ?? strVal(su.model_id);
      if (suModel) tracker.actualModel = suModel;

      const stepType = (strVal(su.step_type) ?? "").toLowerCase();
      const stepState = (strVal(su.state) ?? "").toLowerCase();

      if (stepType === "user_input" || stepType === "system_message") {
        emit({
          kind: "system",
          title: stepType,
          content: stepState || stepType,
        });
        return;
      }

      if (stepType === "agent_response") {
        const think =
          strVal(su.thinking_delta) ?? strVal(su.thought_delta) ?? strVal(su.thinking);
        if (think) {
          emit({ kind: "thought", title: "Thinking", content: think });
        }

        const delta = strVal(su.text_delta) ?? strVal(su.delta) ?? strVal(su.text);
        if (delta) {
          tracker.textParts.push(delta);
          emit({ kind: "text", content: delta });
        }

        if (su.usage && typeof su.usage === "object") {
          const usage = extractUsageFromObj({ usage: su.usage });
          if (usage) {
            tracker.usage = accumulateUsage(tracker.usage, usage);
            emit({
              kind: "usage",
              title: "Agy Usage",
              content: `in=${usage.input_tokens} out=${usage.output_tokens} cache_r=${usage.cache_read_tokens ?? 0}`,
              meta: usage as unknown as Record<string, unknown>,
            });
          }
        }
        return;
      }

      if (stepType === "tool") {
        const toolInfo = (su.tool_info ?? {}) as Record<string, unknown>;
        const toolName = strVal(su.tool_name) ?? strVal(toolInfo.name) ?? "tool";
        if (stepState === "active") {
          tracker.toolCallsCount += 1;
          const params = toolInfo.parameters ?? toolInfo;
          emit({
            kind: "tool_call",
            title: toolName,
            content: (typeof params === "string" ? params : JSON.stringify(params)).slice(0, 2000),
          });
          return;
        }
        if (stepState === "error" || toolInfo.error) {
          const errObj = toolInfo.error as Record<string, unknown> | undefined;
          const errMsg =
            strVal(errObj?.message) ??
            strVal(toolInfo.error) ??
            JSON.stringify(toolInfo.error ?? toolInfo);
          emit({
            kind: "error",
            title: toolName,
            content: errMsg.slice(0, 2000),
          });
          return;
        }
        if (stepState === "done") {
          const out = toolInfo.result ?? toolInfo.response ?? toolInfo.output ?? toolInfo.parameters ?? "done";
          emit({
            kind: "tool_result",
            title: toolName,
            content: (typeof out === "string" ? out : JSON.stringify(out)).slice(0, 2000),
          });
          return;
        }
      }

      emit({
        kind: "system",
        title: stepType || "step_update",
        content: stepState || line.slice(0, 300),
      });
      return;
    }

    if (!handleGenericJsonLine(line, tracker, emit)) {
      tracker.textParts.push(line);
      emit({ kind: "text", content: line });
    }
  }
}
