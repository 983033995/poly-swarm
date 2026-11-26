import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  findBinaryInPath,
  type AdapterCapabilities,
  type AdapterRunInput,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { handleGenericJsonLine } from "./json_helpers.js";
import {
  getStaticFallbackModels,
  mergeModelOptions,
  parseQoderModelsOutput,
  runCliListCmd,
} from "./models.js";

export class QoderAdapter extends BaseCliAdapter {
  readonly id = "qoder" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: true,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: false,
    supportsStrictReadonly: true,
    defaultBinaryCandidates: ["qodercli"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    const fallback = getStaticFallbackModels("qoder", override);
    const bin = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    if (!bin) return fallback;
    const raw = await runCliListCmd(bin, ["--list-models"], 6000);
    if (!raw) return fallback;
    const detected = parseQoderModelsOutput(raw);
    if (detected.length === 0) return fallback;
    return mergeModelOptions(detected, fallback, override?.defaultModel, Date.now());
  }

  buildCommand(input: AdapterRunInput): { args: string[] } {
    const args: string[] = [
      "-p",
      "-w",
      input.cwd,
      "-o",
      "stream-json",
    ];
    if (input.sessionId) {
      args.push("-r", input.sessionId);
    }
    if (input.mode === "readonly") {
      args.push("--permission-mode", "dont_ask", "--disallowed-tools", "Write,Edit,MultiEdit,NotebookEdit");
    } else {
      args.push("--yolo");
    }
    const model = input.model ?? input.override?.defaultModel;
    if (model) args.push("-m", model);
    const effort = input.effort ?? input.override?.defaultEffort;
    if (effort) args.push("--reasoning-effort", effort);
    args.push(input.prompt);
    return { args };
  }

  protected handleStdoutLine(
    line: string,
    tracker: StreamTurnTracker,
    emit: (ev: NormalizedEvent) => void,
  ): void {
    if (!handleGenericJsonLine(line, tracker, emit)) {
      tracker.textParts.push(line);
      emit({ kind: "text", content: line });
    }
  }
}
