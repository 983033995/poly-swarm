import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import pkg from "../../package.json";
import type {
  AgyCompany,
  AgyCompanyView,
  BackendConfigEntry,
  BackendHealth,
  BackendId,
  BackendModelOption,
  BoardMessage,
  CandidateEvaluation,
  CandidateGateFailure,
  CapabilityTag,
  ChannelRecord,
  ConversationArchivesPayload,
  DashboardSnapshot,
  DispatchGraph,
  DispatchPolicyLayerConfig,
  GraphEdgeKind,
  MessageTag,
  PendingDispatchRecord,
  RealBackendId,
  ResolvedDispatchPolicy,
  SessionMatchReason,
  StaffAvatarId,
  StaffRosterMember,
  SwarmPlan,
  SwarmRecord,
  TeamAttachResult,
  TeamRecord,
  TurnRecord,
  UiFocusState,
  UiPreferencesRecord,
  UsageAggregate,
  WorkerDetailPayload,
  WorkerDeliverableSummary,
  WorkerEvent,
  WorkerPolicySnapshot,
  WorkerRecord,
  WorkerRole,
  WorkerSummary,
  WorkerSwitchRecord,
  WorkbenchTab,
  WorkspaceMode,
} from "../shared/types.js";
import { getBuildId } from "../shared/build_id.js";
import { areRoleSkillPaths, MAX_ROLE_SKILLS } from "../shared/role_skills.js";
import { isMissingWorkerEnvironment, type AdapterRunResult } from "./adapters/base.js";
import { getStaticFallbackModels } from "./adapters/models.js";
import { AdapterRegistry, REAL_BACKEND_IDS } from "./adapters/registry.js";
import { AgyAccounts, type AgyLaunchProfile } from "./agy_accounts.js";
import {
  DEFAULT_ROUTES,
  roleToDefaultCapability,
  savePolySwarmConfig,
  updateBackendOverride,
  type BackendOverrideConfig,
  type PolySwarmConfig,
} from "./config.js";
import { parseMessageSignals, STAFF_ROSTER_KV_KEY, stripMarkdownCode, type PolySwarmDB } from "./db.js";
import { buildDispatchGraph } from "./graph.js";
import { fetchHostConversationMeta, hasHostConversationEnv } from "./host_conversations.js";
import { aggregateNormalizedUsage, buildSessionTurnUsageItem } from "./pricing.js";
import {
  buildEffectiveGlobalUiLayer,
  buildWorkerPolicySnapshot,
  inferVendorFamily,
  loadProjectPolicy,
  mergePolicyLayerPatch,
  resolveDispatchPolicy,
  resolveEffectiveModelAndEffort,
  resolveWorkerDispatch,
  sanitizePolicyLayer,
  saveProjectPolicy,
} from "./policy.js";
import { runGit, WorkspaceManager } from "./worktree.js";

const WORKER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const RESERVED_NAMES = new Set(["all", "coordinator", "watchdog"]);
const AGY_ACCOUNT_ID_RE = /^[a-f0-9]{24}$/;
const AGY_COMPANY_ID_RE = /^agy-[a-f0-9]{24}$/;
const companyIdFor = (accountId: string) => `agy-${accountId}`;
export const AGY_COMPANY_ID = z.string().regex(AGY_COMPANY_ID_RE);
export const AGY_COMPANY_REQUEST = z.object({
  op: z.enum(["list", "add", "update"]),
  account_ids: z.array(z.string().regex(AGY_ACCOUNT_ID_RE)).min(1).max(100).optional(),
  id: AGY_COMPANY_ID.optional(),
  config: z.object({
    name: z.string().trim().min(1).max(48),
    enabled: z.boolean(),
    default_model: z.string().max(160).nullable(),
    default_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  }).optional(),
});
const LAST_WORKBENCH_SWARM_KV_KEY = "last_workbench_swarm_id";
const STAFF_AVATAR_IDS = new Set<StaffAvatarId>(["aria", "leo", "theo", "jules", "mia"]);

export const UI_PREFERENCES_PATCH = z.strictObject({
  language: z.enum(["zh-CN", "en"]).optional(),
  theme: z.enum(["system", "dark", "light"]).optional(),
  showOfficeBanner: z.boolean().optional(),
  animatedAvatars: z.boolean().optional(),
  autoCollapseBannerNarrow: z.boolean().optional(),
});

const DEFAULT_UI_PREFERENCES: UiPreferencesRecord = {
  language: "zh-CN",
  theme: "system",
  showOfficeBanner: true,
  animatedAvatars: true,
  autoCollapseBannerNarrow: false,
};

interface SessionTargetOptions {
  swarmId?: string | null;
  teamId?: string | null;
  conversationId?: string | null;
  repoRoot?: string | null;
  surface?: "workbench" | "inline" | "global";
  autoSelect?: boolean;
  bind?: boolean;
}

type DashboardOptions = Omit<SessionTargetOptions, "swarmId" | "autoSelect"> & { autoSelectLatest?: boolean };

interface SessionTarget {
  swarm: SwarmRecord | null;
  team: TeamRecord | null;
  matchReason: SessionMatchReason;
  activeConversationId: string | null;
}

function isReadonlyRole(role: WorkerRole): boolean {
  return role === "verifier" || role === "researcher";
}

function isDisabledAgyAccount(message: string): boolean {
  return /this service has been disabled in this account/i.test(message);
}

function requiresExplicitWorkerRetry(worker: WorkerRecord): boolean {
  const reason = worker.last_error ?? "";
  return worker.state === "error" && (isMissingWorkerEnvironment(reason) ||
    Boolean(worker.agy_account_id && (isDisabledAgyAccount(reason) ||
      reason.includes("The selected AGY company is disabled."))));
}

function isIndependentBackend(backend: BackendId, model: string | null, author: Pick<WorkerRecord, "backend" | "model">): boolean {
  return backend !== author.backend && (author.backend === "mock" ||
    inferVendorFamily(backend, model) !== inferVendorFamily(author.backend, author.model));
}

function readOnlyReason(swarm: SwarmRecord): string | null {
  return swarm.status === "active" ? null : `Swarm '${swarm.id}' is ${swarm.status} and read-only.`;
}

function reviewedCommit(text: string): string | null {
  const explicit = [...text.matchAll(/\b(?:sha(?:-?1|-?256)?|commit)\s*(?:[:=]\s*|\s+)`?([a-f0-9]{7,64})\b/gi)];
  const hashes = new Set((explicit.length ? explicit.map((m) => m[1]!) :
    text.match(/\b[a-f0-9]{7,64}\b/gi) ?? []).map((sha) => sha.toLowerCase()));
  return hashes.size === 1 ? [...hashes][0]! : null;
}

export function validateWorkerName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!WORKER_NAME_RE.test(normalized)) {
    throw new Error(
      `Invalid worker name '${name}'. Must match /^[a-z0-9][a-z0-9_-]{0,23}$/.`,
    );
  }
  if (RESERVED_NAMES.has(normalized) || normalized.startsWith("coordinator-")) {
    throw new Error(`Worker name '${normalized}' is reserved.`);
  }
  return normalized;
}

function inferMessageTag(text: string): MessageTag {
  const tag = stripMarkdownCode(text).match(/^[ \t]*(?:@[a-z0-9_-]+(?:[ \t]*[:：][ \t]*|[ \t]+))*\[(review_fail|review_pass|blocked|stall|done)\]/im)?.[1];
  return (tag?.toLowerCase() as MessageTag | undefined) ?? "update";
}

function parseChannelsJson(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : ["main"];
  } catch {
    return ["main"];
  }
}

export interface AddWorkerParams {
  swarm_id: string;
  name: string;
  staff_id?: string;
  company_id?: string;
  identity?: string;
  role?: WorkerRole;
  backend?: BackendId;
  capability?: CapabilityTag;
  model?: string | null;
  effort?: string | null;
  workspace_mode?: WorkspaceMode;
  review_of?: string | null;
  reports_to?: string | null;
  depends_on?: string[];
  channels?: string[];
  brief: string;
  auto_fallback?: boolean;
}

export function truncateUtf8Bytes(text: string, maxBytes: number, suffix = ""): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(0, maxBytes - suffixBytes);
  if (budget === 0 && suffixBytes > maxBytes) {
    return truncateUtf8Bytes(suffix, maxBytes, "");
  }
  let used = 0;
  let acc = "";
  for (const ch of text) {
    const cb = Buffer.byteLength(ch, "utf8");
    if (used + cb > budget) break;
    used += cb;
    acc += ch;
  }
  return `${acc}${suffix}`;
}

function normalizeLockPath(workspacePath: string): string {
  try {
    return fs.realpathSync(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

export class PolySwarmEngine extends EventEmitter {
  public readonly db: PolySwarmDB;
  public readonly config: PolySwarmConfig;
  public readonly registry: AdapterRegistry;
  public readonly workspace: WorkspaceManager;
  public readonly instanceId: string;
  public readonly version: string = pkg.version;
  public readonly dataDir: string;

  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeTurnPromises = new Map<string, Promise<void>>();
  private readonly runningWorkers = new Set<string>();
  private readonly workspaceWriteLocks = new Map<string, Promise<void>>();
  private readonly activeWritersByPath = new Map<string, Set<string>>();
  private readonly readonlyObserversByPath = new Map<string, Set<{ writerObserved: boolean }>>();
  private globalInFlight = 0;
  private readonly globalWaitQueue: Array<() => void> = [];
  private healthInitialized = false;
  private readonly agyAccounts: AgyAccounts;
  private isShutdown = false;
  private instanceHeartbeatTimer: NodeJS.Timeout | null = null;
  private readonly focusBySwarm = new Map<string, Omit<UiFocusState, "workbench_alive">>();
  private readonly heartbeatBySwarm = new Map<string, number>();
  private globalFocusSeq = 0;
  private recentFocusSwarmId: string | null = null;
  private backendModelsCache: {
    expiresAt: number;
    data: Partial<Record<RealBackendId, BackendModelOption[]>>;
  } | null = null;
  private readonly agyCompanyModelCache = new Map<string, { expiresAt: number; models: BackendModelOption[] }>();
  private readonly agyCompanyModelRequests = new Map<string, Promise<BackendModelOption[]>>();

  constructor(params: {
    db: PolySwarmDB;
    config: PolySwarmConfig;
    registry?: AdapterRegistry;
    workspace?: WorkspaceManager;
    agyAccounts?: AgyAccounts;
  }) {
    super();
    this.db = params.db;
    this.dataDir = this.db.dbPath === ":memory:" ? ":memory:" : path.dirname(path.resolve(this.db.dbPath));
    this.config = params.config;
    this.agyAccounts = params.agyAccounts ?? new AgyAccounts(this.dataDir);
    this.migrateAgyCompanies();
    this.db.initializeSharedRoster(() => this.buildDefaultStaffRoster());
    this.registry = params.registry ?? new AdapterRegistry();
    this.workspace = params.workspace ?? new WorkspaceManager();
    this.instanceId = `inst-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.registerInstance(this.instanceId);
    const savedFocusSwarmId = this.db.getAppKv<string>(LAST_WORKBENCH_SWARM_KV_KEY);
    if (savedFocusSwarmId && this.db.isRealSwarm(savedFocusSwarmId)) {
      this.recentFocusSwarmId = savedFocusSwarmId;
    }
    const recovered = this.db.recoverStaleRunningState({ currentInstanceId: this.instanceId });
    if (recovered.pendingDispatches.length > 0 || recovered.uncertainDispatches.length > 0) {
      queueMicrotask(() => {
        if (!this.isShutdown) {
          void this.resumePendingDispatches(recovered.pendingDispatches, recovered.uncertainDispatches);
        }
      });
    }
    this.instanceHeartbeatTimer = setInterval(() => {
      if (!this.isShutdown) {
        try {
          this.db.heartbeatInstance(this.instanceId);
        } catch {
          // ignore if DB already closed
        }
      }
    }, 15_000);
    this.instanceHeartbeatTimer.unref();
  }

  private async resumePendingDispatches(
    pending: PendingDispatchRecord[],
    uncertain: PendingDispatchRecord[],
  ): Promise<void> {
    if (this.isShutdown) return;
    for (const item of uncertain) {
      if (this.isShutdown) return;
      try {
        if (this.db.getSwarm(item.swarm_id)?.status !== "active") continue;
        const current = this.db.getPendingDispatch(item.swarm_id, item.worker_name);
        if (!current || current.status !== "uncertain") continue;
        await this.postMessage({
          swarm_id: item.swarm_id,
          sender: "system",
          channel: "main",
          tag: "system",
          text: `[recovery] @coordinator 服务端重启前写成员 @${item.worker_name} 正在执行 #${item.trigger_seq}，重启后结果未知（uncertain）。为避免重复触发写副作用，未自动重跑；请检查工作区状态后决定是否重新派发。`,
          suppressWake: true,
        });
        this.db.clearPendingDispatch(item.swarm_id, item.worker_name);
      } catch (err) {
        if (!this.isShutdown) {
          console.error(`[poly-swarm] failed to report uncertain dispatch ${item.swarm_id}::${item.worker_name}:`, err);
        }
      }
    }
    for (const item of pending) {
      if (this.isShutdown) return;
      try {
        if (this.db.getSwarm(item.swarm_id)?.status !== "active") continue;
        const worker = this.db.getWorker(item.swarm_id, item.worker_name);
        if (!worker || worker.state === "killed") continue;
        this.scheduleWorkerRun(item.swarm_id, item.worker_name, item.trigger_seq, { alreadyEnqueued: true });
      } catch (err) {
        if (!this.isShutdown) {
          console.error(`[poly-swarm] failed to resume pending dispatch ${item.swarm_id}::${item.worker_name}:`, err);
        }
      }
    }
  }

  private workerKey(swarmId: string, name: string): string {
    return `${swarmId}::${name}`;
  }

  private async withWorkspaceWriteLock<T>(
    workspacePath: string,
    writerKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = normalizeLockPath(workspacePath);
    const prev = this.workspaceWriteLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.catch(() => {}).then(() => nextLock);
    this.workspaceWriteLocks.set(lockKey, chained);

    await prev.catch(() => {});
    let writers = this.activeWritersByPath.get(lockKey);
    if (!writers) {
      writers = new Set<string>();
      this.activeWritersByPath.set(lockKey, writers);
    }
    writers.add(writerKey);
    const observers = this.readonlyObserversByPath.get(lockKey);
    if (observers) {
      for (const obs of observers) obs.writerObserved = true;
    }

    try {
      return await fn();
    } finally {
      const currentWriters = this.activeWritersByPath.get(lockKey);
      currentWriters?.delete(writerKey);
      if (currentWriters && currentWriters.size === 0) {
        this.activeWritersByPath.delete(lockKey);
      }
      release();
      if (this.workspaceWriteLocks.get(lockKey) === chained) {
        this.workspaceWriteLocks.delete(lockKey);
      }
    }
  }

  private async ensureHealthChecked(): Promise<BackendHealth[]> {
    if (!this.healthInitialized) {
      this.healthInitialized = true;
      return this.registry.detectAllBackends(this.db, this.config);
    }
    return this.db.listBackendHealth();
  }

  async refreshBackends(includeMock = false): Promise<BackendHealth[]> {
    this.healthInitialized = true;
    return this.registry.detectAllBackends(this.db, this.config, includeMock);
  }

  assertSwarmWritable(swarmId: string): SwarmRecord {
    const swarm = this.db.getSwarm(swarmId);
    if (!swarm) throw new Error(`Swarm '${swarmId}' not found.`);
    const reason = readOnlyReason(swarm);
    if (reason) throw new Error(reason);
    return swarm;
  }

  private parseSwarmSessionPolicy(swarm: SwarmRecord | TeamRecord | null): DispatchPolicyLayerConfig | null {
    if (!swarm?.policy_json) return null;
    try {
      const parsed = JSON.parse(swarm.policy_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as DispatchPolicyLayerConfig;
      }
    } catch {
      // ignore invalid stored session policy
    }
    return null;
  }

  resolvePolicy(opts?: {
    swarmId?: string | null;
    repoRoot?: string | null;
  }): ResolvedDispatchPolicy {
    const swarm = opts?.swarmId ? this.db.getSwarm(opts.swarmId) : null;
    const repoRoot = opts?.repoRoot ?? swarm?.repo_root ?? null;
    const sessionPolicy = this.parseSwarmSessionPolicy(swarm);
    return resolveDispatchPolicy({
      config: this.config,
      repoRoot,
      sessionPolicy,
      swarmId: swarm?.id ?? opts?.swarmId ?? null,
    });
  }

  getDispatchGraph(swarmId: string): DispatchGraph {
    const swarm = this.db.getSwarm(swarmId);
    if (!swarm) {
      throw new Error(`Swarm '${swarmId}' not found.`);
    }
    const workers = this.db.listWorkers(swarm.id);
    const boardMessages = this.db.readBoardMessages({
      swarm_id: swarm.id,
      since: 0,
      limit: 2000,
    });
    const persistedEdges = this.db.listDispatchEdges(swarm.id, 1000);
    const workflows = this.db.listWorkflows(swarm.id, 50);
    const usageByWorker = this.db.aggregateUsage(swarm.id, "worker");
    const policy = this.resolvePolicy({ swarmId: swarm.id, repoRoot: swarm.repo_root });
    return buildDispatchGraph({
      swarm,
      workers,
      boardMessages,
      persistedEdges,
      workflows,
      policy,
      usageByWorker,
    });
  }

  async updateDispatchPolicy(input: {
    scope: "global_ui" | "project" | "session";
    swarm_id?: string | null;
    repo_root?: string | null;
    patch?: DispatchPolicyLayerConfig | null;
    reset?: boolean;
  }): Promise<ResolvedDispatchPolicy> {
    for (const [id, identity] of Object.entries(input.patch?.identities ?? {})) {
      if (identity?.skill_paths != null && !areRoleSkillPaths(identity.skill_paths)) {
        throw new Error(`Identity '${id}': skill_paths must contain up to ${MAX_ROLE_SKILLS} workspace-relative SKILL.md paths.`);
      }
    }
    if (input.scope === "global_ui") {
      const baseRaw: DispatchPolicyLayerConfig = input.reset
        ? {}
        : buildEffectiveGlobalUiLayer(this.config);
      const merged = input.reset
        ? (input.patch ?? {})
        : mergePolicyLayerPatch(baseRaw, input.patch);
      const { policy: clean, warnings } = sanitizePolicyLayer(merged, { layer: "global_ui" });
      for (const w of warnings) {
        console.error(`[poly-swarm policy] ${w}`);
      }

      const nextConfig = structuredClone(this.config);
      // Apply routes (clearing omitted capabilities back to DEFAULT_ROUTES if reset/null)
      const nextRoutes = structuredClone(DEFAULT_ROUTES);
      if (clean.routes) {
        for (const [cap, list] of Object.entries(clean.routes)) {
          if (Array.isArray(list) && list.length > 0) {
            nextRoutes[cap as CapabilityTag] = [...list];
          }
        }
      }
      nextConfig.routes = nextRoutes;

      // Apply backend overrides while preserving CLI launch settings from config.
      if (input.reset || input.patch?.backends !== undefined || clean.backends !== undefined) {
        const nextBackends: Partial<Record<BackendId, BackendOverrideConfig>> = {};
        for (const [bKey, existing] of Object.entries(nextConfig.backends)) {
          if (!existing) continue;
          const preserved: BackendOverrideConfig = {};
          if (existing.command) preserved.command = existing.command;
          if (existing.extraArgs) preserved.extraArgs = existing.extraArgs;
          if (existing.env) preserved.env = existing.env;
          if (existing.envFiles) preserved.envFiles = existing.envFiles;
          if (Object.keys(preserved).length > 0) {
            nextBackends[bKey as BackendId] = preserved;
          }
        }
        if (clean.backends) {
          for (const [bKey, bOv] of Object.entries(clean.backends)) {
            if (!bOv) continue;
            const cur = { ...(nextBackends[bKey as BackendId] ?? {}) };
            if (bOv.enabled === false) cur.enabled = false;
            else if (bOv.enabled === true) delete cur.enabled;
            if (typeof bOv.defaultModel === "string" && bOv.defaultModel.trim()) {
              cur.defaultModel = bOv.defaultModel.trim();
            }
            if (typeof bOv.defaultEffort === "string" && bOv.defaultEffort.trim()) {
              cur.defaultEffort = bOv.defaultEffort.trim();
            }
            if (Object.keys(cur).length > 0) {
              nextBackends[bKey as BackendId] = cur;
            }
          }
        }
        nextConfig.backends = nextBackends;
      }

      if (clean.identities && Object.keys(clean.identities).length > 0) {
        nextConfig.identities = clean.identities;
      } else {
        delete nextConfig.identities;
      }
      if (clean.topology && clean.topology.length > 0) {
        nextConfig.topology = clean.topology;
      } else {
        delete nextConfig.topology;
      }
      nextConfig.globalUiRaw = clean;

      savePolySwarmConfig(this.config.configPath, nextConfig);
      this.config.routes = nextConfig.routes;
      this.config.backends = nextConfig.backends;
      this.config.identities = nextConfig.identities;
      this.config.topology = nextConfig.topology;
      this.config.globalUiRaw = nextConfig.globalUiRaw;
      this.backendModelsCache = null;
      await this.refreshBackends();
      return this.resolvePolicy({ swarmId: input.swarm_id ?? null, repoRoot: input.repo_root ?? null });
    }

    if (input.scope === "project") {
      const swarm = input.swarm_id ? this.db.getSwarm(input.swarm_id) : null;
      const repoRoot = input.repo_root ?? swarm?.repo_root ?? null;
      if (!repoRoot) {
        throw new Error("Project policy scope requires 'repo_root' or an existing 'swarm_id'.");
      }
      const loaded = loadProjectPolicy(repoRoot);
      const nextRaw = input.reset
        ? (input.patch ?? null)
        : mergePolicyLayerPatch(loaded.policy, input.patch);
      if (nextRaw === null) {
        saveProjectPolicy(repoRoot, null);
      } else {
        const { policy: clean, warnings } = sanitizePolicyLayer(nextRaw, { layer: "project" });
        for (const w of warnings) {
          console.error(`[poly-swarm policy] ${w}`);
        }
        saveProjectPolicy(repoRoot, clean);
      }
      return this.resolvePolicy({ swarmId: input.swarm_id ?? null, repoRoot });
    }

    // scope === "session"
    if (!input.swarm_id) {
      throw new Error("Session policy scope requires 'swarm_id'.");
    }
    const swarm = this.assertSwarmWritable(input.swarm_id);
    const existingSession = this.parseSwarmSessionPolicy(swarm);
    const nextRaw = input.reset
      ? (input.patch ?? null)
      : mergePolicyLayerPatch(existingSession, input.patch);
    if (nextRaw === null) {
      this.db.updateSwarmPolicy(swarm.id, null);
    } else {
      const { policy: clean, warnings } = sanitizePolicyLayer(nextRaw, { layer: "session" });
      for (const w of warnings) {
        console.error(`[poly-swarm policy] ${w}`);
      }
      this.db.updateSwarmPolicy(swarm.id, Object.keys(clean).length > 0 ? clean : null);
    }
    return this.resolvePolicy({ swarmId: swarm.id, repoRoot: swarm.repo_root });
  }

  async createSwarm(input: {
    title: string;
    repo_root: string;
    base_branch?: string | null;
    policy?: DispatchPolicyLayerConfig | null;
    team_id?: string;
    team_name?: string;
    goal?: string | null;
    conversation_id?: string | null;
    reuse_team?: boolean;
    auto_created_by_workflow?: boolean;
  }): Promise<SwarmRecord> {
    const detectedRoot = path.resolve((await this.workspace.getRepoRoot(input.repo_root)) ?? input.repo_root);
    const baseBranch =
      input.base_branch ?? (await this.workspace.getCurrentBranch(detectedRoot));
    let cleanPolicy: DispatchPolicyLayerConfig | null | undefined = input.policy;
    if (input.policy) {
      const sanitized = sanitizePolicyLayer(input.policy, { layer: "session" });
      for (const w of sanitized.warnings) {
        console.error(`[poly-swarm policy] ${w}`);
      }
      cleanPolicy = Object.keys(sanitized.policy).length > 0 ? sanitized.policy : null;
    }
    const conversationId = input.conversation_id?.trim() || null;
    const swarm = this.db.transaction(() => {
      let team: TeamRecord | null = null;
      if (input.team_id) {
        team = this.requireTeam(input.team_id);
      } else if (conversationId && input.reuse_team !== false) {
        const binding = this.db.getSessionBinding(conversationId);
        const boundTeam = binding ? this.db.getTeam(binding.team_id) : null;
        if (boundTeam && path.resolve(boundTeam.repo_root) === detectedRoot) team = boundTeam;
      }
      team ??= this.db.createTeam({
        name: input.team_name?.trim() || input.title,
        goal: input.goal,
        repo_root: detectedRoot,
        policy_json: cleanPolicy ? JSON.stringify(cleanPolicy) : null,
      });
      const lastWave = this.db.listTeamSwarms(team.id)[0];
      const created = this.db.createSwarm({
        title: input.title,
        repo_root: detectedRoot,
        base_branch: baseBranch,
        policy: cleanPolicy === undefined ? this.parseSwarmSessionPolicy(team) : cleanPolicy,
        team_id: team.id,
        conversation_id: conversationId,
        wave_index: (lastWave?.wave_index ?? 0) + 1,
        auto_created_by_workflow: input.auto_created_by_workflow,
      });
      this.db.updateTeam(team.id, { active_swarm_id: created.id, status: "active" });
      if (conversationId) this.db.ensureConversationArchive(conversationId);
      if (conversationId && !input.auto_created_by_workflow) this.bindConversation(conversationId, team, created);
      return created;
    });
    if (!input.auto_created_by_workflow) {
      this.persistLastWorkbenchSwarm(swarm.id, false);
    }
    this.emit("swarm:created", swarm);
    return swarm;
  }

  private persistLastWorkbenchSwarm(swarmId: string | null, updateLiveFocus = true): void {
    if (!swarmId || !this.db.isRealSwarm(swarmId)) return;
    if (updateLiveFocus) {
      this.recentFocusSwarmId = swarmId;
    }
    try {
      this.db.setAppKv(LAST_WORKBENCH_SWARM_KV_KEY, swarmId);
    } catch {
      // ignore KV persistence errors during shutdown
    }
  }

  hasRecentWorkbenchFocus(): boolean {
    return Boolean(this.recentFocusSwarmId && this.db.isRealSwarm(this.recentFocusSwarmId));
  }

  private requireTeam(teamId: string): TeamRecord {
    const team = this.db.getTeam(teamId);
    if (!team) throw new Error(`Team '${teamId}' not found.`);
    return team;
  }

  private getTeamSwarm(teamId: string, swarmId?: string | null): SwarmRecord | null {
    const swarm = swarmId ? this.db.getSwarm(swarmId) : null;
    return swarm?.team_id === teamId ? swarm : null;
  }

  private bindConversation(conversationId: string, team: TeamRecord, swarm: SwarmRecord | null, repoRoot?: string | null) {
    return this.db.upsertSessionBinding({
      conversation_id: conversationId,
      team_id: team.id,
      active_swarm_id: swarm?.id ?? null,
      repo_root: repoRoot || swarm?.repo_root || team.repo_root,
    });
  }

  resolveSessionTarget(opts: SessionTargetOptions = {}): SessionTarget {
    const activeConversationId = opts.conversationId?.trim() || null;
    const resolved = (matchReason: SessionMatchReason, swarm: SwarmRecord | null, team?: TeamRecord | null) => ({
      swarm, team: team ?? (swarm?.team_id ? this.db.getTeam(swarm.team_id) : null), matchReason, activeConversationId,
    });
    const none = () => resolved("none", null);
    const swarmId = opts.swarmId?.trim();
    const teamId = opts.teamId?.trim();
    if (swarmId) {
      const swarm = this.db.getSwarm(swarmId);
      if (!swarm) return none();
      const target = resolved("explicit_swarm", swarm);
      if (opts.bind !== false && activeConversationId && target.team) {
        this.bindConversation(activeConversationId, target.team, swarm, opts.repoRoot);
      }
      return target;
    }
    if (teamId) {
      const team = this.db.getTeam(teamId);
      if (!team) return none();
      const swarm = this.getTeamSwarm(team.id, team.active_swarm_id) ?? this.db.listTeamSwarms(team.id)[0] ?? null;
      if (opts.bind !== false && activeConversationId) {
        this.bindConversation(activeConversationId, team, swarm, opts.repoRoot);
      }
      return resolved("explicit_team", swarm, team);
    }
    if (opts.surface === "global" && opts.autoSelect !== true) return none();
    if (activeConversationId) {
      const binding = this.db.getSessionBinding(activeConversationId);
      const team = binding ? this.db.getTeam(binding.team_id) : null;
      if (binding && team) {
        const swarm = this.getTeamSwarm(team.id, binding.active_swarm_id)
          ?? this.db.listTeamSwarms(team.id).find((wave) => this.db.isRealSwarm(wave.id)) ?? null;
        if (opts.bind !== false) this.bindConversation(activeConversationId, team, swarm, binding.repo_root);
        return resolved("conversation_binding", swarm, team);
      }
      if (opts.autoSelect !== true) return none();
    }
    if (opts.repoRoot?.trim()) {
      const repoCandidates = [...new Set([path.resolve(opts.repoRoot), normalizeLockPath(opts.repoRoot)])];
      for (const repoRoot of repoCandidates) {
        const rawBinding = this.db.findLatestBindingByRepo(repoRoot);
        const binding =
          rawBinding && (!activeConversationId || rawBinding.conversation_id === activeConversationId)
            ? rawBinding
            : null;
        const team = (binding ? this.db.getTeam(binding.team_id) : null)
          ?? this.db.findLatestTeamByRepo(repoRoot, { excludeEmptyWorkflow: true });
        if (team) {
          const pointed = this.getTeamSwarm(team.id, binding?.active_swarm_id ?? team.active_swarm_id);
          const swarm = pointed && this.db.isRealSwarm(pointed.id) ? pointed : this.db.getLatestRealActiveSwarm(team.id);
          return resolved("repo_match", swarm, team);
        }
      }
    }
    if (opts.autoSelect === true) {
      const focused = this.recentFocusSwarmId ? this.db.getSwarm(this.recentFocusSwarmId) : null;
      if (focused && this.db.isRealSwarm(focused.id)) return resolved("recent_workbench_focus", focused);
      const latest = this.db.getLatestRealActiveSwarm();
      if (latest) return resolved("recent_active_team", latest);
    }
    return none();
  }

  async attachSessionToTeam(input: {
    team_id: string;
    swarm_id?: string | null;
    conversation_id?: string | null;
    repo_root?: string | null;
    reopen?: boolean;
  }): Promise<TeamAttachResult> {
    const team = this.requireTeam(input.team_id);
    const swarmId = input.swarm_id?.trim();
    let swarm = swarmId
      ? this.getTeamSwarm(team.id, swarmId)
      : this.getTeamSwarm(team.id, team.active_swarm_id) ?? this.db.listTeamSwarms(team.id)[0] ?? null;
    if (swarmId && !swarm) throw new Error(`Swarm '${swarmId}' does not belong to team '${team.id}'.`);
    if (input.reopen !== false && swarm?.status === "done") swarm = await this.reopenSwarm(swarm.id);
    const conversationId = input.conversation_id?.trim() || null;
    const updatedTeam = input.reopen !== false && swarm?.status === "active"
      ? this.db.updateTeam(team.id, { status: "active", active_swarm_id: swarm.id })
      : team;
    const binding = conversationId ? this.bindConversation(conversationId, updatedTeam, swarm, input.repo_root) : null;
    this.setUiFocus({ swarm_id: swarm?.id ?? null, worker_name: null, tab: "detail" });
    const snapshot = await this.getDashboardSnapshot(swarm?.id, {
      teamId: team.id, conversationId, repoRoot: input.repo_root, surface: "workbench",
    });
    const members = snapshot.workers.filter((w) => w.state !== "killed")
      .map((w) => `@${w.name} (${w.backend}/${w.model ?? "default"}, ${w.role}, ${w.state})`);
    const conclusions = this.db.listTeamBlackboard(team.id).map((message) =>
      `#${message.seq} [${message.tag}] ${truncateUtf8Bytes(message.text.replace(/\s+/g, " ").trim(), 240, "…")}`);
    const repoRoot = swarm?.repo_root ?? updatedTeam.repo_root;
    const handoff_context = [
      "[Poly-Swarm 团队关联上下文]",
      `team_id: ${team.id}`,
      `team_name: ${updatedTeam.name}`,
      `active_swarm_id: ${swarm?.id ?? "null"}`,
      `repo_root: ${repoRoot}`,
      `成员: ${members.join("；") || "暂无"}`,
      `最近黑板结论: ${conclusions.join("；") || "暂无"}`,
      `调用 poly_swarm_open(${JSON.stringify({
        team_id: team.id, swarm_id: swarm?.id, conversation_id: conversationId ?? undefined, repo_root: repoRoot,
      })}) 延续调度。`,
    ].join("\n");
    return { team: updatedTeam, swarm, binding, handoff_context, snapshot };
  }

  async reopenSwarm(swarmId: string): Promise<SwarmRecord> {
    const { swarm, message } = this.db.transaction(() => {
      const swarm = this.db.getSwarm(swarmId);
      if (!swarm) throw new Error(`Swarm '${swarmId}' not found.`);
      if (swarm.status === "archived") throw new Error(`Swarm '${swarmId}' is archived and cannot be reopened. Start a new wave instead.`);
      if (swarm.status === "active") return { swarm, message: null };
      this.db.updateSwarmStatus(swarmId, "active");
      if (swarm.team_id) this.db.updateTeam(swarm.team_id, { status: "active", active_swarm_id: swarmId });
      const { message } = this.db.postBoardMessage({
        swarm_id: swarmId, sender: "coordinator", tag: "system",
        text: "[system] 项目组已重新打开继续推进", suppress_wake: true,
      });
      return { swarm: this.db.getSwarm(swarmId)!, message };
    });
    if (message) this.emit("board:message", message);
    return swarm;
  }

  async startNewWave(input: {
    team_id: string;
    title?: string;
    conversation_id?: string | null;
    repo_root?: string | null;
    base_branch?: string | null;
  }): Promise<SwarmRecord> {
    const team = this.requireTeam(input.team_id);
    return this.createSwarm({
      ...input,
      title: input.title?.trim() || team.name,
      repo_root: input.repo_root || team.repo_root,
    });
  }

  renameTeam(teamId: string, name: string, goal?: string | null): TeamRecord {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Team name must not be empty.");
    return this.db.updateTeam(teamId, { name: trimmed, goal });
  }

  recordConversationTitle(conversationId: string, title: string, source: "custom" | "host" = "host"): void {
    const cid = conversationId.trim();
    const clean = title.trim();
    if (!cid || !clean) return;
    if (source === "custom") {
      this.db.upsertConversationMeta(cid, { custom_title: clean });
    } else {
      this.db.upsertConversationMeta(cid, { host_title: clean, host_synced_at: Date.now() });
    }
  }

  renameConversation(conversationId: string, name: string | null): ConversationArchivesPayload {
    const cid = conversationId.trim();
    if (!cid) throw new Error("conversation_id must not be empty.");
    const trimmed = name?.trim() ?? null;
    this.db.upsertConversationMeta(cid, { custom_title: trimmed && trimmed.length > 0 ? trimmed : null });
    return this.db.listConversationArchives(cid);
  }

  assignSwarmConversation(
    swarmId: string,
    targetConversationId: string | null,
    currentConversationId?: string | null,
  ): { swarm: SwarmRecord; conversation_archives: ConversationArchivesPayload } {
    const swarm = this.db.assignSwarmConversation(swarmId, targetConversationId);
    return {
      swarm,
      conversation_archives: this.db.listConversationArchives(currentConversationId ?? targetConversationId ?? null),
    };
  }

  async syncMissingConversationTitles(conversationIds: string[]): Promise<void> {
    if (!hasHostConversationEnv()) return;
    const now = Date.now();
    const ttlMs = 5 * 60_000;
    const candidates: string[] = [];
    for (const rawId of conversationIds) {
      const id = rawId.trim();
      if (!id || candidates.includes(id)) continue;
      const meta = this.db.getConversationArchiveMeta(id);
      if (meta?.host_title) continue;
      if (meta?.host_synced_at && now - meta.host_synced_at < ttlMs) continue;
      candidates.push(id);
      if (candidates.length >= 8) break;
    }
    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (id) => {
        const syncedAt = Date.now();
        try {
          const info = await fetchHostConversationMeta(id);
          if (info) {
            this.db.upsertConversationMeta(id, {
              ...(info.title ? { host_title: info.title } : {}),
              ...(info.summary ? { host_summary: info.summary } : {}),
              ...(info.runState ? { host_run_state: info.runState } : {}),
              host_synced_at: syncedAt,
            });
          } else {
            this.db.upsertConversationMeta(id, { host_synced_at: syncedAt });
          }
        } catch {
          this.db.upsertConversationMeta(id, { host_synced_at: syncedAt });
        }
      }),
    );
  }

  getUiPreferences(): UiPreferencesRecord {
    const stored = this.db.getAppKv<unknown>("ui_preferences") ?? {};
    return { ...DEFAULT_UI_PREFERENCES, ...UI_PREFERENCES_PATCH.parse(stored) };
  }

  setUiPreferences(patch: Partial<UiPreferencesRecord>): UiPreferencesRecord {
    const changes = UI_PREFERENCES_PATCH.parse(patch);
    return this.db.transaction(() => {
      const next = this.getUiPreferences();
      for (const key of Object.keys(changes) as Array<keyof UiPreferencesRecord>) {
        if (changes[key] !== undefined) Object.assign(next, { [key]: changes[key] });
      }
      this.db.setAppKv("ui_preferences", next);
      return next;
    });
  }

  async finishSwarm(swarmId: string, summary?: string): Promise<void> {
    this.assertSwarmWritable(swarmId);
    await this.postMessage({
      swarm_id: swarmId,
      sender: "coordinator",
      tag: "done",
      text: `[done] ${summary || "Swarm completed."}`,
      suppressWake: true,
    });
    this.db.transaction(() => {
      this.db.clearPendingDispatch(swarmId);
      this.db.updateSwarmStatus(swarmId, "done");
      const teamId = this.db.getSwarm(swarmId)?.team_id;
      if (teamId && this.db.getTeam(teamId)?.active_swarm_id === swarmId) {
        this.db.updateTeam(teamId, { status: "paused" });
      }
    });
  }

  async selectBackend(params: {
    capability: CapabilityTag;
    excludeBackends?: BackendId[];
    excludeVendorFamilies?: string[];
    allowSameVendorFallback?: boolean;
    requireReadonly?: boolean;
    policy?: ResolvedDispatchPolicy;
    preferredBackends?: BackendId[];
    modelForBackend?: (backend: BackendId) => string | null;
  }): Promise<BackendId> {
    const healthList = await this.ensureHealthChecked();
    const healthMap = new Map(healthList.map((h) => [h.backend, h]));
    const exclude = new Set(params.excludeBackends);
    const excludeFamilies = new Set(params.excludeVendorFamilies);
    const policy = params.policy ?? this.resolvePolicy();
    const candidates = this.backendCandidates(policy, params.capability, params.preferredBackends);
    const now = Date.now();

    const usable = candidates.filter((id) => this.backendGateFailures(
      id, policy, healthMap.get(id), params.requireReadonly ?? false, now,
    ).length === 0);

    for (const id of usable) {
      if (exclude.has(id)) continue;
      const model = params.modelForBackend ? params.modelForBackend(id) : policy.backends[id]?.defaultModel;
      if (!excludeFamilies.has(inferVendorFamily(id, model))) return id;
    }

    if (params.allowSameVendorFallback === true && usable[0]) return usable[0];
    if (exclude.size || excludeFamilies.size) {
      throw new Error(
        `No independent cross-vendor CLI backend found for capability '${params.capability}'. Check backend availability, cooldown and vendor exclusions.`,
      );
    }

    throw new Error(
      `No installed and healthy CLI backend found for capability '${params.capability}'. Check 'poly_swarm(action="backends")'.`,
    );
  }

  private backendCandidates(policy: ResolvedDispatchPolicy, capability: CapabilityTag, preferred?: BackendId[]): BackendId[] {
    return [...new Set([...(preferred ?? []), ...(policy.routes[capability] ?? policy.routes.author)])];
  }

  private backendGateFailures(
    backend: BackendId,
    policy: ResolvedDispatchPolicy,
    health: BackendHealth | undefined,
    requireReadonly: boolean,
    now: number,
  ): CandidateGateFailure[] {
    const failures: CandidateGateFailure[] = [];
    if (policy.backends[backend]?.enabled === false) {
      failures.push({ gate: "G1", reason: `Backend '${backend}' is disabled in policy.` });
    } else if (health?.installed !== 1) {
      failures.push({ gate: "G1", reason: `Backend '${backend}' is not installed.` });
    }
    if (health?.cooldown_until && health.cooldown_until > now) {
      failures.push({ gate: "G2", reason: `Backend '${backend}' is cooling down until ${new Date(health.cooldown_until).toISOString()}.` });
    }
    if (requireReadonly && !this.registry.get(backend).capabilities.supportsStrictReadonly) {
      failures.push({ gate: "G4", reason: `Backend '${backend}' does not enforce strict readonly mode.` });
    }
    return failures;
  }

  private reviewAuthor(swarmId: string | null | undefined, reviewOf: string): WorkerRecord {
    const name = reviewOf.trim().toLowerCase().replace(/^@/, "");
    const author = swarmId ? this.db.getWorker(swarmId, name) : null;
    if (!author) throw new Error(`Review target '@${name}' not found in the swarm.`);
    return author;
  }

  private assertIndependentReviewer(backend: BackendId, model: string | null, author: WorkerRecord | null): void {
    if (backend !== "mock" && author && !isIndependentBackend(backend, model, author)) {
      throw new Error(`G6 requires an independent cross-vendor reviewer: '${backend}${model ? `/${model}` : ""}' is not independent of @${author.name}.`);
    }
  }

  async evaluateCandidates(params: {
    swarmId?: string | null;
    repoRoot?: string | null;
    capability: CapabilityTag;
    role?: WorkerRole;
    identityId?: string | null;
    reviewOf?: string | null;
  }): Promise<CandidateEvaluation[]> {
    const policy = this.resolvePolicy(params);
    const defaultRole = params.capability === "verifier" || params.reviewOf ? "verifier"
      : params.capability === "research" ? "researcher" : undefined;
    const plan = resolveWorkerDispatch(policy, {
      capability: params.capability,
      role: params.role ?? (params.identityId ? undefined : defaultRole),
      identity: params.identityId ?? undefined,
    });
    const author = params.reviewOf && plan.identity.require_cross_vendor !== false
      ? this.reviewAuthor(params.swarmId, params.reviewOf) : null;
    const healthMap = new Map((await this.ensureHealthChecked()).map((h) => [h.backend, h]));
    const now = Date.now();
    let hasRecommendation = false;
    return this.backendCandidates(policy, plan.capability, plan.preferred_backends).flatMap((backend) => {
      if (backend === "mock") return [];
      const { model, effort } = resolveEffectiveModelAndEffort({ policy, identity: plan.identity, backend });
      const gate_failures = this.backendGateFailures(backend, policy, healthMap.get(backend), isReadonlyRole(plan.role), now);
      if (author && !isIndependentBackend(backend, model, author)) {
        gate_failures.push({ gate: "G6", reason: `Backend '${backend}' is not an independent cross-vendor reviewer for @${author.name}.` });
      }
      const eligible = gate_failures.length === 0;
      const recommended = eligible && !hasRecommendation;
      if (recommended) hasRecommendation = true;
      return [{
        backend, model, effort, vendor_family: inferVendorFamily(backend, model), eligible, recommended,
        reasons: eligible ? ["All required gates passed."] : gate_failures.map((g) => g.reason),
        gate_failures,
      }];
    });
  }

  async addWorker(params: AddWorkerParams): Promise<{
    worker: WorkerRecord;
    brief_message: BoardMessage;
  }> {
    const swarm = this.assertSwarmWritable(params.swarm_id);
    const name = validateWorkerName(params.name);
    if (this.db.getWorker(swarm.id, name)) {
      throw new Error(`Worker '${name}' already exists in swarm '${swarm.id}'.`);
    }

    const staff = this.resolveStaffForDispatch(params.staff_id, name, params.backend);
    if (staff && params.company_id && staff.company_id !== params.company_id) {
      throw new Error("The selected employee belongs to a different company.");
    }
    const companyId = params.company_id ?? staff?.company_id;
    const company = companyId ? this.requireAgyCompany(companyId) : null;
    const agyAccount = company ? company.id.slice(4) : null;
    if (agyAccount) this.agyAccounts.assertAvailable(agyAccount);
    if (company && params.backend && params.backend !== "agy") {
      throw new Error("This company uses the AGY backend.");
    }
    const policy = this.resolvePolicy({ swarmId: swarm.id, repoRoot: swarm.repo_root });
    if (staff) {
      let staffIdentity = params.identity === undefined && !params.role ? staff.identity_id ?? undefined : undefined;
      if (staffIdentity && !policy.identities[staffIdentity]?.enabled) {
        console.error(`[poly-swarm] Employee '${staff.id}' has an unavailable dispatch identity '${staffIdentity}'; falling back to role '${staff.role}'.`);
        staffIdentity = undefined;
      }
      params = {
        ...params,
        backend: staff.backend,
        model: params.model ?? (staff.model || company?.default_model || undefined),
        effort: params.effort ?? staff.effort ?? company?.default_effort,
        role: params.role ?? staff.role,
        capability: params.capability ?? staff.capability,
        identity: params.identity ?? staffIdentity,
      };
    }
    if (company) {
      params = {
        ...params,
        backend: "agy",
        model: params.model ?? company.default_model,
        effort: params.effort ?? company.default_effort,
        auto_fallback: false,
      };
    }

    const plan = resolveWorkerDispatch(policy, {
      identity: params.identity,
      role: params.role,
      capability: params.capability,
      backend: params.backend,
      model: params.model,
      effort: params.effort,
      workspace_mode: params.workspace_mode,
      auto_fallback: params.auto_fallback,
      reports_to: params.reports_to,
    });

    const role: WorkerRole = plan.role;
    const readonly = isReadonlyRole(role);
    const capability: CapabilityTag = plan.capability;
    const workspaceMode: WorkspaceMode = plan.workspace_mode;

    const reviewOf = params.review_of?.trim().toLowerCase().replace(/^@/, "") || null;
    const targetAuthor = reviewOf && plan.identity.require_cross_vendor !== false && params.backend !== "mock"
      ? this.reviewAuthor(swarm.id, reviewOf) : null;
    const seatPolicy = company && policy.backends.agy ? {
      ...policy, backends: { ...policy.backends, agy: { ...policy.backends.agy,
        defaultModel: company.default_model ?? undefined, defaultEffort: company.default_effort ?? undefined,
      } },
    } : policy;
    const resolveSeat = (backend: BackendId) => resolveEffectiveModelAndEffort({
      policy: seatPolicy, identity: plan.identity, backend, explicitModel: params.model, explicitEffort: params.effort,
    });

    const backend =
      params.backend ??
      (await this.selectBackend({
        capability,
        excludeBackends: targetAuthor ? [targetAuthor.backend] : undefined,
        excludeVendorFamilies: targetAuthor && targetAuthor.backend !== "mock"
          ? [inferVendorFamily(targetAuthor.backend, targetAuthor.model)] : undefined,
        requireReadonly: readonly,
        policy,
        preferredBackends: plan.preferred_backends,
        modelForBackend: (id) => resolveSeat(id).model,
      }));
    // Validate backend exists in registry, supports strict readonly when required, and is enabled
    const selectedAdapter = this.registry.get(backend);
    if (readonly && !selectedAdapter.capabilities.supportsStrictReadonly) {
      throw new Error(
        `Backend '${backend}' does not enforce strict readonly mode and cannot run role '${role}'.`,
      );
    }
    const resolvedBackendPolicy = policy.backends[backend];
    if (resolvedBackendPolicy?.enabled === false && (!company ||
        resolvedBackendPolicy.enabled_source.layer === "project" || resolvedBackendPolicy.enabled_source.layer === "session")) {
      throw new Error(
        `Backend '${backend}' is disabled in Poly Swarm policy (${resolvedBackendPolicy.enabled_source.layer}). Enable it in the 配置 tab or policy first.`,
      );
    }

    const eff = resolveSeat(backend);
    this.assertIndependentReviewer(backend, eff.model, targetAuthor);
    const policySnapshot = buildWorkerPolicySnapshot({
      plan,
      backend,
      backendExplicit: Boolean(params.backend),
      model: eff.model,
      effort: eff.effort,
      model_source: eff.model_source,
      effort_source: eff.effort_source,
      policy,
    });

    let workspaceNotice = "";
    if (workspaceMode !== "inherit") {
      const status = await this.workspace.getWorkspaceStatus(swarm.repo_root).catch((err) => {
        console.error(`[poly-swarm] Could not check the source workspace before isolating @${name}:`, err);
        return null;
      });
      if (status?.dirty) {
        workspaceNotice = "主工作区有未提交改动。新建隔离工作区基于已提交的 HEAD，主工作区的未提交改动不会自动带入。请先核对任务依赖的文件是否可见。";
        console.error(`[poly-swarm] @${name}: ${workspaceNotice}`);
      }
    }
    const prepared = await this.workspace.prepareWorkspace(
      swarm.repo_root,
      swarm.id,
      name,
      workspaceMode,
    );
    this.assertSwarmWritable(swarm.id);

    const worker = this.db.addWorker({
      swarm_id: swarm.id,
      name,
      role,
      capability,
      backend,
      model: eff.model,
      effort: eff.effort,
      workspace_mode: workspaceMode,
      workspace_path: prepared.workspacePath,
      worktree_branch: prepared.worktreeBranch,
      auto_fallback: plan.auto_fallback,
      review_of: reviewOf,
      channels: params.channels ?? ["main"],
      identity_id: plan.identity_id,
      staff_id: staff?.id ?? null,
      agy_account_id: agyAccount,
      parent_node: "coordinator",
      policy_source: policySnapshot.policy_source,
      resolved_policy_json: JSON.stringify(policySnapshot),
    });

    const primaryChannel = (params.channels?.[0] || "main").toLowerCase().replace(/^#/, "");
    const briefText = workspaceNotice
      ? `@${name} 【工作区提示】${workspaceNotice}\n\n${params.brief}`
      : `@${name} ${params.brief}`;
    const { message } = await this.postMessage({
      swarm_id: swarm.id,
      sender: "coordinator",
      channel: primaryChannel,
      tag: "brief",
      text: briefText,
    });

    this.db.insertDispatchEdge({
      swarm_id: swarm.id,
      from_node: "coordinator",
      to_node: name,
      kind: "dispatch",
      seq: message.seq,
      label: `${plan.identity_id} (${backend}${eff.model ? `/${eff.model}` : ""})`,
      meta: {
        identity_id: plan.identity_id,
        policy_source: policySnapshot.policy_source,
        backend,
        model: eff.model,
      },
    });

    if (plan.reports_to && plan.reports_to !== "coordinator") {
      this.db.insertDispatchEdge({
        swarm_id: swarm.id,
        from_node: name,
        to_node: plan.reports_to,
        kind: "reports_to",
        label: "汇报关系",
      });
    }
    if (reviewOf) {
      this.db.insertDispatchEdge({
        swarm_id: swarm.id,
        from_node: name,
        to_node: reviewOf,
        kind: "review",
        label: "只读审校",
      });
    }
    if (params.depends_on && params.depends_on.length > 0) {
      for (const rawDep of params.depends_on) {
        const dep = rawDep.trim().toLowerCase();
        if (dep && dep !== name) {
          this.db.insertDispatchEdge({
            swarm_id: swarm.id,
            from_node: dep,
            to_node: name,
            kind: "depends_on",
            label: "前置依赖",
          });
        }
      }
    }

    return { worker: this.db.getWorker(swarm.id, name)!, brief_message: message };
  }

  async postMessage(input: {
    swarm_id: string;
    sender: string;
    channel?: string;
    tag?: MessageTag;
    text: string;
    turn_id?: string | null;
    suppressWake?: boolean;
  }): Promise<{ message: BoardMessage; woken: string[] }> {
    this.assertSwarmWritable(input.swarm_id);

    const workers = input.suppressWake ? [] : this.db.listWorkers(input.swarm_id);
    const workerByName = new Map(workers.map((w) => [w.name, w]));
    const preSignals = parseMessageSignals(input.text);
    const toWake: string[] = [];

    if (!input.suppressWake) {
      for (const w of workers) {
        if (w.state === "killed") continue;
        if (w.name === input.sender) continue;
        const wChannels = parseChannelsJson(w.channels_json);
        const hitByChannel = preSignals.channelMentions.some((ch) => wChannels.includes(ch));
        const hitByName = preSignals.mentions.includes(w.name);
        const hitByAll = preSignals.hasAll;
        if (requiresExplicitWorkerRetry(w) && !(input.sender === "coordinator" && input.tag === "brief" && hitByName)) continue;
        if (hitByName || hitByAll || hitByChannel) {
          toWake.push(w.name);
        }
      }
    }

    const { message, signals } = this.db.postBoardMessageWithWakes(
      {
        ...input,
        suppress_wake: Boolean(input.suppressWake),
      },
      toWake,
    );
    this.emit("board:message", message);

    if (input.suppressWake) {
      return { message, woken: [] };
    }

    if (input.tag !== "brief") {
      const senderWorker = workerByName.get(input.sender);
      const tag = message.tag;
      let reviewTarget: string | null = null;
      if (tag === "review_pass" || tag === "review_fail") {
        reviewTarget =
          senderWorker?.review_of && workerByName.has(senderWorker.review_of)
            ? senderWorker.review_of
            : signals.mentions.find((m) => workerByName.has(m) && m !== input.sender) ?? null;
        if (reviewTarget) {
          this.db.insertDispatchEdge({
            swarm_id: input.swarm_id,
            from_node: input.sender,
            to_node: reviewTarget,
            kind: tag,
            seq: message.seq,
            turn_id: input.turn_id ?? null,
            label: tag === "review_pass" ? "审校通过" : "审校打回",
          });
        }
      }

      for (const wName of toWake) {
        if ((tag === "review_pass" || tag === "review_fail") && reviewTarget === wName) {
          continue;
        }
        const edgeKind: GraphEdgeKind = "handoff";
        this.db.insertDispatchEdge({
          swarm_id: input.swarm_id,
          from_node: input.sender,
          to_node: wName,
          kind: edgeKind,
          seq: message.seq,
          turn_id: input.turn_id ?? null,
          label: tag !== "update" ? `[${tag}]` : null,
        });
      }

      if (input.sender !== "coordinator" && signals.mentions.includes("coordinator")) {
        this.db.insertDispatchEdge({
          swarm_id: input.swarm_id,
          from_node: input.sender,
          to_node: "coordinator",
          kind: "handoff",
          seq: message.seq,
          turn_id: input.turn_id ?? null,
          label: tag !== "update" ? `[${tag}]` : "汇报",
        });
      }
    }

    for (const workerName of toWake) {
      this.scheduleWorkerRun(input.swarm_id, workerName, message.seq, { alreadyEnqueued: true });
    }

    return { message, woken: toWake };
  }

  scheduleWorkerRun(
    swarmId: string,
    workerName: string,
    triggerSeq: number,
    options?: { alreadyEnqueued?: boolean },
  ): void {
    if (this.isShutdown || this.db.getSwarm(swarmId)?.status !== "active") return;
    const key = this.workerKey(swarmId, workerName);
    if (!options?.alreadyEnqueued) {
      this.db.enqueuePendingDispatch(swarmId, workerName, triggerSeq);
    }
    if (this.runningWorkers.has(key)) {
      return;
    }
    const promise = this.drainWorkerQueue(swarmId, workerName);
    this.activeTurnPromises.set(key, promise);
  }

  async runWithConcurrencySlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireConcurrencySlot();
    try {
      return await fn();
    } finally {
      this.releaseConcurrencySlot();
    }
  }

  private async acquireConcurrencySlot(): Promise<void> {
    if (this.globalInFlight < this.config.maxConcurrency) {
      this.globalInFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.globalWaitQueue.push(() => {
        this.globalInFlight += 1;
        resolve();
      });
    });
  }

  private releaseConcurrencySlot(): void {
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    const next = this.globalWaitQueue.shift();
    if (next) next();
  }

  private async drainWorkerQueue(swarmId: string, workerName: string): Promise<void> {
    const key = this.workerKey(swarmId, workerName);
    if (this.runningWorkers.has(key) || this.isShutdown) return;
    this.runningWorkers.add(key);

    try {
      while (!this.isShutdown) {
        const worker = this.db.getWorker(swarmId, workerName);
        if (!worker || worker.state === "killed" || this.db.getSwarm(swarmId)?.status !== "active") {
          this.db.clearPendingDispatch(swarmId, workerName);
          break;
        }
        const claimed = this.db.claimPendingDispatch(swarmId, workerName, this.instanceId);
        if (!claimed) break;

        await this.acquireConcurrencySlot();
        try {
          if (this.isShutdown || this.db.getSwarm(swarmId)?.status !== "active") break;
          await this.executeWorkerTurnWithFallback(swarmId, workerName, claimed.trigger_seq);
        } finally {
          this.releaseConcurrencySlot();
          if (!this.isShutdown) {
            try {
              this.db.completePendingDispatch(swarmId, workerName, claimed.trigger_seq);
            } catch {
              // ignore if DB already closed
            }
          }
        }
      }
    } catch (err) {
      if (!this.isShutdown) {
        console.error(`[poly-swarm] drainWorkerQueue(${key}) unexpected error:`, err);
      }
    } finally {
      this.runningWorkers.delete(key);
      this.activeTurnPromises.delete(key);
    }
  }

  private buildWorkerPrompt(
    swarm: SwarmRecord,
    worker: WorkerRecord,
    triggerMessage: BoardMessage | undefined,
    policy?: ResolvedDispatchPolicy,
  ): { prompt: string; deliveredReadCursor: number; omittedSeqs: number[] } {
    const MAX_MSG_BYTES = 12 * 1024;
    const MAX_TRIGGER_BYTES = 28 * 1024;
    const MIN_TRIGGER_RESERVE = 32 * 1024;
    const MAX_BG_COUNT = 80;
    const MAX_PROMPT_BYTES = 96 * 1024;
    const clampMsg = (text: string) =>
      truncateUtf8Bytes(text, MAX_MSG_BYTES, "\n...[message truncated]");

    const channels = new Set(parseChannelsJson(worker.channels_json));
    const workerNameLower = worker.name.toLowerCase();
    const isVisibleToWorker = (m: BoardMessage): boolean => {
      if (channels.has(m.channel)) return true;
      const sig = parseMessageSignals(m.text);
      return (
        sig.mentions.includes(workerNameLower) ||
        sig.hasAll ||
        sig.channelMentions.some((ch) => channels.has(ch))
      );
    };

    const visibleUnreadBg: BoardMessage[] = [];
    const scannedInvisibleSeqs: number[] = [];
    let scanCursor = worker.last_read_seq;
    let maxScannedSeq = worker.last_read_seq;
    while (true) {
      const batch = this.db.readBoardMessages({
        swarm_id: swarm.id,
        since: scanCursor,
        limit: 200,
      });
      if (batch.length === 0) break;
      scanCursor = batch[batch.length - 1]!.seq;
      maxScannedSeq = Math.max(maxScannedSeq, scanCursor);
      for (const m of batch) {
        if (triggerMessage && m.seq === triggerMessage.seq) continue;
        if (isVisibleToWorker(m)) {
          visibleUnreadBg.push(m);
        } else {
          scannedInvisibleSeqs.push(m.seq);
        }
      }
      if (batch.length < 200) break;
    }

    const needsColdContext = !worker.session_id || worker.needs_handoff === 1;
    const headerParts: string[] = [];
    const identityId = worker.identity_id || worker.role;
    const activePolicy = policy ?? this.resolvePolicy({ swarmId: swarm.id, repoRoot: swarm.repo_root });
    const identity = activePolicy.identities[identityId];

    if (needsColdContext) {
      headerParts.push(
        `You are worker '@${worker.name}' (identity: ${identityId}, role: ${worker.role}) in Poly-Swarm '${swarm.title}' (${swarm.id}).`,
      );
      headerParts.push(`Workspace path: ${worker.workspace_path}`);
      if (worker.worktree_branch) {
        headerParts.push(`Git branch: ${worker.worktree_branch} (isolated worktree; stay within this directory).`);
      }
      if (worker.role === "verifier") {
        headerParts.push(
          "STRICT READONLY VERIFIER RULE: You must NEVER edit, create, or delete files. Inspect code, run read-only checks/tests, and post findings to @author or @coordinator with [review_pass] or [review_fail].",
        );
      } else if (worker.role === "researcher") {
        headerParts.push(
          "STRICT READONLY RESEARCHER RULE: You must NEVER edit, create, or delete files. Inspect code/files in readonly mode and report findings back to @coordinator.",
        );
      }
      const identPrompt = identity?.system_prompt?.trim();
      if (identPrompt) {
        headerParts.push(`Identity Directive (${identityId}):\n${clampMsg(identPrompt)}`);
      }
      if (swarm.plan_json) {
        headerParts.push(`Swarm plan:\n${clampMsg(swarm.plan_json)}`);
      }
      if (worker.needs_handoff === 1) {
        const recentHistory = this.db
          .readBoardTail(swarm.id, 40)
          .filter(isVisibleToWorker)
          .slice(-12);
        headerParts.push(
          "HANDOFF NOTICE: You were switched to a new backend/session. Recent channel messages for continuity:",
        );
        if (worker.last_error) {
          headerParts.push(`Previous failure summary: ${clampMsg(worker.last_error)}`);
        }
        for (const m of recentHistory) {
          headerParts.push(`#${m.seq} [${m.channel}] ${m.sender} (${m.tag}): ${clampMsg(m.text)}`);
        }
      }
      headerParts.push(
        "Posting convention: Start completion posts with [done] (or [review_pass]/[review_fail]/[blocked]). Mention the next peer with @name if handing off, otherwise mention @coordinator. Do NOT @mention peers unless you intentionally want to wake them for follow-up work (use plain names or backticks when merely referencing other workers).",
      );
    } else {
      headerParts.push(`Continue work as '@${worker.name}' (role: ${worker.role}).`);
    }
    if (identity?.enabled && identity.skill_paths?.length) {
      headerParts.splice(1, 0, [
        "Role Skills (paths relative to the assigned workspace):",
        ...identity.skill_paths.map((skill) => `- ${skill}`),
        "Read and apply relevant skills using your permitted file tools. These references grant no permissions. Skip missing or denied files and report them when relevant; do not try to bypass the workspace or tool restrictions.",
      ].join("\n"));
    }
    if (worker.backend === "agy" && isReadonlyRole(worker.role)) {
      headerParts.push(
        "AGY READONLY: Use list_dir, grep_search and read_file on the assigned workspace. Treat external paths and binary media as out of scope. Do not retry a denied target through a wrapper or another tool. Continue with permitted inputs and give a written report with any gaps. Use [blocked] if you cannot deliver the report, and use [done] only with the requested findings.",
      );
    }

    let headerStr = headerParts.join("\n\n");
    const maxHeaderBytes = MAX_PROMPT_BYTES - MIN_TRIGGER_RESERVE;
    if (Buffer.byteLength(headerStr, "utf8") > maxHeaderBytes) {
      headerStr = truncateUtf8Bytes(headerStr, maxHeaderBytes, "\n...[header truncated]");
    }
    const headerBytes = Buffer.byteLength(headerStr, "utf8");

    const triggerSectionText = triggerMessage
      ? `Current Trigger Message (#${triggerMessage.seq}):\n#${triggerMessage.seq} [${triggerMessage.channel}] ${triggerMessage.sender} (${triggerMessage.tag}): ${truncateUtf8Bytes(triggerMessage.text, MAX_TRIGGER_BYTES, "\n...[trigger message truncated]")}`
      : "";
    const triggerBytes = triggerSectionText ? Buffer.byteLength(triggerSectionText, "utf8") : 0;

    // Reserve at least 32 KiB for trigger message (or its actual byte size if <= 32 KiB)
    const effectiveTriggerReserve = triggerMessage
      ? Math.max(triggerBytes, Math.min(MIN_TRIGGER_RESERVE, MAX_PROMPT_BYTES - headerBytes))
      : 0;
    const availableContextBudget = Math.max(0, MAX_PROMPT_BYTES - headerBytes - effectiveTriggerReserve - 1024);

    // Pack newest visible unread background messages first; track any omitted older seqs
    const formatBg = (m: BoardMessage) =>
      `#${m.seq} [${m.channel}] ${m.sender} (${m.tag}): ${clampMsg(m.text)}`;
    const includedBg: Array<{ msg: BoardMessage; line: string }> = [];
    const omittedSeqsDesc: number[] = [];
    let usedBgBytes = 0;
    let budgetExhausted = false;

    for (let i = visibleUnreadBg.length - 1; i >= 0; i--) {
      const msg = visibleUnreadBg[i]!;
      const line = formatBg(msg);
      const lineBytes = Buffer.byteLength(line, "utf8") + 2;
      if (!budgetExhausted && includedBg.length < MAX_BG_COUNT && usedBgBytes + lineBytes <= availableContextBudget) {
        includedBg.unshift({ msg, line });
        usedBgBytes += lineBytes;
      } else {
        budgetExhausted = true;
        omittedSeqsDesc.push(msg.seq);
      }
    }
    const omittedSeqs = omittedSeqsDesc.reverse();

    const refSeqSet = new Set<number>();
    const collectRefs = (m: BoardMessage) => {
      try {
        const refs = JSON.parse(m.refs_json) as number[];
        for (const r of refs) refSeqSet.add(r);
      } catch {
        // ignore
      }
    };
    if (triggerMessage) collectRefs(triggerMessage);
    for (const item of includedBg) collectRefs(item.msg);

    const referencedMsgs = this.db.getMessagesBySeqs(swarm.id, [...refSeqSet]);
    const refLines: string[] = [];
    let refBudget = Math.max(0, availableContextBudget - usedBgBytes);
    for (const rm of referencedMsgs) {
      const line = `#${rm.seq} [${rm.channel}] ${rm.sender}: ${clampMsg(rm.text)}`;
      const lineBytes = Buffer.byteLength(line, "utf8") + 2;
      if (lineBytes <= refBudget) {
        refLines.push(line);
        refBudget -= lineBytes;
      }
    }

    const bodyParts: string[] = [];
    if (omittedSeqs.length > 0) {
      const sample = omittedSeqs.length > 40
        ? [...omittedSeqs.slice(0, 10).map((s) => `#${s}`), `...(${omittedSeqs.length - 30} omitted)...`, ...omittedSeqs.slice(-20).map((s) => `#${s}`)]
        : omittedSeqs.map((s) => `#${s}`);
      bodyParts.push(
        `Omitted earlier board message seqs (${omittedSeqs.length} unread; use poly_board_read if needed): ${sample.join(", ")}`,
      );
    }
    if (refLines.length > 0) {
      bodyParts.push("Referenced earlier board posts:");
      bodyParts.push(...refLines);
    }
    if (includedBg.length > 0) {
      bodyParts.push("New board messages for you:");
      for (const item of includedBg) {
        bodyParts.push(item.line);
      }
    }
    if (triggerSectionText) {
      bodyParts.push(triggerSectionText);
    }

    let prompt = bodyParts.length > 0 ? `${headerStr}\n\n${bodyParts.join("\n\n")}` : headerStr;
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      // Drop background/ref lines first, never dropping triggerSectionText
      const droppedSeqs = includedBg.map((item) => item.msg.seq);
      if (droppedSeqs.length > 0) {
        omittedSeqs.unshift(...droppedSeqs);
        omittedSeqs.sort((a, b) => a - b);
        includedBg.length = 0;
      }
      const safeBody = triggerSectionText ? [triggerSectionText] : [];
      prompt = safeBody.length > 0 ? `${headerStr}\n\n${safeBody.join("\n\n")}` : headerStr;
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        prompt = truncateUtf8Bytes(prompt, MAX_PROMPT_BYTES, "\n...[truncated]");
      }
    }

    let deliveredReadCursor: number;
    if (omittedSeqs.length === 0) {
      deliveredReadCursor = Math.max(
        worker.last_read_seq,
        maxScannedSeq,
        triggerMessage?.seq ?? 0,
      );
    } else {
      const firstOmitted = omittedSeqs[0]!;
      deliveredReadCursor = worker.last_read_seq;
      if (triggerMessage && triggerMessage.seq < firstOmitted) {
        deliveredReadCursor = Math.max(deliveredReadCursor, triggerMessage.seq);
      }
      for (const item of includedBg) {
        if (item.msg.seq < firstOmitted) {
          deliveredReadCursor = Math.max(deliveredReadCursor, item.msg.seq);
        }
      }
      for (const seq of scannedInvisibleSeqs) {
        if (seq < firstOmitted) {
          deliveredReadCursor = Math.max(deliveredReadCursor, seq);
        }
      }
    }

    return { prompt, deliveredReadCursor, omittedSeqs };
  }

  private async recordWorkerBlocked(worker: WorkerRecord, reason: string): Promise<void> {
    if (this.db.getSwarm(worker.swarm_id)?.status !== "active") return;
    this.db.updateWorkerState(worker.swarm_id, worker.name, "error", reason);
    await this.postMessage({
      swarm_id: worker.swarm_id,
      sender: worker.name,
      channel: parseChannelsJson(worker.channels_json)[0] || "main",
      tag: "blocked",
      text: `[blocked] @coordinator ${reason}`,
      suppressWake: true,
    });
  }

  private async snapshotWorkerHandoff(worker: WorkerRecord, label: string): Promise<void> {
    if (worker.workspace_mode === "inherit" || isReadonlyRole(worker.role)) return;
    try {
      if (await this.workspace.getCurrentBranch(worker.workspace_path) !== worker.worktree_branch) {
        throw new Error(`Expected worker branch '${worker.worktree_branch}' to be checked out.`);
      }
      await this.workspace.snapshotDirtyForHandoff(worker.workspace_path, label);
    } catch (err) {
      const reason = `Could not save worktree handoff for @${worker.name}: ${err instanceof Error ? err.message : String(err)}`;
      await this.recordWorkerBlocked(worker, reason);
      throw new Error(reason, { cause: err });
    }
  }

  private async executeWorkerTurnWithFallback(
    swarmId: string,
    workerName: string,
    triggerSeq: number,
  ): Promise<void> {
    const triedBackends = new Set<BackendId>();
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const worker = this.db.getWorker(swarmId, workerName);
      if (!worker || worker.state === "killed" || this.db.getSwarm(swarmId)?.status !== "active") return;
      triedBackends.add(worker.backend);

      const policy = this.resolvePolicy({ swarmId });
      const identity = policy.identities[worker.identity_id || worker.role] ?? policy.identities[worker.role];
      try {
        const author = worker.review_of && worker.backend !== "mock" && identity?.require_cross_vendor !== false
          ? this.reviewAuthor(swarmId, worker.review_of) : null;
        this.assertIndependentReviewer(worker.backend, worker.model, author);
      } catch (err) {
        await this.recordWorkerBlocked(worker, err instanceof Error ? err.message : String(err));
        return;
      }

      if (requiresExplicitWorkerRetry(worker)) {
        const trigger = this.db.getMessagesBySeqs(swarmId, [triggerSeq])[0];
        if (trigger?.sender !== "coordinator" || trigger.tag !== "brief" ||
            !parseMessageSignals(trigger.text).mentions.includes(workerName)) return;
      }

      let res = await this.executeSingleTurn(swarmId, worker, triggerSeq);
      // Retrying the same read-only backend does not enable cross-backend fallback.
      if (res.errorKind === "connection_error" && worker.backend === "cursor" &&
          !res.outputText.trim() && res.toolCallsCount === 0 && isReadonlyRole(worker.role) && !this.isShutdown &&
          this.db.getSwarm(swarmId)?.status === "active") {
        res = await this.executeSingleTurn(swarmId, { ...worker, session_id: null }, triggerSeq);
      }
      if (res.ok || this.db.getSwarm(swarmId)?.status !== "active") return;

      if (worker.agy_account_id && res.errorKind === "auth_error" && isDisabledAgyAccount(res.errorMessage ?? "")) {
        this.db.disableAgyCompany(companyIdFor(worker.agy_account_id));
      }
      const canFallbackOnQuota = res.errorKind === "quota_exhausted";
      const canFallbackOnConfig = res.errorKind === "config_error" && !worker.model &&
        !isMissingWorkerEnvironment(res.errorMessage ?? "");

      if (canFallbackOnQuota) {
        const until = Date.now() + this.config.cooldownMs;
        if (worker.agy_account_id) this.db.setAgyCompanyCooldown(companyIdFor(worker.agy_account_id), until);
        else this.db.setBackendCooldown(worker.backend, until, res.errorMessage ?? "quota_exhausted");
      }

      let fallbackError: string | null = null;
      if ((canFallbackOnQuota || canFallbackOnConfig) && !worker.agy_account_id && worker.auto_fallback === 1 && attempt + 1 < maxAttempts) {
        const policy = this.resolvePolicy({ swarmId });
        const identityId = worker.identity_id || worker.role;
        const identity = policy.identities[identityId] ?? policy.identities[worker.role];
        const resolveFallback = (backend: BackendId) => identity
          ? resolveEffectiveModelAndEffort({ policy, identity, backend, isFallback: true })
          : {
              model: policy.backends[backend]?.defaultModel ?? null,
              effort: policy.backends[backend]?.defaultEffort ?? null,
            };
        let nextBackend: BackendId | null = null;
        try {
          const author = worker.review_of && identity?.require_cross_vendor !== false
            ? this.reviewAuthor(swarmId, worker.review_of) : null;
          nextBackend = await this.selectBackend({
            capability: worker.capability,
            excludeBackends: author ? [...triedBackends, author.backend] : [...triedBackends],
            excludeVendorFamilies: author && author.backend !== "mock"
              ? [inferVendorFamily(author.backend, author.model)] : undefined,
            requireReadonly: isReadonlyRole(worker.role),
            policy,
            preferredBackends: identity?.preferred_backends,
            modelForBackend: (id) => resolveFallback(id).model,
          });
        } catch (err) {
          fallbackError = err instanceof Error ? err.message : String(err);
        }

        if (nextBackend) {
          const oldBackend = worker.backend;
          const eff = resolveFallback(nextBackend);
          try {
            this.assertSwarmWritable(swarmId);
            if (worker.review_of && identity?.require_cross_vendor !== false) {
              this.assertIndependentReviewer(nextBackend, eff.model, this.reviewAuthor(swarmId, worker.review_of));
            }
          } catch (err) {
            await this.recordWorkerBlocked(worker, err instanceof Error ? err.message : String(err));
            return;
          }
          try {
            await this.snapshotWorkerHandoff(worker, `${oldBackend} -> ${nextBackend}`);
          } catch {
            return; // Snapshot failure was recorded on the board and worker.
          }
          if (this.db.getSwarm(swarmId)?.status !== "active") return;
          let nextPolicyJson: string | undefined;
          try {
            const prevSnap = worker.resolved_policy_json
              ? (JSON.parse(worker.resolved_policy_json) as WorkerPolicySnapshot)
              : null;
            if (prevSnap) {
              const updatedSnap: WorkerPolicySnapshot = {
                ...prevSnap,
                backend: nextBackend,
                model: eff.model,
                effort: eff.effort,
              };
              nextPolicyJson = JSON.stringify(updatedSnap);
            }
          } catch {
            // ignore
          }
          this.db.updateWorkerBackend(
            swarmId,
            workerName,
            nextBackend,
            eff.model,
            eff.effort,
            nextPolicyJson,
          );
          const { message: handoffMsg } = await this.postMessage({
            swarm_id: swarmId,
            sender: "coordinator",
            channel: "main",
            tag: "system",
            text: `[handoff] Worker @${workerName} hit ${res.errorKind} on '${oldBackend}', auto-switched to '${nextBackend}'.`,
            suppressWake: true,
          });
          this.db.insertDispatchEdge({
            swarm_id: swarmId,
            from_node: workerName,
            to_node: workerName,
            kind: "fallback",
            seq: handoffMsg.seq,
            label: `${oldBackend} -> ${nextBackend} (${res.errorKind})`,
            meta: {
              from_backend: oldBackend,
              to_backend: nextBackend,
              from_model: worker.model,
              to_model: eff.model,
              auto: true,
              reason: res.errorKind,
            },
          });
          continue;
        }
      }

      // Non-recoverable or no fallback available -> notify coordinator
      if (res.errorKind !== "cancelled") {
        await this.recordWorkerBlocked(worker,
          `(${res.errorKind}) ${res.errorMessage ?? "Turn failed"}${fallbackError ? ` ${fallbackError}` : ""}`,
        );
      }
      return;
    }
  }

  private async executeSingleTurn(
    swarmId: string,
    worker: WorkerRecord,
    triggerSeq: number,
  ): Promise<AdapterRunResult> {
    const swarm = this.db.getSwarm(swarmId)!;
    const policy = this.resolvePolicy({ swarmId, repoRoot: swarm.repo_root });
    const triggerMsg = this.db.getMessagesBySeqs(swarmId, [triggerSeq])[0];
    const { prompt, deliveredReadCursor } = this.buildWorkerPrompt(swarm, worker, triggerMsg, policy);
    const mode: "readonly" | "write" =
      worker.role === "verifier" || worker.role === "researcher" ? "readonly" : "write";
    const adapter = this.registry.get(worker.backend);

    const turn = this.db.createTurn({
      swarm_id: swarmId,
      worker_name: worker.name,
      backend: worker.backend,
      model: worker.model,
      effort: worker.effort ?? null,
      mode,
      trigger_seq: triggerSeq,
      prompt_preview: prompt,
      session_id_used: worker.session_id,
      owner_instance_id: this.instanceId,
    });

    if (mode === "readonly" && !adapter.capabilities.supportsStrictReadonly) {
      const msg = `Backend '${worker.backend}' does not enforce strict readonly mode for role '${worker.role}'.`;
      this.db.completeTurn(turn.id, {
        status: "failed",
        error_kind: "config_error",
        error_message: msg,
        output_text: "",
        duration_ms: 0,
        tool_calls_count: 0,
      });
      return {
        ok: false,
        outputText: "",
        errorKind: "config_error",
        errorMessage: msg,
        usage: {
          accuracy: "estimated",
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: null,
        },
        durationMs: 0,
        toolCallsCount: 0,
        exitCode: 1,
      };
    }

    const polBackend = policy.backends[worker.backend];
    if (polBackend?.enabled === false && (!worker.agy_account_id ||
        polBackend.enabled_source.layer === "project" || polBackend.enabled_source.layer === "session")) {
      const msg = `Backend '${worker.backend}' is disabled in policy (${polBackend.enabled_source.layer}).`;
      this.db.completeTurn(turn.id, {
        status: "failed",
        error_kind: "config_error",
        error_message: msg,
        output_text: "",
        duration_ms: 0,
        tool_calls_count: 0,
      });
      return {
        ok: false,
        outputText: "",
        errorKind: "config_error",
        errorMessage: msg,
        usage: {
          accuracy: "estimated",
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: null,
        },
        durationMs: 0,
        toolCallsCount: 0,
        exitCode: 1,
      };
    }

    this.db.updateWorkerState(swarmId, worker.name, "working", null, this.instanceId);
    const controller = new AbortController();
    const key = this.workerKey(swarmId, worker.name);
    this.activeControllers.set(key, controller);
    this.emit("worker:state", { swarmId, workerName: worker.name, state: "working", turnId: turn.id });

    const lockKey = normalizeLockPath(worker.workspace_path);
    const readObserver =
      mode === "readonly" && worker.workspace_mode === "inherit"
        ? { writerObserved: this.activeWritersByPath.has(lockKey) }
        : null;
    if (readObserver) {
      let observers = this.readonlyObserversByPath.get(lockKey);
      if (!observers) {
        observers = new Set();
        this.readonlyObserversByPath.set(lockKey, observers);
      }
      observers.add(readObserver);
    }

    let beforeSnapshot: Awaited<ReturnType<WorkspaceManager["snapshotStatus"]>> | null = null;
    let seqInTurn = 0;
    let res: AdapterRunResult;

    const effectiveOverride: BackendOverrideConfig | undefined = (() => {
      const rawOv = this.config.backends[worker.backend];
      const baseOv: BackendOverrideConfig = rawOv ? { ...rawOv } : {};
      if (worker.agy_account_id) {
        delete baseOv.defaultModel;
        delete baseOv.defaultEffort;
      } else if (polBackend) {
        if (polBackend.defaultModel) baseOv.defaultModel = polBackend.defaultModel;
        else delete baseOv.defaultModel;
        if (polBackend.defaultEffort) baseOv.defaultEffort = polBackend.defaultEffort;
        else delete baseOv.defaultEffort;
      }
      return Object.keys(baseOv).length > 0 ? baseOv : undefined;
    })();

    const invokeTurn = () => {
      if (controller.signal.aborted) {
        return Promise.resolve<AdapterRunResult>({
          ok: false,
          outputText: "",
          actualModel: null,
          errorKind: "cancelled",
          errorMessage: "Cancelled",
          usage: {
            accuracy: "estimated",
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: null,
          },
          durationMs: 0,
          toolCallsCount: 0,
          exitCode: 130,
        });
      }
      let agyProfile: AgyLaunchProfile | undefined;
      if (worker.agy_account_id) {
        try {
          if (worker.backend !== "agy") throw new Error("The bound AGY account requires the AGY backend.");
          this.requireAgyCompany(companyIdFor(worker.agy_account_id));
          agyProfile = this.agyAccounts.prepare(worker.agy_account_id);
        } catch (err) {
          return Promise.resolve<AdapterRunResult>({
            ok: false, outputText: "", errorKind: "config_error",
            errorMessage: err instanceof Error ? err.message : "Unable to prepare the bound AGY account.",
            usage: { accuracy: "estimated", input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: null },
            durationMs: 0, toolCallsCount: 0, exitCode: 1,
          });
        }
      }
      return adapter.runTurn({
        cwd: worker.workspace_path,
        prompt,
        mode,
        sessionId: worker.session_id,
        model: worker.model,
        effort: worker.effort,
        timeoutMs: this.config.defaultTurnTimeoutMs,
        idleTimeoutMs: this.config.defaultIdleTimeoutMs,
        hookMetricsDir: this.config.hookMetricsDir,
        override: effectiveOverride,
        agyProfile,
        signal: controller.signal,
        onEvent: (ev) => {
          seqInTurn += 1;
          this.db.insertEvent({
            turn_id: turn.id,
            swarm_id: swarmId,
            worker_name: worker.name,
            seq_in_turn: seqInTurn,
            kind: ev.kind,
            title: ev.title ?? null,
            content: ev.content,
            meta: ev.meta ?? null,
          });
          this.emit("worker:event", {
            turnId: turn.id,
            swarmId,
            workerName: worker.name,
            event: ev,
          });
        },
      });
    };

    try {
      beforeSnapshot =
        mode === "readonly" ? await this.workspace.snapshotStatus(worker.workspace_path) : null;
      try {
        res = mode === "write"
          ? await this.withWorkspaceWriteLock(worker.workspace_path, key, invokeTurn)
          : await invokeTurn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res = {
          ok: false,
          outputText: "",
          actualModel: null,
          errorKind: "unknown",
          errorMessage: msg,
          usage: {
            accuracy: "estimated",
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: null,
          },
          durationMs: 0,
          toolCallsCount: 0,
          exitCode: 1,
        };
      } finally {
        this.activeControllers.delete(key);
      }

      const concurrentInternalWriter = Boolean(
        readObserver && (readObserver.writerObserved || this.activeWritersByPath.has(lockKey)),
      );

      // Readonly enforcement for verifier/researcher
      if (beforeSnapshot) {
        // A shared checkout can change outside this engine (for example, in the
        // coordinator's editor). Git status cannot attribute those changes.
        const auditOnly = worker.workspace_mode === "inherit";
        const rollback = await this.workspace.detectAndRollbackUnauthorizedWrites(
          worker.workspace_path,
          beforeSnapshot,
          { dryRun: auditOnly },
        );
        if (concurrentInternalWriter) {
          seqInTurn += 1;
          this.db.insertEvent({
            turn_id: turn.id,
            swarm_id: swarmId,
            worker_name: worker.name,
            seq_in_turn: seqInTurn,
            kind: "system",
            title: "Concurrent Internal Writer in Shared Workspace",
            content: `Shared inherit directory had an active concurrent internal write turn while readonly '${worker.name}' ran; read view may span versions and rollback was skipped (${rollback.observedChanges?.length ?? 0} changed path(s)).`,
          });
        } else if (rollback.skippedReason === "head_changed") {
          seqInTurn += 1;
          this.db.insertEvent({
            turn_id: turn.id,
            swarm_id: swarmId,
            worker_name: worker.name,
            seq_in_turn: seqInTurn,
            kind: "system",
            title: "Concurrent Git HEAD Changed — Rollback Skipped",
            content: `Git HEAD changed during readonly turn (${rollback.beforeHeadSha?.slice(0, 7) ?? "none"} -> ${rollback.afterHeadSha?.slice(0, 7) ?? "none"}); observed ${rollback.observedChanges?.length ?? 0} changed path(s). Skipping rollback to avoid reverting external commits.`,
          });
        } else if (
          rollback.skippedReason === "shared_strict_readonly_audit" &&
          (rollback.observedChanges?.length ?? 0) > 0
        ) {
          seqInTurn += 1;
          this.db.insertEvent({
            turn_id: turn.id,
            swarm_id: swarmId,
            worker_name: worker.name,
            seq_in_turn: seqInTurn,
            kind: "system",
            title: "Concurrent Workspace Edits Observed (Preserved)",
            content: `The shared workspace changed during readonly '${worker.name}' (${rollback.observedChanges!.join(", ")}). Changes were preserved; the review may have read an earlier version.`,
          });
        } else if (rollback.reverted.length > 0 || rollback.unreverted.length > 0) {
          const parts: string[] = [];
          if (rollback.reverted.length > 0) {
            parts.push(`reverted: ${rollback.reverted.join(", ")}`);
          }
          if (rollback.unreverted.length > 0) {
            parts.push(
              `NOT reverted (snapshot omitted or git restore failed): ${rollback.unreverted.join(", ")}`,
            );
          }
          const msg = `Unauthorized file modifications by readonly '${worker.name}' (${parts.join("; ")}). If this worker needs write access, dispatch with role='author' and workspace_mode='share'.`;
          seqInTurn += 1;
          this.db.insertEvent({
            turn_id: turn.id,
            swarm_id: swarmId,
            worker_name: worker.name,
            seq_in_turn: seqInTurn,
            kind: "error",
            title:
              rollback.unreverted.length > 0
                ? "Unauthorized Write (Partial/Unreverted)"
                : "Unauthorized Write Reverted",
            content: msg,
          });
          res = {
            ...res,
            ok: false,
            errorKind: "unauthorized_write",
            errorMessage: msg,
          };
        }
      }
    } finally {
      if (readObserver) {
        const observers = this.readonlyObserversByPath.get(lockKey);
        observers?.delete(readObserver);
        if (observers && observers.size === 0) {
          this.readonlyObserversByPath.delete(lockKey);
        }
      }
    }

    // Persist usage & turn final status
    this.db.insertUsage({
      turn_id: turn.id,
      swarm_id: swarmId,
      worker_name: worker.name,
      backend: worker.backend,
      model: worker.model,
      accuracy: res.usage.accuracy,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      reasoning_tokens: res.usage.reasoning_tokens,
      cache_read_tokens: res.usage.cache_read_tokens,
      cache_write_tokens: res.usage.cache_write_tokens,
      total_tokens: res.usage.total_tokens,
      cost_usd: res.usage.cost_usd,
      duration_ms: res.durationMs,
      tool_calls_count: res.toolCallsCount,
    });

    const finalStatus = res.ok
      ? "completed"
      : res.errorKind === "cancelled"
        ? "cancelled"
        : "failed";

    this.db.completeTurn(turn.id, {
      status: finalStatus,
      error_kind: res.errorKind,
      error_message: res.errorMessage,
      output_text: res.outputText,
      structured_json: res.structuredJson,
      session_id_returned: res.sessionId,
      actual_model: res.actualModel ?? null,
      duration_ms: res.durationMs,
      tool_calls_count: res.toolCallsCount,
    });

    if (deliveredReadCursor > worker.last_read_seq && res.errorKind !== "connection_error") {
      this.db.updateWorkerCursors(swarmId, worker.name, { last_read_seq: deliveredReadCursor });
    }

    if (res.ok) {
      const nextSessionId = res.sessionId ?? worker.session_id;
      this.db.updateWorkerSession(swarmId, worker.name, nextSessionId, false);
      const current = this.db.getWorker(swarmId, worker.name);
      if (current && current.state !== "killed") {
        this.db.updateWorkerState(swarmId, worker.name, "waiting", null);
      }

      const body = res.outputText || "(no text output)";
      const hasMention = /(?:^|[^a-zA-Z0-9._-])@[a-z0-9#_-]+/i.test(body);
      const postedText = hasMention ? body : `@coordinator ${body}`;
      const primaryChannel = parseChannelsJson(worker.channels_json)[0] || "main";
      if (this.db.getSwarm(swarmId)?.status === "active") await this.postMessage({
        swarm_id: swarmId,
        sender: worker.name,
        channel: primaryChannel,
        tag: inferMessageTag(postedText),
        text: postedText,
        turn_id: turn.id,
      });
    } else if (res.errorKind === "cancelled") {
      const current = this.db.getWorker(swarmId, worker.name);
      if (current && current.state !== "killed") {
        this.db.updateWorkerState(swarmId, worker.name, "stopped", res.errorMessage ?? "Cancelled");
      }
    }

    this.emit("turn:completed", { swarmId, workerName: worker.name, turnId: turn.id, ok: res.ok });
    return res;
  }

  async switchWorkerBackend(params: {
    swarm_id: string;
    name: string;
    backend: BackendId;
    model?: string | null;
    effort?: string | null;
    reason?: string;
    resume_prompt?: string;
  }): Promise<WorkerRecord> {
    this.assertSwarmWritable(params.swarm_id);
    const worker = this.db.getWorker(params.swarm_id, params.name);
    if (!worker) throw new Error(`Worker '${params.name}' not found.`);
    if (worker.agy_account_id && params.backend !== "agy") {
      throw new Error("This worker is bound to an AGY account. Dispatch another employee to use a different backend.");
    }
    if (worker.state === "working") {
      throw new Error(`Worker '${params.name}' is currently working; cancel or wait first.`);
    }
    const targetAdapter = this.registry.get(params.backend);
    if (
      isReadonlyRole(worker.role) &&
      !targetAdapter.capabilities.supportsStrictReadonly
    ) {
      throw new Error(
        `Backend '${params.backend}' does not enforce strict readonly mode for role '${worker.role}'.`,
      );
    }
    const policy = this.resolvePolicy({ swarmId: params.swarm_id });
    const polBackend = policy.backends[params.backend];
    if (polBackend?.enabled === false && (!worker.agy_account_id ||
        polBackend.enabled_source.layer === "project" || polBackend.enabled_source.layer === "session")) {
      throw new Error(
        `Backend '${params.backend}' is disabled in policy (${polBackend.enabled_source.layer}).`,
      );
    }

    const oldBackend = worker.backend;
    const identityId = worker.identity_id || worker.role;
    const identity = policy.identities[identityId] ?? policy.identities[worker.role];
    const eff = worker.agy_account_id
      ? { model: params.model ?? worker.model, effort: params.effort ?? worker.effort }
      : identity
      ? resolveEffectiveModelAndEffort({
          policy,
          identity,
          backend: params.backend,
          explicitModel: params.model,
          explicitEffort: params.effort,
          isFallback: oldBackend !== params.backend && !params.model,
        })
      : { model: params.model ?? null, effort: params.effort ?? null };
    const author = worker.review_of && params.backend !== "mock" && identity?.require_cross_vendor !== false
      ? this.reviewAuthor(params.swarm_id, worker.review_of) : null;
    this.assertIndependentReviewer(params.backend, eff.model, author);
    await this.snapshotWorkerHandoff(worker, `${oldBackend} -> ${params.backend}`);
    this.assertSwarmWritable(params.swarm_id);

    let nextPolicyJson: string | undefined;
    try {
      const prevSnap = worker.resolved_policy_json
        ? (JSON.parse(worker.resolved_policy_json) as WorkerPolicySnapshot)
        : null;
      if (prevSnap) {
        nextPolicyJson = JSON.stringify({
          ...prevSnap,
          backend: params.backend,
          model: eff.model,
          effort: eff.effort,
        });
      }
    } catch {
      // ignore
    }

    this.db.updateWorkerBackend(
      params.swarm_id,
      params.name,
      params.backend,
      eff.model,
      eff.effort,
      nextPolicyJson,
    );

    const msgText = params.resume_prompt
      ? `@${params.name} [switched ${oldBackend} -> ${params.backend}${params.reason ? `: ${params.reason}` : ""}] ${params.resume_prompt}`
      : `[switch] Worker @${params.name} switched from '${oldBackend}' to '${params.backend}'${params.reason ? ` (${params.reason})` : ""}.`;

    const { message: switchMsg } = await this.postMessage({
      swarm_id: params.swarm_id,
      sender: "coordinator",
      channel: "main",
      tag: "system",
      text: msgText,
      suppressWake: !params.resume_prompt,
    });

    this.db.insertDispatchEdge({
      swarm_id: params.swarm_id,
      from_node: params.name,
      to_node: params.name,
      kind: "fallback",
      seq: switchMsg.seq,
      label: `${oldBackend} -> ${params.backend} (manual)`,
      meta: {
        from_backend: oldBackend,
        to_backend: params.backend,
        from_model: worker.model,
        to_model: eff.model,
        auto: false,
        reason: params.reason ?? null,
      },
    });

    return this.db.getWorker(params.swarm_id, params.name)!;
  }

  cancelWorkerTurn(swarmId: string, name: string): boolean {
    this.assertSwarmWritable(swarmId);
    const key = this.workerKey(swarmId, name);
    this.db.clearPendingDispatch(swarmId, name);
    const controller = this.activeControllers.get(key);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  async mergeWorker(swarmId: string, name: string, opts?: { expectedSha?: string }) {
    const swarm = this.assertSwarmWritable(swarmId);
    const worker = this.db.getWorker(swarmId, name);
    if (!worker) throw new Error(`Worker '${name}' not found.`);
    if (!worker.worktree_branch) {
      throw new Error(`Worker '${name}' has no isolated worktree branch to merge.`);
    }
    if (worker.state === "working") {
      throw new Error(`Worker '${name}' is still working.`);
    }
    const result = await this.workspace.mergeWorkerBranch(
      swarm.repo_root,
      worker.worktree_branch,
      worker.workspace_path,
      { targetBranch: swarm.base_branch, expectedSha: opts?.expectedSha },
    );
    const mergePost = await this.postMessage({
      swarm_id: swarmId,
      sender: "coordinator",
      channel: "main",
      tag: result.ok ? "done" : "blocked",
      text: result.ok
        ? `[merged] @${name} branch '${worker.worktree_branch}' merged (${result.merged_commit}).`
        : `[blocked] Merge of @${name} stopped: ${result.message}${result.conflicts.length ? ` Conflicts: ${result.conflicts.join(", ")}` : ""}`,
      suppressWake: result.ok || result.conflicts.length === 0,
    });
    this.db.insertDispatchEdge({
      swarm_id: swarmId,
      from_node: name,
      to_node: "repo",
      kind: "merge",
      seq: mergePost.message.seq,
      label: result.ok ? `合并 ${result.merged_commit ?? ""}`.trim() : result.conflicts.length ? "合并冲突" : "合并受阻",
      meta: {
        ok: result.ok,
        merged_commit: result.merged_commit ?? null,
        conflicts: result.conflicts,
      },
    });
    return result;
  }

  async killWorker(
    swarmId: string,
    name: string,
    cleanupWorkspace = false,
  ): Promise<WorkerRecord> {
    const swarm = this.assertSwarmWritable(swarmId);
    const worker = this.db.getWorker(swarmId, name);
    if (!worker) throw new Error(`Worker '${name}' not found.`);
    const inflight = this.activeTurnPromises.get(this.workerKey(swarmId, name));
    this.cancelWorkerTurn(swarmId, name);
    if (inflight) {
      await Promise.race([
        inflight.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    this.db.updateWorkerState(swarmId, name, "killed", null);
    this.db.clearPendingDispatch(swarmId, name);
    if (cleanupWorkspace) {
      await this.workspace.cleanupWorkspace(
        swarm.repo_root,
        worker.workspace_path,
        worker.workspace_mode,
        worker.worktree_branch,
      );
    }
    return this.db.getWorker(swarmId, name)!;
  }

  waitForBoard(params: {
    swarm_id: string;
    since: number;
    channel?: string;
    mentions_only_for?: string;
    timeout_ms?: number;
  }): Promise<BoardMessage[]> {
    const match = (msg: BoardMessage): boolean => {
      if (msg.swarm_id !== params.swarm_id || msg.seq <= params.since) return false;
      if (params.channel && params.channel !== "*" && msg.channel !== params.channel) {
        return false;
      }
      if (params.mentions_only_for) {
        const target = params.mentions_only_for.toLowerCase();
        const sig = parseMessageSignals(msg.text);
        return (
          sig.mentions.includes(target) ||
          sig.hasAll ||
          sig.channelMentions.includes(msg.channel.toLowerCase())
        );
      }
      return true;
    };

    const existing = this.db
      .readBoardMessages({ swarm_id: params.swarm_id, since: params.since, limit: 100 })
      .filter(match);
    if (existing.length > 0) {
      return Promise.resolve(existing);
    }

    const timeoutMs = Math.min(params.timeout_ms ?? 30_000, 120_000);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onMsg = (msg: BoardMessage) => {
        if (!match(msg)) return;
        cleanup();
        resolve([msg]);
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.off("board:message", onMsg);
      };
      this.on("board:message", onMsg);
      timer = setTimeout(() => {
        cleanup();
        resolve([]);
      }, timeoutMs);
      timer.unref();
    });
  }

  // --- UI Focus & Heartbeat (strictly scoped per swarm_id) ---

  private focusKey(swarmId?: string | null): string {
    return swarmId && swarmId.trim() ? swarmId.trim() : "__session__";
  }

  recordWorkbenchHeartbeat(swarmId?: string | null): void {
    this.heartbeatBySwarm.set(this.focusKey(swarmId), Date.now());
  }

  isWorkbenchAlive(swarmId?: string | null): boolean {
    const last = this.heartbeatBySwarm.get(this.focusKey(swarmId)) ?? 0;
    return Date.now() - last < 4500;
  }

  getUiFocus(swarmId?: string | null): UiFocusState {
    const k = this.focusKey(swarmId);
    const stored = this.focusBySwarm.get(k);
    return {
      swarm_id: stored?.swarm_id ?? (swarmId ?? null),
      worker_name: stored?.worker_name ?? null,
      tab: stored?.tab ?? "detail",
      seq: stored?.seq ?? 0,
      updated_at: stored?.updated_at ?? 0,
      workbench_alive: this.isWorkbenchAlive(swarmId),
    };
  }

  setUiFocus(params: {
    swarm_id?: string | null;
    worker_name?: string | null;
    tab?: WorkbenchTab;
  }): UiFocusState {
    const targetSwarmId = params.swarm_id ?? null;
    const k = this.focusKey(targetSwarmId);
    const prev = this.focusBySwarm.get(k) ?? {
      swarm_id: targetSwarmId,
      worker_name: null,
      tab: "detail" as WorkbenchTab,
      seq: 0,
      updated_at: 0,
    };
    this.globalFocusSeq += 1;
    const next: Omit<UiFocusState, "workbench_alive"> = {
      swarm_id: params.swarm_id !== undefined ? params.swarm_id : prev.swarm_id,
      worker_name: params.worker_name !== undefined ? params.worker_name : prev.worker_name,
      tab: params.tab ?? prev.tab,
      seq: this.globalFocusSeq,
      updated_at: Date.now(),
    };
    this.focusBySwarm.set(k, next);
    this.persistLastWorkbenchSwarm(targetSwarmId);
    return {
      ...next,
      workbench_alive: this.isWorkbenchAlive(targetSwarmId),
    };
  }

  private getEffectiveDefaults(): Partial<Record<BackendId, { model?: string; effort?: string }>> {
    const out: Partial<Record<BackendId, { model?: string; effort?: string }>> = {};
    for (const [id, cfg] of Object.entries(this.config.backends)) {
      if (!cfg) continue;
      if (cfg.defaultModel || cfg.defaultEffort) {
        out[id as BackendId] = {
          ...(cfg.defaultModel ? { model: cfg.defaultModel } : {}),
          ...(cfg.defaultEffort ? { effort: cfg.defaultEffort } : {}),
        };
      }
    }
    return out;
  }

  private getBackendConfigs(): Partial<Record<RealBackendId, BackendConfigEntry>> {
    const out: Partial<Record<RealBackendId, BackendConfigEntry>> = {};
    for (const id of REAL_BACKEND_IDS) {
      const cfg = this.config.backends[id];
      out[id] = {
        enabled: cfg?.enabled !== false,
        ...(cfg?.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
        ...(cfg?.defaultEffort ? { defaultEffort: cfg.defaultEffort } : {}),
      };
    }
    return out;
  }

  async updateBackendConfigs(
    updates: Array<{
      backend: RealBackendId;
      enabled?: boolean;
      defaultModel?: string | null;
      defaultEffort?: string | null;
    }>,
  ): Promise<Partial<Record<RealBackendId, BackendConfigEntry>>> {
    const nextConfig = structuredClone(this.config);
    if (!nextConfig.globalUiRaw) nextConfig.globalUiRaw = {};
    if (!nextConfig.globalUiRaw.backends) nextConfig.globalUiRaw.backends = {};
    for (const item of updates) {
      if (!REAL_BACKEND_IDS.includes(item.backend)) {
        throw new Error(`Unsupported backend '${item.backend}'.`);
      }
      this.registry.get(item.backend);
      const updatedOv = updateBackendOverride(nextConfig, item.backend, {
        enabled: item.enabled,
        defaultModel: item.defaultModel,
        defaultEffort: item.defaultEffort,
      });
      const rawEntry: { enabled?: boolean; defaultModel?: string | null; defaultEffort?: string | null } = {};
      if (updatedOv.enabled === false) rawEntry.enabled = false;
      else if (item.enabled === true) rawEntry.enabled = true;
      else if (typeof nextConfig.globalUiRaw.backends[item.backend]?.enabled === "boolean") {
        rawEntry.enabled = nextConfig.globalUiRaw.backends[item.backend]!.enabled as boolean;
      }
      if (updatedOv.defaultModel) rawEntry.defaultModel = updatedOv.defaultModel;
      if (updatedOv.defaultEffort) rawEntry.defaultEffort = updatedOv.defaultEffort;
      if (Object.keys(rawEntry).length > 0) {
        nextConfig.globalUiRaw.backends[item.backend] = rawEntry;
      } else {
        delete nextConfig.globalUiRaw.backends[item.backend];
      }
    }
    savePolySwarmConfig(this.config.configPath, nextConfig);
    this.config.backends = nextConfig.backends;
    this.config.globalUiRaw = nextConfig.globalUiRaw;
    this.backendModelsCache = null;
    await this.refreshBackends();
    return this.getBackendConfigs();
  }

  private resolveStaffModel(backend: RealBackendId): string {
    const cfg = this.config.backends[backend]?.defaultModel?.trim();
    if (cfg) return cfg;
    return getStaticFallbackModels(backend, this.config.backends[backend])[0]?.id ?? backend;
  }

  private buildDefaultStaffRoster(now = Date.now()): StaffRosterMember[] {
    const mainAgyCompany = this.db.listAgyCompanies().find((company) =>
      company.enabled && /^(主账号|主号)/i.test(company.name));
    const seeds: Array<[
      id: string, name: string, title: string, avatar: StaffAvatarId, backend: RealBackendId,
      model: string, effort: string | null, role: WorkerRole, capability: CapabilityTag, identity_id: string,
    ]> = [
      ["agy-orch-neon", "Orion", "首席系统架构师", "aria", "agy", "gemini-pro-orchestrator-neon", null, "researcher", "architect", "architect"],
      ["agy-orch-carbon", "Caelum", "技术规划总监", "theo", "agy", "gemini-pro-orchestrator", null, "researcher", "architect", "tech-lead"],
      ["agy-neon", "Aria", "首席安全与代码审校官", "aria", "agy", "gemini-4-neon-high", null, "verifier", "verifier", "sec-auditor"],
      ["agy-carbon", "Clara", "全栈与交互架构开发", "jules", "agy", "gemini-4-carbon-high", null, "author", "author", "frontend-author"],
      ["codex-62-astra", "Astra", "核心系统攻关主程", "leo", "codex", "gpt-6.2-astra", "high", "author", "author", "backend-author"],
      ["codex-62-sol", "Leo", "全栈主力开发工程师", "leo", "codex", "gpt-6.2-sol", "high", "author", "author", "author"],
      ["codex-61-terra", "Terra", "跨厂商代码审校专家", "theo", "codex", "gpt-6.1-terra", "high", "verifier", "verifier", "verifier"],
      ["codex-6-luna", "Luna", "测试开发与重构工程师", "mia", "codex", "gpt-6-luna", "medium", "author", "author", "test-engineer"],
      ["grok-47-high", "Theo", "深度调研与反例挑战官", "theo", "grok", "grok-4.7", "high", "researcher", "research", "researcher"],
      ["cursor-auto", "Jules", "多文件协作与前端专家", "jules", "cursor", "auto", null, "author", "author", "frontend-author"],
      ["trae-auto", "Tara", "智能工程与构建专员", "mia", "trae", "auto", null, "author", "enterprise", "devops-sre"],
      ["codebuddy-ds41", "Mia", "企业规范与研发协同专员", "mia", "codebuddy", "deepseek-v4.1-flash", "high", "worker", "enterprise", "enterprise-worker"],
      ["opencode-ds41-free", "Echo", "零成本高速扇出专员", "jules", "opencode", "opencode/deepseek-v4.1-flash-free", null, "worker", "fanout", "worker"],
    ];
    return seeds.map(([id, name, title, avatar, backend, model, effort, role, capability, identity_id]) => ({
      id, name, title, avatar, backend, model, effort, role, capability, identity_id,
      company_id: backend === "agy" ? mainAgyCompany?.id ?? null : null,
      enabled: true,
      builtin: true,
      created_at: now,
      updated_at: now,
    }));
  }

  listAgyAccounts() {
    return this.agyAccounts.list();
  }

  handleAgyCompanies(request: z.infer<typeof AGY_COMPANY_REQUEST>) {
    if (request.op === "list") return { agy_companies: this.getAgyCompanies(), agy_accounts: this.listAgyAccounts() };
    if (request.op === "add" && request.account_ids) return { agy_companies: this.addAgyCompanies(request.account_ids) };
    if (request.op === "update" && request.id && request.config) {
      return { agy_companies: this.updateAgyCompany(request.id, request.config) };
    }
    throw new Error("Missing AGY company arguments.");
  }

  private migrateAgyCompanies(): void {
    const ids = new Set(this.db.listHistoricalAgyAccountIds());
    const prior = this.db.getAppKv<unknown[]>(STAFF_ROSTER_KV_KEY);
    if (Array.isArray(prior)) {
      for (const item of prior) {
        if (!item || typeof item !== "object") continue;
        const old = item as Record<string, unknown>;
        if (old.backend === "agy" && typeof old.agy_account_id === "string") ids.add(old.agy_account_id);
      }
    }
    this.addMissingAgyCompanies([...ids].filter((id) => AGY_ACCOUNT_ID_RE.test(id)));
  }

  private addMissingAgyCompanies(accountIds: string[]): void {
    if (!accountIds.length) return;
    this.db.talentTransaction(() => {
      const ids = new Set(this.db.listAgyCompanies().map((c) => c.id));
      for (const accountId of accountIds) {
        const id = companyIdFor(accountId);
        if (ids.has(id)) continue;
        this.db.addAgyCompany(id, `Antigravity · ${String(ids.size + 1).padStart(2, "0")}`);
        ids.add(id);
      }
    });
  }

  addAgyCompanies(accountIds: string[]): AgyCompanyView[] {
    for (const id of accountIds) this.agyAccounts.assertAvailable(id);
    this.addMissingAgyCompanies(accountIds);
    return this.getAgyCompanies();
  }

  getAgyCompanies(): AgyCompanyView[] {
    const companies = this.db.listAgyCompanies();
    if (!companies.length) return [];
    const accounts = new Map(this.agyAccounts.list().map((item) => [item.id, item.email]));
    return companies.map((company) => {
      const email = accounts.get(company.id.slice(4));
      return {
        ...company,
        account_available: Boolean(email),
        ...(email ? { account_hint: `${email.slice(0, 2)}•••@${email.split("@").at(-1)}` } : {}),
      };
    });
  }

  updateAgyCompany(id: string, config: Pick<AgyCompany, "name" | "enabled" | "default_model" | "default_effort">): AgyCompanyView[] {
    const company = this.db.listAgyCompanies().find((c) => c.id === id);
    if (!company) throw new Error("The selected AGY company does not exist.");
    const name = config.name.trim();
    if (!name) throw new Error("Company name is required.");
    this.db.updateAgyCompany({
      ...company, name, enabled: config.enabled,
      default_model: config.default_model?.trim() || null,
      default_effort: config.default_effort?.trim() || null,
    });
    return this.getAgyCompanies();
  }

  private requireAgyCompany(id: string): AgyCompany {
    const company = this.db.listAgyCompanies().find((c) => c.id === id);
    if (!company) throw new Error("The selected AGY company does not exist.");
    if (!company.enabled) throw new Error("The selected AGY company is disabled.");
    if ((company.cooldown_until ?? 0) > Date.now()) throw new Error("The selected AGY company is cooling down after reaching its quota.");
    return company;
  }

  private resolveStaffForDispatch(staffId: string | undefined, name: string, backend?: BackendId): StaffRosterMember | undefined {
    const roster = this.getStaffRoster();
    if (staffId) {
      const member = roster.find((entry) => entry.id === staffId);
      if (!member?.enabled) throw new Error("The selected employee does not exist or is disabled.");
      if (backend && backend !== member.backend) throw new Error("The selected employee uses a different backend.");
      return member;
    }
    if (backend && backend !== "agy") return;
    const matches = roster.filter((entry) =>
      entry.name.trim().toLowerCase().replace(/^@/, "") === name);
    if (!matches.some((entry) => entry.company_id)) return;
    if (matches.length > 1) throw new Error("Multiple employees have this name; specify staff_id.");
    if (!matches[0]?.enabled) throw new Error("The selected employee is disabled.");
    return matches[0];
  }

  getStaffRoster(): StaffRosterMember[] {
    const raw = this.db.getAppKv<unknown[]>(STAFF_ROSTER_KV_KEY);
    if (!Array.isArray(raw)) {
      return this.buildDefaultStaffRoster();
    }
    const validRoles = new Set<WorkerRole>(["author", "verifier", "researcher", "worker"]);
    const validCaps = new Set<CapabilityTag>(["architect", "author", "verifier", "research", "enterprise", "fanout"]);
    const out: StaffRosterMember[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id.trim() : "";
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const backend = typeof r.backend === "string" && REAL_BACKEND_IDS.includes(r.backend as RealBackendId)
        ? (r.backend as RealBackendId)
        : "codex";
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      const avatar = typeof r.avatar === "string" && STAFF_AVATAR_IDS.has(r.avatar as StaffAvatarId)
        ? (r.avatar as StaffAvatarId)
        : "leo";
      const role = typeof r.role === "string" && validRoles.has(r.role as WorkerRole)
        ? (r.role as WorkerRole)
        : "author";
      const capability = typeof r.capability === "string" && validCaps.has(r.capability as CapabilityTag)
        ? (r.capability as CapabilityTag)
        : roleToDefaultCapability(role);
      const companyId = backend !== "agy" ? null
        : typeof r.company_id === "string" && AGY_COMPANY_ID_RE.test(r.company_id) ? r.company_id
        : typeof r.agy_account_id === "string" && AGY_ACCOUNT_ID_RE.test(r.agy_account_id) ? companyIdFor(r.agy_account_id) : null;
      out.push({
        id,
        name,
        title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : name,
        avatar,
        backend,
        model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : companyId ? "" : this.resolveStaffModel(backend),
        effort: typeof r.effort === "string" && r.effort.trim() ? r.effort.trim() : null,
        role,
        capability,
        identity_id: typeof r.identity_id === "string" && r.identity_id.trim() ? r.identity_id.trim() : null,
        company_id: companyId,
        bio: typeof r.bio === "string" && r.bio.trim() ? r.bio.trim() : null,
        enabled: typeof r.enabled === "boolean" ? r.enabled : true,
        builtin: r.builtin === true,
        created_at: typeof r.created_at === "number" ? r.created_at : now,
        updated_at: typeof r.updated_at === "number" ? r.updated_at : now,
      });
    }
    return out;
  }

  upsertStaffMember(input: {
    id?: string;
    name: string;
    title?: string;
    avatar?: StaffAvatarId;
    backend: RealBackendId;
    model?: string;
    effort?: string | null;
    role: WorkerRole;
    capability?: CapabilityTag;
    identity_id?: string | null;
    company_id?: string | null;
    bio?: string | null;
    enabled?: boolean;
  }): StaffRosterMember[] {
    if (!REAL_BACKEND_IDS.includes(input.backend)) {
      throw new Error(`Unsupported backend '${input.backend}'.`);
    }
    const cleanName = input.name.trim();
    if (!cleanName) {
      throw new Error("Employee name is required.");
    }
    return this.db.talentTransaction(() => {
      const roster = this.getStaffRoster();
      const now = Date.now();
      const rawId = input.id?.trim() || "";
      const slugBase = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "staff";
      const id = rawId || `${slugBase}-${crypto.randomUUID().slice(0, 6)}`;
      const idx = roster.findIndex((m) => m.id === id);
      const prev = idx >= 0 ? roster[idx]! : null;
      const companyId = input.backend === "agy"
        ? (input.company_id === undefined ? prev?.company_id ?? null : input.company_id)
        : null;
      if (companyId && !this.db.listAgyCompanies().some((company) => company.id === companyId)) {
        throw new Error("The selected AGY company does not exist.");
      }
      const avatar: StaffAvatarId = input.avatar && STAFF_AVATAR_IDS.has(input.avatar)
        ? input.avatar
        : prev?.avatar ?? "leo";
      const nextMember: StaffRosterMember = {
        id,
        name: cleanName.slice(0, 48),
        title: (input.title?.trim() || prev?.title || cleanName).slice(0, 64),
        avatar,
        backend: input.backend,
        model: input.model?.trim() || (companyId ? "" : this.resolveStaffModel(input.backend)),
        effort: input.effort !== undefined ? (input.effort?.trim() || null) : (prev?.effort ?? null),
        role: input.role,
        capability: input.capability ?? roleToDefaultCapability(input.role),
        identity_id: input.identity_id !== undefined ? (input.identity_id?.trim() || null) : (prev?.identity_id ?? null),
        company_id: companyId,
        bio: input.bio !== undefined ? (input.bio?.trim().slice(0, 180) || null) : (prev?.bio ?? null),
        enabled: input.enabled ?? prev?.enabled ?? true,
        builtin: prev?.builtin ?? false,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      const next = idx >= 0
        ? roster.map((m, i) => (i === idx ? nextMember : m))
        : [...roster, nextMember];
      this.db.setAppKv(STAFF_ROSTER_KV_KEY, next);
      return next;
    });
  }

  deleteStaffMember(id: string): StaffRosterMember[] {
    const cleanId = id.trim();
    if (!cleanId) {
      throw new Error("Employee id is required.");
    }
    return this.db.talentTransaction(() => {
      const roster = this.getStaffRoster();
      const next = roster.filter((m) => m.id !== cleanId);
      if (next.length === roster.length) {
        throw new Error(`Employee '${cleanId}' not found in roster.`);
      }
      this.db.setAppKv(STAFF_ROSTER_KV_KEY, next);
      return next;
    });
  }

  resetStaffRoster(): StaffRosterMember[] {
    const defaults = this.buildDefaultStaffRoster();
    this.db.setAppKv(STAFF_ROSTER_KV_KEY, defaults);
    return defaults;
  }

  async listAgyCompanyModels(id: string, refresh = false): Promise<BackendModelOption[]> {
    if (!this.db.listAgyCompanies().some((company) => company.id === id)) {
      throw new Error("这家 Antigravity 外包公司不存在。");
    }
    const accountId = id.slice(4);
    this.agyAccounts.assertAvailable(accountId);
    const running = this.agyCompanyModelRequests.get(id);
    if (running) return running;
    const cached = this.agyCompanyModelCache.get(id);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.models;
    const request = (async () => {
      const adapter = this.registry.get("agy");
      if (!adapter.listAvailableModels) throw new Error("当前 Antigravity CLI 不支持读取模型目录。");
      const profile = this.agyAccounts.prepare(accountId);
      const models = await adapter.listAvailableModels(this.config.backends.agy, profile);
      this.agyCompanyModelCache.set(id, { expiresAt: Date.now() + 5 * 60_000, models });
      return models;
    })();
    this.agyCompanyModelRequests.set(id, request);
    try {
      return await request;
    } catch (err) {
      this.agyCompanyModelCache.delete(id);
      throw err;
    } finally {
      this.agyCompanyModelRequests.delete(id);
    }
  }

  async listAllBackendModels(
    forceRefresh = false,
  ): Promise<Partial<Record<RealBackendId, BackendModelOption[]>>> {
    if (!forceRefresh && this.backendModelsCache && this.backendModelsCache.expiresAt > Date.now()) {
      return this.backendModelsCache.data;
    }

    const entries = await Promise.all(
      REAL_BACKEND_IDS.map(async (id) => {
        const adapter = this.registry.get(id);
        const override = this.config.backends[id];
        const fallback = id === "codex" ? [] : getStaticFallbackModels(id, override);
        try {
          const rawList = adapter.listAvailableModels
            ? await adapter.listAvailableModels(override)
            : fallback;
          const configured = override?.defaultModel?.trim();
          const seen = new Set<string>();
          const merged: BackendModelOption[] = [];
          const pushOpt = (opt: BackendModelOption) => {
            const optId = opt.id.trim();
            if (!optId || seen.has(optId)) return;
            seen.add(optId);
            merged.push(opt);
          };
          if (configured && (id !== "codex" || rawList.some((model) => model.id === configured))) {
            const match = rawList.find((m) => m.id === configured) ?? fallback.find((m) => m.id === configured);
            pushOpt({
              id: configured,
              label:
                match?.label && !match.label.includes("(当前配置)")
                  ? `${match.label} (当前配置)`
                  : match?.label ?? `${configured} (当前配置)`,
              source: "configured",
              detected_at: match?.source === "detected" ? (match.detected_at ?? null) : null,
            });
          }
          for (const item of rawList) {
            if (item.source === "configured" && configured && item.id === configured) continue;
            pushOpt(
              item.source
                ? item
                : { ...item, source: "detected", detected_at: item.detected_at ?? Date.now() },
            );
          }
          for (const item of id === "agy" && rawList.some((model) => model.source === "detected") ? [] : fallback) {
            pushOpt(item);
          }
          return [id, merged] as const;
        } catch {
          return [id, fallback] as const;
        }
      }),
    );

    const data: Partial<Record<RealBackendId, BackendModelOption[]>> = {};
    for (const [id, list] of entries) {
      data[id] = list;
    }
    this.backendModelsCache = {
      expiresAt: Date.now() + 5 * 60 * 1000,
      data,
    };
    return data;
  }

  // --- Read Models for UI & Coordinator ---

  private buildWorkerSummary(
    swarmId: string,
    w: WorkerRecord,
    usageByWorkerMap?: Map<string, UsageAggregate>,
  ): WorkerSummary {
    const u =
      (usageByWorkerMap
        ? usageByWorkerMap.get(w.name)
        : this.db.aggregateUsage(swarmId, "worker").find((x) => x.key === w.name)) ?? {
        key: w.name,
        turns: 0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        known_cost_usd: 0,
        priced_turns: 0,
        unpriced_turns: 0,
        duration_ms: 0,
        tool_calls_count: 0,
        exact_turns: 0,
        hook_turns: 0,
        estimated_turns: 0,
      };
    return {
      ...w,
      channels: parseChannelsJson(w.channels_json),
      latest_turn: this.db.getLatestWorkerTurn(swarmId, w.name),
      latest_event: this.db.getLatestWorkerEvent(swarmId, w.name),
      usage: u,
    };
  }

  async getDashboardSnapshot(
    swarmId?: string | null,
    opts?: DashboardOptions,
  ): Promise<DashboardSnapshot> {
    return this.buildDashboardSnapshot(swarmId, opts, true);
  }

  private getSecondmentHistory(swarmId: string): WorkerSwitchRecord[] {
    return this.db.listWorkerSwitchEdges(swarmId).flatMap((edge) => {
      let meta: Record<string, unknown> | null = null;
      try {
        meta = edge.meta_json ? JSON.parse(edge.meta_json) : null;
      } catch {
        return [];
      }
      const validBackend = (id: unknown): id is BackendId => id === "mock" ||
        REAL_BACKEND_IDS.includes(id as RealBackendId);
      if (!meta || !validBackend(meta.from_backend) || !validBackend(meta.to_backend)) return [];
      return [{
        swarm_id: swarmId, worker_name: edge.to_node,
        from_backend: meta.from_backend, to_backend: meta.to_backend,
        from_model: typeof meta.from_model === "string" ? meta.from_model : null,
        to_model: typeof meta.to_model === "string" ? meta.to_model : null,
        auto: meta.auto === true, reason: typeof meta.reason === "string" ? meta.reason : null,
        seq: edge.seq, created_at: edge.created_at,
      }];
    });
  }

  private async getDeliverables(swarm: SwarmRecord, workers: WorkerRecord[]): Promise<Record<string, WorkerDeliverableSummary>> {
    const reviews = new Map(this.db.listLatestDeliverableReviews(swarm.id).map(({ review_of, ...message }) => [review_of, message]));
    return Object.fromEntries(await Promise.all(workers.filter((worker) => worker.workspace_mode !== "inherit").map(async (worker) => {
      const status = await this.workspace.getWorkspaceStatus(worker.workspace_path).catch((err) => {
        console.error(`[poly-swarm] Cannot inspect worktree for @${worker.name}:`, err);
        return null;
      });
      const latest_review = reviews.get(worker.name) ?? null;
      const reviewed_sha = latest_review ? reviewedCommit(latest_review.text) : null;
      const head_sha = status?.head_sha ?? null;
      const turn = latest_review?.turn_id ? this.db.getTurn(latest_review.turn_id) : null;
      const independent = Boolean(turn && turn.swarm_id === swarm.id && turn.worker_name === latest_review?.sender &&
        turn.status === "completed" && turn.mode === "readonly" && turn.backend !== "mock" &&
        isIndependentBackend(turn.backend, turn.model, worker));
      let sha_matches = false;
      if (head_sha && reviewed_sha && status?.branch === worker.worktree_branch) {
        const head = reviewed_sha.length <= head_sha.length ? head_sha :
          await runGit(worker.workspace_path, ["rev-parse", "--verify", `${head_sha}^{commit}`])
            .then(({ stdout }) => stdout.trim(), () => "");
        sha_matches = head.toLowerCase().startsWith(reviewed_sha);
      }
      return [worker.name, {
        worker_name: worker.name, branch: status?.branch ?? worker.worktree_branch, target_branch: swarm.base_branch,
        head_sha, dirty: status?.dirty ?? false, dirty_files: status?.dirty_files ?? [], latest_review, reviewed_sha,
        needs_independent_reviewer: !independent, sha_matches,
        stale: latest_review !== null && (!sha_matches || status?.dirty === true),
      } satisfies WorkerDeliverableSummary];
    })));
  }

  private async buildDashboardSnapshot(
    swarmId: string | null | undefined,
    opts: DashboardOptions | undefined,
    includeEvidence: boolean,
  ): Promise<DashboardSnapshot> {
    await this.ensureHealthChecked();
    const { swarm, team, matchReason, activeConversationId } = this.resolveSessionTarget({
      ...opts, swarmId, autoSelect: opts?.autoSelectLatest ?? false,
    });
    const swarms = this.db.listSwarms(30);
    let conversationArchives = includeEvidence
      ? this.db.listConversationArchives(activeConversationId)
      : undefined;
    if (includeEvidence && opts?.surface === "global" && conversationArchives && conversationArchives.sessions.length > 0) {
      await this.syncMissingConversationTitles(conversationArchives.sessions.map((s) => s.conversation_id)).catch(() => {});
      conversationArchives = this.db.listConversationArchives(activeConversationId);
    }
    const session = {
      team,
      teams: includeEvidence ? this.db.listTeamSummaries(30, activeConversationId) : [],
      ...(conversationArchives ? { conversation_archives: conversationArchives } : {}),
      team_waves: team ? this.db.listTeamSwarms(team.id) : [],
      match_reason: matchReason,
      active_conversation_id: activeConversationId,
      ui_preferences: this.getUiPreferences(),
      data_dir: this.dataDir,
      plugin_version: this.version,
    };
    const focusScopeId = swarm?.id ?? null;
    if (opts?.surface === "workbench") {
      this.recordWorkbenchHeartbeat(focusScopeId);
      if (focusScopeId && ["explicit_swarm", "explicit_team", "conversation_binding"].includes(matchReason)) {
        this.persistLastWorkbenchSwarm(focusScopeId);
      }
    }

    const effectiveDefaults = this.getEffectiveDefaults();
    const backends = this.db.listBackendHealth().map((backend) => ({
      ...backend, vendor_family: inferVendorFamily(backend.backend, effectiveDefaults[backend.backend]?.model),
    }));
    const backendConfigs = this.getBackendConfigs();
    const staffRoster = this.getStaffRoster();
    const uiFocus = this.getUiFocus(focusScopeId);
    const dispatchPolicy = this.resolvePolicy({
      swarmId: swarm?.id ?? null,
      repoRoot: swarm?.repo_root ?? null,
    });
    const evidence = includeEvidence ? {
      global_usage_by_backend: this.db.aggregateGlobalUsageByBackend(),
      global_usage_by_vendor: this.db.listGlobalUsageByVendor(),
      ...(opts?.surface === "global" ? {
        agy_companies: this.getAgyCompanies(), agy_company_usage: this.db.aggregateAgyCompanyUsage(),
        staff_performance: this.db.listStaffPerformance(),
      } : {}),
      swarm_summaries: this.db.listSwarmBriefSummaries([...swarms.map((s) => s.id), ...(swarm ? [swarm.id] : [])]),
      secondment_history: swarm ? this.getSecondmentHistory(swarm.id) : [],
      blackboard_messages: swarm ? this.db.listBlackboardMessages(swarm.id) : [],
      deliverables: swarm ? await this.getDeliverables(swarm, this.db.listWorkers(swarm.id)) : {},
      read_only_reason: swarm ? readOnlyReason(swarm) : null,
    } : {};

    if (!swarm) {
      return {
        ...session,
        ...evidence,
        surface: opts?.surface ?? "workbench",
        swarm: null,
        swarms,
        plan: null,
        channels: [],
        workers: [],
        board_tail: [],
        backends,
        workflows: this.db.listWorkflows(null, 20),
        usage_totals: {
          key: "total",
          turns: 0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          known_cost_usd: 0,
          priced_turns: 0,
          unpriced_turns: 0,
          duration_ms: 0,
          tool_calls_count: 0,
          exact_turns: 0,
          hook_turns: 0,
          estimated_turns: 0,
        },
        usage_by_backend: [],
        usage_by_worker: [],
        ui_focus: uiFocus,
        ui_build_id: getBuildId(),
        effective_defaults: effectiveDefaults,
        backend_configs: backendConfigs,
        staff_roster: staffRoster,
        dispatch_policy: dispatchPolicy,
        dispatch_graph: null,
        config_path: this.config.configPath,
        generated_at: Date.now(),
      };
    }

    let plan: SwarmPlan | null = null;
    if (swarm.plan_json) {
      try {
        plan = JSON.parse(swarm.plan_json) as SwarmPlan;
      } catch {
        plan = null;
      }
    }

    const rawWorkers = this.db.listWorkers(swarm.id);
    const usageByWorker = this.db.aggregateUsage(swarm.id, "worker");
    const usageByWorkerMap = new Map(usageByWorker.map((u) => [u.key, u]));
    const workers = rawWorkers.map((w) => this.buildWorkerSummary(swarm.id, w, usageByWorkerMap));
    const boardTail = this.db.readBoardTail(swarm.id, 160);
    const allBoardForGraph = this.db.readBoardMessages({
      swarm_id: swarm.id,
      since: 0,
      limit: 2000,
    });
    const persistedEdges = this.db.listDispatchEdges(swarm.id, 1000);
    const workflows = this.db.listWorkflows(swarm.id, 20);
    const swarmUsageRows = includeEvidence ? this.db.listSwarmUsageWithTurns(swarm.id, 200) : [];
    const sessionUsageExtras = includeEvidence
      ? (() => {
          const normalizedRows = swarmUsageRows.map((row) => ({
            ...row,
            model: row.resolved_model?.trim() || row.model?.trim() || null,
          }));
          const rowsByWorker = new Map<string, typeof normalizedRows>();
          for (const row of normalizedRows) {
            let bucket = rowsByWorker.get(row.worker_name);
            if (!bucket) {
              bucket = [];
              rowsByWorker.set(row.worker_name, bucket);
            }
            bucket.push(row);
          }
          const byWorker: Record<string, ReturnType<typeof aggregateNormalizedUsage>> = {};
          for (const [workerName, rows] of rowsByWorker.entries()) {
            byWorker[workerName] = aggregateNormalizedUsage(rows);
          }
          return {
            session_usage_breakdown: aggregateNormalizedUsage(normalizedRows),
            session_usage_by_worker: byWorker,
            session_turn_usages: swarmUsageRows.slice(0, 80).map(buildSessionTurnUsageItem),
          };
        })()
      : {};
    const dispatchGraph = buildDispatchGraph({
      swarm,
      workers: rawWorkers,
      boardMessages: allBoardForGraph,
      persistedEdges,
      workflows,
      policy: dispatchPolicy,
      usageByWorker,
    });

    return {
      ...session,
      ...evidence,
      ...sessionUsageExtras,
      surface: opts?.surface ?? "workbench",
      swarm,
      swarms,
      plan,
      channels: this.db.listChannels(swarm.id),
      workers,
      board_tail: boardTail,
      backends,
      workflows,
      usage_totals: this.db.aggregateUsage(swarm.id, "all")[0]!,
      usage_by_backend: this.db.aggregateUsage(swarm.id, "backend"),
      usage_by_worker: usageByWorker,
      ui_focus: uiFocus,
      ui_build_id: getBuildId(),
      effective_defaults: effectiveDefaults,
      backend_configs: backendConfigs,
      staff_roster: staffRoster,
      dispatch_policy: dispatchPolicy,
      dispatch_graph: dispatchGraph,
      config_path: this.config.configPath,
      generated_at: Date.now(),
    };
  }

  async getModelSnapshot(
    swarmId?: string | null,
    opts?: DashboardOptions,
  ): Promise<DashboardSnapshot> {
    const full = await this.buildDashboardSnapshot(swarmId, opts, false);
    const projectWave = (wave: SwarmRecord) => ({ ...wave, plan_json: null, policy_json: null });
    return {
      ...full,
      projected: true,
      swarm: full.swarm ? projectWave(full.swarm) : null,
      team: full.team ? { ...full.team, policy_json: null } : null,
      team_waves: full.team_waves?.slice(0, 12).map(projectWave),
      teams: full.swarm ? [] : this.db.listTeamSummaries(12, full.active_conversation_id).map((summary) => ({
        ...summary,
        team: { ...summary.team, policy_json: null },
        waves: [],
        latest_blackboard: [],
      })),
      swarms: full.swarm
        ? []
        : full.swarms.slice(0, 12).map((s) => ({ ...s, plan_json: null, policy_json: null })),
      plan: null,
      channels: [],
      workers: full.workers.map((w) => ({
        ...w,
        resolved_policy_json: null,
        latest_turn: w.latest_turn
          ? {
              ...w.latest_turn,
              prompt_preview: "",
              output_text: null,
              structured_json: null,
            }
          : null,
        latest_event: w.latest_event
          ? {
              ...w.latest_event,
              content: truncateUtf8Bytes(w.latest_event.content, 160, "..."),
              meta_json: null,
            }
          : null,
      })),
      board_tail: [],
      workflows: [],
      usage_by_backend: [],
      usage_by_worker: [],
      backend_configs: {},
      dispatch_policy: null,
      dispatch_graph: null,
      config_path: undefined,
    };
  }

  async getWorkerDetail(swarmId: string, name: string): Promise<WorkerDetailPayload> {
    const swarm = this.db.getSwarm(swarmId);
    if (!swarm) throw new Error(`Swarm '${swarmId}' not found.`);
    const w = this.db.getWorker(swarmId, name);
    if (!w) throw new Error(`Worker '${name}' not found.`);

    const summary = this.buildWorkerSummary(swarmId, w);
    const turns = this.db.listWorkerTurns(swarmId, name, 30);
    const latestEvents = turns[0] ? this.db.listTurnEvents(turns[0].id, 0, 500) : [];

    const eventsByTurn: Record<string, WorkerEvent[]> = {};
    for (const [idx, t] of turns.slice(0, 10).entries()) {
      eventsByTurn[t.id] = idx === 0 ? latestEvents : this.db.listTurnEvents(t.id, 0, 500);
    }

    const triggerSeqs = [
      ...new Set(
        turns
          .map((t) => t.trigger_seq)
          .filter((seq): seq is number => typeof seq === "number" && seq > 0),
      ),
    ];
    const triggerMessages: Record<number, BoardMessage> = {};
    for (const msg of this.db.getMessagesBySeqs(swarmId, triggerSeqs)) {
      triggerMessages[msg.seq] = msg;
    }

    const diff =
      w.workspace_mode === "inherit"
        ? null
        : await this.workspace.collectDiff(w.workspace_path, swarm.base_branch);

    return {
      worker: summary,
      turns,
      latest_turn_events: latestEvents,
      events_by_turn: eventsByTurn,
      trigger_messages: triggerMessages,
      diff,
    };
  }

  getTurnEvents(turnId: string, afterEventId = 0): { turn: TurnRecord | null; events: WorkerEvent[] } {
    return {
      turn: this.db.getTurn(turnId),
      events: this.db.listTurnEvents(turnId, afterEventId, 500),
    };
  }

  shutdown(): void {
    this.isShutdown = true;
    if (this.instanceHeartbeatTimer) {
      clearInterval(this.instanceHeartbeatTimer);
      this.instanceHeartbeatTimer = null;
    }
    try {
      this.db.unregisterInstance(this.instanceId);
    } catch {
      // ignore if DB already closed
    }
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.activeTurnPromises.clear();
    while (this.globalWaitQueue.length > 0) {
      this.globalWaitQueue.shift()?.();
    }
  }
}
