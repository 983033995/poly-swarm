import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BackendId, BackendModelOption } from "../../shared/types.js";
import { buildAugmentedPath, type BackendOverrideConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const STATIC_FALLBACK_MODELS: Record<Exclude<BackendId, "mock">, BackendModelOption[]> = {
  agy: [
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)" },
    { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" },
    { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
  codex: [
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "o3", label: "OpenAI o3" },
    { id: "o4-mini", label: "OpenAI o4-mini" },
  ],
  cursor: [
    { id: "auto", label: "Auto (Default)" },
    { id: "grok-4.7-high-fast", label: "Grok 4.7 High Fast" },
    { id: "grok-4.7-high", label: "Grok 4.7 High" },
    { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 Thinking High" },
    { id: "claude-opus-5-thinking-high-fast", label: "Claude Opus 5 Thinking High Fast" },
    { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol High" },
    { id: "gpt-5.3-codex-high", label: "Codex 5.3 High" },
  ],
  grok: [
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
  ],
  opencode: [
    { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" },
    { id: "cliproxyapi/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "cliproxyapi/gemini-3.8-flash-high", label: "Gemini 3.8 Flash High" },
    { id: "cliproxyapi/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ],
  codebuddy: [
    { id: "hy4flash-free", label: "hy4flash-free (推荐免费)" },
    { id: "hy4flash", label: "hy4flash" },
    { id: "hy4std", label: "hy4std" },
    { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash" },
    { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
    { id: "glm-5.3", label: "glm-5.3" },
    { id: "glm-5.3-flash", label: "glm-5.3-flash" },
    { id: "kimi-k3.1-pro", label: "kimi-k3.1-pro" },
    { id: "minimax-m3.1-flash", label: "minimax-m3.1-flash" },
  ],
  qoder: [
    { id: "Auto", label: "Auto" },
    { id: "Ultimate", label: "Ultimate" },
    { id: "Fast", label: "Fast" },
    { id: "Efficient", label: "Efficient" },
    { id: "dfmodel", label: "DeepSeek-Flash (dfmodel)" },
    { id: "DeepSeek-V4-Pro", label: "DeepSeek-V4-Pro" },
    { id: "Qwen4-Max", label: "Qwen4-Max" },
    { id: "GLM-5.3", label: "GLM-5.3" },
    { id: "Kimi-K3.1-Pro", label: "Kimi-K3.1-Pro" },
  ],
  trae: [
    { id: "auto", label: "Auto (TRAE 智能路由)" },
    { id: "doubao-seed-code", label: "Doubao Seed Code" },
    { id: "deepseek-v4.1", label: "DeepSeek V4.1" },
    { id: "glm-5.3", label: "GLM 5.3" },
    { id: "kimi-k3.1", label: "Kimi K3.1" },
    { id: "minimax-m3.1-flash", label: "MiniMax M3.1 Flash" },
  ],
};

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export async function runCliListCmd(
  binaryPath: string,
  args: string[],
  timeoutMs = 4500,
  opts?: { env?: Record<string, string>; stdoutOnly?: boolean },
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PATH: buildAugmentedPath(), ...opts?.env },
    });
    return stripAnsi(opts?.stdoutOnly ? stdout : `${stdout || ""}\n${stderr || ""}`);
  } catch {
    return null;
  }
}

export function mergeModelOptions(
  detected: BackendModelOption[],
  fallback: BackendModelOption[],
  configuredDefault?: string | null,
  detectedAt?: number | null,
): BackendModelOption[] {
  const seen = new Set<string>();
  const result: BackendModelOption[] = [];
  const defaultDetectedAt = detected.length > 0 ? (detectedAt === undefined ? Date.now() : detectedAt) : null;

  const pushUnique = (opt: BackendModelOption) => {
    const id = opt.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({
      id,
      ...(opt.label ? { label: opt.label } : {}),
      ...(opt.source ? { source: opt.source } : {}),
      ...(opt.detected_at !== undefined ? { detected_at: opt.detected_at } : {}),
    });
  };

  if (configuredDefault && configuredDefault.trim()) {
    const cfgId = configuredDefault.trim();
    const matchedDetected = detected.find((m) => m.id === cfgId);
    const matched = matchedDetected ?? fallback.find((m) => m.id === cfgId);
    pushUnique({
      id: cfgId,
      label: matched?.label ? `${matched.label} (当前配置)` : `${cfgId} (当前配置)`,
      source: "configured",
      detected_at: matchedDetected ? (matchedDetected.detected_at ?? defaultDetectedAt) : null,
    });
  }

  for (const item of detected) {
    pushUnique({
      ...item,
      source: item.source ?? "detected",
      detected_at: item.detected_at !== undefined ? item.detected_at : defaultDetectedAt,
    });
  }
  for (const item of fallback) {
    pushUnique({
      ...item,
      source: item.source ?? "fallback",
      detected_at: item.detected_at !== undefined ? item.detected_at : null,
    });
  }
  return result;
}

export function parseAgyModelsOutput(raw: string): BackendModelOption[] {
  const out: BackendModelOption[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^fetching/i.test(trimmed)) continue;
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx > 0) {
      const id = trimmed.slice(0, tabIdx).trim();
      const label = trimmed.slice(tabIdx + 1).trim();
      if (/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) out.push({ id, label: label || id });
    } else {
      const m = trimmed.match(/^([a-zA-Z0-9._:/-]+)\s{2,}(.+)$/);
      if (m?.[1]) out.push({ id: m[1], label: m[2]?.trim() || m[1] });
    }
  }
  return out;
}

export function parseCursorModelsOutput(raw: string): BackendModelOption[] {
  const out: BackendModelOption[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models/i.test(trimmed) || /^loading/i.test(trimmed)) continue;
    const m = trimmed.match(/^([a-zA-Z0-9._:/\[\]-]+)\s+-\s+(.+)$/);
    if (m?.[1]) {
      out.push({ id: m[1], label: m[2]?.trim() || m[1] });
    }
  }
  return out;
}

export function parseCodeBuddyModelsFromHelp(raw: string): BackendModelOption[] {
  const m = raw.match(/Currently supported:\s*\(([^)]+)\)/i);
  if (!m?.[1]) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id === "hy4flash-free" ? "hy4flash-free (推荐免费)" : id }));
}

export function parseQoderModelsOutput(raw: string): BackendModelOption[] {
  const out: BackendModelOption[] = [];
  const counts = new Map<string, number>();
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "MODEL" && !/^loading/i.test(l));

  for (const line of lines) {
    const customMatch = line.match(/^(.+?)\s+\(([^)]+)\)$/);
    if (!customMatch) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  for (const line of lines) {
    const customMatch = line.match(/^(.+?)\s+\(([^)]+)\)$/);
    if (customMatch?.[1] && customMatch[2]) {
      const display = customMatch[1].trim();
      const key = customMatch[2].trim();
      out.push({ id: key, label: `${display} (${key})` });
      continue;
    }
    if ((counts.get(line) ?? 0) > 1) {
      if (line.toLowerCase() === "deepseek-flash") {
        out.push({ id: "dfmodel", label: "DeepSeek-Flash (dfmodel)" });
      }
      continue;
    }
    out.push({ id: line, label: line });
  }
  return out;
}

export function parseOpenCodeModelsOutput(raw: string): BackendModelOption[] {
  const ids = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/\s/.test(l) && l.includes("/"));
  const freeFirst = [
    ...ids.filter((id) => id.startsWith("opencode/") || id.includes("free")),
    ...ids.filter((id) => !id.startsWith("opencode/") && !id.includes("free")),
  ];
  return freeFirst.slice(0, 80).map((id) => ({ id, label: id }));
}

export function parseTraeModelsOutput(raw: string): BackendModelOption[] {
  const out: BackendModelOption[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, label?: unknown) => {
    if (typeof id !== "string") return;
    const key = id.trim();
    if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ id: key, label: (typeof label === "string" && label.trim()) || key });
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      const entry = value as Record<string, unknown>;
      if (entry.hidden === true) return;
      const list = entry.models ?? entry.data;
      if (Array.isArray(list)) visit(list);
      else add(entry.model ?? entry.id ?? entry.slug ?? entry.name, entry.displayName ?? entry.display_name ?? entry.label ?? entry.name);
    } else {
      add(value);
    }
  };

  try {
    visit(JSON.parse(raw));
    return out;
  } catch {
    // Older CLI output can be a line-based list.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:models?|loading|fetching|available models|error|warning|notice)(?:[:\s]|$)/i.test(trimmed)) continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { visit(JSON.parse(trimmed)); } catch { /* ignore incomplete JSON rows */ }
      continue;
    }
    const match = trimmed.match(/^(?:[-*]\s+)?([a-z0-9][a-z0-9._:/-]*)(?:\s+-\s+(.+)|\t+(.+)| {2,}(.+))?$/i);
    if (match) add(match[1], match[2] ?? match[3] ?? match[4]);
  }
  return out;
}

export function getStaticFallbackModels(
  backend: Exclude<BackendId, "mock">,
  override?: BackendOverrideConfig,
): BackendModelOption[] {
  return mergeModelOptions([], STATIC_FALLBACK_MODELS[backend] ?? [], override?.defaultModel, null);
}
