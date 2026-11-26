import {
  App,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { getBuildId } from "../shared/build_id.js";
import { areRoleSkillPaths, MAX_ROLE_SKILLS } from "../shared/role_skills.js";
import type {
  AgyAccountOption,
  AgyCompanyView,
  BackendConfigEntry,
  BackendId,
  BackendModelOption,
  BackendPolicyOverride,
  CandidateEvaluation,
  CapabilityTag,
  ConversationArchivesPayload,
  DashboardSnapshot,
  DispatchIdentityPatch,
  DispatchPolicyLayerConfig,
  PlannedGraphLink,
  PlannedGraphLinkKind,
  PromptMergeMode,
  RealBackendId,
  ResolvedDispatchPolicy,
  StaffAvatarId,
  StaffRosterMember,
  TurnRecord,
  TeamAttachResult,
  TeamRecord,
  UiPreferencesRecord,
  SessionMatchReason,
  WorkerDetailPayload,
  WorkerEvent,
  WorkerRole,
  WorkerSummary,
  WorkbenchTab,
  WorkspaceMode,
} from "../shared/types.js";
import { edgeKindCssClass, graphEventKey, projectDispatchReplay, renderDispatchGraphSvg, type GraphFilterMode } from "./graph_view.js";
import { readBrowserWorkbench } from "./browser_workbench.js";
import {
  BACKEND_COLORS,
  renderBrandLogoSvg,
  renderChatIdentityAvatar,
  renderEmployeeAvatarSvg,
  renderMiniOfficeSvg,
} from "./avatars_3d.js";
import { applyPreferences, getLanguage, getPreferences, t, hydratePreferences } from "./i18n.js";
import { esc, renderMarkdown } from "./markdown.js";
import {
  applyMentionSelection,
  buildMentionCandidates,
  detectMentionTrigger,
  filterMentionCandidates,
  type MentionCandidate,
  type MentionTrigger,
} from "./mention_picker.js";
import {
  dashboardTarget,
  formatWorkerActivity,
  groupBlackboard,
  readSessionHints,
  graphEdgeKindLabel,
  normalizeTab,
  projectDeliverables,
  projectBlackboard,
  policyLayerBadgeClass,
  policyLayerLabel,
  policyLayerShortLabel,
  reconcileDraftAfterSave,
  type ArchiveSortKey,
  type BackendDraftState,
  type BlackboardSection,
  type PrimaryTab,
} from "./swarm_view_model.js";
import {
  CHAT_EVENT_PAGE_SIZE,
  boardMessageLabel,
  boardSenderLabel,
  getChatEventsForTurn,
  renderBlackboardPanel,
  renderCompanyOverview,
  renderEmployeeDetail,
  renderDeliverablesPanel,
  renderOkrPanel,
  renderSessionPeople,
  renderTeamSwitcher,
  renderTeamSummaryPreview,
  type ChatEventPage,
} from "./views_session.js";
import {
  renderGlobalCompanies,
  renderAgyCompanyImport,
  renderGlobalHistory,
  renderGlobalPreferences,
  renderGlobalStaff,
  renderGlobalRules,
  renderStaffEditorModal,
  renderTeamCards,
  type StaffEditorDraft,
  type AgyCompanyModelsState,
} from "./views_global.js";

const TOGGLE_AUX_PANE_RESULT_SCHEMA = z
  .object({ isError: z.boolean().optional() })
  .passthrough();

const AVATAR_META: Record<string, { letter: string; bg: string }> = {
  grok: { letter: "G", bg: "#2F7D4C" },
  opencode: { letter: "O", bg: "#B45309" },
  codebuddy: { letter: "C", bg: "#0F766E" },
  codex: { letter: "X", bg: "#C85A32" },
  cursor: { letter: "S", bg: "#D97706" },
  qoder: { letter: "Q", bg: "#576574" },
  trae: { letter: "T", bg: "#0EA5A4" },
  agy: { letter: "A", bg: "#2B6CB0" },
  mock: { letter: "M", bg: "#78716C" },
};

type TraceFilter = "all" | "thought" | "tool" | "text" | "error" | "system";
type DetailViewMode = "chat" | "trace" | "config";
type BoardTagFilter = "all" | "result" | "alert" | "brief";
type WorkbenchFilter = "all" | "running" | "acceptance" | "risk" | "idle";
type GlobalTab = "hr" | "history" | "settings";
type GlobalHrSection = "companies" | "staff" | "rules";

interface MentionPopupState {
  open: boolean;
  trigger: MentionTrigger | null;
  items: MentionCandidate[];
  activeIndex: number;
}

const mentionPopup: MentionPopupState = {
  open: false,
  trigger: null,
  items: [],
  activeIndex: 0,
};

const REAL_BACKENDS: RealBackendId[] = [
  "agy",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "codebuddy",
  "qoder",
  "trae",
];

interface UiState {
  snapshot: DashboardSnapshot | null;
  selectedSwarmId: string | null;
  selectedTeamId: string | null;
  conversationId: string | null;
  repoRoot: string | null;
  matchReason: SessionMatchReason;
  historySwarmId: string | null;
  historyTeamId: string | null;
  staffQuery: string;
  staffFilter: string;
  archiveQuery: string;
  archiveRepoFilter: string;
  archiveSort: ArchiveSortKey;
  archiveViewMode: "cards" | "list";
  selectedArchiveConvId: string | null;
  archiveUnassignedOpen: boolean;
  archiveRenamingConvId: string | null;
  boardSearchOpen: boolean;
  boardFiltersOpen: boolean;
  flowSection: "graph" | "timeline" | "deliverables";
  historyBrowsingMode: boolean;
  historyDrawerOpen: boolean;
  surfaceMode: "workbench" | "global";
  activeTab: PrimaryTab;
  userSelectedTab: boolean;
  globalOverride: boolean;
  historyFromGlobal: boolean;
  candidateIntent: "switch" | "review";
  actionInFlight: boolean;
  planBannerExpanded: boolean;
  showKilledWorkers: boolean;
  boardSearchQuery: string;
  expandedBoardSeqs: Set<number>;
  highlightedSeq: number | null;
  boardLocatedSeq: number | null;
  detailViewMode: DetailViewMode;
  rawTraceChunks: boolean;
  configExpanded: boolean;
  expandedKeys: Set<string>;
  selectedWorkerName: string | null;
  workerDetail: WorkerDetailPayload | null;
  selectedTurnId: string | null;
  turnEvents: WorkerEvent[];
  chatEventPages: Map<string, ChatEventPage>;
  traceFilter: TraceFilter;
  showPatch: boolean;
  boardChannelFilter: string;
  boardTagFilter: BoardTagFilter;
  boardSenderFilter: string | null;
  switchTargetWorker: string | null;
  lastFocusSeq: number;
  toast: string | null;
  canSendMessage: boolean;
  backendModels: Partial<Record<RealBackendId, BackendModelOption[]>>;
  modelsLoading: boolean;
  modelsLoaded: boolean;
  configDrafts: Map<RealBackendId, BackendDraftState>;
  savingBackends: Set<RealBackendId>;
  savingAllConfigs: boolean;
  graphFilterMode: GraphFilterMode;
  selectedGraphNodeId: string | null;
  selectedGraphEdgeId: string | null;
  graphZoom: number;
  graphFitMode: boolean;
  policyEditScope: "global_ui" | "project" | "session";
  expandedIdentityId: string | null;
  newIdentityOpen: boolean;
  savingPolicy: boolean;
  globalTab: GlobalTab;
  globalHrSection: GlobalHrSection;
  selectedVendor: RealBackendId;
  workbenchFilter: WorkbenchFilter;
  workerDetailOpen: boolean;
  studioPeekWorker: string | null;
  staffEditorDraft: StaffEditorDraft | null;
  staffSaving: boolean;
  selectedAgyCompany: string | null;
  agyCompanyDraft: { id: string; name: string; model: string; effort: string } | null;
  agyCompanySaving: boolean;
  agyCompanyModels: Record<string, AgyCompanyModelsState>;
  agyImportOpen: boolean;
  agyImportLoading: boolean;
  agyImportFailed: boolean;
  agyImportAccounts: AgyAccountOption[];
  agyImportPicked: Set<string>;
  officeBannerExpanded: boolean;
  blackboardOpen: boolean;
  blackboardSection: BlackboardSection | "all";
  silentPost: boolean;
  graphReplayCount: number | null;
  teamDockOpen: boolean;
  candidates: CandidateEvaluation[];
  candidatesLoading: boolean;
  candidateBackend: RealBackendId | null;
  candidateError: string | null;
  lastRenderDigest: string;
}

const state: UiState = {
  snapshot: null,
  selectedSwarmId: null,
  selectedTeamId: null,
  conversationId: null,
  repoRoot: null,
  matchReason: "none",
  historySwarmId: null,
  historyTeamId: null,
  staffQuery: "",
  staffFilter: "all",
  archiveQuery: "",
  archiveRepoFilter: "all",
  archiveSort: "recent",
  archiveViewMode: "cards",
  selectedArchiveConvId: null,
  archiveUnassignedOpen: false,
  archiveRenamingConvId: null,
  boardSearchOpen: false,
  boardFiltersOpen: false,
  flowSection: "graph",
  historyBrowsingMode: false,
  historyDrawerOpen: false,
  surfaceMode: "workbench",
  activeTab: "detail",
  userSelectedTab: false,
  globalOverride: false,
  historyFromGlobal: false,
  candidateIntent: "switch",
  actionInFlight: false,
  planBannerExpanded: false,
  showKilledWorkers: false,
  boardSearchQuery: "",
  expandedBoardSeqs: new Set<number>(),
  highlightedSeq: null,
  boardLocatedSeq: null,
  detailViewMode: "chat",
  rawTraceChunks: false,
  configExpanded: false,
  expandedKeys: new Set<string>(),
  selectedWorkerName: null,
  workerDetail: null,
  selectedTurnId: null,
  turnEvents: [],
  chatEventPages: new Map(),
  traceFilter: "all",
  showPatch: false,
  boardChannelFilter: "main",
  boardTagFilter: "all",
  boardSenderFilter: null,
  switchTargetWorker: null,
  lastFocusSeq: 0,
  toast: null,
  canSendMessage: false,
  backendModels: {},
  modelsLoading: false,
  modelsLoaded: false,
  configDrafts: new Map<RealBackendId, BackendDraftState>(),
  savingBackends: new Set<RealBackendId>(),
  savingAllConfigs: false,
  graphFilterMode: "actual",
  selectedGraphNodeId: null,
  selectedGraphEdgeId: null,
  graphZoom: 1,
  graphFitMode: false,
  policyEditScope: "global_ui",
  expandedIdentityId: null,
  newIdentityOpen: false,
  savingPolicy: false,
  globalTab: "hr",
  globalHrSection: "companies",
  selectedVendor: "codex",
  workbenchFilter: "all",
  workerDetailOpen: false,
  studioPeekWorker: null,
  staffEditorDraft: null,
  staffSaving: false,
  selectedAgyCompany: null,
  agyCompanyDraft: null,
  agyCompanySaving: false,
  agyCompanyModels: {},
  agyImportOpen: false,
  agyImportLoading: false,
  agyImportFailed: false,
  agyImportAccounts: [],
  agyImportPicked: new Set(),
  officeBannerExpanded: true,
  blackboardOpen: false,
  blackboardSection: "all",
  silentPost: false,
  graphReplayCount: null,
  teamDockOpen: false,
  candidates: [],
  candidatesLoading: false,
  candidateBackend: null,
  candidateError: null,
  lastRenderDigest: "",
};

let mcpApp: App | null = null;
let isMcpMode = false;
let toastTimer: number | null = null;
let graphReplayTimer: number | null = null;
let highlightTimer: number | null = null;
let mentionBlurTimer: number | null = null;
let pollInFlight = false;
let candidateRequest = 0;
let hostTheme: "dark" | "light" | undefined;
let isImeComposing = false;
let lastInputAt = 0;
let lastUserScrollAt = 0;
let isRestoringScroll = false;
let dashboardRequest = 0;
let preferencesBusy = false;
let teamBusy = false;
let pendingHandoff: string | null = null;
let connected = false;
let dashboardRootId = "root";
let embeddedSwarmId: string | null = null;
const narrow = window.matchMedia("(max-width: 479px)");
const wide = window.matchMedia("(min-width: 960px)");

function avatarFor(backend: string): { letter: string; bg: string } {
  const current = AVATAR_META[backend] ?? AVATAR_META.mock!;
  return { ...current, bg: BACKEND_COLORS[backend] ?? current.bg };
}

function showToast(msg: string): void {
  state.toast = msg;
  render();
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 3200);
}

function fmtCompactTokens(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function stateDotClass(st: string): string {
  if (st === "working") return "dot-info";
  if (st === "waiting") return "dot-ok";
  if (st === "error") return "dot-err";
  if (st === "stopped") return "dot-warn";
  return "dot-muted";
}

function roleLabel(role: WorkerRole, capability?: CapabilityTag): string {
  if (capability === "architect") return getLanguage() === "en" ? "Architect" : "架构岗";
  if (role === "author") return getLanguage() === "en" ? "Author" : "实现岗";
  if (role === "verifier") return getLanguage() === "en" ? "Reviewer" : "审校岗";
  if (role === "researcher") return getLanguage() === "en" ? "Researcher" : "调研岗";
  return getLanguage() === "en" ? "Specialist" : "协作岗";
}

function isReadOnly(): boolean {
  return state.historyBrowsingMode || Boolean(state.snapshot?.read_only_reason) || state.snapshot?.swarm?.status !== "active" && Boolean(state.snapshot?.swarm);
}

function extractStructured<T>(result: unknown): T | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { structuredContent?: unknown };
  if (r.structuredContent && typeof r.structuredContent === "object") {
    return r.structuredContent as T;
  }
  return null;
}

async function callBackendTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  httpFallback: { method: "GET" | "POST"; url: string; body?: unknown },
): Promise<T> {
  if (isMcpMode && mcpApp) {
    const res = await mcpApp.callServerTool({ name: toolName, arguments: args });
    if ((res as { isError?: boolean }).isError) {
      const msg =
        (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ||
        `Tool ${toolName} failed`;
      throw new Error(msg);
    }
    const structured = extractStructured<T>(res);
    if (!structured) {
      throw new Error(`Tool ${toolName} returned no structuredContent`);
    }
    return structured;
  }

  const resp = await fetch(httpFallback.url, {
    method: httpFallback.method,
    headers: httpFallback.method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: httpFallback.method === "POST" ? JSON.stringify(httpFallback.body ?? args) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

async function syncFocusToServer(params: {
  swarm_id?: string | null;
  worker_name?: string | null;
  tab?: WorkbenchTab;
}): Promise<void> {
  if (state.historyBrowsingMode) return;
  try {
    const focus = await callBackendTool<{ seq: number }>(
      "app_focus_worker",
      params,
      { method: "POST", url: "/api/focus" },
    );
    if (typeof focus.seq === "number" && focus.seq > state.lastFocusSeq) {
      state.lastFocusSeq = focus.seq;
    }
  } catch {
    // ignore focus sync failure
  }
}

function currentSurface(): "workbench" | "global" {
  if (state.historyBrowsingMode) return "workbench";
  if (state.surfaceMode === "global") return "global";
  return state.globalOverride ? "global" : "workbench";
}

function goGlobal(section: GlobalHrSection = "companies"): void {
  if (state.historyBrowsingMode) {
    state.historySwarmId = state.historyTeamId = null;
    state.historyBrowsingMode = false;
    state.workerDetailOpen = false;
    state.workerDetail = null;
  }
  state.teamDockOpen = false;
  state.globalOverride = true;
  state.globalTab = "hr";
  state.globalHrSection = section;
  if (!state.modelsLoaded && !state.modelsLoading) void loadBackendModels(false);
}

function applyTab(tab: WorkbenchTab): void {
  if (tab === "settings" && !isReadOnly()) goGlobal("rules");
  else state.activeTab = normalizeTab(tab);
  if (state.activeTab !== "graph" || currentSurface() === "global") stopGraphReplay(true);
}

function tr(zh: string, en: string): string {
  return esc(getLanguage() === "en" ? en : zh);
}

function computeRenderDigest(): string {
  const snap = state.snapshot;
  if (!snap) return "empty";
  const surf = currentSurface();
  const backendsSig = snap.backends
    .map((b) => `${b.backend}:${b.installed}:${b.version ?? ""}:${b.cooldown_until ?? 0}:${b.supports_strict_readonly}:${b.cooldown_reason ?? ""}`)
    .join("|");
  const draftsSig = [...state.configDrafts.entries()]
    .map(([k, v]) => `${k}:${v.enabled}:${v.defaultModel}:${v.defaultEffort}:${v.customMode}`)
    .join("|");

  if (surf === "global") {
    const policySig = snap.dispatch_policy
      ? `${snap.dispatch_policy.layers.map((l) => `${l.layer}:${l.override_count}`).join(",")}:${Object.keys(snap.dispatch_policy.identities).length}:${snap.dispatch_policy.topology.length}:${snap.dispatch_policy.warnings.length}`
      : "no-policy";
    return JSON.stringify([
      surf, state.canSendMessage, state.surfaceMode, state.globalOverride, teamBusy,
      state.globalTab, state.globalHrSection, state.selectedVendor,
      state.staffQuery, state.staffFilter, state.staffEditorDraft, state.staffSaving, snap.staff_roster, snap.staff_performance,
      snap.agy_companies, snap.agy_company_usage, state.selectedAgyCompany, state.agyCompanyDraft,
      state.agyCompanySaving, state.agyImportOpen, state.agyImportLoading, state.agyImportFailed,
      state.agyCompanyModels,
      state.agyImportAccounts, [...state.agyImportPicked],
      state.archiveQuery, state.archiveRepoFilter, state.archiveSort, state.archiveViewMode,
      state.selectedArchiveConvId, state.archiveUnassignedOpen, state.archiveRenamingConvId,
      state.globalTab === "history" ? snap.conversation_archives : null,
      state.policyEditScope, state.expandedIdentityId ?? "", state.newIdentityOpen, state.savingPolicy,
      state.globalHrSection === "rules" ? [policySig, snap.dispatch_policy, state.selectedSwarmId ?? "", snap.swarm?.id ?? ""] : null,
      state.modelsLoading, state.modelsLoaded, state.backendModels,
      state.savingAllConfigs, state.savingBackends.size, draftsSig,
      backendsSig, snap.backend_configs ?? {},
      snap.global_usage_by_backend, snap.global_usage_by_vendor,
      state.toast ?? "", getPreferences(), snap.ui_build_id ?? "",
    ]);
  }

  const workersSig = snap.workers
    .map(
      (w) =>
        `${w.name}:${w.state}:${w.backend}:${w.model ?? ""}:${w.usage.turns}:${w.usage.total_tokens}:${w.latest_turn?.id ?? ""}:${w.latest_event?.id ?? ""}`,
    )
    .join("|");
  const lastBoardSeq = snap.board_tail[snap.board_tail.length - 1]?.seq ?? 0;
  const lastEventId = state.turnEvents[state.turnEvents.length - 1]?.id ?? 0;
  const graphSummary = snap.dispatch_graph?.summary;
  const graphSig = snap.dispatch_graph
    ? `${snap.dispatch_graph.nodes.length}:${snap.dispatch_graph.edges.length}:${snap.dispatch_graph.timeline.length}:${graphSummary?.review_pass_count ?? 0}:${graphSummary?.merge_count ?? 0}`
    : "no-graph";
  const policySig = snap.dispatch_policy
    ? `${snap.dispatch_policy.layers.map((l) => `${l.layer}:${l.override_count}`).join(",")}:${Object.keys(snap.dispatch_policy.identities).length}:${snap.dispatch_policy.topology.length}:${snap.dispatch_policy.warnings.length}`
    : "no-policy";

  return JSON.stringify([
    surf, state.canSendMessage, state.actionInFlight,
    snap.team, snap.teams, state.matchReason, state.historySwarmId, state.historyTeamId,
    state.boardSearchOpen, state.boardFiltersOpen, state.flowSection,
    state.candidateIntent, state.historyFromGlobal,
    snap.swarm?.id ?? "",
    snap.swarm?.title ?? "",
    snap.swarm?.status ?? "",
    snap.swarm?.plan_json ?? "",
    snap.swarms, snap.swarm_summaries, snap.channels, snap.usage_by_worker, snap.usage_by_backend,
    snap.session_usage_breakdown, snap.session_usage_by_worker, snap.session_turn_usages,
    snap.secondment_history, snap.usage_totals, snap.effective_defaults,
    snap.ui_focus.seq,
    state.selectedSwarmId ?? "",
    state.historyBrowsingMode,
    state.historyDrawerOpen,
    state.activeTab,
    state.planBannerExpanded,
    state.showKilledWorkers,
    state.boardSearchQuery,
    [...state.expandedBoardSeqs],
    state.highlightedSeq ?? 0,
    state.detailViewMode,
    state.selectedWorkerName ?? "",
    state.selectedTurnId ?? "",
    state.rawTraceChunks,
    state.configExpanded,
    state.showPatch,
    state.switchTargetWorker ?? "",
    state.traceFilter,
    state.boardChannelFilter,
    state.boardTagFilter,
    state.boardSenderFilter,
    [...state.expandedKeys],
    state.toast ?? "",
    state.graphFilterMode,
    state.selectedGraphNodeId ?? "",
    state.selectedGraphEdgeId ?? "",
    state.graphZoom,
    state.graphFitMode,
    state.workbenchFilter,
    state.workerDetailOpen,
    state.studioPeekWorker ?? "",
    state.officeBannerExpanded,
    state.blackboardOpen,
    state.blackboardSection,
    state.silentPost,
    state.graphReplayCount,
    state.teamDockOpen,
    state.candidatesLoading,
    state.candidateBackend ?? "",
    state.candidateError ?? "",
    state.candidates,
    getPreferences(),
    snap.deliverables,
    snap.blackboard_messages?.map((m) => m.seq).join(",") ?? "",
    snap.read_only_reason ?? "",
    state.workerDetail?.diff ? `${state.workerDetail.diff.head_sha ?? ""}:${state.workerDetail.diff.dirty}:${state.workerDetail.diff.files.join(",")}` : "",
    state.workerDetail?.turns.map((turn) => `${turn.id}:${turn.status}:${turn.ended_at ?? 0}`).join("|") ?? "",
    draftsSig,
    workersSig,
    snap.board_tail.length,
    lastBoardSeq,
    state.turnEvents.length,
    lastEventId,
    backendsSig,
    snap.backend_configs ?? {},
    graphSig, snap.dispatch_graph?.timeline.at(-1),
    snap.workers.map((w) => [w.role, w.identity_id, w.capability, w.effort, w.needs_handoff, w.last_error, w.worktree_branch]),
    policySig, snap.dispatch_policy, state.workerDetail?.diff,
  ]);
}

function applyServerPreferences(next: UiPreferencesRecord): void {
  const previous = getPreferences();
  hydratePreferences(next);
  if (previous.autoCollapseBannerNarrow !== next.autoCollapseBannerNarrow) {
    state.officeBannerExpanded = !next.autoCollapseBannerNarrow || !narrow.matches;
  }
  applyPreferences(hostTheme);
}

async function savePreferences(patch: Partial<UiPreferencesRecord>): Promise<void> {
  if (preferencesBusy) return;
  preferencesBusy = true;
  ++dashboardRequest;
  try {
    const result = await callBackendTool<{ ui_preferences: UiPreferencesRecord }>(
      "app_preferences", { op: "set", patch }, { method: "POST", url: "/api/preferences", body: { patch } },
    );
    applyServerPreferences(result.ui_preferences);
  } catch (err) {
    showToast(String(err));
  } finally {
    preferencesBusy = false;
    render();
  }
}

function acceptSessionSnapshot(snap: DashboardSnapshot): void {
  if (snap.ui_preferences && !preferencesBusy) applyServerPreferences(snap.ui_preferences);
  if (state.historyBrowsingMode) return;
  state.conversationId = snap.active_conversation_id || state.conversationId;
  if (currentSurface() !== "workbench") return;
  const reason = snap.match_reason ?? "none";
  if (!snap.swarm && reason === "none") {
    if (state.selectedSwarmId !== null) resetWorkerSelection();
    state.selectedSwarmId = null;
    state.selectedTeamId = null;
    state.matchReason = "none";
    return;
  }
  if (state.selectedSwarmId !== (snap.swarm?.id ?? null)) resetWorkerSelection();
  state.selectedSwarmId = snap.swarm?.id ?? null;
  state.selectedTeamId = snap.team?.id ?? null;
  if (!["explicit_swarm", "explicit_team"].includes(reason) || state.matchReason === "none") state.matchReason = reason;
}

function applySessionHints(input: unknown): void {
  const hints = readSessionHints(input);
  if (hints.conversationId && state.conversationId !== hints.conversationId) {
    if (state.conversationId || connected) {
      ++dashboardRequest;
      state.selectedSwarmId = state.selectedTeamId = null;
      state.historySwarmId = state.historyTeamId = null;
      state.selectedArchiveConvId = state.archiveRenamingConvId = null;
      state.historyBrowsingMode = state.historyDrawerOpen = false;
      state.activeTab = "detail";
      pendingHandoff = null;
      state.repoRoot = null;
      state.matchReason = "none";
      state.snapshot = null;
      resetWorkerSelection();
    }
    state.conversationId = hints.conversationId;
  }
  if (hints.repoRoot) state.repoRoot = hints.repoRoot;
}

async function manageTeam(action: "attach" | "new_wave", teamId: string, swarmId?: string, title?: string): Promise<void> {
  if (teamBusy || state.historyBrowsingMode) return;
  const conversationId = state.conversationId;
  const existing = state.snapshot?.teams?.find(({ team }) => team.id === teamId);
  const inArchives = state.snapshot?.conversation_archives?.sessions.some(
    (s) => s.bound_team_id === teamId || s.team_ids.includes(teamId),
  );
  if (!existing && !inArchives && state.snapshot?.team?.id !== teamId) return;
  const current = state.snapshot;
  if (action === "new_wave" && (!title || !current || current.team?.id !== teamId || !canManageCurrentTeam(current))) return;
  teamBusy = true;
  pendingHandoff = null;
  ++dashboardRequest;
  render();
  try {
    const result = await callBackendTool<TeamAttachResult>("app_team_action", {
      action, team_id: teamId, ...(action === "attach" && swarmId ? { swarm_id: swarmId } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(action === "new_wave" ? { title, repo_root: current?.team?.repo_root } : state.repoRoot ? { repo_root: state.repoRoot } : {}),
      ...(action === "attach" ? { reopen: false } : {}),
      surface: "workbench",
    }, { method: "POST", url: "/api/team-action" });
    if (state.conversationId !== conversationId) return;
    resetWorkerSelection();
    state.globalOverride = state.historyBrowsingMode = false;
    state.surfaceMode = "workbench";
    state.historySwarmId = state.historyTeamId = null;
    state.activeTab = "detail";
    state.selectedTeamId = result.team.id;
    state.selectedSwarmId = result.swarm?.id ?? null;
    state.matchReason = "explicit_team";
    state.snapshot = result.snapshot;
    acceptSessionSnapshot(result.snapshot);
    // Reflect the new team immediately, before waiting for a host acknowledgement.
    state.historyDrawerOpen = false;
    void syncFocusToServer({ swarm_id: result.swarm?.id ?? null, tab: "detail" });
    render();
    if (result.handoff_context) {
      const canUpdate = Boolean(mcpApp?.getHostCapabilities()?.updateModelContext?.text);
      if (canUpdate && mcpApp) {
        try {
          await mcpApp.updateModelContext({
            content: [{ type: "text", text: result.handoff_context }],
          });
        } catch {
          if (state.conversationId === (result.snapshot.active_conversation_id || conversationId)) pendingHandoff = result.handoff_context;
        }
      } else pendingHandoff = result.handoff_context;
      if (pendingHandoff) state.historyDrawerOpen = true;
    }
    showToast(action === "new_wave" ? tr("已在同一团队创建新轮次。", "New wave created in this team.")
      : result.binding ? t("teamAttached") : tr("已在面板切换团队", "Team selected in this panel"));
  } catch (err) {
    showToast(String(err));
  } finally {
    teamBusy = false;
    render();
  }
}

function canManageCurrentTeam(snap: DashboardSnapshot): boolean {
  const team = snap.team;
  return Boolean(team && team.status !== "archived" && !state.historyBrowsingMode && (
    !snap.swarm || snap.swarm.id === team.active_swarm_id || snap.match_reason === "conversation_binding" ||
    snap.teams?.some((item) => item.team.id === team.id && item.is_bound_to_current)
  ));
}

async function renameCurrentTeam(id: string, name: string): Promise<void> {
  const snap = state.snapshot;
  if (teamBusy || !snap || snap.team?.id !== id || !canManageCurrentTeam(snap) || name === snap.team.name) return;
  teamBusy = true;
  try {
    const { team } = await callBackendTool<{ team: TeamRecord }>("app_team_action",
      { action: "rename", team_id: id, name }, { method: "POST", url: "/api/team-action" });
    if (state.snapshot?.team?.id === id) {
      state.snapshot = { ...state.snapshot, team, teams: state.snapshot.teams?.map((item) =>
        item.team.id === id ? { ...item, team } : item) };
      showToast(tr("已保存团队名称。", "Team name saved."));
    }
  } catch (err) {
    showToast(String(err));
  } finally {
    teamBusy = false;
    render();
  }
}

async function mutateArchiveAction(
  payload: Record<string, unknown>,
  toastMsg: string,
): Promise<boolean> {
  if (teamBusy) return false;
  teamBusy = true;
  render();
  try {
    const res = await callBackendTool<{ conversation_archives?: ConversationArchivesPayload }>(
      "app_team_action",
      {
        ...payload,
        ...(state.conversationId ? { conversation_id: state.conversationId } : {}),
      },
      { method: "POST", url: "/api/team-action" },
    );
    if (res.conversation_archives && state.snapshot) {
      state.snapshot.conversation_archives = res.conversation_archives;
    }
    showToast(toastMsg);
    return true;
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    teamBusy = false;
    render();
  }
}

async function refreshDashboard(fromPoll = false): Promise<void> {
  const surf = currentSurface();
  const request = ++dashboardRequest;
  const scope = surf === "global" && state.globalHrSection === "rules" &&
    state.globalTab === "hr" && state.policyEditScope !== "global_ui" && state.selectedSwarmId;
  const target = dashboardTarget({
    surface: surf,
    swarmId: state.selectedSwarmId, teamId: state.selectedTeamId,
    conversationId: state.conversationId, repoRoot: state.repoRoot,
    historySwarmId: state.historySwarmId,
  });
  if (scope) {
    target.args.swarm_id = scope;
    delete target.args.conversation_id;
    delete target.args.repo_root;
  }
  const query = new URLSearchParams(Object.entries(target.args).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "0") : v])).toString();
  const snap = await callBackendTool<DashboardSnapshot>(
    "app_get_dashboard", target.args, { method: "GET", url: `/api/dashboard?${query}` },
  );
  if (request !== dashboardRequest || surf !== currentSurface() || (fromPoll && shouldPausePolling(true))) return;
  acceptSessionSnapshot(snap);

  // Strict session isolation: only accept incoming focus updates belonging to THIS bound swarm_id.
  const incomingFocus = snap.ui_focus;
  let focusChangedWorker = false;
  if (
    !state.historyBrowsingMode && surf === "workbench" && state.selectedSwarmId &&
    incomingFocus &&
    incomingFocus.swarm_id === state.selectedSwarmId &&
    incomingFocus.seq > state.lastFocusSeq
  ) {
    state.lastFocusSeq = incomingFocus.seq;
    if (incomingFocus.tab) {
      applyTab(incomingFocus.tab);
    }
    if (incomingFocus.worker_name && incomingFocus.tab === "detail") state.workerDetailOpen = true;
    if (incomingFocus.worker_name && incomingFocus.worker_name !== state.selectedWorkerName) {
      state.selectedWorkerName = incomingFocus.worker_name;
      state.selectedTurnId = null;
      state.turnEvents = [];
      state.showPatch = false;
      focusChangedWorker = true;
    }
  }

  state.snapshot = snap;

  const visibleWorkers = state.showKilledWorkers
    ? snap.workers
    : snap.workers.filter((w) => w.state !== "killed");
  const candidateWorkers = visibleWorkers.length > 0 ? visibleWorkers : snap.workers;

  if (
    (!state.selectedWorkerName ||
      !snap.workers.some((w) => w.name === state.selectedWorkerName)) &&
    candidateWorkers.length > 0
  ) {
    state.selectedWorkerName = candidateWorkers[0]!.name;
    state.selectedTurnId = null;
    state.turnEvents = [];
    focusChangedWorker = true;
  }

  if (surf === "workbench" && state.activeTab === "detail" && (state.workerDetailOpen || wide.matches) && snap.swarm && state.selectedWorkerName) {
    await refreshWorkerDetail(snap.swarm.id, state.selectedWorkerName, focusChangedWorker);
  }
  if (surf === "global" && state.globalTab === "hr" && !state.modelsLoaded && !state.modelsLoading) {
    void loadBackendModels(false);
  }
  if (request !== dashboardRequest || (fromPoll && shouldPausePolling(true))) return;
  if (fromPoll && computeRenderDigest() === state.lastRenderDigest) {
    return;
  }
  render();
}

async function refreshWorkerDetail(
  swarmId: string,
  name: string,
  forceResetTurn = false,
): Promise<void> {
  const detail = await callBackendTool<WorkerDetailPayload>(
    "app_get_worker_detail",
    { swarm_id: swarmId, name },
    {
      method: "GET",
      url: `/api/worker?swarm_id=${encodeURIComponent(swarmId)}&name=${encodeURIComponent(name)}`,
    },
  );
  if (state.selectedSwarmId !== swarmId || state.selectedWorkerName !== name) return;
  state.workerDetail = detail;
  if (
    forceResetTurn ||
    !state.selectedTurnId ||
    !detail.turns.some((t) => t.id === state.selectedTurnId)
  ) {
    state.selectedTurnId = detail.turns[0]?.id ?? null;
    state.turnEvents = detail.latest_turn_events;
  } else {
    await refreshTurnEvents(state.selectedTurnId, true);
  }
}

function fetchTurnEvents(turnId: string, after: number): Promise<{ turn: TurnRecord | null; events: WorkerEvent[] }> {
  return callBackendTool(
    "app_get_turn_events",
    { turn_id: turnId, after_event_id: after },
    {
      method: "GET",
      url: `/api/turn-events?turn_id=${encodeURIComponent(turnId)}&after_event_id=${after}`,
    },
  );
}

async function refreshTurnEvents(turnId: string, incremental: boolean): Promise<void> {
  const after = incremental ? state.turnEvents.at(-1)?.id ?? 0 : 0;
  const data = await fetchTurnEvents(turnId, after);
  if (state.selectedTurnId !== turnId) return;
  if (incremental && after > 0) {
    if (data.events.length > 0) {
      state.turnEvents = [...state.turnEvents, ...data.events].slice(-1000);
    }
  } else {
    state.turnEvents = data.events.slice(-1000);
  }
}

async function loadChatEvents(turnId: string): Promise<void> {
  const detail = state.workerDetail;
  const turn = detail?.turns.find((row) => row.id === turnId);
  if (!detail || !turn || detail.worker.name !== state.selectedWorkerName || state.chatEventPages.get(turnId)?.loading) return;
  const page: ChatEventPage = { events: getChatEventsForTurn(state, detail, turn), loading: true, complete: false };
  state.chatEventPages.set(turnId, page);
  const stillCurrent = () => state.chatEventPages.get(turnId) === page && state.selectedWorkerName === detail.worker.name;
  render();
  try {
    // Bound a single click so unusually long turns can be loaded in batches.
    for (let i = 0; i < 4 && !page.complete; i++) {
      const { events } = await fetchTurnEvents(turnId, page.events.at(-1)?.id ?? 0);
      if (!stillCurrent()) return;
      page.events = [...page.events, ...events];
      page.complete = events.length < CHAT_EVENT_PAGE_SIZE;
    }
  } catch (err) {
    if (stillCurrent()) showToast(err instanceof Error ? err.message : String(err));
  } finally {
    page.loading = false;
    if (stillCurrent()) render();
  }
}

function getSavedBackendConfig(snap: DashboardSnapshot, id: RealBackendId): BackendConfigEntry {
  const fromSnap = snap.backend_configs?.[id];
  if (fromSnap) return fromSnap;
  const eff = snap.effective_defaults?.[id];
  return {
    enabled: true,
    ...(eff?.model ? { defaultModel: eff.model } : {}),
    ...(eff?.effort ? { defaultEffort: eff.effort } : {}),
  };
}

function getEffectiveDraft(snap: DashboardSnapshot, id: RealBackendId): BackendDraftState {
  const draft = state.configDrafts.get(id);
  if (draft) return draft;
  const saved = getSavedBackendConfig(snap, id);
  const models = state.backendModels[id] ?? [];
  const savedModel = saved.defaultModel ?? "";
  const inModels = !savedModel || models.some((m) => m.id === savedModel);
  return {
    enabled: saved.enabled,
    defaultModel: savedModel,
    defaultEffort: saved.defaultEffort ?? "",
    customMode: Boolean(savedModel && !inModels && state.modelsLoaded),
  };
}

function isBackendDraftDirty(snap: DashboardSnapshot, id: RealBackendId): boolean {
  const draft = state.configDrafts.get(id);
  if (!draft) return false;
  const saved = getSavedBackendConfig(snap, id);
  return (
    draft.enabled !== saved.enabled ||
    draft.defaultModel.trim() !== (saved.defaultModel ?? "") ||
    draft.defaultEffort.trim() !== (saved.defaultEffort ?? "")
  );
}

async function loadBackendModels(forceRefresh = false): Promise<void> {
  if (state.modelsLoading) return;
  state.modelsLoading = true;
  render();
  try {
    const res = await callBackendTool<{
      models: Partial<Record<RealBackendId, BackendModelOption[]>>;
    }>(
      "app_list_backend_models",
      { refresh: forceRefresh },
      { method: "GET", url: forceRefresh ? "/api/backend-models?refresh=1" : "/api/backend-models" },
    );
    state.backendModels = res.models ?? {};
    state.modelsLoaded = true;
  } catch (err) {
    showToast(`获取模型列表失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.modelsLoading = false;
    render();
  }
}

async function saveBackendUpdates(
  updates: Array<{
    backend: RealBackendId;
    enabled?: boolean;
    defaultModel?: string | null;
    defaultEffort?: string | null;
  }>,
  toastMsg: string,
): Promise<void> {
  if (state.historyBrowsingMode) {
    showToast("只读历史回看模式不可修改全局配置");
    return;
  }
  if (updates.length === 0) return;
  const surf = currentSurface();
  try {
    const res = await callBackendTool<{
      backend_configs: Partial<Record<RealBackendId, BackendConfigEntry>>;
      snapshot?: DashboardSnapshot;
    }>(
      "app_update_backend_config",
      {
        ...(state.selectedSwarmId ? { swarm_id: state.selectedSwarmId } : {}),
        surface: surf,
        updates,
      },
      { method: "POST", url: "/api/backend-config" },
    );

    if (res.snapshot) {
      state.snapshot = res.snapshot;
    } else if (state.snapshot && res.backend_configs) {
      state.snapshot.backend_configs = res.backend_configs;
    }

    for (const u of updates) {
      const curDraft = state.configDrafts.get(u.backend);
      const savedCfg =
        res.backend_configs?.[u.backend] ??
        (state.snapshot ? getSavedBackendConfig(state.snapshot, u.backend) : undefined);
      if (curDraft && savedCfg) {
        const reconciled = reconcileDraftAfterSave(curDraft, savedCfg, {
          enabled: u.enabled,
          defaultModel: u.defaultModel,
          defaultEffort: u.defaultEffort,
        });
        if (reconciled) {
          state.configDrafts.set(u.backend, reconciled);
        } else {
          state.configDrafts.delete(u.backend);
        }
      } else {
        state.configDrafts.delete(u.backend);
      }
    }

    showToast(toastMsg);
  } catch (err) {
    showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function savePolicyUpdate(params: {
  scope: "global_ui" | "project" | "session";
  patch?: DispatchPolicyLayerConfig | null;
  reset?: boolean;
  toastMsg: string;
}): Promise<void> {
  if (state.historyBrowsingMode) {
    showToast("只读历史回看模式不可修改权重策略");
    return;
  }
  const snap = state.snapshot;
  const surf = currentSurface();
  state.savingPolicy = true;
  render();
  try {
    const res = await callBackendTool<{
      dispatch_policy: ResolvedDispatchPolicy;
      snapshot?: DashboardSnapshot;
    }>(
      "app_update_dispatch_policy",
      {
        scope: params.scope,
        ...(snap?.swarm?.id ? { swarm_id: snap.swarm.id } : {}),
        ...(snap?.swarm?.repo_root ? { repo_root: snap.swarm.repo_root } : {}),
        surface: surf,
        ...(params.patch !== undefined ? { patch: params.patch } : {}),
        ...(params.reset ? { reset: true } : {}),
      },
      { method: "POST", url: "/api/policy" },
    );
    if (res.snapshot) {
      state.snapshot = res.snapshot;
    } else if (state.snapshot && res.dispatch_policy) {
      state.snapshot.dispatch_policy = res.dispatch_policy;
    }
    showToast(params.toastMsg);
  } catch (err) {
    showToast(`策略保存失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.savingPolicy = false;
    render();
  }
}

async function runWorkerAction(payload: Record<string, unknown>): Promise<boolean> {
  if (state.actionInFlight) return false;
  if (payload.action !== "refresh_backends" && isReadOnly()) {
    showToast(t("readonly"));
    return false;
  }
  state.actionInFlight = true;
  try {
    const result = await callBackendTool<{ ok?: boolean; cancelled?: boolean; message?: string }>("app_worker_action", payload, {
      method: "POST", url: "/api/worker-action",
    });
    if (result.ok === false) {
      await refreshDashboard();
      showToast(result.message || "Merge failed");
      return false;
    }
    showToast(result.cancelled === false ? tr("没有正在执行的轮次", "No running turn") : t("actionComplete"));
    await refreshDashboard();
    return true;
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    state.actionInFlight = false;
    render();
  }
}

async function openCandidates(name: string, intent: "switch" | "review"): Promise<void> {
  const snap = state.snapshot;
  const worker = snap?.workers.find((w) => w.name === name);
  if (!worker || !snap?.swarm || (intent === "switch" && isReadOnly())) return;
  const swarmId = snap.swarm.id;
  state.switchTargetWorker = name;
  state.candidateIntent = intent;
  state.candidates = [];
  state.candidateBackend = null;
  state.candidateError = null;
  state.candidatesLoading = true;
  const token = ++candidateRequest;
  render();
  const args = {
    swarm_id: swarmId,
    capability: intent === "review" ? "verifier" : worker.capability,
    role: intent === "review" ? "verifier" : worker.role,
    ...(intent === "switch" && worker.identity_id ? { identity_id: worker.identity_id } : {}),
    ...(intent === "review" ? { review_of: worker.name } : worker.review_of ? { review_of: worker.review_of } : {}),
  };
  try {
    const result = await callBackendTool<{ candidates: CandidateEvaluation[] }>("app_evaluate_candidates", args, {
      method: "GET", url: `/api/candidates?${new URLSearchParams(args)}`,
    });
    if (token !== candidateRequest) return;
    state.candidates = result.candidates;
    state.candidateBackend = result.candidates.find((c) => c.recommended && c.eligible)?.backend
      ?? result.candidates.find((c) => c.eligible)?.backend ?? null;
  } catch (err) {
    if (token === candidateRequest) state.candidateError = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === candidateRequest) {
      state.candidatesLoading = false;
      render();
    }
  }
}

function resetWorkerSelection(): void {
  stopGraphReplay(true);
  state.selectedGraphNodeId = state.selectedGraphEdgeId = null;
  state.flowSection = "graph";
  state.selectedWorkerName = null;
  state.workerDetailOpen = false;
  state.studioPeekWorker = null;
  state.workerDetail = null;
  state.selectedTurnId = null;
  state.turnEvents = [];
  state.chatEventPages.clear();
  state.boardChannelFilter = "main";
  state.boardTagFilter = "all";
  state.boardSenderFilter = null;
  state.boardSearchQuery = "";
  state.expandedBoardSeqs.clear();
  state.highlightedSeq = null;
  state.boardLocatedSeq = null;
  state.blackboardOpen = false;
  state.blackboardSection = "all";
  state.teamDockOpen = false;
  state.switchTargetWorker = null;
  candidateRequest += 1;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("copied"));
  } catch {
    window.prompt(t("copyManually"), text);
  }
}

async function openFileInHost(absPath: string): Promise<void> {
  if (!isMcpMode || !mcpApp) {
    showToast(`文件路径: ${absPath}`);
    return;
  }
  try {
    const uri = absPath.startsWith("file://") ? absPath : `file://${encodeURI(absPath)}`;
    const res = (await mcpApp.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri },
      } as never,
      TOGGLE_AUX_PANE_RESULT_SCHEMA,
    )) as { isError?: boolean } | undefined;
    if (res?.isError) {
      showToast(`无法在侧栏打开文件: ${absPath}`);
    }
  } catch (err) {
    console.error("[poly-swarm ui] openFileInHost failed:", err);
    showToast(`侧栏打开失败 (${err instanceof Error ? err.message : absPath})`);
  }
}

function renderSessionEmptyCard(snap: DashboardSnapshot): string {
  const teams = snap.teams ?? [];
  return `<div class="tab-scroll-pane"><section class="panel-card session-empty">
    ${renderMiniOfficeSvg([], { empty: true, compact: true })}
    <h2>${esc(t("noProject"))}</h2><p class="muted">${esc(t("noProjectHint"))}</p>
    <div class="pill-row">
      <button type="button" class="btn btn-primary" data-action="go-global-hr">${esc(t("viewGlobalHr"))}</button>
      <button type="button" class="btn" data-action="toggle-team-drawer">${esc(t("attachTeam"))}</button>
    </div>
    ${teams.length ? `<div class="project-history-grid">${renderTeamCards(teams.slice(0, 3), { busy: teamBusy, currentTeam: state.selectedTeamId, density: "rail", intent: "browse" })}</div>` : ""}
    <details><summary>${esc(t("historyProjects"))} (${esc(snap.swarms.length)})</summary>
      <div class="history-list">${snap.swarms.map((group) => `<button type="button" class="history-item-btn" data-action="open-history-swarm" data-swarm-id="${esc(group.id)}">${esc(group.title)} <span class="badge">${esc(group.status)}</span></button>`).join("") || esc(t("noRecords"))}</div>
    </details>
  </section></div>`;
}

function renderDetail(snap: DashboardSnapshot): string {
  if (!snap.swarm) return renderSessionEmptyCard(snap);
  const prefs = getPreferences();
  const employee = state.workerDetailOpen || wide.matches ? snap.workers.find((w) => w.name === state.selectedWorkerName) : null;
  return `<div class="workbench-grid ${employee ? "has-detail" : ""}">
    ${renderCompanyOverview(snap, {
      filter: state.workbenchFilter, officeExpanded: state.officeBannerExpanded,
      showOffice: prefs.showOfficeBanner, animated: prefs.animatedAvatars,
      selectedName: employee?.name ?? null, studioPeekWorker: state.studioPeekWorker, readOnly: isReadOnly(),
    })}
    ${employee ? renderEmployeeDetail({ ...state, readOnly: isReadOnly() }, employee, snap) : ""}
  </div>`;
}

function renderCandidateDrawer(): string {
  const name = state.switchTargetWorker;
  if (!name) return "";
  const review = state.candidateIntent === "review";
  const picked = state.candidates.find((c) => c.backend === state.candidateBackend && c.eligible);
  return `<div class="drawer-scrim"><section class="panel-card candidate-drawer" role="dialog" aria-modal="true" aria-labelledby="candidate-title">
    <div class="section-head"><h2 id="candidate-title" class="section-title">${esc(t(review ? "independentReview" : "reassign"))} · @${esc(name)}</h2><button type="button" class="btn" data-action="cancel-switch">${esc(t("cancel"))}</button></div>
    ${review ? "" : `<p class="muted">${esc(t("switchWarning"))}</p>`}
    ${state.candidatesLoading ? `<p>${tr("检查门禁中…", "Checking gates…")}</p>` : ""}
    ${state.candidateError ? `<p class="status-risk" role="alert">${esc(state.candidateError)}</p>` : ""}
    ${!state.candidatesLoading && !state.candidateError && !state.candidates.length ? `<p>${esc(t("noCandidates"))}</p>` : ""}
    <div class="candidate-list">${state.candidates.map((c) => `<article class="candidate-row ${picked?.backend === c.backend ? "is-picked" : ""}">
      ${renderEmployeeAvatarSvg({ backend: c.backend, model: c.model, size: 38 })}
      <div><strong>${esc(c.backend)}</strong> · ${esc(c.vendor_family)}
      <div class="muted">${esc(c.model ?? "CLI")} · ${esc(c.effort ?? "—")}</div>
      <div class="${c.eligible ? "status-ok" : "status-risk"}">${c.eligible ? "✓" : "✕"} ${esc(t(c.eligible ? "eligible" : "rejected"))}${c.recommended ? ` · ${tr("推荐", "Recommended")}` : ""}</div>
      ${c.gate_failures.map((g) => `<small class="gate-reason">${esc(g.gate)} · ${esc(g.reason)}</small>`).join("")}</div>
      ${!review && c.eligible ? `<button type="button" class="btn btn-sm-pad" data-action="pick-candidate" data-backend="${esc(c.backend)}" aria-pressed="${picked?.backend === c.backend}">${tr("选择", "Select")}</button>` : ""}
      </article>`).join("")}</div>
    ${review && !state.candidatesLoading && !state.candidateError && !state.candidates.some((c) => c.eligible) ? `<p class="status-risk">${esc(t("noIndependent"))}</p><button type="button" class="btn" data-action="copy-review-diagnostics">${tr("复制排查说明", "Copy review diagnostics")}</button>` : ""}
    ${!review && picked ? `<div class="candidate-form">
      <label>Model<input id="candidate-model" class="input-sm" value="${esc(picked.model ?? "")}"></label>
      <label>Effort<input id="candidate-effort" class="input-sm" value="${esc(picked.effort ?? "")}"></label>
      <label>${esc(t("handoffSummary"))}<input id="candidate-reason" class="input-sm"></label>
      <label>${esc(t("resumePrompt"))}<textarea id="candidate-resume" class="input-sm" rows="2"></textarea></label>
      <button type="button" class="btn btn-primary" data-action="confirm-switch" data-worker="${esc(name)}" ${isReadOnly() || state.actionInFlight ? "disabled" : ""}>${esc(t("confirmReassign"))}</button>
    </div>` : ""}
  </section></div>`;
}

function renderBoard(snap: DashboardSnapshot): string {
  if (!snap.swarm) return renderSessionEmptyCard(snap);
  const channels = ["main", ...snap.channels.map((c) => c.name).filter((c) => c !== "main"), "*"];
  const query = state.boardSearchQuery.trim().toLowerCase();
  const extra = state.boardLocatedSeq == null ? [] : projectBlackboard(snap).filter((m) => m.seq === state.boardLocatedSeq && !snap.board_tail.some((row) => row.seq === m.seq));
  const msgs = [...extra, ...snap.board_tail].sort((a, b) => a.seq - b.seq).filter((m) => {
    if (state.boardChannelFilter !== "*" && state.boardChannelFilter !== m.channel) return false;
    if (state.boardSenderFilter && m.sender !== state.boardSenderFilter) return false;
    if (state.boardTagFilter === "result" && !["done", "review_pass"].includes(m.tag)) return false;
    if (state.boardTagFilter === "alert" && !["blocked", "review_fail", "stall"].includes(m.tag)) return false;
    if (state.boardTagFilter === "brief" && m.tag !== "brief") return false;
    return !query || `${m.sender} ${m.channel} #${m.seq} ${m.text}`.toLowerCase().includes(query);
  });
  const workers = new Map(snap.workers.map((w) => [w.name, w]));
  const online = snap.workers.filter((w) => w.state === "working" || w.state === "waiting").length;
  const readOnly = isReadOnly();
  const disabled = readOnly ? "disabled" : "";
  const sendToChat = state.canSendMessage && !readOnly;
  const groups = groupBlackboard(snap);
  const importantCount = groups.risks.length + groups.results.length + groups.briefs.length;
  const staffAvatar = (w: WorkerSummary, size: number) => {
    const initials = w.name.split(/[-_]+/).filter(Boolean);
    const mark = (initials.length > 1 ? initials.slice(0, 2).map((part) => part[0]).join("") : w.name.slice(0, 2)).toUpperCase();
    return `<span class="chat-member-avatar" aria-hidden="true">${renderEmployeeAvatarSvg({ backend: w.backend, model: w.model, name: w.name, role: w.role, size })}<b>${esc(mark)}</b></span>`;
  };
  const senderRail = (name: string, icon: string, heading: string, caption: string, accent: string) =>
    `<button type="button" class="chat-person" style="--speaker:${esc(accent)}" data-action="filter-board-sender" data-sender="${esc(name)}" aria-pressed="${state.boardSenderFilter === name}" title="${caption}">
      ${icon}<span class="chat-person-copy"><strong>${heading}</strong><small>${caption}</small></span></button>`;
  const roster = [
    senderRail("coordinator", renderChatIdentityAvatar("coordinator", 27), boardSenderLabel("coordinator"),
      tr("派发与决策", "Assignments and decisions"), "var(--accent-hi)"),
    senderRail("user", renderChatIdentityAvatar("user", 27), boardSenderLabel("user"),
      tr("我的发言", "My messages"), "var(--ok)"),
    ...snap.workers.map((w) => senderRail(w.name, staffAvatar(w, 27), boardSenderLabel(w.name),
      esc(getLanguage() === "en" ? w.latest_turn?.output_text?.trim().slice(0, 88) || w.latest_event?.title || t(w.state) : formatWorkerActivity(w)),
      BACKEND_COLORS[w.backend] ?? BACKEND_COLORS.mock!)),
  ].join("");
  const list = msgs.map((m, index) => {
    const sender = workers.get(m.sender);
    const mine = !sender && (m.sender === "user" || m.sender === "coordinator");
    const system = m.tag === "system" && !sender && !mine;
    const prev = msgs[index - 1];
    const continues = !system && prev?.sender === m.sender && prev.channel === m.channel && prev.tag === m.tag
      && m.created_at - prev.created_at < 120_000;
    const expanded = state.expandedBoardSeqs.has(m.seq);
    const long = m.text.length > 420 || m.text.split("\n").length > 8;
    const tag = mine && m.sender === "user" && m.tag === "update" ? { label: tr("发言", "Message"), tone: "" } : boardMessageLabel(m.tag);
    const name = sender ? esc(`@${m.sender}`) : boardSenderLabel(m.sender);
    const accent = mine ? m.sender === "user" ? "var(--ok)" : "var(--accent-hi)" : sender ? BACKEND_COLORS[sender.backend] ?? BACKEND_COLORS.mock! : "var(--tx-3)";
    const speaker = mine ? renderChatIdentityAvatar(m.sender === "user" ? "user" : "coordinator") : sender ? staffAvatar(sender, 34) :
      `<span class="chat-fallback-avatar" aria-hidden="true">${esc(m.sender.slice(0, 2).toUpperCase())}</span>`;
    return `<article class="board-item chat-message ${mine ? "is-user" : system ? "is-system" : "is-employee"}${continues ? " is-continuation" : ""}${state.highlightedSeq === m.seq ? " is-highlight" : ""}" data-seq="${esc(m.seq)}" tabindex="-1" aria-label="${name} · ${tag.label}" style="--speaker:${esc(accent)}">
      ${system ? "" : `<div class="chat-avatar-slot">${continues ? "" : speaker}</div>`}
      <div class="message-main">${continues ? "" : `<div class="board-meta">
        ${sender ? `<button type="button" class="sender-link" data-action="open-worker-detail" data-worker="${esc(m.sender)}">${name}</button>
          <span class="chat-identity">${esc(roleLabel(sender.role, sender.capability))} · ${esc(sender.backend)}</span>` : `<strong>${name}</strong>`}
        <span class="badge ${tag.tone ? `badge-${tag.tone}` : ""}">${tag.label}</span>
        ${state.boardChannelFilter === "*" ? `<span class="badge">#${esc(m.channel)}</span>` : ""}
      </div>`}
      ${extra.some((item) => item.seq === m.seq) ? `<span class="chat-archived-source">${tr("从黑板定位 · 不在近期聊天窗口内", "From the coordination board · Outside the recent chat window")}</span>` : ""}
      <div class="board-text md-body">${renderMarkdown(long && !expanded ? `${m.text.split("\n").slice(0, 8).join("\n").slice(0, 420)}…` : m.text)}</div>
      ${long ? `<button type="button" class="link-btn" data-action="toggle-board-more" data-seq="${esc(m.seq)}">${expanded ? tr("收起", "Collapse") : tr("展开全文", "Read more")}</button>` : ""}
      <footer class="message-foot"><time>${esc(fmtTime(m.created_at))}</time><span>#${esc(m.seq)}</span>
        ${readOnly || system ? "" : `<button class="link-btn" type="button" data-action="quote-seq" data-seq="${esc(m.seq)}">${tr("引用", "Quote")}</button>`}
        ${sendToChat ? `<button type="button" class="link-btn" data-action="send-to-chat" data-seq="${esc(m.seq)}">${esc(t("backToChat"))}</button>` : ""}</footer></div>
    </article>`;
  }).join("");
  return `<div class="group-chat-grid${state.blackboardOpen ? " has-blackboard" : ""}">
    <section class="panel-card board-stage">
      <header class="board-toolbar">
        <select id="board-channel-select" class="select-sm" aria-label="${esc(t("channel"))}">${channels.map((c) => `<option value="${esc(c)}" ${c === state.boardChannelFilter ? "selected" : ""}>${c === "*" ? esc(t("all")) : `# ${esc(c)}`}</option>`).join("")}</select>
        <span class="board-online"><i></i>${esc(online)} ${esc(t("online"))}</span>
        <div class="board-tools"><button type="button" class="btn btn-icon" data-action="toggle-board-search" aria-label="${esc(t("searchMessages"))}" aria-expanded="${state.boardSearchOpen}">⌕</button>
        <button type="button" class="btn btn-icon" data-action="toggle-board-filters" aria-label="${tr("标签筛选", "Filter by tag")}" aria-expanded="${state.boardFiltersOpen}">☷</button>
        <button type="button" class="blackboard-toggle btn" data-action="toggle-blackboard" aria-controls="coordination-board" aria-expanded="${state.blackboardOpen}"><span aria-hidden="true">▤</span> ${tr("协作黑板", "Board")} <b>${esc(importantCount)}</b></button></div>
      </header>
      <div class="chat-people" aria-label="${tr("按发言人筛选", "Filter by speaker")}">${roster}</div>
      ${state.boardSenderFilter ? `<div class="chat-filter-notice"><span>${tr("仅看", "Only")} ${boardSenderLabel(state.boardSenderFilter)}</span><button type="button" class="link-btn" data-action="filter-board-sender">${tr("显示全部发言", "Show all speakers")}</button></div>` : ""}
      ${state.boardSearchOpen || state.boardFiltersOpen ? `<div class="board-filter-bar">
        ${state.boardSearchOpen ? `<input id="board-search-input" class="input-sm board-search-input" autocomplete="off" aria-label="${esc(t("searchMessages"))}" placeholder="${esc(t("searchMessages"))}" value="${esc(state.boardSearchQuery)}">` : ""}
        ${state.boardFiltersOpen ? `<select id="board-tags" class="select-sm" aria-label="${tr("标签", "Tags")}">${([["all",esc(t("all"))],["result",tr("结论","Results")],["alert",esc(t("risk"))],["brief",tr("派发","Dispatch")]] as const).map(([id, label]) => `<option value="${id}" ${id === state.boardTagFilter ? "selected" : ""}>${label}</option>`).join("")}</select>` : ""}
      </div>` : ""}
      <div class="board-list" aria-label="${tr("群聊消息", "Chat messages")}" tabindex="0">${list || `<p class="chat-empty">${tr("当前筛选下没有消息", "No messages match these filters")}</p>`}</div>
      <div class="composer-wrap">
        <div class="segmented composer-modes" data-silent="${state.silentPost}" role="group" aria-label="${tr("发送方式", "Posting mode")}">${([["silent",true],["notify",false]] as const).map(([label, silent]) => `<button type="button" aria-pressed="${state.silentPost === silent}" data-action="set-post-mode" data-silent="${silent}" ${disabled}>${esc(t(label))}</button>`).join("")}</div>
        <div id="mention-popover" class="mention-popover hidden" role="listbox"></div>
        <div class="composer">
          <button type="button" class="btn btn-icon" data-action="insert-at" ${disabled}>@</button>
          <textarea id="board-input" class="input-sm composer-textarea" rows="1" ${disabled} placeholder="${esc(t(readOnly ? "readonly" : "messagePlaceholder"))}"></textarea>
          <button type="button" class="btn btn-primary send-btn" data-action="post-board" ${disabled}>${esc(t("send"))}</button>
        </div>
      </div>
    </section>
    ${state.blackboardOpen ? `<div class="blackboard-container">${renderBlackboardPanel(snap, state.blackboardSection)}</div>` : ""}
  </div>`;
}

function renderFlow(snap: DashboardSnapshot): string {
  if (!snap.swarm) return renderSessionEmptyCard(snap);
  const sections = [["graph", tr("协同脉络", "Collaboration")], ["timeline", esc(t("timeline"))], ["deliverables", esc(t("deliverables"))]] as const;
  const goal = snap.plan?.goal.line || snap.team?.goal;
  return `<div class="tab-scroll-pane flow-pane">
    <nav class="segmented flow-tabs" aria-label="${esc(t("flow"))}">${sections.map(([section, label]) => `<button type="button" data-action="set-flow-section" data-section="${section}" aria-pressed="${state.flowSection === section}">${label}</button>`).join("")}</nav>
    ${state.flowSection === "graph" ? renderGraph(snap) : state.flowSection === "timeline" ? renderFlowTimeline(snap) : renderDeliverablesPanel(snap, isReadOnly())}
    ${snap.plan || goal ? `<details class="flow-goal"><summary><strong>${tr("任务目标与分解", "Objective and plan")}</strong>${goal ? `<span>${esc(goal)}</span>` : ""}</summary>
      ${snap.plan ? renderOkrPanel(snap) : ""}</details>` : ""}</div>`;
}

function renderFlowTimeline(snap: DashboardSnapshot): string {
  const graph = snap.dispatch_graph;
  const workersByName = new Map(snap.workers.map((worker) => [worker.name, worker]));
  const timelineRows = [...(graph?.timeline ?? [])].reverse().slice(0, 40).map((ev) => {
    const worker = workersByName.get(ev.from_node) ?? workersByName.get(ev.to_node);
    return `<div class="graph-timeline-row">
      ${worker ? renderEmployeeAvatarSvg({ backend: worker.backend, model: worker.model, name: worker.name, role: worker.role, size: 23 }) : ""}
      <span class="badge ${edgeKindCssClass(ev.kind)}">${getLanguage() === "en" ? esc(ev.kind.replaceAll("_", " ")) : esc(graphEdgeKindLabel(ev.kind))}</span>
      <span class="mono"><strong>${esc(ev.from_node)}</strong> → <strong>${esc(ev.to_node)}</strong></span>
      ${ev.label ? `<span class="muted">${esc(ev.label)}</span>` : ""}
      <span class="graph-timeline-meta">${ev.seq ? `<button type="button" class="md-seq-ref" data-action="scroll-seq" data-seq="${ev.seq}">#${ev.seq}</button>` : ""}
      <time class="muted">${esc(fmtTime(ev.created_at))}</time></span></div>`;
  }).join("");
  return `<section class="panel-card timeline-panel"><h2 class="section-title">${esc(t("timeline"))}</h2><div class="graph-timeline-list">${timelineRows || esc(t("noRecords"))}</div></section>`;
}

function stopGraphReplay(exit = false): void {
  if (graphReplayTimer !== null) window.clearInterval(graphReplayTimer);
  graphReplayTimer = null;
  if (exit) state.graphReplayCount = null;
}

function renderGraphControlChange(): void {
  const active = document.activeElement;
  const action = active instanceof HTMLButtonElement && active.dataset.action?.startsWith("graph-") ? active.dataset.action : null;
  render();
  if (action) document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
}

function advanceGraphReplay(): void {
  const total = state.snapshot?.dispatch_graph?.timeline.length ?? 0;
  if (state.graphReplayCount === null || state.activeTab !== "graph" || state.flowSection !== "graph" || currentSurface() !== "workbench") {
    stopGraphReplay(true);
    return;
  }
  state.graphReplayCount = Math.min(state.graphReplayCount + 1, total);
  if (state.graphReplayCount >= total) stopGraphReplay();
  renderGraphControlChange();
}

function computeGraphCanvasRender(snap: DashboardSnapshot) {
  const source = snap.dispatch_graph!;
  const replaying = state.graphReplayCount !== null;
  const graph = replaying ? projectDispatchReplay(source, state.graphReplayCount!) : source;
  const event = replaying ? graph.timeline.at(-1) : undefined;
  const running = new Set(replaying ? event ? [event.to_node] : [] : snap.workers.filter((w) => w.state === "working").map((w) => w.name));
  const liveEdges = new Set(graph.edges.filter((edge) => {
    if (edge.mode !== "actual" || !running.has(edge.to)) return false;
    if (event) return graphEventKey(edge.from, edge.to, edge.kind) === graphEventKey(event.from_node, event.to_node, event.kind);
    const worker = snap.workers.find((w) => w.name === edge.to);
    return !source.backfilled && worker?.latest_turn?.status === "running" && edge.seq != null &&
      edge.seq === worker.latest_turn.trigger_seq && (edge.kind === "dispatch" || edge.kind === "handoff");
  }).map((edge) => edge.id));
  const mode = replaying ? "actual" : state.graphFilterMode;
  const selectedNode = state.selectedGraphNodeId
    ? graph.nodes.find((n) => n.id === state.selectedGraphNodeId) ?? null
    : null;
  const selectedEdge =
    !selectedNode && state.selectedGraphEdgeId
      ? graph.edges.find((e) => e.id === state.selectedGraphEdgeId && (mode === "all" || e.mode === mode)) ?? null
      : null;
  return { source, replaying, graph, event, running, liveEdges, mode, selectedNode, selectedEdge };
}

function renderGraph(snap: DashboardSnapshot): string {
  if (!snap.dispatch_graph) return `<div class="panel-card muted">${tr("暂无协同记录。", "No collaboration recorded yet.")}</div>`;
  const { source, replaying, graph, event, running, liveEdges, mode, selectedNode, selectedEdge } = computeGraphCanvasRender(snap);
  const s = source.summary;
  const filterBtn = (filterMode: GraphFilterMode, label: string) =>
    `<button type="button" class="filter-pill ${state.graphFilterMode === filterMode ? "active" : ""}" data-action="set-graph-filter" data-graph-filter="${filterMode}" aria-pressed="${state.graphFilterMode === filterMode}">${label}</button>`;

  let inspectorHtml = "";
  if (selectedNode) {
    const inEdges = graph.edges.filter((e) => e.to === selectedNode.id);
    const outEdges = graph.edges.filter((e) => e.from === selectedNode.id);
    const formatEdgeChip = (e: typeof graph.edges[number], dir: "in" | "out") =>
      `<button type="button" class="graph-io-chip badge ${edgeKindCssClass(e.kind)}" data-action="select-graph-edge" data-edge-id="${esc(e.id)}">${dir === "in" ? `${esc(e.from)} →` : `→ ${esc(e.to)}`} · ${esc(graphEdgeKindLabel(e.kind))}${e.mode === "planned" ? " (规划)" : ""}</button>`;
    inspectorHtml = `<div class="panel-card graph-inspector">
      <div class="section-head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong>${esc(selectedNode.label)}</strong>
          <span class="badge">${esc(selectedNode.kind)} · ${esc(selectedNode.state)}</span>
          ${selectedNode.policy_source ? `<span class="layer-pill ${policyLayerBadgeClass(selectedNode.policy_source)}">${esc(policyLayerLabel(selectedNode.policy_source))}</span>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${
            selectedNode.kind === "worker"
              ? `<button type="button" class="btn btn-primary btn-sm-pad" data-action="jump-worker" data-worker="${esc(selectedNode.id)}">${tr("跳转会话 ↗", "Open session ↗")}</button>`
              : ""
          }
          <button type="button" class="btn btn-sm-pad" data-action="graph-clear-selection" aria-label="${tr("关闭检查器", "Close inspector")}">×</button>
        </div>
      </div>
      <div class="kv-grid" style="margin-bottom:8px;">
        <div class="kv-cell"><span class="kv-label">${tr("调度身份:", "Identity:")}</span><span class="kv-val">${esc(selectedNode.identity_id || "-")}</span></div>
        <div class="kv-cell"><span class="kv-label">${tr("后端/模型:", "Backend / model:")}</span><span class="kv-val">${esc(selectedNode.backend || "-")}${selectedNode.model ? ` / ${esc(selectedNode.model)}` : ""}</span></div>
        <div class="kv-cell"><span class="kv-label">${tr("工作区:", "Workspace:")}</span><span class="kv-val">${esc(selectedNode.worktree_branch || selectedNode.workspace_mode || "-")}</span></div>
        <div class="kv-cell"><span class="kv-label">${tr("消耗/审校:", "Usage / review:")}</span><span class="kv-val">${esc(selectedNode.turns ?? 0)} ${tr("轮", "turns")} · ${esc(fmtCompactTokens(selectedNode.total_tokens ?? 0))} tokens${selectedNode.review_status ? ` · ${esc(selectedNode.review_status)}` : ""}</span></div>
      </div>
      <div class="graph-io-rows">
        <div><span class="muted">${tr("入边", "Inbound")} (${inEdges.length}):</span> ${inEdges.length > 0 ? inEdges.map((e) => formatEdgeChip(e, "in")).join(" ") : `<span class="muted">${tr("无", "None")}</span>`}</div>
        <div><span class="muted">${tr("出边", "Outbound")} (${outEdges.length}):</span> ${outEdges.length > 0 ? outEdges.map((e) => formatEdgeChip(e, "out")).join(" ") : `<span class="muted">${tr("无", "None")}</span>`}</div>
      </div>
    </div>`;
  } else if (selectedEdge) {
    inspectorHtml = `<div class="panel-card graph-inspector">
      <div class="section-head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong><button type="button" class="link-btn graph-node-jump" data-action="select-graph-node" data-node-id="${esc(selectedEdge.from)}">${esc(selectedEdge.from)}</button> → <button type="button" class="link-btn graph-node-jump" data-action="select-graph-node" data-node-id="${esc(selectedEdge.to)}">${esc(selectedEdge.to)}</button></strong>
          <span class="badge ${edgeKindCssClass(selectedEdge.kind)}">${esc(graphEdgeKindLabel(selectedEdge.kind))}</span>
          <span class="badge">${selectedEdge.mode === "planned" ? tr("预规划连线", "Planned") : `${tr("实际发生", "Actual")} ×${selectedEdge.count}`}</span>
          ${selectedEdge.source_layer ? `<span class="layer-pill ${policyLayerBadgeClass(selectedEdge.source_layer)}">${esc(policyLayerShortLabel(selectedEdge.source_layer))}</span>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${
            selectedEdge.seq
              ? `<button type="button" class="btn btn-primary btn-sm-pad" data-action="scroll-seq" data-seq="${selectedEdge.seq}">${tr(`定位群聊 #${selectedEdge.seq} ↗`, `Locate #${selectedEdge.seq} ↗`)}</button>`
              : ""
          }
          <button type="button" class="btn btn-sm-pad" data-action="graph-clear-selection" aria-label="${tr("关闭检查器", "Close inspector")}">×</button>
        </div>
      </div>
      <div class="muted">${esc(selectedEdge.label || tr("无附加说明", "No additional notes"))}${selectedEdge.created_at ? ` · ${fmtTime(selectedEdge.created_at)}` : ""}</div>
    </div>`;
  }

  const total = source.timeline.length;
  const activeCount = snap.workers.filter((w) => w.state === "working").length;
  const status = replaying ? tr("事件回放", "Event replay") : source.backfilled ? tr("历史重建", "Reconstructed history")
    : isReadOnly() ? tr("历史记录", "Recorded history") : tr("实时更新", "Live updates");
  const focusChipLabel = selectedNode
    ? tr(`聚焦 ${selectedNode.id === "coordinator" ? "主会话" : `@${selectedNode.label}`}`, `Focus ${selectedNode.label}`)
    : selectedEdge
      ? tr(`聚焦 ${selectedEdge.from} → ${selectedEdge.to}`, `Focus ${selectedEdge.from} → ${selectedEdge.to}`)
      : "";
  const zoomPct = Math.round(state.graphZoom * 100);

  return `<section class="flow-graph">
    <div class="panel-card graph-stage-card">
      <header class="graph-command-bar">
        <div><span class="graph-caption">${tr("本轮调度记录", "DISPATCH TELEMETRY")}</span><h2>${tr("协同脉络", "Collaboration")}</h2></div>
        <span class="graph-source${status === tr("实时更新", "Live updates") && activeCount ? " is-live" : ""}"><i></i>${status}</span>
      </header>
      <div class="graph-controls">
        ${replaying ? `<div class="graph-replay-label">${tr("事件回放", "Replay")} <b>${graph.timeline.length} / ${total}</b></div>`
          : `<div class="filter-pills" role="group" aria-label="${tr("显示连线", "Show connections")}">
            ${filterBtn("actual", tr("实际", "Actual"))}${filterBtn("all", tr("叠加", "Overlay"))}${filterBtn("planned", tr("规划", "Planned"))}</div>`}
        <div class="graph-player">
          ${total ? `<button type="button" class="btn btn-sm-pad" data-action="graph-replay">${graphReplayTimer !== null ? tr("Ⅱ 暂停", "Ⅱ Pause") : replaying && graph.timeline.length < total ? tr("▷ 继续", "▷ Resume") : tr("▷ 回放", "▷ Replay")}</button>` : ""}
          ${replaying ? `<button type="button" class="btn btn-sm-pad" data-action="graph-step" ${graph.timeline.length >= total ? "disabled" : ""}>${tr("下一步", "Step")}</button><button type="button" class="btn btn-sm-pad" data-action="graph-replay-exit">${tr("退出", "Exit")}</button>` : ""}
        </div>
      </div>
      <div class="graph-hud-strip" aria-label="${replaying ? tr("回放遥测条", "Replay telemetry") : tr("本轮概况", "Wave overview")}">
        ${
          replaying
            ? `<div class="graph-hud-event">
                ${
                  event
                    ? `<span class="badge ${edgeKindCssClass(event.kind)}">${getLanguage() === "en" ? esc(event.kind.replaceAll("_", " ")) : esc(graphEdgeKindLabel(event.kind))}</span>
                      <span class="graph-event-route">${esc(boardSenderLabel(event.from_node))} → ${esc(boardSenderLabel(event.to_node))}</span>
                      ${event.seq ? `<button class="md-seq-ref" type="button" data-action="scroll-seq" data-seq="${esc(event.seq)}">#${esc(event.seq)} ↗</button>` : ""}
                      <time class="muted">${esc(fmtTime(event.created_at))}</time>`
                    : `<span class="muted">${tr("从本轮第一条记录开始", "Starting at the first recorded event")}</span>`
                }
              </div>
              <div class="graph-hud-scrubber">
                <input type="range" class="graph-replay-range" data-graph-scrub min="0" max="${total}" value="${graph.timeline.length}" aria-label="${tr("拖动回放进度", "Scrub replay progress")}" />
                <span class="graph-scrub-count">${graph.timeline.length} / ${total}</span>
              </div>`
            : `<div class="graph-hud-kpis">
                <span><b>${s.worker_count}</b><i>${tr("成员", "Members")}</i></span>
                <span class="${activeCount > 0 ? "is-active" : ""}"><b>${activeCount}</b><i>${tr("执行中", "Running")}</i></span>
                <span><b>${total}</b><i>${tr("记录", "Events")}</i></span>
              </div>
              <span class="graph-hud-sep" aria-hidden="true"></span>
              <div class="graph-hud-pills">
                <span><i class="dot" style="background:var(--ok);"></i>${tr("通过", "Accepted")} <b>${s.review_pass_count}</b></span>
                <span><i class="dot" style="background:var(--info);"></i>${tr("待审", "Pending")} <b>${s.pending_review_count}</b></span>
                <span><i class="dot" style="background:var(--err);"></i>${tr("打回", "Returned")} <b>${s.review_fail_count}</b></span>
                <span><i class="dot" style="background:var(--ok);"></i>${tr("合并", "Merged")} <b>${s.merge_count}</b></span>
              </div>`
        }
      </div>
      <div class="graph-canvas-shell">
        <span class="graph-corner graph-corner-tl" aria-hidden="true"></span>
        <span class="graph-corner graph-corner-tr" aria-hidden="true"></span>
        <span class="graph-corner graph-corner-bl" aria-hidden="true"></span>
        <span class="graph-corner graph-corner-br" aria-hidden="true"></span>
        ${focusChipLabel ? `<button type="button" class="graph-focus-chip" data-action="graph-clear-selection" title="${tr("清除聚焦", "Clear focus")}"><span>${esc(focusChipLabel)}</span><span class="graph-focus-clear">× ${tr("清除", "Clear")}</span></button>` : ""}
        <div class="graph-viewport-hud" role="group" aria-label="${tr("画布缩放控制", "Canvas zoom controls")}">
          <button type="button" data-action="graph-zoom-out" title="${tr("缩小", "Zoom out")}" aria-label="${tr("缩小", "Zoom out")}">−</button>
          <button type="button" data-action="graph-zoom-reset" title="${tr("重置为 100%", "Reset zoom to 100%")}">${zoomPct}%</button>
          <button type="button" data-action="graph-zoom-in" title="${tr("放大", "Zoom in")}" aria-label="${tr("放大", "Zoom in")}">+</button>
          <button type="button" data-action="graph-zoom-fit" aria-pressed="${state.graphFitMode}" title="${tr("自适应视口", "Fit to viewport")}">${tr("适应", "Fit")}</button>
        </div>
        <div class="graph-canvas-wrap" tabindex="0" aria-label="${tr("协同画布，可滚动或拖拽查看", "Scrollable and pannable collaboration canvas")}">
          ${renderDispatchGraphSvg(graph, {
            filterMode: mode,
            selectedNodeId: selectedNode?.id,
            selectedEdgeId: selectedEdge?.id,
            activeEdgeIds: liveEdges,
            pulseNodeIds: running,
            zoom: state.graphZoom,
          })}
        </div>
      </div>
      <div class="graph-legend">
        <span><i class="legend-line" style="background:var(--info);"></i>${tr("派发 / 交接", "Dispatch / handoff")}</span>
        <span><i class="legend-line" style="background:var(--ok);"></i>${tr("通过 / 合并", "Accept / merge")}</span>
        <span><i class="legend-line" style="background:var(--warn);"></i>${tr("审校 / 切换", "Review / switch")}</span>
        <span><i class="legend-line" style="background:var(--err);"></i>${tr("打回", "Returned")}</span>
        <span><i class="legend-line is-dashed"></i>${tr("规划", "Planned")}</span>
        <button type="button" class="link-btn graph-settings-link" data-action="go-settings">${tr("配置拓扑 ›", "Configure topology ›")}</button>
      </div>
    </div>
    ${inspectorHtml}
    </section>`;
}

function renderFloatingTeamDock(snap: DashboardSnapshot, global: boolean): string {
  if (global || state.activeTab === "board" || !snap.swarm || snap.workers.length === 0) return "";
  const workers = snap.workers;
  const workingCount = workers.filter((w) => w.state === "working").length;
  const hasBottomComposer = state.activeTab === "detail" && state.workerDetailOpen && state.detailViewMode === "chat";
  const extraCount = Math.max(0, workers.length - 4);
  const stack = workers
    .slice(0, 4)
    .map((w) =>
      renderEmployeeAvatarSvg({
        backend: w.backend,
        model: w.model,
        name: w.name,
        role: w.role,
        size: 22,
        animated: false,
      }),
    )
    .join("");
  const metaText =
    workingCount > 0
      ? tr(`${workingCount} 运行中`, `${workingCount} running`)
      : snap.swarm.status === "done"
        ? tr("已完成", "done")
        : tr("待命中", "idle");
  const popover = state.teamDockOpen
    ? `<section class="team-dock-popover" role="dialog" aria-label="${tr("团队成员", "Team members")}">
        <header class="team-dock-head">
          <span>${esc(workers.length)} ${tr("位团队成员", "team members")}</span>
          <button type="button" class="btn btn-icon" data-action="close-team-dock" aria-label="${esc(t("cancel"))}">×</button>
        </header>
        <div class="team-dock-list">
          ${workers
            .map((w) => {
              const model = w.model ?? snap.effective_defaults[w.backend]?.model ?? "CLI";
              const roleText = w.identity_id ?? w.role;
              const statusText =
                w.state === "working"
                  ? t("running")
                  : w.state === "waiting"
                    ? t("idle")
                    : t(w.state);
              return `<button type="button" class="team-dock-row ${state.selectedWorkerName === w.name ? "active" : ""}" data-action="dock-jump-worker" data-worker="${esc(w.name)}">
                ${renderEmployeeAvatarSvg({ backend: w.backend, model: w.model, name: w.name, role: w.role, size: 28, animated: false })}
                <span class="team-dock-copy">
                  <strong>@${esc(w.name)}</strong>
                  <small>${esc(w.backend)} · ${esc(model)} · ${esc(roleText)}</small>
                </span>
                <span class="team-dock-state st-${esc(w.state)}">${esc(statusText)}</span>
              </button>`;
            })
            .join("")}
        </div>
      </section>`
    : "";
  return `<div class="floating-team-dock ${hasBottomComposer ? "above-composer" : ""}">
    ${popover}
    <button type="button" class="team-dock-pill" data-action="toggle-team-dock" aria-expanded="${state.teamDockOpen}">
      <span class="team-dock-avatars" aria-hidden="true">${stack}${extraCount > 0 ? `<span class="team-dock-more">+${esc(extraCount)}</span>` : ""}</span>
      <span class="team-dock-label">${esc(workers.length)} ${tr("位团队成员", "team members")}</span>
      <span class="team-dock-meta">${esc(metaText)}</span>
      <span class="team-dock-arrow" aria-hidden="true">${state.teamDockOpen ? "▾" : "▴"}</span>
    </button>
  </div>`;
}

function renderTeamDrawer(snap: DashboardSnapshot): string {
  if (!state.historyDrawerOpen) return "";
  const currentTeam = snap.team?.id;
  const otherTeams = (snap.teams ?? []).filter((entry) => entry.team.id !== currentTeam);
  return `<div class="drawer-scrim"><section class="panel-card team-drawer" role="dialog" aria-modal="true" aria-labelledby="team-drawer-title">
    <header class="section-head"><h2 id="team-drawer-title">${esc(t("switchTeam"))}</h2><button type="button" class="btn btn-icon" data-action="toggle-team-drawer" aria-label="${esc(t("cancel"))}">×</button></header>
    ${pendingHandoff ? `<div class="panel-card handoff-note"><p>${tr("宿主未接收团队上下文。可以复制后粘贴到主对话。", "The host did not receive the team context. Copy it into the main chat.")}</p><button type="button" class="btn" data-action="copy-handoff">${esc(t("copyHandoff"))}</button></div>` : ""}
    ${renderTeamSummaryPreview(snap, { history: state.historyBrowsingMode, canManage: canManageCurrentTeam(snap), busy: teamBusy })}
    <section class="team-other" aria-labelledby="team-other-title">
      <h3 id="team-other-title">${tr("切换到其他团队", "Switch to another team")}</h3>
      <p class="muted">${otherTeams.length ? tr("只读回看不会改变本会话的团队关联。", "Viewing history does not change this chat’s team.") : tr("暂无其他团队。", "There are no other teams.")}</p>
      ${otherTeams.length ? `<div class="project-history-grid">${renderTeamCards(otherTeams, { busy: teamBusy, currentTeam: state.selectedTeamId, density: "rail", intent: "attach" })}</div>` : ""}
    </section>
  </section></div>`;
}

interface ScrollCapture {
  selector: string;
  scrollTop: number;
  scrollLeft: number;
  followBottom: boolean;
}

const ALL_SCROLL_SELECTORS = [
  ".tab-scroll-pane",
  ".employee-detail",
  ".flow-pane",
  ".campus-layout",
  ".campus-stage-card",
  ".campus-inspector",
  ".graph-canvas-wrap",
  ".team-drawer",
  ".team-dock-list",
  ".board-list",
  ".blackboard-list",
  ".chat-people",
  ".candidate-drawer",
  ".staff-editor-modal",
] as const;

const ALL_SCROLL_SELECTOR = ALL_SCROLL_SELECTORS.join(", ");

function captureScrollPositions(): ScrollCapture[] {
  const captured: ScrollCapture[] = [];
  for (const selector of ALL_SCROLL_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
    const followBottom = atBottom && selector === ".board-list";
    captured.push({ selector, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, followBottom });
  }
  return captured;
}

function applyScrollPositionsOnce(captured: ScrollCapture[]): void {
  isRestoringScroll = true;
  try {
    for (const item of captured) {
      const el = document.querySelector<HTMLElement>(item.selector);
      if (!el) continue;
      el.scrollTop = item.followBottom ? el.scrollHeight : item.scrollTop;
      el.scrollLeft = item.scrollLeft;
    }
  } finally {
    isRestoringScroll = false;
  }
}

function restoreScrollPositions(captured: ScrollCapture[], expectedPage: string): void {
  if (captured.length === 0) return;
  applyScrollPositionsOnce(captured);
  const stampAtRestore = lastUserScrollAt;
  window.requestAnimationFrame(() => {
    const root = document.getElementById(dashboardRootId);
    if (!root || root.dataset.page !== expectedPage) return;
    if (lastUserScrollAt !== stampAtRestore) return;
    applyScrollPositionsOnce(captured);
  });
}

interface SavedInputState {
  id: string;
  value: string;
  focused: boolean;
  selStart: number | null;
  selEnd: number | null;
}

function captureInputStates(ids: string[]): SavedInputState[] {
  const out: SavedInputState[] = [];
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) continue;
    out.push({
      id,
      value: el.value,
      focused: document.activeElement === el,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd,
    });
  }
  return out;
}

function restoreInputStates(saved: SavedInputState[]): void {
  for (const item of saved) {
    const el = document.getElementById(item.id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) continue;
    el.value = item.value;
    if (el.tagName === "TEXTAREA") {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
    }
    if (item.focused && !el.disabled) {
      el.focus({ preventScroll: true });
      if (item.selStart !== null && item.selEnd !== null) {
        el.setSelectionRange(item.selStart, item.selEnd);
      }
    }
  }
}

function render(boardJumpSeq?: number): void {
  const root = document.getElementById(dashboardRootId);
  if (!root) return;
  const snap = state.snapshot;
  if (!snap) {
    root.innerHTML = `<div class="app-shell"><div class="panel-card">Loading Poly Swarm…</div></div>`;
    return;
  }
  const scroll = captureScrollPositions();
  const sameSwarm = root.dataset.renderedSwarm === (snap.swarm?.id ?? "");
  const sameEmployee = sameSwarm && root.dataset.renderedWorker === state.selectedWorkerName;
  const sameEmployeeView = sameEmployee && root.dataset.renderedDetailMode === state.detailViewMode;
  const sameVendor = root.dataset.renderedVendor === state.selectedVendor;
  const saved = captureInputStates([
    ...(sameSwarm ? ["board-input", "board-search-input"] : []),
    ...(sameEmployee ? ["chat-reply-input"] : []),
    "staff-search", "archive-search", "archive-rename-input", "team-wave-title", "team-name-input", "candidate-reason", "candidate-resume",
    ...(root.dataset.candidateBackend === state.candidateBackend ? ["candidate-model", "candidate-effort"] : []),
  ]).filter((item) => !item.id.startsWith("candidate-") || (sameSwarm && root.dataset.candidateWorker === state.switchTargetWorker));
  root.dataset.renderedSwarm = snap.swarm?.id ?? "";
  root.dataset.renderedWorker = state.selectedWorkerName ?? "";
  root.dataset.renderedDetailMode = state.detailViewMode;
  root.dataset.renderedVendor = state.selectedVendor;
  root.dataset.candidateWorker = state.switchTargetWorker ?? "";
  root.dataset.candidateBackend = state.candidateBackend ?? "";
  const openDetails = [...root.querySelectorAll("details")].map((item) => item.open);
  const previousPage = root.dataset.page ?? "";
  closeMentionPopover();
  const global = currentSurface() === "global";
  const page = global ? `${state.globalTab}:${state.globalHrSection}` : state.activeTab;
  root.dataset.page = page;
  const localBuildId = getBuildId();
  const readonly = !global && isReadOnly();
  const nav = (entries: readonly (readonly [string, string])[], current: string, data: string) =>
    `<nav class="top-nav" aria-label="${tr("导航", "Navigation")}">${entries.map(([id, key]) => `<button type="button" class="nav-tab ${current === id ? "active" : ""}" ${data}="${esc(id)}" aria-current="${current === id ? "page" : "false"}">${esc(t(key))}</button>`).join("")}</nav>`;
  const globalPillNav = `<nav class="global-pill-nav" aria-label="${esc(t("humanResources"))}">${([
    ["hr", "talentCampus", "campusShort", "🏢"],
    ["history", "projectArchive", "historyShort", "🗂"],
    ["settings", "hqSettings", "settingsShort", "⚙"],
  ] as const).map(([id, wideKey, narrowKey, icon]) => `<button type="button" class="global-pill-btn ${state.globalTab === id ? "active" : ""}" data-global-tab="${id}" aria-current="${state.globalTab === id ? "page" : "false"}"><span aria-hidden="true">${icon}</span><span class="label-wide">${esc(t(wideKey))}</span><span class="label-narrow">${esc(t(narrowKey))}</span></button>`).join("")}</nav>`;

  const globalOnlineCount = REAL_BACKENDS.filter((id) => {
    const cfg = snap.backend_configs?.[id];
    const h = snap.backends.find((b) => b.backend === id);
    return cfg?.enabled !== false && h?.installed === 1 && !(h.cooldown_until && h.cooldown_until > Date.now());
  }).length;
  const vendorSummaryRows = Object.values(snap.global_usage_by_vendor ?? {});
  const globalUsageRows = snap.global_usage_by_backend ?? [];
  const globalTotalTokens = vendorSummaryRows.length > 0
    ? vendorSummaryRows.reduce((s, r) => s + (r?.totals.total_tokens ?? 0), 0)
    : globalUsageRows.reduce((s, r) => s + r.total_tokens, 0);
  const globalTotalUsd = vendorSummaryRows.length > 0
    ? vendorSummaryRows.reduce((s, r) => s + ((r?.totals.priced_turns ?? 0) > 0 ? r!.totals.known_cost_usd : 0), 0)
    : globalUsageRows.reduce((s, r) => s + (r.priced_turns ? (r.known_cost_usd ?? 0) : 0), 0);
  const globalPriced = vendorSummaryRows.length > 0
    ? vendorSummaryRows.some((r) => (r?.totals.priced_turns ?? 0) > 0)
    : globalUsageRows.some((r) => (r.priced_turns ?? 0) > 0);
  const globalLivePill = `<span class="campus-live-pill"><i class="dot dot-ok" aria-hidden="true"></i><span>${esc(globalOnlineCount)}/${REAL_BACKENDS.length} ${esc(t("online"))} CLI</span><span>·</span><span>${esc(fmtCompactTokens(globalTotalTokens))} tokens</span>${globalPriced ? `<span>·</span><span>$${esc(globalTotalUsd.toFixed(2))}</span>` : ""}</span>`;
  const canBackToSession = state.surfaceMode !== "global" && state.globalOverride;

  const mainNav = global ? "" : nav([["detail","workbench"],["graph","flow"],["board","chat"],["usage","people"]], state.activeTab, "data-tab");
  const view = global
    ? state.globalTab === "history" ? renderGlobalHistory(snap, {
          query: state.archiveQuery,
          repoFilter: state.archiveRepoFilter,
          sort: state.archiveSort,
          viewMode: state.archiveViewMode,
          selectedConvId: state.selectedArchiveConvId,
          unassignedOpen: state.archiveUnassignedOpen,
          renamingConvId: state.archiveRenamingConvId,
          busy: teamBusy,
          canSendMessage: state.canSendMessage,
          canBackToSession,
          currentConversationId: state.conversationId,
          currentTeamId: state.selectedTeamId,
        })
      : state.globalTab === "settings" ? renderGlobalPreferences(snap, preferencesBusy)
      : state.globalHrSection === "companies" ? renderGlobalCompanies(snap, {
          selectedVendor: state.selectedVendor,
          selectedAgyCompany: state.selectedAgyCompany,
          agyCompanyDraft: state.agyCompanyDraft,
          agyCompanySaving: state.agyCompanySaving,
          agyCompanyModels: state.selectedAgyCompany ? state.agyCompanyModels[state.selectedAgyCompany] : undefined,
          savingBackends: state.savingBackends,
          backendModels: state.backendModels,
          modelsLoading: state.modelsLoading,
          draft: (id) => getEffectiveDraft(snap, id),
          saved: (id) => getSavedBackendConfig(snap, id),
          isDirty: (id) => isBackendDraftDirty(snap, id),
        })
      : state.globalHrSection === "staff" ? renderGlobalStaff(snap, state.backendModels, state.staffFilter, state.staffQuery, state.modelsLoading)
      : renderGlobalRules(snap, { ...state, draft: (id) => getEffectiveDraft(snap, id), saved: (id) => getSavedBackendConfig(snap, id), isDirty: (id) => isBackendDraftDirty(snap, id) })
    : state.activeTab === "detail" ? renderDetail(snap)
    : state.activeTab === "graph" ? renderFlow(snap)
    : state.activeTab === "board" ? renderBoard(snap)
    : snap.swarm ? renderSessionPeople(snap) : renderSessionEmptyCard(snap);

  root.innerHTML = `<div class="app-shell mode-detail company-app ${global ? "is-global-surface" : ""}">
    <header class="topbar ${global ? "global-topbar" : ""}">
      <div class="brand-group">
        ${renderBrandLogoSvg()}<span class="brand-title">Poly Swarm</span>
        ${global ? globalPillNav : state.historyBrowsingMode ? `<span class="swarm-current-pill">${esc(snap.team?.name ?? snap.swarm?.title ?? t("projectHistory"))}</span>` : renderTeamSwitcher(snap, state.selectedTeamId, teamBusy)}
        <div class="brand-controls">
          ${global ? globalLivePill : ""}
          ${state.historyBrowsingMode ? `<button type="button" class="btn btn-sm-pad" data-action="exit-history-mode">${state.historyFromGlobal ? tr("← 返回历史", "← Back to history") : esc(t("backSession"))}</button>`
            : global ? canBackToSession ? `<button type="button" class="btn btn-sm-pad" data-action="back-session"><span class="label-wide">${esc(t("backSession"))}</span><span class="label-narrow">${esc(t("backShort"))}</span></button>` : ""
            : `<button type="button" class="btn btn-sm-pad" data-action="go-global-hr">${esc(t("globalHr"))}</button>`}
          <button type="button" class="btn btn-sm-pad" data-action="toggle-language" aria-label="${esc(t("language"))}">${getLanguage() === "en" ? "EN / 中" : "中 / EN"}</button>
          <button type="button" class="btn btn-icon" data-action="refresh-now" title="${esc(t("refresh"))}">↻</button>
        </div>
      </div>${mainNav}
    </header>
    ${snap.ui_build_id && localBuildId !== "dev" && snap.ui_build_id > localBuildId ? `<div class="update-banner">${tr("插件已更新，请重新打开面板。", "Plugin updated. Reopen this panel.")} ${esc(snap.ui_build_id)}</div>` : ""}
    ${readonly ? `<div class="readonly-banner">${esc(t("readonly"))}${snap.read_only_reason ? ` · ${esc(snap.read_only_reason)}` : ""}</div>` : ""}
    ${view}${renderTeamDrawer(snap)}${renderCandidateDrawer()}${renderStaffEditorModal({
      draft: state.staffEditorDraft,
      catalog: state.backendModels,
      busy: state.staffSaving,
      loadingModels: state.modelsLoading,
      agyCompanies: snap.agy_companies,
      agyCompanyModels: state.staffEditorDraft?.company_id ? state.agyCompanyModels[state.staffEditorDraft.company_id] : undefined,
      identities: snap.dispatch_policy?.identities,
    })}${renderAgyCompanyImport({
      open: state.agyImportOpen, loading: state.agyImportLoading, failed: state.agyImportFailed,
      saving: state.agyCompanySaving, accounts: state.agyImportAccounts, companies: snap.agy_companies ?? [],
      picked: state.agyImportPicked,
    })}${renderFloatingTeamDock(snap, global)}${state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ""}
  </div>`;
  state.lastRenderDigest = computeRenderDigest();
  bindDomEvents();
  restoreInputStates(saved);
  if (previousPage === page && (global || sameSwarm)) {
    root.querySelectorAll("details").forEach((item, i) => { if (openDetails[i] !== undefined) item.open = openDetails[i]!; });
    let filteredScroll = sameEmployeeView ? scroll : scroll.filter(({ selector }) => selector !== ".employee-detail");
    if (boardJumpSeq !== undefined) filteredScroll = filteredScroll.filter(({ selector }) => selector !== ".board-list");
    if (global && page === "hr:companies" && !sameVendor) {
      filteredScroll = filteredScroll.filter(({ selector }) => selector !== ".campus-inspector");
    }
    restoreScrollPositions(filteredScroll, page);
  }
  const board = document.querySelector<HTMLElement>(".board-list");
  if (board && boardJumpSeq !== undefined) {
    const target = board.querySelector<HTMLElement>(`.board-item[data-seq="${boardJumpSeq}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      board.scrollTop += target.getBoundingClientRect().top - board.getBoundingClientRect().top - 8;
    }
  } else if (board && (!sameSwarm || previousPage !== page)) {
    board.scrollTop = board.scrollHeight;
  }
}

async function sendWorkerFollowUp(workerName: string): Promise<void> {
  if (isReadOnly()) {
    showToast(t("readonly"));
    return;
  }
  const swarmId = state.snapshot?.swarm?.id;
  const inp = document.getElementById("chat-reply-input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const raw = inp?.value.trim();
  if (!raw || !swarmId) return;

  const escaped = workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasMention = new RegExp(`(?:^|[^a-zA-Z0-9._-])@${escaped}(?=$|[\\s,:：])`, "i").test(raw);
  const outgoing = hasMention ? raw : `@${workerName} ${raw}`;
  const workerSummary = state.snapshot?.workers.find((x) => x.name === workerName);
  const ch = workerSummary?.channels[0] || "main";

  try {
    await callBackendTool(
      "app_board_post",
      { swarm_id: swarmId, text: outgoing, channel: ch },
      { method: "POST", url: "/api/board" },
    );
    if (inp) {
      inp.value = "";
      inp.style.height = "auto";
    }
    showToast(`已发送给 @${workerName}`);
    await refreshDashboard();
  } catch (err) {
    showToast(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function postBoardMessage(): Promise<void> {
  if (isReadOnly()) {
    showToast(t("readonly"));
    return;
  }
  const swarmId = state.snapshot?.swarm?.id;
  const inp = document.getElementById("board-input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const text = inp?.value.trim();
  if (!text || !swarmId) return;
  const ch = state.boardChannelFilter === "*" ? "main" : state.boardChannelFilter;
  try {
    await callBackendTool(
      "app_board_post",
      { swarm_id: swarmId, text, channel: ch, suppress_wake: state.silentPost },
      { method: "POST", url: "/api/board" },
    );
    if (inp) {
      inp.value = "";
      inp.style.height = "auto";
    }
    closeMentionPopover();
    showToast("已发送到群聊");
    await refreshDashboard();
  } catch (err) {
    showToast(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function closeMentionPopover(): void {
  mentionPopup.open = false;
  mentionPopup.trigger = null;
  mentionPopup.items = [];
  mentionPopup.activeIndex = 0;
  const pop = document.getElementById("mention-popover");
  if (pop) {
    pop.classList.add("hidden");
    pop.innerHTML = "";
  }
}

function renderMentionPopover(): void {
  const pop = document.getElementById("mention-popover");
  if (!pop) return;
  if (!mentionPopup.open || mentionPopup.items.length === 0) {
    pop.classList.add("hidden");
    pop.innerHTML = "";
    return;
  }

  pop.classList.remove("hidden");
  const rowsHtml = mentionPopup.items
    .map((item, idx) => {
      const active = idx === mentionPopup.activeIndex;
      const worker = state.snapshot?.workers.find((w) => `@${w.name}` === item.insertText);
      return `<button type="button" class="mention-option ${active ? "active" : ""}" role="option" aria-selected="${active}" data-mention-idx="${idx}">
        ${worker ? renderEmployeeAvatarSvg({ backend: worker.backend, model: worker.model, name: worker.name, role: worker.role, size: 32 }) : `<span class="avatar-circle avatar-sm">#</span>`}
        <span class="mention-opt-text">
          <span class="mention-opt-label">${esc(item.label)}</span>
          <span class="mention-opt-sub">${worker ? `<i class="dot ${stateDotClass(worker.state)}"></i> ${esc(roleLabel(worker.role, worker.capability))} · ${esc(worker.backend)} · ${esc(worker.model ?? "CLI")}` : esc(t("channel"))}</span>
        </span>
      </button>`;
    })
    .join("");

  pop.innerHTML = `
    <div class="mention-list">${rowsHtml}</div>
    <div class="mention-hint">↑↓ 选择 · Enter / Tab 确认 · Esc 关闭</div>
  `;

  pop.querySelector<HTMLElement>(".mention-option.active")?.scrollIntoView({ block: "nearest" });
  pop.querySelectorAll<HTMLButtonElement>(".mention-option").forEach((optBtn) => {
    optBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const idx = Number(optBtn.dataset.mentionIdx);
      if (!Number.isNaN(idx)) {
        selectMentionCandidate(idx);
      }
    });
  });
}

function refreshMentionFromInput(inp: HTMLInputElement | HTMLTextAreaElement): void {
  if (mentionBlurTimer) {
    window.clearTimeout(mentionBlurTimer);
    mentionBlurTimer = null;
  }
  const snap = state.snapshot;
  if (!snap) {
    closeMentionPopover();
    return;
  }
  const cursor = inp.selectionStart ?? inp.value.length;
  const trigger = detectMentionTrigger(inp.value, cursor);
  if (!trigger) {
    closeMentionPopover();
    return;
  }
  const allCandidates = buildMentionCandidates({
    workers: snap.workers,
    channels: snap.channels,
    effectiveDefaults: snap.effective_defaults,
    avatarFor,
    stateLabel: (status) => t(status === "working" ? "running" : status),
  });
  const items = filterMentionCandidates(allCandidates, trigger.query);
  if (items.length === 0) {
    closeMentionPopover();
    return;
  }
  mentionPopup.open = true;
  mentionPopup.trigger = trigger;
  mentionPopup.items = items;
  mentionPopup.activeIndex = Math.min(mentionPopup.activeIndex, items.length - 1);
  renderMentionPopover();
}

function selectMentionCandidate(index: number): void {
  const inp = document.getElementById("board-input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const item = mentionPopup.items[index];
  const trigger = mentionPopup.trigger;
  if (!inp || !item || !trigger) {
    closeMentionPopover();
    return;
  }
  const { nextValue, nextCursor } = applyMentionSelection(inp.value, trigger, item.insertText);
  inp.value = nextValue;
  inp.focus();
  inp.setSelectionRange(nextCursor, nextCursor);
  closeMentionPopover();
}

async function jumpToWorker(swarmId: string, worker: string): Promise<void> {
  state.activeTab = "detail";
  state.workerDetailOpen = true;
  state.detailViewMode = "chat";
  state.workerDetail = null;
  if (state.selectedWorkerName !== worker) state.chatEventPages.clear();
  state.selectedWorkerName = worker;
  state.selectedTurnId = null;
  state.turnEvents = [];
  state.showPatch = false;
  render();
  await syncFocusToServer({ swarm_id: swarmId, worker_name: worker, tab: "detail" });
  try {
    await refreshWorkerDetail(swarmId, worker, true);
    render();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

function scrollToBoardSeq(seq: number): void {
  state.activeTab = "board";
  state.userSelectedTab = true;
  if (![...(state.snapshot?.board_tail ?? []), ...(state.snapshot?.blackboard_messages ?? [])].some((m) => m.seq === seq)) {
    showToast(`当前群聊快照中未找到 #${seq}`);
    render();
    return;
  }
  // Ensure message isn't hidden behind active tag/channel/search filters
  state.boardSearchQuery = "";
  state.boardTagFilter = "all";
  state.boardChannelFilter = "*";
  state.boardSenderFilter = null;
  state.highlightedSeq = seq;
  state.boardLocatedSeq = seq;
  state.expandedBoardSeqs.add(seq);
  state.blackboardOpen = false;
  if (highlightTimer) window.clearTimeout(highlightTimer);
  render(seq);
  highlightTimer = window.setTimeout(() => {
    if (state.highlightedSeq === seq) {
      state.highlightedSeq = null;
      document.querySelector(`.board-item[data-seq="${seq}"]`)?.classList.remove("is-highlight");
    }
  }, 2200);
}

function autoSizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
}

function buildStaffDraft(mode: "create" | "edit", existing?: StaffRosterMember | null): StaffEditorDraft {
  if (existing) {
    return {
      mode: "edit",
      id: existing.id,
      name: existing.name,
      title: existing.title,
      avatar: existing.avatar,
      backend: existing.backend,
      model: existing.model,
      effort: existing.effort ?? "",
      role: existing.role,
      capability: existing.capability,
      identity_id: existing.identity_id ?? "",
      company_id: existing.company_id ?? "",
      legacyAgy: existing.backend === "agy" && !existing.company_id,
      bio: existing.bio ?? "",
      enabled: existing.enabled,
    };
  }
  const company = state.snapshot?.agy_companies?.find((entry) => entry.id === state.selectedAgyCompany && entry.enabled);
  const backend: RealBackendId = company ? "agy" : state.selectedVendor === "agy" ? "codex" : state.selectedVendor;
  const firstModel = company ? "" : state.backendModels[backend]?.[0]?.id ?? "";
  const defaultEffort = company ? "" : state.snapshot?.backend_configs?.[backend]?.defaultEffort ?? "medium";
  return {
    mode: "create",
    id: "",
    name: "",
    title: "",
    avatar: backend === "agy" ? "aria" : backend === "grok" ? "theo" : backend === "cursor" ? "jules" : backend === "codebuddy" || backend === "trae" ? "mia" : "leo",
    backend,
    company_id: company?.id,
    model: firstModel,
    effort: defaultEffort,
    role: "author",
    capability: "author",
    identity_id: "",
    bio: "",
    enabled: true,
  };
}

function readRoleSkillPaths(id: string): string[] | null {
  const input = document.getElementById(id) as HTMLTextAreaElement | null;
  const paths = [...new Set((input?.value ?? "").split("\n").map((line) => line.trim()).filter(Boolean))];
  const valid = areRoleSkillPaths(paths);
  input?.setCustomValidity(valid ? "" : tr(`最多填写 ${MAX_ROLE_SKILLS} 条工作区相对路径，每条以 SKILL.md 结尾。`, `Enter up to ${MAX_ROLE_SKILLS} workspace-relative paths ending in SKILL.md.`));
  if (!valid) input?.reportValidity();
  return valid ? paths : null;
}

function syncStaffDraftFromDom(): void {
  const d = state.staffEditorDraft;
  if (!d) return;
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value;
  const name = val("staff-edit-name");
  const title = val("staff-edit-title");
  const selected = val("staff-edit-backend");
  const model = val("staff-edit-model");
  const effort = val("staff-edit-effort");
  const role = val("staff-edit-role") as WorkerRole | undefined;
  const cap = val("staff-edit-cap") as CapabilityTag | undefined;
  const identity = val("staff-edit-identity");
  const bio = val("staff-edit-bio");
  const enabledEl = document.getElementById("staff-edit-enabled") as HTMLInputElement | null;
  if (name !== undefined) d.name = name;
  if (title !== undefined) d.title = title;
  const company = state.snapshot?.agy_companies?.find((entry) => entry.id === selected);
  if (company) {
    d.backend = "agy";
    d.company_id = company.id;
  } else if (selected && REAL_BACKENDS.includes(selected as RealBackendId)) {
    d.backend = selected as RealBackendId;
    d.company_id = "";
  }
  if (model !== undefined) d.model = model;
  if (effort !== undefined) d.effort = effort;
  if (role) d.role = role;
  if (cap) d.capability = cap;
  if (identity !== undefined) d.identity_id = identity;
  if (bio !== undefined) d.bio = bio;
  if (enabledEl) d.enabled = enabledEl.checked;
}

async function loadAgyCompanyAccounts(): Promise<void> {
  if (state.agyImportLoading) return;
  state.agyImportLoading = true;
  state.agyImportFailed = false;
  render();
  try {
    const res = await callBackendTool<{ agy_accounts: AgyAccountOption[]; agy_companies: AgyCompanyView[] }>(
      "app_agy_companies", { op: "list" }, { method: "GET", url: "/api/agy-companies" },
    );
    state.agyImportAccounts = res.agy_accounts;
    if (state.snapshot) state.snapshot.agy_companies = res.agy_companies;
  } catch {
    state.agyImportAccounts = [];
    state.agyImportFailed = true;
  } finally {
    state.agyImportLoading = false;
    render();
  }
}

async function loadAgyCompanyModels(id: string, refresh = false): Promise<void> {
  const previous = state.agyCompanyModels[id];
  if (previous?.loading || (!refresh && previous?.fetchedAt && Date.now() - previous.fetchedAt < 5 * 60_000)) return;
  if (state.staffEditorDraft) syncStaffDraftFromDom();
  state.agyCompanyModels[id] = { models: [], loading: true };
  render();
  try {
    const query = new URLSearchParams({ company_id: id, ...(refresh ? { refresh: "1" } : {}) });
    const result = await callBackendTool<{ company_id: string; models: BackendModelOption[] }>(
      "app_list_backend_models", { company_id: id, refresh }, { method: "GET", url: `/api/backend-models?${query}` },
    );
    if (result.company_id !== id || !Array.isArray(result.models)) {
      throw new Error(tr("当前后台未提供公司模型目录，请重新打开新版插件。", "The current service does not provide company models. Reopen the updated plugin."));
    }
    state.agyCompanyModels[id] = { models: result.models, loading: false, fetchedAt: Date.now() };
  } catch (err) {
    state.agyCompanyModels[id] = { models: [], loading: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (state.staffEditorDraft) syncStaffDraftFromDom();
    render();
  }
}

async function mutateAgyCompany(payload: Record<string, unknown>, onSuccess: (companies: AgyCompanyView[]) => void): Promise<void> {
  if (state.agyCompanySaving) return;
  state.agyCompanySaving = true;
  ++dashboardRequest;
  render();
  try {
    const res = await callBackendTool<{ agy_companies: AgyCompanyView[] }>(
      "app_agy_companies", payload, { method: "POST", url: "/api/agy-companies", body: payload },
    );
    if (state.snapshot) state.snapshot.agy_companies = res.agy_companies;
    onSuccess(res.agy_companies);
  } catch (err) {
    showToast(String(err));
  } finally {
    state.agyCompanySaving = false;
    render();
  }
}

async function mutateStaffRoster(payload: Record<string, unknown>, toastMsg: string): Promise<void> {
  if (state.staffSaving) return;
  state.staffSaving = true;
  render();
  try {
    const res = await callBackendTool<{ staff_roster: StaffRosterMember[] }>(
      "app_staff_roster",
      payload,
      { method: "POST", url: "/api/staff-roster", body: payload },
    );
    if (state.snapshot && Array.isArray(res.staff_roster)) {
      state.snapshot.staff_roster = res.staff_roster;
    }
    state.staffEditorDraft = null;
    showToast(toastMsg);
  } catch (err) {
    showToast(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.staffSaving = false;
    render();
  }
}

function bindDomEvents(): void {
  for (const [formId, inputId, callback] of [
    ["team-new-wave-form", "team-wave-title", (id: string, name: string) => manageTeam("new_wave", id, undefined, name)],
    ["team-rename-form", "team-name-input", renameCurrentTeam],
  ] as const) {
    const form = document.querySelector<HTMLFormElement>(`#${formId}`);
    const input = document.querySelector<HTMLInputElement>(`#${inputId}`);
    input?.addEventListener("input", () => input.setCustomValidity(""));
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input?.value.trim();
      if (name && form.dataset.teamId) void callback(form.dataset.teamId, name);
      else if (input) {
        input.setCustomValidity(tr("请输入名称。", "Enter a name."));
        input.reportValidity();
      }
    });
  }
  document.querySelectorAll<HTMLButtonElement>("[data-global-tab], [data-hr-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.globalTab) state.globalTab = btn.dataset.globalTab as GlobalTab;
      if (btn.dataset.hrSection) state.globalHrSection = btn.dataset.hrSection as GlobalHrSection;
      if (state.globalTab === "hr" && !state.modelsLoaded && !state.modelsLoading) void loadBackendModels(false);
      render();
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-preference]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const key = inp.dataset.preference;
      if (key === "showOfficeBanner" || key === "animatedAvatars" || key === "autoCollapseBannerNarrow") {
        void savePreferences({ [key]: inp.checked });
      }
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-agy-company-account]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = inp.dataset.agyCompanyAccount;
      if (!id) return;
      if (inp.checked) state.agyImportPicked.add(id); else state.agyImportPicked.delete(id);
      render();
    });
  });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-agy-company-field]").forEach((inp) => {
    inp.addEventListener(inp instanceof HTMLSelectElement ? "change" : "input", () => {
      const company = state.snapshot?.agy_companies?.find((entry) => entry.id === state.selectedAgyCompany);
      const field = inp.dataset.agyCompanyField;
      if (!company || (field !== "name" && field !== "model" && field !== "effort")) return;
      const draft = state.agyCompanyDraft?.id === company.id ? state.agyCompanyDraft : {
        id: company.id, name: company.name, model: company.default_model ?? "", effort: company.default_effort ?? "",
      };
      draft[field] = inp.value;
      state.agyCompanyDraft = draft;
      const button = document.querySelector<HTMLButtonElement>('[data-action="save-agy-company"]');
      if (button) button.disabled = state.agyCompanySaving || !draft.name.trim() ||
        (draft.name === company.name && draft.model === (company.default_model ?? "") && draft.effort === (company.default_effort ?? ""));
    });
  });
  const staffBackendSel = document.getElementById("staff-edit-backend") as HTMLSelectElement | null;
  if (staffBackendSel) {
    staffBackendSel.addEventListener("change", () => {
      syncStaffDraftFromDom();
      const d = state.staffEditorDraft;
      if (!d) return;
      const catalogFirst = state.backendModels[d.backend]?.[0]?.id ?? "";
      d.model = d.company_id ? "" : catalogFirst || state.snapshot?.backend_configs?.[d.backend]?.defaultModel || "";
      if (d.company_id) d.effort = "";
      render();
      if (d.company_id) void loadAgyCompanyModels(d.company_id);
      else if (!state.modelsLoaded && !state.modelsLoading) void loadBackendModels(false);
    });
  }
  for (const id of ["staff-edit-role", "staff-edit-identity"]) {
    document.getElementById(id)?.addEventListener("change", () => {
      syncStaffDraftFromDom();
      const draft = state.staffEditorDraft;
      if (id === "staff-edit-role" && draft?.identity_id) {
        const identity = state.snapshot?.dispatch_policy?.identities[draft.identity_id];
        if (identity && identity.base_role !== draft.role) draft.identity_id = "";
      }
      render();
      document.getElementById(id)?.focus({ preventScroll: true });
    });
  }
  const staffModelSel = document.getElementById("staff-edit-model-select") as HTMLSelectElement | null;
  if (staffModelSel) {
    staffModelSel.addEventListener("change", () => {
      syncStaffDraftFromDom();
      const d = state.staffEditorDraft;
      if (!d) return;
      if (staffModelSel.value === "__custom__") {
        document.getElementById("staff-edit-model")?.focus();
        return;
      }
      d.model = staffModelSel.value;
      render();
    });
  }
  const staffSearch = document.getElementById("staff-search") as HTMLInputElement | null;
  if (staffSearch) {
    const commit = () => { state.staffQuery = staffSearch.value; lastInputAt = Date.now(); render(); };
    staffSearch.addEventListener("compositionstart", () => { isImeComposing = true; });
    staffSearch.addEventListener("compositionend", () => { isImeComposing = false; commit(); });
    staffSearch.addEventListener("input", () => { if (!isImeComposing) commit(); });
  }
  const archiveSearch = document.getElementById("archive-search") as HTMLInputElement | null;
  if (archiveSearch) {
    const commit = () => { state.archiveQuery = archiveSearch.value; lastInputAt = Date.now(); render(); };
    archiveSearch.addEventListener("compositionstart", () => { isImeComposing = true; });
    archiveSearch.addEventListener("compositionend", () => { isImeComposing = false; commit(); });
    archiveSearch.addEventListener("input", () => { if (!isImeComposing) commit(); });
  }
  document.getElementById("archive-repo-filter")?.addEventListener("change", (e) => {
    state.archiveRepoFilter = (e.target as HTMLSelectElement).value || "all";
    render();
  });
  document.getElementById("archive-sort")?.addEventListener("change", (e) => {
    state.archiveSort = (e.target as HTMLSelectElement).value as ArchiveSortKey;
    render();
  });
  const archiveRenameInput = document.getElementById("archive-rename-input") as HTMLInputElement | null;
  if (archiveRenameInput) {
    archiveRenameInput.addEventListener("compositionstart", () => { isImeComposing = true; });
    archiveRenameInput.addEventListener("compositionend", () => { isImeComposing = false; lastInputAt = Date.now(); });
    archiveRenameInput.addEventListener("input", () => { lastInputAt = Date.now(); });
    archiveRenameInput.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.isComposing && state.archiveRenamingConvId) {
        ke.preventDefault();
        const convId = state.archiveRenamingConvId;
        const name = archiveRenameInput.value.trim();
        void mutateArchiveAction(
          { action: "rename_conversation", target_conversation_id: convId, name: name || null },
          name ? tr("已更新主会话名称", "Updated session name") : tr("已恢复默认会话名称", "Restored default session name"),
        ).then((ok) => {
          if (ok) {
            state.archiveRenamingConvId = null;
            render();
          }
        });
      } else if (ke.key === "Escape") {
        ke.preventDefault();
        state.archiveRenamingConvId = null;
        render();
      }
    });
  }
  document.querySelectorAll<HTMLSelectElement>('[data-action="assign-wave-conv"]').forEach((sel) => {
    sel.addEventListener("change", () => {
      const swarmId = sel.dataset.swarmId;
      const targetConvId = sel.value.trim();
      if (!swarmId || !targetConvId) return;
      void mutateArchiveAction(
        { action: "assign_conversation", swarm_id: swarmId, target_conversation_id: targetConvId },
        tr("已归入主会话档案", "Assigned call to session"),
      );
    });
  });
  document.querySelectorAll<HTMLElement>("[data-open-conv]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if ((e.target as Element | null)?.closest("[data-action]")) return;
      const convId = row.dataset.openConv;
      if (!convId) return;
      state.selectedArchiveConvId = convId;
      state.archiveRenamingConvId = null;
      render();
    });
  });
  document.getElementById("board-tags")?.addEventListener("change", (e) => {
    state.boardTagFilter = (e.target as HTMLSelectElement).value as BoardTagFilter;
    render();
  });
  const boardSearch = document.getElementById("board-search-input") as HTMLInputElement | null;
  if (boardSearch) {
    boardSearch.addEventListener("compositionstart", () => {
      isImeComposing = true;
    });
    boardSearch.addEventListener("compositionend", () => {
      isImeComposing = false;
      lastInputAt = Date.now();
      state.boardSearchQuery = boardSearch.value;
      render();
    });
    boardSearch.addEventListener("input", () => {
      lastInputAt = Date.now();
      if (isImeComposing) return;
      state.boardSearchQuery = boardSearch.value;
      render();
    });
  }

  document.getElementById("board-channel-select")?.addEventListener("change", (e) => {
    state.boardChannelFilter = (e.target as HTMLSelectElement).value;
    render();
  });

  const boardInput = document.getElementById("board-input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (boardInput) {
    boardInput.addEventListener("compositionstart", () => {
      isImeComposing = true;
    });
    boardInput.addEventListener("compositionend", () => {
      isImeComposing = false;
      lastInputAt = Date.now();
      refreshMentionFromInput(boardInput);
    });
    boardInput.addEventListener("input", () => {
      lastInputAt = Date.now();
      if (boardInput instanceof HTMLTextAreaElement) autoSizeTextarea(boardInput);
      refreshMentionFromInput(boardInput);
    });
    boardInput.addEventListener("click", () => refreshMentionFromInput(boardInput));
    boardInput.addEventListener("blur", () => {
      if (mentionBlurTimer) window.clearTimeout(mentionBlurTimer);
      mentionBlurTimer = window.setTimeout(() => {
        mentionBlurTimer = null;
        if (document.activeElement !== document.getElementById("board-input")) {
          closeMentionPopover();
        }
      }, 120);
    });
    boardInput.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (mentionPopup.open && mentionPopup.items.length > 0) {
        const len = mentionPopup.items.length;
        if (ke.key === "ArrowDown") {
          ke.preventDefault();
          mentionPopup.activeIndex = (mentionPopup.activeIndex + 1) % len;
          renderMentionPopover();
          return;
        }
        if (ke.key === "ArrowUp") {
          ke.preventDefault();
          mentionPopup.activeIndex = (mentionPopup.activeIndex - 1 + len) % len;
          renderMentionPopover();
          return;
        }
        if ((ke.key === "Enter" || ke.key === "Tab") && !ke.isComposing) {
          ke.preventDefault();
          selectMentionCandidate(mentionPopup.activeIndex);
          return;
        }
        if (ke.key === "Escape") {
          ke.preventDefault();
          closeMentionPopover();
          return;
        }
      }
      if (ke.key === "Enter" && !ke.shiftKey && !ke.isComposing) {
        ke.preventDefault();
        void postBoardMessage();
      }
    });
  }

  const chatReplyInp = document.getElementById("chat-reply-input") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (chatReplyInp) {
    chatReplyInp.addEventListener("compositionstart", () => {
      isImeComposing = true;
    });
    chatReplyInp.addEventListener("compositionend", () => {
      isImeComposing = false;
      lastInputAt = Date.now();
    });
    chatReplyInp.addEventListener("input", () => {
      lastInputAt = Date.now();
      if (chatReplyInp instanceof HTMLTextAreaElement) autoSizeTextarea(chatReplyInp);
    });
    chatReplyInp.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey && !ke.isComposing && state.selectedWorkerName) {
        ke.preventDefault();
        void sendWorkerFollowUp(state.selectedWorkerName);
      }
    });
  }

  document.querySelectorAll<HTMLInputElement>("[data-rule-toggle]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.ruleToggle as RealBackendId | undefined;
      if (!id || !state.snapshot) return;
      state.configDrafts.set(id, { ...getEffectiveDraft(state.snapshot, id), enabled: cb.checked });
      render();
    });
  });

  document.querySelectorAll<HTMLSelectElement>("[data-cfg-model-select]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const id = sel.dataset.cfgModelSelect as RealBackendId | undefined;
      if (!id || !state.snapshot) return;
      const cur = getEffectiveDraft(state.snapshot, id);
      if (sel.value === "__custom__") {
        state.configDrafts.set(id, { ...cur, customMode: true });
      } else {
        state.configDrafts.set(id, { ...cur, defaultModel: sel.value, customMode: false });
      }
      render();
    });
  });

  document.querySelectorAll<HTMLInputElement>("[data-cfg-model-custom]").forEach((inp) => {
    inp.addEventListener("input", () => {
      lastInputAt = Date.now();
      const id = inp.dataset.cfgModelCustom as RealBackendId | undefined;
      if (!id || !state.snapshot) return;
      const cur = getEffectiveDraft(state.snapshot, id);
      state.configDrafts.set(id, { ...cur, defaultModel: inp.value, customMode: true });
      const card = inp.closest(".agent-cfg-card, .campus-inspector");
      const saveBtn = card?.querySelector<HTMLButtonElement>('[data-action="save-backend-cfg"]');
      if (saveBtn) {
        const dirty = isBackendDraftDirty(state.snapshot, id);
        saveBtn.disabled = !dirty;
        saveBtn.classList.toggle("btn-primary", dirty);
        card?.classList.toggle("is-dirty", dirty);
        const saveAll = document.querySelector<HTMLButtonElement>('[data-action="save-all-cfg"]');
        if (saveAll) saveAll.disabled = !REAL_BACKENDS.some((backend) => isBackendDraftDirty(state.snapshot!, backend));
      }
    });
  });

  document.querySelectorAll<HTMLSelectElement>("[data-cfg-effort]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const id = sel.dataset.cfgEffort as RealBackendId | undefined;
      if (!id || !state.snapshot) return;
      const cur = getEffectiveDraft(state.snapshot, id);
      state.configDrafts.set(id, { ...cur, defaultEffort: sel.value });
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextTab = btn.dataset.tab as PrimaryTab;
      state.activeTab = nextTab;
      state.userSelectedTab = true;
      await syncFocusToServer({
        swarm_id: state.selectedSwarmId,
        worker_name: state.selectedWorkerName,
        tab: nextTab,
      });
      if (nextTab === "detail" && (state.workerDetailOpen || wide.matches) && state.snapshot?.swarm && state.selectedWorkerName) {
        await refreshWorkerDetail(state.snapshot.swarm.id, state.selectedWorkerName);
      }
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement | SVGGElement>("[data-action]").forEach((btn) => {
    if (btn instanceof SVGElement && btn.getAttribute("role") === "button") {
      btn.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          btn.dispatchEvent(new MouseEvent("click"));
        }
      });
    }
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const worker = btn.dataset.worker;
      const swarmId = state.snapshot?.swarm?.id;

      if (action === "refresh-now") {
        await refreshDashboard();
        return;
      }
      if (action === "select-vendor" && btn.dataset.vendor) {
        state.selectedVendor = btn.dataset.vendor as RealBackendId;
        state.selectedAgyCompany = null;
        state.agyCompanyDraft = null;
        render();
        return;
      }
      if (action === "select-agy-company" && btn.dataset.company) {
        if (state.selectedAgyCompany !== btn.dataset.company) state.agyCompanyDraft = null;
        state.selectedAgyCompany = btn.dataset.company;
        state.selectedVendor = "agy";
        render();
        void loadAgyCompanyModels(btn.dataset.company);
        return;
      }
      if (action === "refresh-agy-company-models" && btn.dataset.company) {
        await loadAgyCompanyModels(btn.dataset.company, true);
        return;
      }
      if (action === "open-agy-company-import") {
        state.agyImportOpen = true;
        state.agyImportAccounts = [];
        state.agyImportPicked.clear();
        await loadAgyCompanyAccounts();
        return;
      }
      if (action === "close-agy-company-import") {
        if (!state.agyCompanySaving) {
          state.agyImportOpen = false;
          state.agyImportPicked.clear();
          state.agyImportAccounts = [];
          render();
        }
        return;
      }
      if (action === "add-agy-companies" && state.agyImportPicked.size) {
        const ids = [...state.agyImportPicked];
        await mutateAgyCompany({ op: "add", account_ids: ids }, (companies) => {
          state.selectedAgyCompany = companies.find((entry) => entry.id === `agy-${ids[0]}`)?.id ?? null;
          state.selectedVendor = "agy";
          state.agyCompanyDraft = null;
          state.agyImportOpen = false;
          state.agyImportPicked.clear();
          state.agyImportAccounts = [];
          showToast(tr("已添加外包公司", "Companies added"));
          if (state.selectedAgyCompany) void loadAgyCompanyModels(state.selectedAgyCompany);
        });
        return;
      }
      if ((action === "save-agy-company" || action === "toggle-agy-company") && btn.dataset.company) {
        const company = state.snapshot?.agy_companies?.find((entry) => entry.id === btn.dataset.company);
        if (!company) return;
        const edit = action === "save-agy-company";
        const draft = edit && state.agyCompanyDraft?.id === company.id ? state.agyCompanyDraft : null;
        await mutateAgyCompany({ op: "update", id: company.id, config: {
          name: draft?.name ?? company.name, enabled: edit ? company.enabled : !company.enabled,
          default_model: draft ? draft.model.trim() || null : company.default_model,
          default_effort: draft ? draft.effort || null : company.default_effort,
        } }, () => {
          if (edit && state.agyCompanyDraft?.id === company.id) state.agyCompanyDraft = null;
          showToast(tr("已保存公司配置", "Company settings saved"));
        });
        return;
      }
      if (action === "inspect-vendor-staff" && btn.dataset.backend) {
        state.selectedVendor = btn.dataset.backend as RealBackendId;
        state.selectedAgyCompany = null;
        state.globalTab = "hr";
        state.globalHrSection = "staff";
        state.staffQuery = btn.dataset.backend;
        if (!state.modelsLoaded && !state.modelsLoading) void loadBackendModels(false);
        render();
        return;
      }
      if (action === "go-global-hr" || action === "go-global-rules" || action === "go-settings" || action === "edit-backend-rules" ||
          action === "new-global-identity" || action === "edit-global-identity") {
        if (action === "edit-backend-rules" && btn.dataset.backend) {
          state.selectedVendor = btn.dataset.backend as RealBackendId;
        }
        goGlobal(action === "go-global-hr" ? "companies" : "rules");
        if (action === "new-global-identity" || action === "edit-global-identity") state.policyEditScope = "global_ui";
        if (action === "new-global-identity") state.newIdentityOpen = true;
        if (action === "edit-global-identity") state.expandedIdentityId = btn.dataset.identity ?? null;
        render();
        if (action === "edit-backend-rules" && btn.dataset.backend) {
          document.getElementById(`backend-${btn.dataset.backend}`)?.scrollIntoView({ block: "center" });
        }
        if (action === "edit-global-identity" && btn.dataset.identity) {
          document.querySelector(`[data-identity-editor="${CSS.escape(btn.dataset.identity)}"]`)?.scrollIntoView({ block: "start" });
        }
        if (action === "new-global-identity") document.getElementById("new-id-key")?.focus();
        await refreshDashboard();
        return;
      }
      if (action === "toggle-team-drawer") {
        state.historyDrawerOpen = !state.historyDrawerOpen;
        render();
        return;
      }
      if (action === "toggle-team-dock") {
        state.teamDockOpen = !state.teamDockOpen;
        render();
        return;
      }
      if (action === "close-team-dock") {
        state.teamDockOpen = false;
        render();
        return;
      }
      if (action === "dock-jump-worker" && worker && swarmId) {
        state.teamDockOpen = false;
        await jumpToWorker(swarmId, worker);
        return;
      }
      if (action === "copy-handoff" && pendingHandoff) { await copyText(pendingHandoff); return; }
      if (action === "attach-team") {
        const teamId = btn.dataset.teamId;
        if (teamId) await manageTeam("attach", teamId, btn.dataset.swarmId);
        return;
      }
      if (action === "attach-archive-team" && btn.dataset.teamId) {
        if (window.confirm(tr("确认将该主会话的团队接入当前正在浏览的窗口？（不会跳回原窗口）", "Attach this session's team to your current window? (Does not switch to the original window)"))) {
          await manageTeam("attach", btn.dataset.teamId, btn.dataset.swarmId);
        }
        return;
      }
      if (action === "set-archive-view" && (btn.dataset.view === "cards" || btn.dataset.view === "list")) {
        state.archiveViewMode = btn.dataset.view;
        render();
        return;
      }
      if (action === "clear-archive-filters") {
        state.archiveQuery = "";
        state.archiveRepoFilter = "all";
        render();
        return;
      }
      if (action === "toggle-archive-unassigned") {
        state.archiveUnassignedOpen = !state.archiveUnassignedOpen;
        render();
        return;
      }
      if (action === "open-archive-session" && btn.dataset.convId) {
        state.selectedArchiveConvId = btn.dataset.convId;
        state.archiveRenamingConvId = null;
        render();
        return;
      }
      if (action === "close-archive-session") {
        state.selectedArchiveConvId = null;
        state.archiveRenamingConvId = null;
        render();
        return;
      }
      if (action === "start-rename-conv" && btn.dataset.convId) {
        state.archiveRenamingConvId = btn.dataset.convId;
        render();
        document.getElementById("archive-rename-input")?.focus();
        return;
      }
      if (action === "cancel-rename-conv") {
        state.archiveRenamingConvId = null;
        render();
        return;
      }
      if (action === "save-rename-conv" && btn.dataset.convId) {
        const inp = document.getElementById("archive-rename-input") as HTMLInputElement | null;
        const name = inp?.value.trim() ?? "";
        const ok = await mutateArchiveAction(
          { action: "rename_conversation", target_conversation_id: btn.dataset.convId, name: name || null },
          name ? tr("已更新主会话名称", "Updated session name") : tr("已恢复默认会话名称", "Restored default session name"),
        );
        if (ok) {
          state.archiveRenamingConvId = null;
          render();
        }
        return;
      }
      if (action === "unassign-wave-conv" && btn.dataset.swarmId) {
        await mutateArchiveAction(
          { action: "assign_conversation", swarm_id: btn.dataset.swarmId, target_conversation_id: null },
          tr("已移回未归属列表", "Moved back to unassigned"),
        );
        return;
      }
      if (action === "copy-conv-id" && btn.dataset.convId) {
        await copyText(btn.dataset.convId);
        return;
      }
      if (action === "copy-conv-title" && btn.dataset.convTitle) {
        await copyText(btn.dataset.convTitle);
        return;
      }
      if (action === "insert-conv-link" && btn.dataset.convId && state.canSendMessage && mcpApp) {
        const labelText = (btn.dataset.convTitle || btn.dataset.convId).replace(/[\[\]]/g, "");
        await mcpApp.sendMessage({
          role: "user",
          content: [
            {
              type: "text",
              text: `[打开原会话：${labelText}](conversation://${btn.dataset.convId})`,
            },
          ],
        });
        showToast(tr("已在当前对话插入原会话链接，点击气泡链接即可跳转", "Inserted original session link in chat"));
        return;
      }
      if (action === "back-session" || action === "exit-history-mode" || (action === "open-history-swarm" && btn.dataset.swarmId)) {
        const open = action === "open-history-swarm";
        if (open && !state.historyBrowsingMode) state.historyFromGlobal = currentSurface() === "global";
        state.historyBrowsingMode = open;
        state.historyDrawerOpen = false;
        if (action === "back-session") state.globalOverride = false;
        else if (!open && action === "exit-history-mode" && state.historyFromGlobal) {
          state.globalOverride = state.surfaceMode !== "global";
          state.globalTab = "history";
        }
        state.activeTab = "detail";
        state.historySwarmId = open ? btn.dataset.swarmId! : null;
        state.historyTeamId = open ? btn.dataset.teamId ?? null : null;
        resetWorkerSelection();
        await refreshDashboard().catch((err) => showToast(String(err)));
        return;
      }
      if (action === "toggle-language" || action === "pref-language") {
        const language = action === "pref-language" ? (btn.dataset.value === "en" ? "en" : "zh-CN")
          : getLanguage() === "en" ? "zh-CN" : "en";
        await savePreferences({ language });
        return;
      }
      if (action === "pref-theme") {
        const theme = btn.dataset.value;
        if (theme === "dark" || theme === "light" || theme === "system") await savePreferences({ theme });
        return;
      }
      if (action === "staff-filter") { state.staffFilter = btn.dataset.filter ?? "all"; render(); return; }
      if (action === "studio-peek-worker" && worker) {
        state.studioPeekWorker = state.studioPeekWorker === worker ? null : worker;
        render();
        return;
      }
      if (action === "close-studio-peek") {
        state.studioPeekWorker = null;
        render();
        return;
      }
      if (action === "open-staff-recruit") {
        state.staffEditorDraft = buildStaffDraft("create");
        render();
        if (state.staffEditorDraft.company_id) void loadAgyCompanyModels(state.staffEditorDraft.company_id);
        else if (!state.modelsLoaded && !state.modelsLoading) void loadBackendModels(false);
        return;
      }
      if (action === "edit-staff-member" && btn.dataset.staffId && state.snapshot) {
        const target = state.snapshot.staff_roster?.find((m) => m.id === btn.dataset.staffId);
        if (target) {
          state.staffEditorDraft = buildStaffDraft("edit", target);
          render();
          if (target.company_id) void loadAgyCompanyModels(target.company_id);
          else if (!state.modelsLoaded && !state.modelsLoading) void loadBackendModels(false);
        }
        return;
      }
      if (action === "pick-staff-avatar" && btn.dataset.avatar && state.staffEditorDraft) {
        syncStaffDraftFromDom();
        state.staffEditorDraft.avatar = btn.dataset.avatar as StaffAvatarId;
        render();
        return;
      }
      if (action === "close-staff-modal") {
        if (!state.staffSaving) {
          state.staffEditorDraft = null;
          render();
        }
        return;
      }
      if (action === "save-staff-member" && state.staffEditorDraft) {
        syncStaffDraftFromDom();
        const d = state.staffEditorDraft;
        if (!d.name.trim()) {
          showToast(tr("请填写员工花名", "Employee name is required"));
          document.getElementById("staff-edit-name")?.focus();
          return;
        }
        await mutateStaffRoster(
          {
            op: "upsert",
            member: {
              ...(d.id ? { id: d.id } : {}),
              name: d.name.trim(),
              title: d.title.trim() || d.name.trim(),
              avatar: d.avatar,
              backend: d.backend,
              model: d.model.trim() || undefined,
              effort: d.effort.trim() || null,
              role: d.role,
              capability: d.capability,
              identity_id: d.identity_id.trim() || null,
              company_id: d.company_id || null,
              bio: d.bio.trim() || null,
              enabled: d.enabled,
            },
          },
          d.mode === "create" ? tr("已招募新员工", "Recruited employee") : tr("已保存员工档案", "Saved employee profile"),
        );
        return;
      }
      if (action === "delete-staff-member" && btn.dataset.staffId) {
        if (window.confirm(tr("从立体工牌花名册中移除该员工？", "Remove this employee from your roster?"))) {
          await mutateStaffRoster({ op: "delete", id: btn.dataset.staffId }, tr("已移除员工", "Removed employee"));
        }
        return;
      }
      if (action === "reset-staff-roster") {
        if (window.confirm(tr("恢复默认 5 位常驻员工档案？", "Reset roster to the 5 default employees?"))) {
          await mutateStaffRoster({ op: "reset" }, tr("已恢复默认员工档案", "Reset default roster"));
        }
        return;
      }
      if (action === "toggle-company" && btn.dataset.backend) {
        const backend = btn.dataset.backend as RealBackendId;
        if (!state.snapshot || !REAL_BACKENDS.includes(backend) || state.savingBackends.has(backend)) return;
        const enabled = !getSavedBackendConfig(state.snapshot, backend).enabled;
        state.savingBackends.add(backend);
        render();
        try { await saveBackendUpdates([{ backend, enabled }], t("actionComplete")); }
        finally { state.savingBackends.delete(backend); render(); }
        return;
      }
      if (action === "set-flow-section") {
        state.flowSection = btn.dataset.section === "deliverables" || btn.dataset.section === "timeline" ? btn.dataset.section : "graph";
        if (state.flowSection !== "graph") stopGraphReplay(true);
        render();
        return;
      }
      if (action === "toggle-board-search") { state.boardSearchOpen = !state.boardSearchOpen; if (!state.boardSearchOpen) state.boardSearchQuery = ""; render(); document.getElementById("board-search-input")?.focus(); return; }
      if (action === "toggle-board-filters") { state.boardFiltersOpen = !state.boardFiltersOpen; render(); return; }
      if (action === "set-workbench-filter" && btn.dataset.filter) {
        const next = btn.dataset.filter as WorkbenchFilter;
        state.workbenchFilter = next === state.workbenchFilter ? "all" : next;
        render();
        return;
      }
      if (action === "toggle-office") { state.officeBannerExpanded = !state.officeBannerExpanded; render(); return; }
      if (action === "toggle-blackboard") {
        state.blackboardOpen = !state.blackboardOpen;
        render();
        document.querySelector<HTMLElement>(state.blackboardOpen ? "#coordination-board-title" : ".blackboard-toggle")?.focus({ preventScroll: true });
        return;
      }
      if (action === "filter-blackboard") {
        const section = btn.dataset.section;
        if (section !== "risks" && section !== "results" && section !== "briefs" && section !== "all") return;
        state.blackboardSection = state.blackboardSection === section ? "all" : section;
        render();
        const list = document.querySelector<HTMLElement>(".blackboard-list");
        const filter = [...document.querySelectorAll<HTMLButtonElement>(".blackboard-filter")].find((item) => item.dataset.section === section);
        (filter ?? document.querySelector<HTMLButtonElement>(".blackboard-filter"))?.focus({ preventScroll: true });
        window.requestAnimationFrame(() => { if (list) list.scrollTop = 0; });
        return;
      }
      if (action === "filter-board-sender") {
        const sender = btn.dataset.sender ?? null;
        state.boardSenderFilter = sender === state.boardSenderFilter ? null : sender;
        render();
        const selected = sender && [...document.querySelectorAll<HTMLButtonElement>(".chat-person")].find((item) => item.dataset.sender === sender);
        (selected || document.querySelector<HTMLElement>(".chat-people button"))?.focus({ preventScroll: true });
        return;
      }
      if (action === "graph-replay") {
        const total = state.snapshot?.dispatch_graph?.timeline.length ?? 0;
        if (!total) return;
        if (graphReplayTimer !== null) stopGraphReplay();
        else {
          if (state.graphReplayCount === null || state.graphReplayCount >= total) state.graphReplayCount = 0;
          state.selectedGraphNodeId = state.selectedGraphEdgeId = null;
          graphReplayTimer = window.setInterval(advanceGraphReplay, Math.max(180, Math.min(850, 24000 / total)));
          advanceGraphReplay();
          return;
        }
        renderGraphControlChange();
        return;
      }
      if (action === "graph-step") {
        stopGraphReplay();
        advanceGraphReplay();
        return;
      }
      if (action === "graph-replay-exit") {
        stopGraphReplay(true);
        state.selectedGraphNodeId = state.selectedGraphEdgeId = null;
        render();
        document.querySelector<HTMLButtonElement>('[data-action="graph-replay"]')?.focus({ preventScroll: true });
        return;
      }
      if (action === "graph-zoom-in") {
        state.graphFitMode = false;
        state.graphZoom = Math.min(1.8, Number((state.graphZoom + 0.15).toFixed(2)));
        renderGraphControlChange();
        return;
      }
      if (action === "graph-zoom-out") {
        state.graphFitMode = false;
        state.graphZoom = Math.max(0.5, Number((state.graphZoom - 0.15).toFixed(2)));
        renderGraphControlChange();
        return;
      }
      if (action === "graph-zoom-reset") {
        state.graphFitMode = false;
        state.graphZoom = 1;
        renderGraphControlChange();
        return;
      }
      if (action === "graph-zoom-fit") {
        const wrap = document.querySelector<HTMLElement>(".graph-canvas-wrap");
        const svg = wrap?.querySelector<SVGSVGElement>(".graph-svg");
        if (wrap && svg) {
          const vb = svg.viewBox?.baseVal;
          let vw = vb && vb.width > 0 ? vb.width : 0;
          let vh = vb && vb.height > 0 ? vb.height : 0;
          if (!vw || !vh) {
            const parts = (svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
            if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
              vw = parts[2]!;
              vh = parts[3]!;
            }
          }
          if (vw > 0 && vh > 0) {
            const cw = Math.max(180, wrap.clientWidth - 28);
            const ch = Math.max(160, wrap.clientHeight - 28);
            state.graphZoom = Math.max(0.5, Math.min(1.25, Number(Math.min(cw / vw, ch / vh).toFixed(2))));
            state.graphFitMode = true;
            renderGraphControlChange();
          }
        }
        return;
      }
      if (action === "graph-clear-selection") {
        state.selectedGraphNodeId = state.selectedGraphEdgeId = null;
        render();
        return;
      }
      if (action === "select-graph-edge" && btn.dataset.edgeId) {
        stopGraphReplay();
        state.selectedGraphNodeId = null;
        state.selectedGraphEdgeId = btn.dataset.edgeId;
        render();
        return;
      }
      if (action === "select-graph-node" && btn.dataset.nodeId) {
        stopGraphReplay();
        state.selectedGraphEdgeId = null;
        state.selectedGraphNodeId = btn.dataset.nodeId;
        render();
        return;
      }
      if (action === "set-post-mode") { state.silentPost = btn.dataset.silent === "true"; render(); document.getElementById("board-input")?.focus(); return; }
      if (action === "close-worker-detail") { state.workerDetailOpen = false; render(); return; }
      if (action === "follow-up" && !isReadOnly()) {
        state.detailViewMode = "chat";
        render();
        document.getElementById("chat-reply-input")?.focus();
        return;
      }
      if (action === "open-history-worker" && worker && swarmId) {
        state.globalOverride = false;
        await jumpToWorker(swarmId, worker);
        return;
      }
      if ((action === "safe-merge" || action === "copy-merge") && state.snapshot && worker && swarmId) {
        const delivery = projectDeliverables(state.snapshot).find((d) => d.workerName === worker);
        if (!delivery?.headSha || !delivery.targetBranch) return;
        if (action === "copy-merge") {
          const args = { action: "merge", swarm_id: swarmId, name: worker, expected_sha: delivery.headSha };
          await copyText(`Target branch: ${delivery.targetBranch}\n--expected-sha ${delivery.headSha}\npoly_swarm ${JSON.stringify(args)}`);
        } else if (!isReadOnly() && delivery.canMerge && btn.dataset.expectedSha === delivery.headSha) {
          if (window.confirm(`${t("safeMerge")}\n@${worker} → ${delivery.targetBranch}\nHEAD ${delivery.headSha}`)) {
            await runWorkerAction({ action: "merge", swarm_id: swarmId, name: worker, expected_sha: delivery.headSha });
          }
        }
        return;
      }
      if (action === "review-candidates" && worker) { await openCandidates(worker, "review"); return; }
      if (action === "copy-review-diagnostics") {
        await copyText([t("noIndependent"), ...state.candidates.map((c) => `${c.backend}: ${c.gate_failures.map((g) => `${g.gate} ${g.reason}`).join("; ")}`)].join("\n"));
        return;
      }
      if (action === "clear-board-search") {
        state.boardSearchQuery = "";
        render();
        return;
      }
      if (action === "toggle-board-more" && btn.dataset.seq) {
        const seq = Number(btn.dataset.seq);
        if (state.expandedBoardSeqs.has(seq)) state.expandedBoardSeqs.delete(seq);
        else state.expandedBoardSeqs.add(seq);
        render();
        return;
      }
      if (action === "scroll-seq" && btn.dataset.seq) {
        const seq = Number(btn.dataset.seq);
        if (Number.isInteger(seq) && seq > 0) {
          scrollToBoardSeq(seq);
        }
        return;
      }
      if (action === "go-graph") {
        state.activeTab = "graph";
        state.userSelectedTab = true;
        await syncFocusToServer({
          swarm_id: state.selectedSwarmId,
          worker_name: state.selectedWorkerName,
          tab: "graph",
        });
        render();
        return;
      }
      if (action === "set-graph-filter" && btn.dataset.graphFilter) {
        state.graphFilterMode = btn.dataset.graphFilter as GraphFilterMode;
        state.selectedGraphNodeId = state.selectedGraphEdgeId = null;
        render();
        return;
      }
      if (action === "set-policy-scope" && btn.dataset.policyScope) {
        state.policyEditScope = btn.dataset.policyScope as "global_ui" | "project" | "session";
        state.newIdentityOpen = false;
        state.expandedIdentityId = null;
        await refreshDashboard().catch((err) => showToast(String(err)));
        return;
      }
      if (action === "reset-policy-scope") {
        if (window.confirm(tr("清空此层的规则覆盖？", "Reset overrides in this layer?"))) {
          if (state.policyEditScope === "global_ui") state.configDrafts.clear();
          await savePolicyUpdate({
            scope: state.policyEditScope,
            patch: null,
            reset: true,
            toastMsg: t("actionComplete"),
          });
        }
        return;
      }
      if (action === "toggle-new-identity") {
        state.newIdentityOpen = !state.newIdentityOpen;
        render();
        return;
      }
      if (action === "create-identity") {
        const rawId = (document.getElementById("new-id-key") as HTMLInputElement | null)?.value.trim() || "";
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(rawId)) {
          showToast("身份 ID 需匹配 /^[a-z0-9][a-z0-9_-]{0,31}$/");
          return;
        }
        const id = rawId.toLowerCase();
        const label = (document.getElementById("new-id-label") as HTMLInputElement | null)?.value.trim() || id;
        const baseRole = ((document.getElementById("new-id-role") as HTMLSelectElement | null)?.value || "worker") as WorkerRole;
        const cap = ((document.getElementById("new-id-cap") as HTMLSelectElement | null)?.value || "author") as CapabilityTag;
        const ws = ((document.getElementById("new-id-ws") as HTMLSelectElement | null)?.value || "inherit") as WorkspaceMode;
        const backendsRaw = (document.getElementById("new-id-backends") as HTMLInputElement | null)?.value || "";
        const preferred = backendsRaw
          .split(/[\s,]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean) as BackendId[];
        const model = (document.getElementById("new-id-model") as HTMLInputElement | null)?.value.trim() || null;
        const prompt = (document.getElementById("new-id-prompt") as HTMLTextAreaElement | null)?.value.trim() || null;
        const skills = readRoleSkillPaths("new-id-skills");
        if (!skills) return;

        const patch: DispatchIdentityPatch = {
          label,
          base_role: baseRole,
          capability: cap,
          workspace_mode: ws,
          ...(preferred.length > 0 ? { preferred_backends: preferred } : {}),
          ...(model ? { model } : {}),
          ...(prompt ? { system_prompt: prompt } : {}),
          ...(skills.length ? { skill_paths: skills } : {}),
          enabled: true,
        };
        state.newIdentityOpen = false;
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { identities: { [id]: patch } },
          toastMsg: `已创建调度身份 '${id}'`,
        });
        return;
      }
      if (action === "toggle-identity-edit" && btn.dataset.identity) {
        const id = btn.dataset.identity;
        state.expandedIdentityId = state.expandedIdentityId === id ? null : id;
        render();
        return;
      }
      if (action === "save-identity" && btn.dataset.identity) {
        const id = btn.dataset.identity;
        const ed = document.querySelector<HTMLElement>(
          `[data-identity-editor="${CSS.escape(id)}"]`,
        );
        if (!ed) return;
        const val = (f: string) =>
          (ed.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-id-field="${f}"]`)?.value ?? "").trim();
        const enabledEl = ed.querySelector<HTMLInputElement>('[data-id-field="enabled"]');
        const prefList = val("preferred_backends")
          .split(/[\s,]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean) as BackendId[];
        const baseRoleSel = ed.querySelector<HTMLSelectElement>('[data-id-field="base_role"]');
        const promptVal = val("system_prompt");
        const skills = readRoleSkillPaths("identity-edit-skills");
        if (!skills) return;
        const activeLayerRaw = state.snapshot?.dispatch_policy?.layers.find(
          (l) => l.layer === state.policyEditScope,
        )?.raw;
        const prevLayerPatch = activeLayerRaw?.identities?.[id] ?? null;
        const includePrompt =
          state.policyEditScope === "global_ui" ||
          promptVal.length > 0 ||
          prevLayerPatch?.system_prompt !== undefined;

        const patch: DispatchIdentityPatch = {
          label: val("label") || null,
          enabled: enabledEl ? enabledEl.checked : true,
          ...(!baseRoleSel?.disabled && val("base_role") ? { base_role: val("base_role") as WorkerRole } : {}),
          capability: (val("capability") as CapabilityTag) || null,
          workspace_mode: (val("workspace_mode") as WorkspaceMode) || null,
          preferred_backends: prefList.length > 0 ? prefList : null,
          model: val("model") || null,
          effort: val("effort") || null,
          reports_to: val("reports_to") || null,
          review_by: val("review_by") || null,
          ...(skills.length ? { skill_paths: skills } : prevLayerPatch?.skill_paths?.length ? { skill_paths: null } : {}),
          ...(includePrompt
            ? {
                prompt_mode: (val("prompt_mode") as PromptMergeMode) || "replace",
                system_prompt: promptVal || null,
              }
            : {}),
        };
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { identities: { [id]: patch } },
          toastMsg: `已保存身份 '${id}'`,
        });
        return;
      }
      if (action === "reset-identity" && btn.dataset.identity) {
        const id = btn.dataset.identity;
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { identities: { [id]: null } },
          toastMsg: `已还原身份 '${id}' 本层覆盖`,
        });
        return;
      }
      if (action === "add-topo-link" && state.snapshot) {
        const from = ((document.getElementById("topo-from") as HTMLInputElement | null)?.value || "")
          .trim()
          .toLowerCase();
        const to = ((document.getElementById("topo-to") as HTMLInputElement | null)?.value || "")
          .trim()
          .toLowerCase();
        const kind = ((document.getElementById("topo-kind") as HTMLSelectElement | null)?.value ||
          "dispatch") as PlannedGraphLinkKind;
        const label = ((document.getElementById("topo-label") as HTMLInputElement | null)?.value || "").trim();
        if (!from || !to) {
          showToast("请填写源节点与目标节点");
          return;
        }
        const curLayer = state.snapshot.dispatch_policy?.layers.find(
          (l) => l.layer === state.policyEditScope,
        )?.raw;
        const prevLinks: PlannedGraphLink[] = [...(curLayer?.topology ?? [])];
        const filtered = prevLinks.filter(
          (l) => !(l.from === from && l.to === to && l.kind === kind),
        );
        filtered.push({ from, to, kind, ...(label ? { label } : {}) });
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { topology: filtered },
          toastMsg: `已添加规划连线 ${from} → ${to}`,
        });
        return;
      }
      if (
        action === "remove-topo-link" &&
        btn.dataset.topoFrom &&
        btn.dataset.topoTo &&
        btn.dataset.topoKind &&
        state.snapshot
      ) {
        const curLayer = state.snapshot.dispatch_policy?.layers.find(
          (l) => l.layer === state.policyEditScope,
        )?.raw;
        const nextLinks = (curLayer?.topology ?? []).filter(
          (l) =>
            !(
              l.from === btn.dataset.topoFrom &&
              l.to === btn.dataset.topoTo &&
              l.kind === btn.dataset.topoKind
            ),
        );
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { topology: nextLinks },
          toastMsg: "已移除规划连线",
        });
        return;
      }
      if (action === "save-layer-backend" && btn.dataset.backend) {
        const id = btn.dataset.backend as RealBackendId;
        const card = document.querySelector<HTMLElement>(
          `[data-layer-backend-card="${CSS.escape(id)}"]`,
        );
        if (!card) return;
        const enabledEl = card.querySelector<HTMLInputElement>(
          `[data-layer-cfg-enabled="${CSS.escape(id)}"]`,
        );
        const modelEl = card.querySelector<HTMLInputElement>(
          `[data-layer-cfg-model="${CSS.escape(id)}"]`,
        );
        const effortEl = card.querySelector<HTMLSelectElement>(
          `[data-layer-cfg-effort="${CSS.escape(id)}"]`,
        );
        const ov: BackendPolicyOverride = {
          ...(enabledEl && !enabledEl.disabled ? { enabled: enabledEl.checked } : {}),
          defaultModel: modelEl?.value.trim() || null,
          defaultEffort: effortEl?.value.trim() || null,
        };
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { backends: { [id]: ov } },
          toastMsg: `已覆写 ${id} 到当前层`,
        });
        return;
      }
      if (action === "reset-layer-backend" && btn.dataset.backend) {
        const id = btn.dataset.backend as RealBackendId;
        await savePolicyUpdate({
          scope: state.policyEditScope,
          patch: { backends: { [id]: null } },
          toastMsg: `已还原 ${id} 本层覆盖`,
        });
        return;
      }
      if (action === "refresh-models") {
        await loadBackendModels(true);
        return;
      }
      if (action === "reset-backend-cfg" && btn.dataset.backend) {
        state.configDrafts.delete(btn.dataset.backend as RealBackendId);
        render();
        return;
      }
      if (action === "save-backend-cfg" && btn.dataset.backend && state.snapshot) {
        const id = btn.dataset.backend as RealBackendId;
        const draft = getEffectiveDraft(state.snapshot, id);
        state.savingBackends.add(id);
        render();
        try {
          await saveBackendUpdates(
            [
              {
                backend: id,
                enabled: draft.enabled,
                defaultModel: draft.defaultModel.trim() || null,
                defaultEffort: draft.defaultEffort.trim() || null,
              },
            ],
            `已保存 ${id} 默认配置`,
          );
        } finally {
          state.savingBackends.delete(id);
          render();
        }
        return;
      }
      if (action === "save-all-cfg" && state.snapshot) {
        const dirtyIds = REAL_BACKENDS.filter((id) => isBackendDraftDirty(state.snapshot!, id));
        if (dirtyIds.length === 0) return;
        state.savingAllConfigs = true;
        render();
        try {
          await saveBackendUpdates(
            dirtyIds.map((id) => {
              const d = getEffectiveDraft(state.snapshot!, id);
              return {
                backend: id,
                enabled: d.enabled,
                defaultModel: d.defaultModel.trim() || null,
                defaultEffort: d.defaultEffort.trim() || null,
              };
            }),
            `已保存 ${dirtyIds.length} 项 Agent 配置`,
          );
        } finally {
          state.savingAllConfigs = false;
          render();
        }
        return;
      }
      if (action === "refresh-backends") {
        await runWorkerAction({ action: "refresh_backends" });
        return;
      }
      if ((action === "select-worker" || action === "jump-worker" || action === "open-worker-detail") && worker && swarmId) {
        state.studioPeekWorker = null;
        await jumpToWorker(swarmId, worker);
        return;
      }
      if (action === "open-worker-turn" && worker && swarmId && btn.dataset.turn) {
        state.studioPeekWorker = null;
        await jumpToWorker(swarmId, worker);
        state.detailViewMode = "trace";
        state.selectedTurnId = btn.dataset.turn;
        await refreshTurnEvents(btn.dataset.turn, false);
        render();
        return;
      }
      if (action === "set-board-filter" && btn.dataset.boardFilter) {
        state.boardTagFilter = btn.dataset.boardFilter as BoardTagFilter;
        render();
        return;
      }
      if (action === "quote-seq" && btn.dataset.seq) {
        if (state.historyBrowsingMode) return;
        const inp = document.getElementById("board-input") as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        if (inp) {
          const refText = `#${btn.dataset.seq} `;
          const pos = inp.selectionStart ?? inp.value.length;
          const endPos = inp.selectionEnd ?? pos;
          const before = inp.value.slice(0, pos);
          const after = inp.value.slice(endPos);
          const prefixSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
          inp.value = `${before}${prefixSpace}${refText}${after}`;
          const nextPos = before.length + prefixSpace.length + refText.length;
          if (inp instanceof HTMLTextAreaElement) autoSizeTextarea(inp);
          inp.focus();
          inp.setSelectionRange(nextPos, nextPos);
        }
        return;
      }
      if (action === "insert-at") {
        const inp = document.getElementById("board-input") as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        if (inp) {
          const start = inp.selectionStart ?? inp.value.length;
          const end = inp.selectionEnd ?? start;
          const before = inp.value.slice(0, start);
          const after = inp.value.slice(end);
          const needsSpace = before.length > 0 && /[a-zA-Z0-9._-]$/.test(before);
          const inserted = needsSpace ? " @" : "@";
          inp.value = `${before}${inserted}${after}`;
          const nextPos = before.length + inserted.length;
          if (inp instanceof HTMLTextAreaElement) autoSizeTextarea(inp);
          inp.focus();
          inp.setSelectionRange(nextPos, nextPos);
          refreshMentionFromInput(inp);
        }
        return;
      }
      if (action === "toggle-config") {
        state.configExpanded = !state.configExpanded;
        render();
        return;
      }
      if (action === "send-worker-chat" && worker) {
        await sendWorkerFollowUp(worker);
        return;
      }
      if (action === "set-detail-mode" && btn.dataset.mode) {
        state.detailViewMode = btn.dataset.mode as DetailViewMode;
        render();
        return;
      }
      if (action === "load-chat-events" && btn.dataset.turn) {
        await loadChatEvents(btn.dataset.turn);
        return;
      }
      if (action === "inspect-turn-trace" && btn.dataset.turn) {
        state.detailViewMode = "trace";
        state.selectedTurnId = btn.dataset.turn;
        await refreshTurnEvents(btn.dataset.turn, false);
        render();
        return;
      }
      if (action === "toggle-raw-chunks") {
        state.rawTraceChunks = !state.rawTraceChunks;
        render();
        return;
      }
      if (action === "toggle-expand" && btn.dataset.key) {
        const key = btn.dataset.key;
        if (state.expandedKeys.has(key)) state.expandedKeys.delete(key);
        else state.expandedKeys.add(key);
        render();
        return;
      }
      if (action === "set-filter" && btn.dataset.filter) {
        state.traceFilter = btn.dataset.filter as TraceFilter;
        render();
        return;
      }
      if (action === "show-worker-diff") {
        state.detailViewMode = "config";
        state.showPatch = true;
        render();
        return;
      }
      if (action === "toggle-patch") {
        state.showPatch = !state.showPatch;
        render();
        return;
      }
      if (action === "select-turn" && btn.dataset.turn) {
        state.selectedTurnId = btn.dataset.turn;
        await refreshTurnEvents(btn.dataset.turn, false);
        render();
        return;
      }
      if (action === "open-file" && btn.dataset.file && btn.dataset.ws) {
        const ws = btn.dataset.ws.replace(/\/$/, "");
        await openFileInHost(`${ws}/${btn.dataset.file}`);
        return;
      }
      if (action === "open-switch" && worker) { await openCandidates(worker, "switch"); return; }
      if (action === "cancel-switch" && !state.actionInFlight) {
        candidateRequest += 1;
        state.switchTargetWorker = null;
        render();
        return;
      }
      if (action === "pick-candidate" && state.candidates.some((c) => c.backend === btn.dataset.backend && c.eligible)) {
        state.candidateBackend = btn.dataset.backend as RealBackendId;
        render();
        return;
      }
      if (action === "confirm-switch" && worker && swarmId && state.switchTargetWorker === worker &&
          state.candidateIntent === "switch" && state.candidates.some((c) => c.eligible && c.backend === state.candidateBackend) && !isReadOnly()) {
        const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() || undefined;
        if (await runWorkerAction({
          action: "switch", swarm_id: swarmId, name: worker, backend: state.candidateBackend,
          model: value("candidate-model"), effort: value("candidate-effort"),
          reason: value("candidate-reason"), resume_prompt: value("candidate-resume"),
        })) {
          state.switchTargetWorker = null;
          render();
        }
        return;
      }
      if ((action === "cancel" || action === "kill") && worker && swarmId && !isReadOnly()) {
        if (action !== "kill" || window.confirm(`${t("release")} @${worker}?`))
          await runWorkerAction({ action, swarm_id: swarmId, name: worker });
        return;
      }
      if (action === "post-board") {
        await postBoardMessage();
        return;
      }
      if (action === "send-to-chat" && btn.dataset.seq && mcpApp && state.snapshot) {
        if (isReadOnly()) {
          showToast(t("readonly"));
          return;
        }
        const seq = Number(btn.dataset.seq);
        const msg = [...state.snapshot.board_tail, ...(state.snapshot.blackboard_messages ?? [])].find((m) => m.seq === seq);
        if (msg) {
          await mcpApp.sendMessage({
            role: "user",
            content: [
              {
                type: "text",
                text: `关于 Poly Swarm 群聊 #${msg.seq} (${msg.sender}): ${msg.text}`,
              },
            ],
          });
          showToast(`已将 #${msg.seq} 发回主对话`);
        }
      }
    });
  });

  const bindGraphSvgElements = (scope: ParentNode = document) => {
    scope.querySelectorAll<SVGGElement>("[data-graph-node], [data-graph-edge]").forEach((el) => {
      const activate = (keyboard = false) => {
        stopGraphReplay();
        const { graphNode, graphEdge } = el.dataset;
        state.selectedGraphNodeId = graphNode && state.selectedGraphNodeId !== graphNode ? graphNode : null;
        state.selectedGraphEdgeId = graphEdge && state.selectedGraphEdgeId !== graphEdge ? graphEdge : null;
        render();
        if (keyboard) [...document.querySelectorAll<SVGGElement>("[data-graph-node], [data-graph-edge]")]
          .find((item) => item.dataset.graphNode === graphNode && item.dataset.graphEdge === graphEdge)?.focus({ preventScroll: true });
      };
      el.addEventListener("click", () => activate());
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(true);
        }
      });
    });
  };
  bindGraphSvgElements(document);

  const graphScrub = document.querySelector<HTMLInputElement>("input[data-graph-scrub]");
  if (graphScrub) {
    graphScrub.addEventListener("input", () => {
      stopGraphReplay();
      const nextCount = Number(graphScrub.value);
      if (!Number.isFinite(nextCount)) return;
      state.graphReplayCount = nextCount;
      const snap = state.snapshot;
      const total = snap?.dispatch_graph?.timeline.length ?? 0;
      const countEl = document.querySelector<HTMLElement>(".graph-scrub-count");
      if (countEl) countEl.textContent = `${nextCount} / ${total}`;
      const replayLabelB = document.querySelector<HTMLElement>(".graph-replay-label b");
      if (replayLabelB) replayLabelB.textContent = `${nextCount} / ${total}`;
      const wrap = document.querySelector<HTMLElement>(".graph-canvas-wrap");
      if (wrap && snap?.dispatch_graph) {
        const { graph, running, liveEdges, mode, selectedNode, selectedEdge, event } = computeGraphCanvasRender(snap);
        wrap.innerHTML = renderDispatchGraphSvg(graph, {
          filterMode: mode,
          selectedNodeId: selectedNode?.id,
          selectedEdgeId: selectedEdge?.id,
          activeEdgeIds: liveEdges,
          pulseNodeIds: running,
          zoom: state.graphZoom,
        });
        bindGraphSvgElements(wrap);
        const eventEl = document.querySelector<HTMLElement>(".graph-hud-event");
        if (eventEl) {
          eventEl.innerHTML = event
            ? `<span class="badge ${edgeKindCssClass(event.kind)}">${getLanguage() === "en" ? esc(event.kind.replaceAll("_", " ")) : esc(graphEdgeKindLabel(event.kind))}</span>
              <span class="graph-event-route">${esc(boardSenderLabel(event.from_node))} → ${esc(boardSenderLabel(event.to_node))}</span>
              ${event.seq ? `<button class="md-seq-ref" type="button" data-action="scroll-seq" data-seq="${esc(event.seq)}">#${esc(event.seq)} ↗</button>` : ""}
              <time class="muted">${esc(fmtTime(event.created_at))}</time>`
            : `<span class="muted">${tr("从本轮第一条记录开始", "Starting at the first recorded event")}</span>`;
        }
      }
    });
    graphScrub.addEventListener("change", () => {
      renderGraphControlChange();
      document.querySelector<HTMLInputElement>("input[data-graph-scrub]")?.focus({ preventScroll: true });
    });
  }

  const graphWrap = document.querySelector<HTMLElement>(".graph-canvas-wrap");
  if (graphWrap) {
    let panState: {
      pointerId: number;
      startX: number;
      startY: number;
      startLeft: number;
      startTop: number;
      moved: boolean;
    } | null = null;

    graphWrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (target?.closest("[data-graph-node], [data-graph-edge], button, input")) return;
      panState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: graphWrap.scrollLeft,
        startTop: graphWrap.scrollTop,
        moved: false,
      };
      try { graphWrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    graphWrap.addEventListener("pointermove", (e) => {
      if (!panState || e.pointerId !== panState.pointerId) return;
      const dx = e.clientX - panState.startX;
      const dy = e.clientY - panState.startY;
      if (!panState.moved && Math.hypot(dx, dy) > 4) {
        panState.moved = true;
        graphWrap.classList.add("is-panning");
      }
      if (panState.moved) {
        lastUserScrollAt = Date.now();
        graphWrap.scrollLeft = panState.startLeft - dx;
        graphWrap.scrollTop = panState.startTop - dy;
      }
    });

    const endPan = (e: PointerEvent, allowClear: boolean) => {
      if (!panState || e.pointerId !== panState.pointerId) return;
      const wasMoved = panState.moved;
      panState = null;
      graphWrap.classList.remove("is-panning");
      try {
        if (graphWrap.hasPointerCapture(e.pointerId)) graphWrap.releasePointerCapture(e.pointerId);
      } catch { /* ignore */ }
      if (allowClear && !wasMoved && (state.selectedGraphNodeId || state.selectedGraphEdgeId)) {
        const target = e.target as Element | null;
        if (!target?.closest("[data-graph-node], [data-graph-edge], button, input")) {
          state.selectedGraphNodeId = state.selectedGraphEdgeId = null;
          render();
        }
      }
    };

    graphWrap.addEventListener("pointerup", (e) => endPan(e, true));
    graphWrap.addEventListener("pointercancel", (e) => endPan(e, false));
    graphWrap.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const next = Math.max(0.5, Math.min(1.8, Number((state.graphZoom + delta).toFixed(2))));
      if (next !== state.graphZoom) {
        state.graphFitMode = false;
        state.graphZoom = next;
        render();
      }
    }, { passive: false });
  }
}

function shouldPausePolling(ignoreInFlight = false): boolean {
  if ((embeddedSwarmId && document.getElementById(dashboardRootId)?.hidden) ||
      teamBusy || (!ignoreInFlight && pollInFlight) || preferencesBusy || isImeComposing || state.actionInFlight ||
      state.switchTargetWorker !== null || mentionPopup.open || state.savingPolicy ||
      state.savingAllConfigs || state.savingBackends.size > 0 || state.agyCompanySaving || state.agyImportOpen ||
      state.staffEditorDraft !== null || Date.now() - lastInputAt < 800 ||
      Date.now() - lastUserScrollAt < 1200) return true;
  const active = document.activeElement;
  return Boolean(active?.matches("input, textarea, select, [contenteditable=true]") ||
    active?.closest(".identity-editor, #topo-add-form, [data-layer-backend-card]"));
}

type EmbeddedWorkbench = { app: App; rootId: string; swarmId: string };

export async function openEmbeddedWorkbench(input: EmbeddedWorkbench): Promise<void> {
  const firstOpen = embeddedSwarmId === null;
  if (!firstOpen && embeddedSwarmId !== input.swarmId) {
    ++dashboardRequest;
    state.selectedSwarmId = input.swarmId;
    state.selectedTeamId = state.historySwarmId = state.historyTeamId = null;
    state.historyBrowsingMode = state.historyDrawerOpen = state.globalOverride = false;
    state.surfaceMode = "workbench";
    state.snapshot = null;
    resetWorkerSelection();
  }
  embeddedSwarmId = input.swarmId;
  hostTheme = input.app.getHostContext()?.theme ?? hostTheme;
  if (firstOpen) await startDashboard(input);
  else if (connected) await refreshDashboard().catch((err) => showToast(String(err)));
}

export async function startDashboard(embedded?: EmbeddedWorkbench): Promise<void> {
  if (embedded) dashboardRootId = embedded.rootId;
  applyPreferences();
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.blackboardOpen || !(event.target instanceof Element)
      || !event.target.closest("#coordination-board")) return;
    event.preventDefault();
    state.blackboardOpen = false;
    render();
    document.querySelector<HTMLElement>(".blackboard-toggle")?.focus({ preventScroll: true });
  });
  const noteUserScroll = (event: Event) => {
    if (isRestoringScroll) return;
    const t = event.target;
    if (
      t === document ||
      t === window ||
      (t instanceof Element && (t.matches(ALL_SCROLL_SELECTOR) || Boolean(t.closest(ALL_SCROLL_SELECTOR))))
    ) {
      lastUserScrollAt = Date.now();
    }
  };
  document.addEventListener("wheel", noteUserScroll, { passive: true });
  document.addEventListener("touchmove", noteUserScroll, { passive: true });
  document.addEventListener("scroll", noteUserScroll, { capture: true, passive: true });
  state.officeBannerExpanded = !getPreferences().autoCollapseBannerNarrow || !narrow.matches;
  narrow.addEventListener("change", () => {
    if (getPreferences().autoCollapseBannerNarrow) {
      state.officeBannerExpanded = !narrow.matches;
      render();
    }
  });
  wide.addEventListener("change", () => {
    if (embedded && document.getElementById(dashboardRootId)?.hidden) return;
    render();
    void refreshDashboard().catch((err) => showToast(String(err)));
  });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyPreferences(hostTheme));
  const browser = embedded ? null : readBrowserWorkbench();
  isMcpMode = browser?.isMcp ?? true;
  if (browser && !browser.isMcp) {
    const query = new URLSearchParams(window.location.search);
    applySessionHints(Object.fromEntries(query));
    state.selectedSwarmId = browser.swarmId;
    state.selectedTeamId = query.get("team_id")?.trim() || null;
    if (query.get("surface") === "global") {
      state.surfaceMode = "global";
      state.globalOverride = false;
    }
  }

  if (embedded) {
    mcpApp = embedded.app;
    applySessionHints(mcpApp.getHostContext());
    state.selectedSwarmId = embedded.swarmId;
    state.surfaceMode = "workbench";
  } else if (isMcpMode) {
    const app = new App({ name: "Poly Swarm", version: "0.5.0" });
    mcpApp = app;
    const consumeResult = (snap: DashboardSnapshot) => {
      if (snap.active_conversation_id && state.conversationId && snap.active_conversation_id !== state.conversationId) return;
      if (state.historyBrowsingMode && !snap.swarm) return;
      ++dashboardRequest;
      if (snap.surface === "global") {
        state.surfaceMode = "global";
        state.globalOverride = false;
        if (!state.historyBrowsingMode && !state.modelsLoaded && !state.modelsLoading) {
          void loadBackendModels(false);
        }
      }
      if (snap.swarm && state.surfaceMode !== "global") {
        if (state.selectedSwarmId !== snap.swarm.id) resetWorkerSelection();
        state.selectedSwarmId = snap.swarm.id;
        state.historyBrowsingMode = state.historyDrawerOpen = false;
        state.historySwarmId = state.historyTeamId = null;
      }
      if (snap.match_reason && state.surfaceMode !== "global") state.matchReason = snap.match_reason;
      acceptSessionSnapshot(snap);
      if (state.surfaceMode !== "global" && snap.ui_focus?.swarm_id && snap.ui_focus.swarm_id === snap.swarm?.id) {
        state.lastFocusSeq = Math.max(state.lastFocusSeq, snap.ui_focus.seq);
        if (snap.ui_focus.worker_name) {
          state.selectedWorkerName = snap.ui_focus.worker_name;
          state.workerDetailOpen = snap.ui_focus.tab === "detail";
        }
        if (!state.globalOverride && snap.ui_focus.tab) applyTab(snap.ui_focus.tab);
      }
      state.snapshot = snap;
      render();
    };
    let pending: DashboardSnapshot | null = null;
    app.ontoolinput = ({ arguments: args }) => {
      applySessionHints(args);
      if (!args) return;
      if (args.surface === "global") {
        state.surfaceMode = "global";
        state.globalOverride = false;
      }
      if (typeof args.swarm_id === "string" && args.swarm_id) {
        ++dashboardRequest;
        if (state.selectedSwarmId !== args.swarm_id) resetWorkerSelection();
        state.historyBrowsingMode = state.historyDrawerOpen = state.globalOverride = false;
        state.historySwarmId = state.historyTeamId = null;
        state.selectedTeamId = null;
        state.selectedSwarmId = args.swarm_id;
      }
      if (typeof args.team_id === "string" && args.team_id) {
        ++dashboardRequest;
        if (!args.swarm_id && state.selectedTeamId !== args.team_id) {
          state.selectedSwarmId = null;
          resetWorkerSelection();
        }
        state.selectedTeamId = args.team_id;
      }
      if (typeof args.worker_name === "string" && args.worker_name) {
        state.selectedWorkerName = args.worker_name;
        state.workerDetailOpen = true;
      }
      if (typeof args.tab === "string") {
        applyTab(args.tab as WorkbenchTab);
        state.userSelectedTab = true;
      }
    };

    app.ontoolresult = (result) => {
      const snap = extractStructured<DashboardSnapshot>(result);
      if (!connected) {
        if (snap && Array.isArray(snap.backends)) pending = snap;
        return;
      }
      if (snap && Array.isArray(snap.backends)) consumeResult(snap);
      void refreshDashboard().catch((err) => showToast(String(err)));
    };

    app.onhostcontextchanged = (ctx) => {
      const previous = state.conversationId;
      const previousRepo = state.repoRoot;
      applySessionHints(ctx);
      hostTheme = ctx.theme ?? hostTheme;
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      applyPreferences(hostTheme);
      if (connected && (previous !== state.conversationId || previousRepo !== state.repoRoot)) {
        void refreshDashboard().catch((err) => showToast(String(err)));
      }
    };

    await app.connect();
    const ctx = app.getHostContext();
    applySessionHints(ctx);
    hostTheme = ctx?.theme ?? hostTheme;
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    const caps = app.getHostCapabilities() as { message?: unknown; sendMessage?: unknown; canSendMessage?: boolean } | undefined;
    state.canSendMessage = caps?.canSendMessage ?? Boolean(caps?.message ?? caps?.sendMessage);
    const pendingSnap = pending as DashboardSnapshot | null;
    state.surfaceMode = pendingSnap?.surface === "global"
      ? "global"
      : pendingSnap?.surface === "workbench"
        ? "workbench"
        : state.canSendMessage || Boolean(state.conversationId)
          ? "workbench"
          : "global";
    if (pendingSnap) consumeResult(pendingSnap);
  }
  connected = true;
  try {
    const result = await callBackendTool<{ ui_preferences: UiPreferencesRecord }>(
      "app_preferences", { op: "get" }, { method: "GET", url: "/api/preferences" },
    );
    applyServerPreferences(result.ui_preferences);
  } catch (err) {
    console.error("[poly-swarm ui] preferences:", err);
  }
  await refreshDashboard().catch((err) => showToast(String(err)));

  window.setInterval(() => {
    if (shouldPausePolling()) return;
    pollInFlight = true;
    refreshDashboard(true).catch(() => {}).finally(() => { pollInFlight = false; });
  }, 800);
}

export function reportDashboardError(err: unknown): void {
  showToast(String(err));
}
