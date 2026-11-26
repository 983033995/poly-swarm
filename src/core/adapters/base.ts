import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  BackendHealth,
  BackendId,
  BackendModelOption,
  ErrorKind,
  EventKind,
  UsageAccuracy,
} from "../../shared/types.js";
import { buildAugmentedPath, type BackendOverrideConfig } from "../config.js";
import { agyProfileCommand, type AgyLaunchProfile } from "../agy_accounts.js";

const execFileAsync = promisify(execFile);

export interface NormalizedEvent {
  kind: EventKind;
  title?: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface UsageSummary {
  accuracy: UsageAccuracy;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_usd?: number | null;
}

export interface AdapterRunInput {
  cwd: string;
  prompt: string;
  mode: "readonly" | "write";
  sessionId?: string | null;
  model?: string | null;
  effort?: string | null;
  jsonSchema?: Record<string, unknown> | null;
  timeoutMs: number;
  idleTimeoutMs?: number;
  hookMetricsDir: string;
  override?: BackendOverrideConfig;
  agyProfile?: AgyLaunchProfile;
  signal?: AbortSignal;
  onEvent: (event: NormalizedEvent) => void;
}

export interface AdapterRunResult {
  ok: boolean;
  outputText: string;
  structuredJson?: string | null;
  sessionId?: string | null;
  actualModel?: string | null;
  errorKind: ErrorKind;
  errorMessage?: string | null;
  usage: UsageSummary;
  durationMs: number;
  toolCallsCount: number;
  hadFileChange?: boolean;
  exitCode: number | null;
}

export interface AdapterCapabilities {
  supportsAcp: boolean;
  cliSupportsAcp?: boolean;
  activeProtocol?: "headless_cli" | "app_server" | "acp";
  supportsHeadless: boolean;
  supportsResume: boolean;
  supportsExactUsage: boolean;
  supportsStrictReadonly: boolean;
  hasOsReadonlySandbox?: boolean;
  defaultBinaryCandidates: string[];
  versionArgs?: string[];
}

export interface WorkerAdapter {
  readonly id: BackendId;
  readonly capabilities: AdapterCapabilities;
  buildCommand(input: AdapterRunInput, binaryPath: string): {
    args: string[];
    env?: Record<string, string>;
    stdinText?: string;
  };
  checkHealth(override?: BackendOverrideConfig): Promise<
    Omit<BackendHealth, "cooldown_until" | "cooldown_reason">
  >;
  listAvailableModels?(override?: BackendOverrideConfig, agyProfile?: AgyLaunchProfile): Promise<BackendModelOption[]>;
  runTurn(input: AdapterRunInput): Promise<AdapterRunResult>;
}

export function safeJsonParse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const val = JSON.parse(trimmed) as unknown;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function strVal(val: unknown): string | null {
  return typeof val === "string" && val.length > 0 ? val : null;
}

export function numVal(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

/**
 * Heuristic token estimator for backends that omit usage metrics.
 * Counts ~1.5 chars per token for CJK and ~3.8 chars per token for Latin text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk += 1;
    }
  }
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.4 + nonCjk / 3.8));
}

export function buildEstimatedUsage(prompt: string, output: string): UsageSummary {
  const input_tokens = estimateTokens(prompt);
  const output_tokens = estimateTokens(output);
  return {
    accuracy: "estimated",
    input_tokens,
    output_tokens,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: input_tokens + output_tokens,
    cost_usd: null,
  };
}

export function readCursorHookUsage(
  hookDir: string,
  sessionId: string | null | undefined,
): UsageSummary | null {
  if (!sessionId || !hookDir) return null;
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "");
  const candidates = [
    path.join(hookDir, `cursor-${safeId}.json`),
    path.join(hookDir, `${safeId}.json`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const input = numVal(data.input_tokens) ?? 0;
      const output = numVal(data.output_tokens) ?? 0;
      const cacheRead = numVal(data.cache_read_tokens) ?? 0;
      const cacheWrite = numVal(data.cache_write_tokens) ?? 0;
      const reasoning = numVal(data.reasoning_tokens) ?? 0;
      if (input + output + cacheRead + cacheWrite > 0) {
        return {
          accuracy: "hook",
          input_tokens: input,
          output_tokens: output,
          reasoning_tokens: reasoning,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          total_tokens: input + output + reasoning + cacheRead + cacheWrite,
          cost_usd: numVal(data.cost_usd),
        };
      }
    } catch {
      // ignore malformed hook metric file
    }
  }
  return null;
}

export function isMissingWorkerEnvironment(message: string): boolean {
  return /missing environment variable:|private environment file for/i.test(message);
}

export function readBackendEnvFiles(files: BackendOverrideConfig["envFiles"]): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const [key, file] of Object.entries(files ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("Invalid variable name in backend envFiles.");
    }
    try {
      if (!path.isAbsolute(file)) throw new Error();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() ||
            stat.size < 1 || stat.size > 16_384) throw new Error();
        const buf = Buffer.alloc(16_385);
        const length = fs.readSync(fd, buf, 0, buf.length, 0);
        if (length > 16_384) throw new Error();
        const value = buf.toString("utf8", 0, length).replace(/\r?\n$/, "");
        if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error();
        env[key] = value;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      throw new Error(`Missing, invalid or unreadable private environment file for ${key}.`);
    }
  }
  return env;
}

export function classifyError(params: {
  exitCode: number | null;
  stderr: string;
  lastErrorText?: string | null;
  hasFatalError?: boolean;
  hasOutput?: boolean;
  timedOut: boolean;
  cancelled: boolean;
}): ErrorKind {
  if (params.cancelled) return "cancelled";
  if (params.timedOut) return "timeout";
  if (
    params.exitCode === 0 &&
    !params.hasFatalError &&
    !params.lastErrorText &&
    params.hasOutput !== false
  ) {
    return "none";
  }

  const combined = `${params.lastErrorText ?? ""}\n${params.stderr}`.toLowerCase();

  if (isMissingWorkerEnvironment(combined)) return "config_error";
  if (/permission check failed for unsandboxed|permission required:.*headless run cannot ask for approval/.test(combined)) {
    return "permission_denied";
  }
  if (/agent turn stopped after repeated resume attempts made no progress|^\s*(?:error:\s*)?\[unavailable\]\s*$/m.test(combined)) {
    return "connection_error";
  }
  if (
    /\b401\b|\b403\b|unauthorized|not logged in|login required|authentication required|please use \/login|please run \/login|invalid api key|auth_unavailable|not authenticated|workspace trust required|do you trust the contents of this directory|no trae auth token|headless codebase git authentication failed/.test(
      combined,
    )
  ) {
    return "auth_error";
  }
  if (
    /\b429\b|rate[ _-]?limit|\bquota\b|insufficient[ _-]?(?:quota|credits?)|usage[ _-]?limit|out of credits?|credit[ _-]?(?:limit|exhausted)|resource has been exhausted|too many requests|\boverloaded\b|\bcapacity\b/.test(
      combined,
    )
  ) {
    return "quota_exhausted";
  }
  if (
    /\b400\b[\s\S]{0,160}model|model\s+\[?[^\]]+\]?\s+(?:service info )?not found|ambiguous model|specify a model key|unknown model|invalid model|unsupported model/.test(
      combined,
    )
  ) {
    return "config_error";
  }
  if (params.exitCode === 0) {
    return params.hasFatalError ? "unknown" : "none";
  }
  return "unknown";
}

export function findBinaryInPath(candidates: string[], overrideCmd?: string): string | null {
  const list = overrideCmd ? [overrideCmd, ...candidates] : candidates;
  const searchDirs = buildAugmentedPath().split(path.delimiter).filter(Boolean);

  for (const candidate of list) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    for (const dir of searchDirs) {
      const full = path.join(dir, candidate);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

export async function probeBinaryVersion(
  binaryPath: string,
  versionArgs: string[] = ["--version"],
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, versionArgs, {
      timeout: 3000,
      env: { ...process.env, PATH: buildAugmentedPath() },
    });
    const text = (stdout || stderr || "").trim();
    return text.split(/\r?\n/)[0]?.slice(0, 120) || null;
  } catch {
    return null;
  }
}

export interface SpawnStreamingResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutReason?: "hard" | "idle" | null;
  cancelled: boolean;
  durationMs: number;
}

export function spawnStreamingCli(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  replaceEnv?: boolean;
  stdinText?: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
}): Promise<SpawnStreamingResult> {
  const started = Date.now();
  const useStdinPipe = params.stdinText !== undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: {
        ...(params.replaceEnv ? {} : process.env),
        PATH: buildAugmentedPath(),
        ...params.env,
      },
      detached: true,
      stdio: [useStdinPipe ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (useStdinPipe && child.stdin) {
      child.stdin.on("error", () => {
        // ignore EPIPE if child exits early
      });
      child.stdin.end(params.stdinText, "utf8");
    }

    let timedOut = false;
    let timeoutReason: "hard" | "idle" | null = null;
    let cancelled = false;
    let killEscalation: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const clearTimers = () => {
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const terminateGroup = (reason: "hard" | "idle" | null, markCancel: boolean) => {
      clearTimers();
      if (reason) {
        timedOut = true;
        if (!timeoutReason) timeoutReason = reason;
      }
      if (markCancel) cancelled = true;
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      if (!killEscalation) {
        killEscalation = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {
                // ignore
              }
            }
          }
        }, 3000);
        killEscalation.unref();
      }
    };

    const idleMs = params.idleTimeoutMs ?? 0;
    const armIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (
        idleMs > 0 &&
        !timedOut &&
        !cancelled &&
        (params.timeoutMs <= 0 || idleMs < params.timeoutMs)
      ) {
        idleTimer = setTimeout(() => terminateGroup("idle", false), idleMs);
      }
    };

    if (params.timeoutMs > 0) {
      hardTimer = setTimeout(() => terminateGroup("hard", false), params.timeoutMs);
    }
    armIdleTimer();

    const onAbort = () => terminateGroup(null, true);
    if (params.signal) {
      if (params.signal.aborted) {
        terminateGroup(null, true);
      } else {
        params.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const bindReader = (
      stream: NodeJS.ReadableStream | null,
      name: "stdout" | "stderr",
      collector: string[],
    ) => {
      if (!stream) return;
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (name === "stdout" && chunk.trim().length > 0 && !timedOut && !cancelled) {
          armIdleTimer();
        }
        collector.push(chunk);
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line.length > 0) params.onLine(name, line);
        }
      });
      stream.on("end", () => {
        if (buf.length > 0) {
          params.onLine(name, buf.replace(/\r$/, ""));
          buf = "";
        }
      });
    };

    bindReader(child.stdout, "stdout", stdoutChunks);
    bindReader(child.stderr, "stderr", stderrChunks);

    child.on("error", (err) => {
      clearTimers();
      if (killEscalation) clearTimeout(killEscalation);
      params.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimers();
      if (killEscalation) clearTimeout(killEscalation);
      params.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        timedOut,
        timeoutReason,
        cancelled,
        durationMs: Date.now() - started,
      });
    });
  });
}

export interface StreamTurnTracker {
  sessionId: string | null;
  actualModel: string | null;
  textParts: string[];
  lastResultText: string | null;
  structuredJson: string | null;
  lastErrorText: string | null;
  hasFatalError: boolean;
  toolCallsCount: number;
  hadFileChange: boolean;
  usage: UsageSummary | null;
}

export function createTurnTracker(): StreamTurnTracker {
  return {
    sessionId: null,
    actualModel: null,
    textParts: [],
    lastResultText: null,
    structuredJson: null,
    lastErrorText: null,
    hasFatalError: false,
    toolCallsCount: 0,
    hadFileChange: false,
    usage: null,
  };
}

export abstract class BaseCliAdapter implements WorkerAdapter {
  abstract readonly id: BackendId;
  abstract readonly capabilities: AdapterCapabilities;

  abstract buildCommand(input: AdapterRunInput, binaryPath: string): {
    args: string[];
    env?: Record<string, string>;
    stdinText?: string;
  };

  protected abstract handleStdoutLine(
    line: string,
    tracker: StreamTurnTracker,
    emit: (ev: NormalizedEvent) => void,
  ): void;

  async checkHealth(
    override?: BackendOverrideConfig,
  ): Promise<Omit<BackendHealth, "cooldown_until" | "cooldown_reason">> {
    const binaryPath = findBinaryInPath(
      this.capabilities.defaultBinaryCandidates,
      override?.command,
    );
    const version = binaryPath
      ? await probeBinaryVersion(binaryPath, this.capabilities.versionArgs)
      : null;

    return {
      backend: this.id,
      installed: binaryPath ? 1 : 0,
      binary_path: binaryPath,
      version,
      supports_acp: this.capabilities.supportsAcp ? 1 : 0,
      cli_supports_acp: this.capabilities.cliSupportsAcp ? 1 : 0,
      active_protocol: this.capabilities.activeProtocol ?? "headless_cli",
      supports_headless: this.capabilities.supportsHeadless ? 1 : 0,
      supports_resume: this.capabilities.supportsResume ? 1 : 0,
      supports_exact_usage: this.capabilities.supportsExactUsage ? 1 : 0,
      last_checked_at: Date.now(),
    };
  }

  async listAvailableModels(override?: BackendOverrideConfig): Promise<BackendModelOption[]> {
    return [];
  }

  protected resolveFinalUsage(
    input: AdapterRunInput,
    tracker: StreamTurnTracker,
    outputText: string,
  ): UsageSummary {
    return tracker.usage ?? buildEstimatedUsage(input.prompt, outputText);
  }

  async runTurn(input: AdapterRunInput): Promise<AdapterRunResult> {
    const binaryPath = findBinaryInPath(
      this.capabilities.defaultBinaryCandidates,
      input.override?.command,
    );
    if (!binaryPath) {
      const msg = `CLI binary not found for backend '${this.id}' (tried: ${this.capabilities.defaultBinaryCandidates.join(", ")})`;
      input.onEvent({ kind: "error", title: "Binary Missing", content: msg });
      return {
        ok: false,
        outputText: "",
        actualModel: null,
        errorKind: "binary_missing",
        errorMessage: msg,
        usage: buildEstimatedUsage(input.prompt, ""),
        durationMs: 0,
        toolCallsCount: 0,
        exitCode: null,
      };
    }

    const profile = this.id === "agy" ? input.agyProfile : undefined;
    let envFiles: Record<string, string>;
    try {
      envFiles = profile ? {} : readBackendEnvFiles(input.override?.envFiles);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to prepare backend environment.";
      input.onEvent({ kind: "error", title: "Backend Environment", content: message });
      return {
        ok: false, outputText: "", errorKind: "config_error", errorMessage: message,
        usage: { accuracy: "estimated", input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: null },
        durationMs: 0, toolCallsCount: 0, exitCode: null,
      };
    }

    const { args, env, stdinText } = this.buildCommand(input, binaryPath);
    const finalArgs = [...args, ...(input.override?.extraArgs ?? [])];
    const mergedEnv = { ...(input.override?.env ?? {}), ...envFiles, ...(env ?? {}) };
    const launch = profile ? agyProfileCommand(profile, binaryPath, args, input.override?.env)
      : { command: binaryPath, args: finalArgs, env: mergedEnv };

    const tracker = createTurnTracker();
    input.onEvent({
      kind: "system",
      title: `Start ${this.id}`,
      content: `${path.basename(binaryPath)} (${input.mode})`,
      meta: { backend: this.id, model: input.model ?? null, session_id: input.sessionId ?? null },
    });

    const spawnRes = await spawnStreamingCli({
      ...launch,
      cwd: input.cwd,
      stdinText,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      signal: input.signal,
      onLine: (stream, line) => {
        if (stream === "stderr") {
          input.onEvent({ kind: "raw", title: "stderr", content: line });
          return;
        }
        this.handleStdoutLine(line, tracker, input.onEvent);
      },
    });

    const outputText = (tracker.lastResultText ?? tracker.textParts.join("")).trim();
    const errorKind = classifyError({
      exitCode: spawnRes.exitCode,
      stderr: spawnRes.stderr,
      lastErrorText: tracker.lastErrorText,
      hasFatalError: tracker.hasFatalError,
      hasOutput: outputText.length > 0,
      timedOut: spawnRes.timedOut,
      cancelled: spawnRes.cancelled,
    });

    const ok =
      !spawnRes.timedOut &&
      !spawnRes.cancelled &&
      spawnRes.exitCode === 0 &&
      !tracker.hasFatalError &&
      errorKind === "none";

    const usage = this.resolveFinalUsage(input, tracker, outputText);
    const idleLimitLabel =
      (input.idleTimeoutMs ?? 0) >= 1000
        ? `${Math.round((input.idleTimeoutMs ?? 0) / 1000)}s`
        : `${input.idleTimeoutMs ?? 0}ms`;
    const errorMessage = ok
      ? null
      : spawnRes.timedOut
        ? spawnRes.timeoutReason === "idle"
          ? `Timed out after ${Math.round(spawnRes.durationMs / 1000)}s (idle limit ${idleLimitLabel} with no stdout activity)`
          : `Timed out after ${input.timeoutMs}ms (hard turn limit)`
        : spawnRes.cancelled
          ? "Cancelled"
          : tracker.lastErrorText || spawnRes.stderr.trim() || `Process exited with code ${spawnRes.exitCode}`;

    return {
      ok,
      outputText,
      structuredJson: tracker.structuredJson,
      sessionId: tracker.sessionId ?? input.sessionId ?? null,
      actualModel: tracker.actualModel,
      errorKind,
      errorMessage,
      usage,
      durationMs: spawnRes.durationMs,
      toolCallsCount: tracker.toolCallsCount,
      hadFileChange: tracker.hadFileChange,
      exitCode: spawnRes.exitCode,
    };
  }
}

export function extractTextContent(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val.map((item) => extractTextContent(item)).filter(Boolean).join("");
  }
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.delta === "string") return obj.delta;
    if (Array.isArray(obj.content)) return extractTextContent(obj.content);
  }
  return "";
}
