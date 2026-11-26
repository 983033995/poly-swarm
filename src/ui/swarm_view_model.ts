/** Extract only host-supplied session hints; a matched team's repo is not a window hint. */
export function readSessionHints(input: unknown): { conversationId?: string; repoRoot?: string } {
  if (!input || typeof input !== "object") return {};
  const context = input as Record<string, unknown>;
  const first = (keys: string[]) => {
    for (const key of keys) {
      const direct = context[key];
      if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
    }
    for (const [k, val] of Object.entries(context)) {
      if (keys.some((key) => k.endsWith(`/${key}`)) && typeof val === "string" && val.trim().length > 0) {
        return val.trim();
      }
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const nestedObj = val as Record<string, unknown>;
        for (const key of keys) {
          const nested = nestedObj[key];
          if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
        }
      }
    }
    return undefined;
  };
  const conversationId = first(["conversation_id", "conversationId", "chatId", "threadId"]);
  let repoRoot = first(["repo_root", "repoRoot", "workspacePath", "workspace_path"]);
  if (repoRoot?.startsWith("file:")) {
    try {
      const url = new URL(repoRoot);
      repoRoot = url.hostname && url.hostname !== "localhost" ? undefined : decodeURIComponent(url.pathname);
    } catch {
      repoRoot = undefined;
    }
  }
  if (!repoRoot?.startsWith("/") && !/^[a-z]:[\\/]/i.test(repoRoot ?? "")) repoRoot = undefined;
  return { ...(conversationId ? { conversationId } : {}), ...(repoRoot ? { repoRoot } : {}) };
}

export function dashboardTarget(input: {
  surface: "global" | "workbench";
  swarmId: string | null;
  teamId: string | null;
  conversationId: string | null;
  repoRoot: string | null;
  historySwarmId?: string | null;
}): { args: Record<string, string | boolean>; query: string } {
  const history = Boolean(input.historySwarmId);
  const workbench = input.surface === "workbench" && !history;
  const args = {
    surface: workbench ? "workbench" : "global",
    auto_select: workbench && !input.swarmId && !input.teamId && !input.conversationId,
    ...(history ? { swarm_id: input.historySwarmId! } : workbench ? {
      ...(input.swarmId ? { swarm_id: input.swarmId } : {}),
      ...(input.teamId ? { team_id: input.teamId } : {}),
    } : {}),
    ...(!history && input.conversationId ? { conversation_id: input.conversationId } : {}),
    ...(!history && input.repoRoot ? { repo_root: input.repoRoot } : {}),
  };
  return { args, query: new URLSearchParams(Object.entries(args).map(([key, value]) =>
    [key, typeof value === "boolean" ? (value ? "1" : "0") : value])).toString() };
}

import type {
  BackendConfigEntry,
  BoardMessage,
  ConversationArchiveSummary,
  DashboardSnapshot,
  GraphEdgeKind,
  PolicyLayer,
  RealBackendId,
  SwarmPlan,
  WorkerSummary,
  WorkbenchTab,
} from "../shared/types.js";
import { summarizeToolStep } from "./trace_model.js";

export type PrimaryTab = "detail" | "graph" | "board" | "usage";
export type GlobalPrimaryTab = "hr" | "history" | "settings";
export type UiSurface = "workbench" | "global";
export type WorkbenchStatusFilter = "all" | "running" | "acceptance" | "risk" | "idle";

export interface DerivedSwarmPlan {
  goal: {
    title: string;
    line: string;
  };
  tasks: Record<string, string>;
  threads: Array<{
    id: string;
    title: string;
    goal: string;
    tasks: string[];
  }>;
  isSynthetic: boolean;
}

export interface BackendDraftState {
  enabled: boolean;
  defaultModel: string;
  defaultEffort: string;
  customMode: boolean;
}

export interface BackendConfigPatch {
  backend: RealBackendId;
  enabled?: boolean;
  defaultModel?: string | null;
  defaultEffort?: string | null;
}

/**
 * Maps backend/legacy tabs onto the active surface. The session has four tabs;
 * global settings live only in the global entry and never leak into a session.
 */
export function normalizeTab(
  tab?: WorkbenchTab | GlobalPrimaryTab | null,
  surface?: "workbench",
): PrimaryTab;
export function normalizeTab(
  tab: WorkbenchTab | GlobalPrimaryTab | null | undefined,
  surface: "global",
): GlobalPrimaryTab;
export function normalizeTab(
  tab?: WorkbenchTab | GlobalPrimaryTab | null,
  surface: UiSurface = "workbench",
): PrimaryTab | GlobalPrimaryTab {
  if (surface === "global") {
    if (tab === "settings") return "settings";
    if (tab === "history") return "history";
    return "hr";
  }
  if (tab === "graph" || tab === "board" || tab === "usage") return tab;
  // Overview and members both open the workbench; applyTab handles legacy settings.
  return "detail";
}

export function normalizeGlobalTab(
  tab?: WorkbenchTab | GlobalPrimaryTab | null,
): GlobalPrimaryTab {
  return normalizeTab(tab, "global");
}

export function policyLayerLabel(layer?: PolicyLayer | null): string {
  switch (layer) {
    case "global_ui":
      return "主配置 (200)";
    case "project":
      return "项目级 (300)";
    case "session":
      return "会话级 (400)";
    case "worker_explicit":
      return "显式指定 (500)";
    default:
      return "内置默认 (100)";
  }
}

export function policyLayerShortLabel(layer?: PolicyLayer | null): string {
  switch (layer) {
    case "global_ui":
      return "主配置";
    case "project":
      return "项目";
    case "session":
      return "会话";
    case "worker_explicit":
      return "显式";
    default:
      return "内置";
  }
}

export function policyLayerBadgeClass(layer?: PolicyLayer | null): string {
  switch (layer) {
    case "global_ui":
      return "layer-pill-global";
    case "project":
      return "layer-pill-project";
    case "session":
      return "layer-pill-session";
    case "worker_explicit":
      return "layer-pill-explicit";
    default:
      return "layer-pill-builtin";
  }
}

export function graphEdgeKindLabel(kind: GraphEdgeKind): string {
  switch (kind) {
    case "dispatch":
      return "派发";
    case "mention":
      return "提及";
    case "handoff":
      return "交接";
    case "review":
      return "审校";
    case "review_pass":
      return "审校通过";
    case "review_fail":
      return "审校打回";
    case "fallback":
      return "容灾切换";
    case "merge":
      return "合并";
    case "reports_to":
      return "汇报";
    case "depends_on":
      return "依赖";
  }
}

/**
 * Extracts unique lowercase @mention targets from a board message.
 */
export function parseMentions(msg: BoardMessage): string[] {
  const result = new Set<string>();
  try {
    const parsed = JSON.parse(msg.mentions_json) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string") {
          const clean = item.trim().toLowerCase();
          if (clean) result.add(clean);
        }
      }
      if (result.size > 0) return [...result];
    }
  } catch {
    // fallback to scanning text
  }

  const regex = /(?:^|[^a-zA-Z0-9._-])@([a-z0-9][a-z0-9_-]{0,31})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(msg.text)) !== null) {
    if (m[1]) result.add(m[1].toLowerCase());
  }
  return [...result];
}

/**
 * Returns whether a worker has finished its assigned task based on live state and board posts.
 */
function latestTaskSignal(w: WorkerSummary, board: BoardMessage[]): BoardMessage | undefined {
  return [...board].reverse().find((m) =>
    (m.sender === w.name && ["done", "review_pass", "review_fail", "blocked", "stall"].includes(m.tag)) ||
    (m.sender === "coordinator" && m.text.startsWith(`[merged] @${w.name} `)) ||
    (m.tag === "brief" && parseMentions(m).includes(w.name))
  );
}

export function isWorkerTaskDone(w: WorkerSummary, board: BoardMessage[]): boolean {
  if (w.state !== "waiting" && w.state !== "killed") return false;
  const evidence = latestTaskSignal(w, board);
  return evidence?.tag === "done" || evidence?.tag === "review_pass";
}

function compactText(text: string, maxLen = 88): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 3)}...`;
}

/**
 * Produces a compact one-line activity status for worker progress strips.
 */
export function formatWorkerActivity(w: WorkerSummary): string {
  if (w.state === "error" && w.last_error) {
    const first = w.last_error.split(/\r?\n/).find((l) => l.trim()) || w.last_error;
    return compactText(first, 88);
  }

  const ev = w.latest_event;
  if (w.state === "waiting") {
    if (w.latest_turn?.output_text) {
      return compactText(w.latest_turn.output_text, 88);
    }
    if (ev && ev.kind !== "usage" && ev.kind !== "raw" && ev.content) {
      return compactText(ev.content, 88);
    }
    return "等待唤醒";
  }

  if (ev) {
    if (ev.kind === "tool_call") {
      const step = summarizeToolStep(ev.title || "tool", ev.content);
      return compactText(
        step.targetSummary ? `${step.actionLabel} ${step.targetSummary}` : step.actionLabel,
        88,
      );
    }
    if (ev.kind === "tool_result") {
      return compactText(`完成 ${ev.title || "tool"}`, 88);
    }
    if (ev.kind === "thought") {
      return compactText(`思考中: ${ev.content}`, 88);
    }
    if (ev.kind === "error") {
      return compactText(ev.content, 88);
    }
    if (ev.kind === "system" && ev.title === "model_queue_status") {
      return "模型队列排队中...";
    }
    if (ev.kind !== "usage" && ev.kind !== "raw" && ev.content) {
      return compactText(ev.content, 88);
    }
  }

  if (w.state === "working") return "正在启动...";
  if (w.state === "stopped") return "已中断";
  if (w.state === "killed") return "已终止";
  return "等待唤醒";
}

function inferTaskTitleForWorker(w: WorkerSummary, board: BoardMessage[]): string {
  const briefMsg = board.find((m) => {
    if (m.tag !== "brief" && m.sender !== "coordinator") return false;
    return parseMentions(m).includes(w.name.toLowerCase());
  });
  if (briefMsg) {
    const cleaned = briefMsg.text
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/^#+\s*/, "")
          .replace(/^[-*]\s*/, "")
          .replace(/@[a-z0-9_-]+/gi, "")
          .replace(/^[：:,\s]+/, "")
          .trim(),
      )
      .find((l) => l.length >= 3);
    if (cleaned) {
      return compactText(cleaned, 68);
    }
  }
  const roleMap: Record<string, string> = {
    author: "功能编写与代码变更",
    verifier: "只读交叉审查与边界验证",
    researcher: "代码库调研与方案分析",
    worker: "协同任务执行",
  };
  return `${roleMap[w.role] || w.role} (${w.backend})`;
}

/**
 * Returns the explicit `SwarmPlan` (backfilling any workers absent from `threads`) or synthesizes a clean structure.
 */
export function deriveSwarmPlan(snap: DashboardSnapshot): DerivedSwarmPlan {
  if (!snap.swarm) {
    return {
      goal: { title: "Poly Swarm", line: "当前会话暂无 Swarm" },
      tasks: {},
      threads: [],
      isSynthetic: true,
    };
  }

  const tasks: Record<string, string> = {};
  for (const w of snap.workers) {
    tasks[w.name] = inferTaskTitleForWorker(w, snap.board_tail);
  }

  if (snap.plan) {
    const plan: SwarmPlan = snap.plan;
    for (const [k, v] of Object.entries(plan.tasks || {})) {
      if (typeof v === "string" && v.trim()) {
        tasks[k] = v.trim();
      }
    }

    const covered = new Set<string>();
    const threads = (plan.threads || []).map((t) => {
      const list = Array.isArray(t.tasks) ? [...t.tasks] : [];
      for (const n of list) covered.add(n);
      return {
        id: t.id,
        title: t.title,
        goal: t.goal,
        tasks: list,
      };
    });

    const missing = snap.workers.map((w) => w.name).filter((n) => !covered.has(n));
    if (missing.length > 0) {
      threads.push({
        id: "t-other-workers",
        title: threads.length === 0 ? "协同任务分组" : "其他成员",
        goal: "未归类到特定工作流分组的运行成员",
        tasks: missing,
      });
    }

    return {
      goal: {
        title: plan.goal?.title || snap.swarm.title,
        line: plan.goal?.line || "",
      },
      tasks,
      threads,
      isSynthetic: false,
    };
  }

  const repoName =
    snap.swarm.repo_root.split(/[/\\]+/).filter(Boolean).pop() || snap.swarm.repo_root;
  const statusHint = snap.swarm.status === "done" ? "已完成" : "进行中";
  const goal = {
    title: snap.swarm.title,
    line: `${repoName} · ${snap.workers.length} 位成员 · ${statusHint}`,
  };

  const channelGroups = new Map<string, string[]>();
  const unchannelled: WorkerSummary[] = [];
  for (const w of snap.workers) {
    const nonMain = w.channels.find((c) => c !== "main");
    if (nonMain) {
      const arr = channelGroups.get(nonMain) ?? [];
      arr.push(w.name);
      channelGroups.set(nonMain, arr);
    } else {
      unchannelled.push(w);
    }
  }

  const threads: DerivedSwarmPlan["threads"] = [];
  const channelTopicMap = new Map(snap.channels.map((c) => [c.name, c.topic]));
  for (const [ch, names] of channelGroups.entries()) {
    threads.push({
      id: `t-ch-${ch}`,
      title: `#${ch}`,
      goal: channelTopicMap.get(ch) || `频道 #${ch} 的协同任务成员`,
      tasks: names,
    });
  }

  const roleDefs: Array<{ role: string; id: string; title: string; goal: string }> = [
    { role: "author", id: "t-authors", title: "工程实现 (Authors)", goal: "独立工作区代码编写与实现" },
    { role: "verifier", id: "t-verifiers", title: "交叉审查 (Verifiers)", goal: "跨厂商只读复核与边界验证" },
    { role: "researcher", id: "t-researchers", title: "调研分析 (Researchers)", goal: "只读代码库与多源方案检索" },
    { role: "worker", id: "t-workers", title: "协同任务 (Workers)", goal: "并发协同子任务执行" },
  ];

  for (const def of roleDefs) {
    const group = unchannelled.filter((w) => w.role === def.role).map((w) => w.name);
    if (group.length > 0) {
      threads.push({
        id: def.id,
        title: def.title,
        goal: def.goal,
        tasks: group,
      });
    }
  }

  return {
    goal,
    tasks,
    threads,
    isSynthetic: true,
  };
}

/**
 * Reconciles unsaved UI configuration drafts after saving a partial patch (e.g. toggling `enabled`),
 * preserving unsaved `defaultModel` / `defaultEffort` / `customMode` edits instead of wiping them.
 */
export function reconcileDraftAfterSave(
  draft: BackendDraftState | undefined,
  saved: BackendConfigEntry,
  submittedPatch?: Omit<BackendConfigPatch, "backend">,
): BackendDraftState | null {
  if (!draft) return null;

  const next: BackendDraftState = {
    enabled:
      submittedPatch?.enabled !== undefined ? saved.enabled : draft.enabled,
    defaultModel:
      submittedPatch?.defaultModel !== undefined
        ? saved.defaultModel ?? ""
        : draft.defaultModel,
    defaultEffort:
      submittedPatch?.defaultEffort !== undefined
        ? saved.defaultEffort ?? ""
        : draft.defaultEffort,
    customMode:
      submittedPatch?.defaultModel !== undefined ? false : draft.customMode,
  };

  const matchesSaved =
    next.enabled === saved.enabled &&
    next.defaultModel.trim() === (saved.defaultModel ?? "") &&
    next.defaultEffort.trim() === (saved.defaultEffort ?? "") &&
    !next.customMode;

  return matchesSaved ? null : next;
}

export interface OkrTaskProjection {
  name: string;
  title: string;
  state: string;
  done: boolean;
  worker: WorkerSummary | null;
}

export interface OkrThreadProjection {
  id: string;
  title: string;
  goal: string;
  done: number;
  total: number;
  tasks: OkrTaskProjection[];
}

export interface OkrTreeProjection {
  title: string;
  line: string;
  done: number;
  total: number;
  threads: OkrThreadProjection[];
}

/** Projects a Swarm plan into an OKR tree without inventing completion evidence. */
export function deriveOkrTree(snap: DashboardSnapshot): OkrTreeProjection {
  const plan = deriveSwarmPlan(snap);
  const workers = new Map(snap.workers.map((worker) => [worker.name, worker]));
  const threads = plan.threads.map((thread) => {
    const tasks = thread.tasks.map((name) => {
      const worker = workers.get(name) ?? null;
      const done = worker ? isWorkerTaskDone(worker, snap.board_tail) : false;
      return {
        name,
        title: plan.tasks[name] ?? name,
        state: worker?.state ?? "planned",
        done,
        worker,
      };
    });
    return {
      id: thread.id,
      title: thread.title,
      goal: thread.goal,
      done: tasks.filter((task) => task.done).length,
      total: tasks.length,
      tasks,
    };
  });
  const done = threads.reduce((sum, thread) => sum + thread.done, 0);
  const total = threads.reduce((sum, thread) => sum + thread.total, 0);
  return {
    title: plan.goal.title,
    line: plan.goal.line,
    done,
    total,
    threads,
  };
}

export type BlackboardSection = "risks" | "results" | "briefs";

function blackboardSection(tag: BoardMessage["tag"]): BlackboardSection | null {
  if (tag === "blocked" || tag === "stall" || tag === "review_fail") return "risks";
  if (tag === "done" || tag === "review_pass") return "results";
  if (tag === "brief") return "briefs";
  return null;
}

/** Shared blackboard contains project milestones and risks, not ordinary chat. */
export function projectBlackboard(snap: DashboardSnapshot): BoardMessage[] {
  return (snap.blackboard_messages ?? snap.board_tail)
    .filter((message) => blackboardSection(message.tag) !== null)
    .sort((a, b) => b.seq - a.seq);
}

export function groupBlackboard(snap: DashboardSnapshot): Record<BlackboardSection, BoardMessage[]> {
  const groups: Record<BlackboardSection, BoardMessage[]> = { risks: [], results: [], briefs: [] };
  for (const message of projectBlackboard(snap)) {
    const section = blackboardSection(message.tag);
    if (section) groups[section].push(message);
  }
  return groups;
}

export type DeliverableStatus =
  | "accepted"
  | "review_failed"
  | "review_required"
  | "stale"
  | "working"
  | "empty";

export interface DeliverableProjection {
  workerName: string;
  branch: string | null;
  targetBranch: string | null;
  headSha: string | null;
  reviewedSha: string | null;
  dirty: boolean;
  dirtyFiles: string[];
  status: DeliverableStatus;
  canMerge: boolean;
  reviewSeq: number | null;
  reviewText: string;
  independentReviewNeeded: boolean;
  shaMatches: boolean;
}

/** Produces acceptance cards and a conservative SHA gate for every write seat. */
export function projectDeliverables(snap: DashboardSnapshot): DeliverableProjection[] {
  const workers = new Map(snap.workers.map((worker) => [worker.name, worker]));
  return Object.values(snap.deliverables ?? {}).map((item) => {
    const worker = workers.get(item.worker_name);
    const passed = item.latest_review?.tag === "review_pass";
    const independentlyReviewed = item.needs_independent_reviewer === false;
    const shaMatches = item.sha_matches === true;
    const stale = item.stale || Boolean(item.latest_review && !shaMatches);
    const accepted = passed && independentlyReviewed && shaMatches && !item.dirty && !stale;
    const status: DeliverableStatus = accepted ? "accepted" : stale ? "stale"
      : item.latest_review?.tag === "review_fail" ? "review_failed"
      : worker?.state === "working" ? "working" : item.head_sha ? "review_required" : "empty";
    return {
      workerName: item.worker_name,
      branch: item.branch,
      targetBranch: item.target_branch,
      headSha: item.head_sha,
      reviewedSha: item.reviewed_sha,
      dirty: item.dirty,
      dirtyFiles: item.dirty_files,
      status,
      canMerge: Boolean(accepted && item.head_sha && shaMatches && item.target_branch &&
        item.branch && worker?.worktree_branch === item.branch && worker.state !== "working" &&
        snap.swarm?.status === "active" && !snap.read_only_reason),
      reviewSeq: item.latest_review?.seq ?? null,
      reviewText: item.latest_review?.text ?? "",
      independentReviewNeeded: !independentlyReviewed,
      shaMatches,
    };
  });
}

export function workerStatusGroup(worker: WorkerSummary, snap: DashboardSnapshot): Exclude<WorkbenchStatusFilter, "all"> {
  if (worker.state === "working") return "running";
  if (worker.state === "error" || worker.state === "stopped") return "risk";
  const deliverable = snap.deliverables?.[worker.name];
  const evidence = latestTaskSignal(worker, snap.board_tail);
  if (deliverable?.stale || deliverable?.latest_review?.tag === "review_fail" ||
      evidence?.tag === "blocked" || evidence?.tag === "stall" || evidence?.tag === "review_fail") return "risk";
  if (evidence?.tag === "done" || evidence?.tag === "review_pass" ||
      (deliverable?.sha_matches && deliverable.latest_review?.tag === "review_pass")) return "acceptance";
  return "idle";
}

export function filterWorkersByStatus(
  workers: WorkerSummary[],
  filter: WorkbenchStatusFilter,
  snap: DashboardSnapshot,
): WorkerSummary[] {
  const visible = workers.filter((worker) => worker.state !== "killed");
  return filter === "all" ? visible : visible.filter((worker) => workerStatusGroup(worker, snap) === filter);
}

/**
 * Derives concise repo labels for archive display. When multiple distinct repo paths
 * share the same folder basename, prepends the minimal parent segments to disambiguate.
 */
export function formatShortRepoLabels(paths: readonly string[]): Map<string, string> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  const segsMap = new Map<string, string[]>();
  const groups = new Map<string, string[]>();

  for (const p of unique) {
    const clean = p.replace(/[\\/]+$/, "") || p;
    const segs = clean.split(/[\\/]+/).filter(Boolean);
    segsMap.set(p, segs);
    const base = segs[segs.length - 1] ?? clean;
    const arr = groups.get(base);
    if (arr) arr.push(p);
    else groups.set(base, [p]);
  }

  const out = new Map<string, string>();
  for (const [base, members] of groups) {
    if (members.length === 1) {
      out.set(members[0]!, base);
      continue;
    }
    for (const p of members) {
      const segs = segsMap.get(p) ?? [p];
      let depth = 2;
      while (depth <= segs.length) {
        const candidate = segs.slice(-depth).join("/");
        const collision = members.some((other) => {
          if (other === p) return false;
          const oSegs = segsMap.get(other) ?? [other];
          return oSegs.slice(-depth).join("/") === candidate;
        });
        if (!collision || depth === segs.length) {
          out.set(p, candidate);
          break;
        }
        depth += 1;
      }
    }
  }
  return out;
}

export function getLatestBlackboardSignal(messages: readonly BoardMessage[]): BoardMessage | null {
  if (!messages.length) return null;
  let best = messages[0]!;
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i]!.seq > best.seq) best = messages[i]!;
  }
  return best;
}

export function blackboardTagTone(tag: BoardMessage["tag"]): "ok" | "risk" | "info" {
  if (tag === "done" || tag === "review_pass") return "ok";
  if (tag === "blocked" || tag === "stall" || tag === "review_fail") return "risk";
  return "info";
}

export function formatRelativeTime(ts: number, lang: "zh-CN" | "en", now = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 45) return lang === "en" ? "just now" : "刚刚";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return lang === "en" ? `${mins}m ago` : `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return lang === "en" ? `${hrs}h ago` : `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return lang === "en" ? `${days}d ago` : `${days} 天前`;
  return new Date(ts).toLocaleDateString(lang);
}

export function pickDefaultReviewWave<T extends { is_workflow?: boolean }>(waves: readonly T[]): T | null {
  if (!waves.length) return null;
  return waves.find((w) => !w.is_workflow) ?? waves[0]!;
}

export type ArchiveSortKey = "recent" | "name" | "waves" | "cost";

export function filterAndSortConversationArchives(
  sessions: readonly ConversationArchiveSummary[],
  opts: {
    query: string;
    repo: string;
    sort: ArchiveSortKey;
  },
): ConversationArchiveSummary[] {
  const q = opts.query.trim().toLowerCase();
  const repo = opts.repo.trim();
  const filtered = sessions.filter((s) => {
    if (repo && repo !== "all" && !s.repo_roots.includes(repo)) return false;
    if (!q) return true;
    const hay = [
      s.conversation_id,
      s.title ?? "",
      s.custom_title ?? "",
      s.host_title ?? "",
      ...s.repo_roots,
      ...s.backends,
      ...s.waves.map((w) => `${w.swarm.title} ${w.team_name ?? ""}`),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const sorted = [...filtered];
  sorted.sort((a, b) => {
    if (opts.sort === "name") {
      const an = (a.title ?? a.conversation_id).toLowerCase();
      const bn = (b.title ?? b.conversation_id).toLowerCase();
      return an.localeCompare(bn) || b.last_activity_at - a.last_activity_at;
    }
    if (opts.sort === "waves") {
      return b.wave_count - a.wave_count || b.last_activity_at - a.last_activity_at;
    }
    if (opts.sort === "cost") {
      return (
        b.known_cost_usd - a.known_cost_usd ||
        b.total_tokens - a.total_tokens ||
        b.last_activity_at - a.last_activity_at
      );
    }
    return b.last_activity_at - a.last_activity_at;
  });
  return sorted;
}
