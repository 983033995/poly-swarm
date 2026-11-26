import { spawn } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";
import type { BackendModelOption } from "../../shared/types.js";
import { buildAugmentedPath, type BackendOverrideConfig } from "../config.js";
import {
  BaseCliAdapter,
  findBinaryInPath,
  readBackendEnvFiles,
  safeJsonParse,
  type AdapterCapabilities,
  type AdapterRunInput,
  type NormalizedEvent,
  type StreamTurnTracker,
} from "./base.js";
import { handleCodexStyleJsonLine } from "./codex_stream.js";
import { resolveWorktreeGitCommonDir } from "./git_worktree.js";
import { mergeModelOptions } from "./models.js";

function queryCodexModels(binaryPath: string, override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
  const env = { ...process.env, PATH: buildAugmentedPath(), ...override?.env, ...readBackendEnvFiles(override?.envFiles) };
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["app-server"], { cwd: os.homedir(), env, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const models: BackendModelOption[] = [];
    const seenCursors = new Set<string>();
    let requestId = 1;
    let complete = false;
    const timeout = setTimeout(() => {
      reject(new Error("Timed out reading the Codex model catalog."));
      lines.close();
      child.stdin.end();
      child.kill("SIGKILL");
    }, 5_000);
    const send = (message: Record<string, unknown>) => child.stdin.write(JSON.stringify(message) + "\n");
    const requestModels = (cursor?: string) => {
      send({ id: ++requestId, method: "model/list", params: { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) } });
    };
    const stop = () => {
      lines.close();
      child.stdin.end();
    };
    lines.on("line", (line) => {
      const reply = safeJsonParse(line);
      if (!reply || reply.id !== requestId) return;
      const result = reply.result as { data?: unknown; nextCursor?: unknown } | null | undefined;
      if (reply.error || !result || typeof result !== "object") return stop();
      if (requestId === 1) {
        send({ method: "initialized" });
        return requestModels();
      }
      if (!Array.isArray(result.data)) return stop();
      for (const item of result.data) {
        if (!item || item.hidden === true || typeof item.model !== "string" || !item.model.trim()) continue;
        const id = item.model.trim();
        const label = typeof item.displayName === "string" ? item.displayName.trim() : "";
        models.push({ id, label: label || id });
      }
      if (typeof result.nextCursor === "string" && result.nextCursor) {
        if (seenCursors.size >= 20 || seenCursors.has(result.nextCursor)) return stop();
        seenCursors.add(result.nextCursor);
        return requestModels(result.nextCursor);
      }
      complete = true;
      stop();
    });
    child.stdin.on("error", stop);
    child.on("error", stop);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (complete && code === 0) resolve(mergeModelOptions(models, []));
      else reject(new Error("Unable to read the Codex model catalog."));
    });
    send({ id: requestId, method: "initialize", params: { clientInfo: { name: "poly-swarm", version: "0.5.0" } } });
  });
}

export class CodexAdapter extends BaseCliAdapter {
  readonly id = "codex" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: false,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    hasOsReadonlySandbox: true,
    defaultBinaryCandidates: ["codex"],
    versionArgs: ["--version"],
  };

  override async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    const binaryPath = findBinaryInPath(this.capabilities.defaultBinaryCandidates, override?.command);
    return binaryPath ? queryCodexModels(binaryPath, override) : [];
  }

  buildCommand(input: AdapterRunInput): { args: string[]; stdinText?: string } {
    const model = input.model ?? input.override?.defaultModel;
    const effort = input.effort ?? input.override?.defaultEffort;
    const sandboxMode = input.mode === "readonly" ? "read-only" : "workspace-write";
    if (input.sessionId) {
      const args = [
        "exec",
        "resume",
        input.sessionId,
        "--json",
        "--skip-git-repo-check",
        "--trust",
        "-c",
        `sandbox_mode="${sandboxMode}"`,
        "-c",
        'approval_policy="never"',
      ];
      if (model) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("-");
      return { args, stdinText: input.prompt };
    }

    const args = [
      "exec",
      "--json",
      "-C",
      input.cwd,
      "--skip-git-repo-check",
      "--trust",
      "--sandbox",
      sandboxMode,
      "-c",
      'approval_policy="never"',
    ];
    if (input.mode === "write") {
      const gitCommonDir = resolveWorktreeGitCommonDir(input.cwd);
      if (gitCommonDir) {
        args.push("--add-dir", gitCommonDir);
      }
    }
    if (model) args.push("-m", model);
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
