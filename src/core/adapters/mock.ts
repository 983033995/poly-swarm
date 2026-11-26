import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendHealth, ErrorKind, UsageAccuracy } from "../../shared/types.js";
import type { BackendOverrideConfig } from "../config.js";
import type {
  AdapterCapabilities,
  AdapterRunInput,
  AdapterRunResult,
  UsageSummary,
  WorkerAdapter,
} from "./base.js";

export interface MockDirective {
  thought?: string;
  tool?: { name: string; args?: string; result?: string };
  text?: string;
  structured?: Record<string, unknown>;
  writeFile?: { path: string; content: string };
  errorKind?: ErrorKind;
  errorMessage?: string;
  sleepMs?: number;
  sessionId?: string;
  actualModel?: string;
  usage?: {
    accuracy?: UsageAccuracy;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cache_read_tokens?: number;
    cost_usd?: number | null;
  };
}

function parseMockDirective(prompt: string): MockDirective {
  const marker = "[MOCK:";
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return {};
  const start = idx + marker.length;
  let depth = 0;
  let end = -1;
  for (let i = start; i < prompt.length; i++) {
    const ch = prompt[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return {};
  try {
    return JSON.parse(prompt.slice(start, end)) as MockDirective;
  } catch {
    return {};
  }
}

export class MockAdapter implements WorkerAdapter {
  readonly id = "mock" as const;
  readonly capabilities: AdapterCapabilities = {
    supportsAcp: false,
    cliSupportsAcp: false,
    activeProtocol: "headless_cli",
    supportsHeadless: true,
    supportsResume: true,
    supportsExactUsage: true,
    supportsStrictReadonly: true,
    defaultBinaryCandidates: ["mock"],
  };

  buildCommand(input: AdapterRunInput): { args: string[] } {
    return { args: ["-p", input.prompt] };
  }

  async checkHealth(
    _override?: BackendOverrideConfig,
  ): Promise<Omit<BackendHealth, "cooldown_until" | "cooldown_reason">> {
    return {
      backend: "mock",
      installed: 1,
      binary_path: "builtin://mock",
      version: "mock-1.0.0",
      supports_acp: 0,
      cli_supports_acp: 0,
      active_protocol: "headless_cli",
      supports_headless: 1,
      supports_resume: 1,
      supports_exact_usage: 1,
      last_checked_at: Date.now(),
    };
  }

  async runTurn(input: AdapterRunInput): Promise<AdapterRunResult> {
    const started = Date.now();
    const directive = parseMockDirective(input.prompt);
    const sessionId =
      directive.sessionId ?? input.sessionId ?? `mock-ses-${crypto.randomUUID().slice(0, 6)}`;

    input.onEvent({
      kind: "system",
      title: "Start mock",
      content: `mock (${input.mode}) session=${sessionId}`,
    });

    if (directive.sleepMs && directive.sleepMs > 0) {
      const cancelled = await new Promise<boolean>((resolve) => {
        if (input.signal?.aborted) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => {
          input.signal?.removeEventListener("abort", onAbort);
          resolve(false);
        }, directive.sleepMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(true);
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (cancelled) {
        input.onEvent({ kind: "error", title: "Cancelled", content: "Mock turn cancelled" });
        return {
          ok: false,
          outputText: "",
          sessionId,
          actualModel: directive.actualModel ?? null,
          errorKind: "cancelled",
          errorMessage: "Cancelled",
          usage: {
            accuracy: "exact",
            input_tokens: 10,
            output_tokens: 0,
            total_tokens: 10,
            cost_usd: 0,
          },
          durationMs: Date.now() - started,
          toolCallsCount: 0,
          exitCode: 130,
        };
      }
    }

    if (directive.thought) {
      input.onEvent({ kind: "thought", title: "Thinking", content: directive.thought });
    }

    let toolCallsCount = 0;
    if (directive.tool) {
      toolCallsCount += 1;
      input.onEvent({
        kind: "tool_call",
        title: directive.tool.name,
        content: directive.tool.args ?? "{}",
      });
      input.onEvent({
        kind: "tool_result",
        title: directive.tool.name,
        content: directive.tool.result ?? "ok",
      });
    }

    if (directive.writeFile) {
      const target = path.resolve(input.cwd, directive.writeFile.path);
      if (target.startsWith(path.resolve(input.cwd) + path.sep) || target === path.resolve(input.cwd)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, directive.writeFile.content, "utf8");
        toolCallsCount += 1;
        input.onEvent({
          kind: "tool_call",
          title: "write_file",
          content: directive.writeFile.path,
        });
      }
    }

    const usage: UsageSummary = {
      accuracy: directive.usage?.accuracy ?? "exact",
      input_tokens: directive.usage?.input_tokens ?? 120,
      output_tokens: directive.usage?.output_tokens ?? 48,
      reasoning_tokens: directive.usage?.reasoning_tokens ?? 0,
      cache_read_tokens: directive.usage?.cache_read_tokens ?? 0,
      cache_write_tokens: 0,
      total_tokens:
        (directive.usage?.input_tokens ?? 120) +
        (directive.usage?.output_tokens ?? 48) +
        (directive.usage?.reasoning_tokens ?? 0) +
        (directive.usage?.cache_read_tokens ?? 0),
      cost_usd: directive.usage?.cost_usd ?? 0.0012,
    };

    if (directive.errorKind && directive.errorKind !== "none") {
      const msg = directive.errorMessage ?? `Mock error: ${directive.errorKind}`;
      input.onEvent({ kind: "error", title: directive.errorKind, content: msg });
      return {
        ok: false,
        outputText: "",
        sessionId,
        actualModel: directive.actualModel ?? null,
        errorKind: directive.errorKind,
        errorMessage: msg,
        usage,
        durationMs: Date.now() - started,
        toolCallsCount,
        exitCode: 1,
      };
    }

    const text = directive.text ?? `[done] Completed task in ${path.basename(input.cwd)}`;
    input.onEvent({ kind: "text", content: text });
    input.onEvent({
      kind: "usage",
      title: "Usage",
      content: `in=${usage.input_tokens} out=${usage.output_tokens}`,
      meta: usage as unknown as Record<string, unknown>,
    });

    return {
      ok: true,
      outputText: text,
      structuredJson: directive.structured ? JSON.stringify(directive.structured) : null,
      sessionId,
      actualModel: directive.actualModel ?? null,
      errorKind: "none",
      errorMessage: null,
      usage,
      durationMs: Date.now() - started,
      toolCallsCount,
      exitCode: 0,
    };
  }
}
