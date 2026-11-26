import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BackendId,
  CapabilityTag,
  DispatchIdentityPatch,
  DispatchPolicyLayerConfig,
  PlannedGraphLink,
  RealBackendId,
  WorkerRole,
} from "../shared/types.js";

export interface BackendOverrideConfig {
  command?: string;
  defaultModel?: string;
  defaultEffort?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  envFiles?: Record<string, string>;
  enabled?: boolean;
}

export interface PolySwarmConfig {
  configPath: string;
  routes: Record<CapabilityTag, BackendId[]>;
  backends: Partial<Record<BackendId, BackendOverrideConfig>>;
  identities?: Record<string, DispatchIdentityPatch | null>;
  topology?: PlannedGraphLink[];
  globalUiRaw?: DispatchPolicyLayerConfig;
  maxConcurrency: number;
  defaultTurnTimeoutMs: number;
  defaultIdleTimeoutMs: number;
  cooldownMs: number;
  watchdogIntervalMs: number;
  stallThresholdMs: number;
  hookMetricsDir: string;
  historyAwareRouting?: boolean;
}

export const DEFAULT_ROUTES: Record<CapabilityTag, BackendId[]> = {
  architect: ["agy", "cursor", "codex", "grok", "trae", "opencode", "qoder", "codebuddy"],
  author: ["cursor", "codex", "agy", "trae", "qoder", "opencode", "grok", "codebuddy"],
  verifier: ["agy", "grok", "cursor", "codex", "trae", "opencode", "qoder", "codebuddy"],
  research: ["grok", "opencode", "agy", "cursor", "trae", "qoder"],
  enterprise: ["codebuddy", "trae", "agy", "qoder", "opencode"],
  fanout: ["opencode", "agy", "qoder", "grok", "codex", "trae"],
};

export const EXTRA_BIN_DIRS: string[] = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".npm-global", "bin"),
  path.join(os.homedir(), ".bun", "bin"),
  path.join(os.homedir(), ".cargo", "bin"),
];

export function buildAugmentedPath(basePath = process.env.PATH ?? ""): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of [...EXTRA_BIN_DIRS, ...basePath.split(path.delimiter)]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(path.delimiter);
}

export function roleToDefaultCapability(role: WorkerRole): CapabilityTag {
  switch (role) {
    case "verifier":
      return "verifier";
    case "researcher":
      return "research";
    case "author":
      return "author";
    default:
      return "author";
  }
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".poly-swarm", "backends.json");
}

export function defaultHookMetricsDir(): string {
  return path.join(os.homedir(), ".poly-swarm", "hooks");
}

export function writeJsonAtomic(target: string, payload: unknown, mode = 0o600): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(target).replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode,
    });
    fs.renameSync(tmpPath, target);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

export function loadPolySwarmConfig(configPath?: string): PolySwarmConfig {
  const target = configPath || process.env.POLY_SWARM_CONFIG || defaultConfigPath();
  const globalUiRaw: DispatchPolicyLayerConfig = {};
  const base: PolySwarmConfig = {
    configPath: target,
    routes: structuredClone(DEFAULT_ROUTES),
    backends: {},
    globalUiRaw,
    maxConcurrency: 4,
    defaultTurnTimeoutMs: 30 * 60 * 1000,
    defaultIdleTimeoutMs: 10 * 60 * 1000,
    cooldownMs: 5 * 60 * 1000,
    watchdogIntervalMs: 30 * 1000,
    stallThresholdMs: 90 * 1000,
    hookMetricsDir: defaultHookMetricsDir(),
  };

  if (!fs.existsSync(target)) {
    return base;
  }

  try {
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<PolySwarmConfig>;
    if (parsed.routes && typeof parsed.routes === "object") {
      const rawRoutes: Partial<Record<CapabilityTag, BackendId[]>> = {};
      for (const key of Object.keys(base.routes) as CapabilityTag[]) {
        const list = parsed.routes[key];
        if (Array.isArray(list) && list.length > 0) {
          base.routes[key] = list;
          rawRoutes[key] = [...list];
        }
      }
      if (Object.keys(rawRoutes).length > 0) {
        globalUiRaw.routes = rawRoutes;
      }
    }
    if (parsed.backends && typeof parsed.backends === "object" && !Array.isArray(parsed.backends)) {
      base.backends = parsed.backends;
      const rawBackends: NonNullable<DispatchPolicyLayerConfig["backends"]> = {};
      for (const [bKey, bCfg] of Object.entries(parsed.backends)) {
        if (!bCfg || typeof bCfg !== "object") continue;
        const entry: { enabled?: boolean; defaultModel?: string | null; defaultEffort?: string | null } = {};
        if (typeof bCfg.enabled === "boolean") entry.enabled = bCfg.enabled;
        if (typeof bCfg.defaultModel === "string") entry.defaultModel = bCfg.defaultModel;
        if (typeof bCfg.defaultEffort === "string") entry.defaultEffort = bCfg.defaultEffort;
        if (Object.keys(entry).length > 0) {
          rawBackends[bKey as BackendId] = entry;
        }
      }
      if (Object.keys(rawBackends).length > 0) {
        globalUiRaw.backends = rawBackends;
      }
    }
    if (parsed.identities && typeof parsed.identities === "object" && !Array.isArray(parsed.identities)) {
      base.identities = structuredClone(parsed.identities);
      globalUiRaw.identities = structuredClone(parsed.identities);
    }
    if (Array.isArray(parsed.topology)) {
      base.topology = structuredClone(parsed.topology);
      globalUiRaw.topology = structuredClone(parsed.topology);
    }
    if (typeof parsed.maxConcurrency === "number" && parsed.maxConcurrency >= 1) {
      base.maxConcurrency = Math.min(16, Math.floor(parsed.maxConcurrency));
    }
    if (typeof parsed.defaultTurnTimeoutMs === "number" && parsed.defaultTurnTimeoutMs >= 1000) {
      base.defaultTurnTimeoutMs = parsed.defaultTurnTimeoutMs;
    }
    if (
      typeof parsed.defaultIdleTimeoutMs === "number" &&
      (parsed.defaultIdleTimeoutMs === 0 || parsed.defaultIdleTimeoutMs >= 1000)
    ) {
      base.defaultIdleTimeoutMs = parsed.defaultIdleTimeoutMs;
    }
    if (typeof parsed.cooldownMs === "number" && parsed.cooldownMs >= 1000) {
      base.cooldownMs = parsed.cooldownMs;
    }
    if (typeof parsed.watchdogIntervalMs === "number" && parsed.watchdogIntervalMs >= 500) {
      base.watchdogIntervalMs = parsed.watchdogIntervalMs;
    }
    if (typeof parsed.stallThresholdMs === "number" && parsed.stallThresholdMs >= 1000) {
      base.stallThresholdMs = parsed.stallThresholdMs;
    }
    if (parsed.historyAwareRouting === true) base.historyAwareRouting = true;
    if (typeof parsed.hookMetricsDir === "string" && parsed.hookMetricsDir.trim()) {
      base.hookMetricsDir = parsed.hookMetricsDir;
    }
  } catch (err) {
    console.error(`[poly-swarm] failed to parse config at ${target}:`, err);
  }
  const envTurnMs = Number(process.env.POLY_SWARM_TURN_TIMEOUT_MS);
  if (Number.isFinite(envTurnMs) && envTurnMs >= 1000) {
    base.defaultTurnTimeoutMs = Math.floor(envTurnMs);
  }
  const envIdleRaw = process.env.POLY_SWARM_IDLE_TIMEOUT_MS;
  if (envIdleRaw !== undefined && envIdleRaw.trim() !== "") {
    const envIdleMs = Number(envIdleRaw);
    if (Number.isFinite(envIdleMs) && (envIdleMs === 0 || envIdleMs >= 1000)) {
      base.defaultIdleTimeoutMs = Math.floor(envIdleMs);
    }
  }
  return base;
}

export function updateBackendOverride(
  config: PolySwarmConfig,
  backend: RealBackendId,
  patch: {
    enabled?: boolean;
    defaultModel?: string | null;
    defaultEffort?: string | null;
  },
): BackendOverrideConfig {
  const prev = config.backends[backend] ? { ...config.backends[backend] } : {};
  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      delete prev.enabled;
    } else {
      prev.enabled = false;
    }
  }
  if (patch.defaultModel !== undefined) {
    const trimmed = typeof patch.defaultModel === "string" ? patch.defaultModel.trim() : "";
    if (trimmed) {
      prev.defaultModel = trimmed;
    } else {
      delete prev.defaultModel;
    }
  }
  if (patch.defaultEffort !== undefined) {
    const trimmed = typeof patch.defaultEffort === "string" ? patch.defaultEffort.trim() : "";
    if (trimmed) {
      prev.defaultEffort = trimmed;
    } else {
      delete prev.defaultEffort;
    }
  }
  config.backends[backend] = prev;
  return prev;
}

export function savePolySwarmConfig(configPath: string, config: PolySwarmConfig): void {
  const target = configPath || config.configPath || defaultConfigPath();

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const nextPayload: Record<string, unknown> = {
    ...existing,
    routes: config.routes,
    backends: config.backends,
  };
  if (config.identities && Object.keys(config.identities).length > 0) {
    nextPayload.identities = config.identities;
  } else {
    delete nextPayload.identities;
  }
  if (config.topology && config.topology.length > 0) {
    nextPayload.topology = config.topology;
  } else {
    delete nextPayload.topology;
  }

  writeJsonAtomic(target, nextPayload, 0o600);
}
