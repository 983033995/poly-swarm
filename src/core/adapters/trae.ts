import type { BackendModelOption } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  findBinaryInPath,
  readBackendEnvFiles,
  type AdapterCapabilities,
  type AdapterRunInput,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { handleCodexStyleJsonLine } from "./codex_stream.js";
import { resolveWorktreeGitCommonDir } from "./git_worktree.js";
import { getStaticFallbackModels, mergeModelOptions, parseTraeModelsOutput, runCliListCmd } from "./models.js";

export class TraeAdapter extends BaseCliAdapter {
  readonly id = "trae" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: true,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    hasOsReadonlySandbox: true,
    defaultBinaryCandidates: ["traecli"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    const fallback = getStaticFallbackModels(this.id, override);
    const bin = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    if (!bin) return fallback;
    const raw = await runCliListCmd(bin, ["models", "--json"], 4500, {
      env: { ...override?.env, ...readBackendEnvFiles(override?.envFiles) },
      stdoutOnly: true,
    });
    const models = raw ? parseTraeModelsOutput(raw) : [];
    return models.length ? mergeModelOptions(models, fallback, override?.defaultModel) : fallback;
  }

  buildCommand(input: AdapterRunInput): { args: string[]; stdinText: string } {
    const model = (input.model ?? input.override?.defaultModel)?.trim();
    const effort = input.effort ?? input.override?.defaultEffort;
    const sandboxMode = input.mode === "readonly" ? "read-only" : "workspace-write";
    const args = input.sessionId
      ? ["exec", "resume", input.sessionId, "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandboxMode}"`]
      : ["exec", "--json", "-C", input.cwd, "--skip-git-repo-check", "-s", sandboxMode];
    args.push("-c", 'approval_policy="never"');
    if (!input.sessionId && input.mode === "write") {
      const gitCommonDir = resolveWorktreeGitCommonDir(input.cwd);
      if (gitCommonDir) args.push("--add-dir", gitCommonDir);
    }
    if (model && model.toLowerCase() !== "auto") args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
    return { args, stdinText: input.prompt };
  }

  protected handleStdoutLine(
    line: string,
    tracker: StreamTurnTracker,
    emit: (ev: NormalizedEvent) => void,
  ): void {
    handleCodexStyleJsonLine(this.id, line, tracker, emit);
  }
}
