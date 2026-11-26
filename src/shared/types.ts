export type BackendId =
  | "agy"
  | "cursor"
  | "grok"
  | "opencode"
  | "codex"
  | "qoder"
  | "codebuddy"
  | "trae"
  | "mock";

export type RealBackendId = Exclude<BackendId, "mock">;

export type WorkerRole = "author" | "verifier" | "researcher" | "worker";

export type CapabilityTag =
  | "architect"
  | "author"
  | "verifier"
  | "research"
  | "enterprise"
  | "fanout";

export type WorkerState = "waiting" | "working" | "stopped" | "error" | "killed";

export type WorkspaceMode = "inherit" | "share" | "branch";

export type ErrorKind =
  | "none"
  | "quota_exhausted"
  | "auth_error"
  | "config_error"
  | "connection_error"
  | "timeout"
  | "cancelled"
  | "binary_missing"
  | "permission_denied"
  | "unauthorized_write"
  | "unknown";

export type UsageAccuracy = "exact" | "hook" | "estimated";

export type EventKind =
  | "system"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "text"
  | "error"
  | "usage"
  | "raw";

export type MessageTag =
  | "brief"
  | "update"
  | "done"
  | "blocked"
  | "stall"
  | "review_pass"
  | "review_fail"
  | "system";

export interface SwarmRecord {
  id: string;
  title: string;
  repo_root: string;
  base_branch: string | null;
  status: "active" | "done" | "archived";
  plan_json: string | null;
  policy_json?: string | null;
  team_id?: string | null;
  conversation_id?: string | null;
  conversation_source?: string | null;
  wave_index?: number;
  auto_created_by_workflow?: number;
  created_at: number;
  updated_at: number;
}

export type TeamStatus = "active" | "paused" | "archived";

export interface TeamRecord {
  id: string;
  name: string;
  goal: string | null;
  repo_root: string;
  status: TeamStatus;
  active_swarm_id: string | null;
  policy_json?: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionBindingRecord {
  conversation_id: string;
  team_id: string;
  active_swarm_id: string | null;
  repo_root: string | null;
  window_label: string | null;
  last_opened_at: number;
  updated_at: number;
}

export type SessionMatchReason =
  | "explicit_swarm"
  | "explicit_team"
  | "conversation_binding"
  | "repo_match"
  | "recent_workbench_focus"
  | "recent_active_team"
  | "none";

export interface UiPreferencesRecord {
  language: "zh-CN" | "en";
  theme: "system" | "dark" | "light";
  showOfficeBanner: boolean;
  animatedAvatars: boolean;
  autoCollapseBannerNarrow: boolean;
}

export interface ChannelRecord {
  id: number;
  swarm_id: string;
  name: string;
  topic: string | null;
  archived: number;
  created_at: number;
}

export interface WorkerRecord {
  id: string;
  swarm_id: string;
  name: string;
  role: WorkerRole;
  capability: CapabilityTag;
  backend: BackendId;
  model: string | null;
  effort: string | null;
  state: WorkerState;
  workspace_mode: WorkspaceMode;
  workspace_path: string;
  worktree_branch: string | null;
  session_id: string | null;
  needs_handoff: number;
  auto_fallback: number;
  review_of: string | null;
  channels_json: string;
  last_read_seq: number;
  last_post_seq: number;
  last_error: string | null;
  owner_instance_id?: string | null;
  identity_id?: string | null;
  agy_account_id?: string | null;
  parent_node?: string | null;
  policy_source?: PolicyLayer | null;
  resolved_policy_json?: string | null;
  created_at: number;
  updated_at: number;
}

export interface BoardMessage {
  seq: number;
  swarm_id: string;
  channel: string;
  sender: string;
  tag: MessageTag;
  text: string;
  mentions_json: string;
  refs_json: string;
  turn_id: string | null;
  suppress_wake?: number;
  created_at: number;
}

export type PendingDispatchStatus = "pending" | "claimed" | "uncertain";

export interface PendingDispatchRecord {
  swarm_id: string;
  worker_name: string;
  trigger_seq: number;
  status: PendingDispatchStatus;
  owner_instance_id: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TurnRecord {
  id: string;
  swarm_id: string;
  worker_name: string;
  backend: BackendId;
  model: string | null;
  actual_model?: string | null;
  effort?: string | null;
  mode: "readonly" | "write";
  trigger_seq: number | null;
  prompt_preview: string;
  status: "running" | "completed" | "failed" | "cancelled";
  error_kind: ErrorKind;
  error_message: string | null;
  output_text: string | null;
  structured_json: string | null;
  session_id_used: string | null;
  session_id_returned: string | null;
  duration_ms: number | null;
  tool_calls_count: number;
  owner_instance_id?: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface WorkerEvent {
  id: number;
  turn_id: string;
  swarm_id: string;
  worker_name: string;
  seq_in_turn: number;
  kind: EventKind;
  title: string | null;
  content: string;
  meta_json: string | null;
  created_at: number;
}

export interface UsageRecord {
  id: number;
  turn_id: string;
  swarm_id: string;
  worker_name: string;
  backend: BackendId;
  model: string | null;
  accuracy: UsageAccuracy;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  duration_ms: number;
  tool_calls_count: number;
  created_at: number;
}

export interface BackendHealth {
  backend: BackendId;
  installed: number;
  binary_path: string | null;
  version: string | null;
  supports_acp: number;
  cli_supports_acp?: number;
  active_protocol?: "headless_cli" | "app_server" | "acp";
  supports_headless: number;
  supports_resume: number;
  supports_exact_usage: number;
  supports_strict_readonly?: number;
  vendor_family?: string;
  cooldown_until: number | null;
  cooldown_reason: string | null;
  last_checked_at: number;
}

export interface SwarmPlanThread {
  id: string;
  title: string;
  goal: string;
  tasks: string[];
}

export interface SwarmPlan {
  goal: {
    title: string;
    line: string;
  };
  tasks: Record<string, string>;
  threads: SwarmPlanThread[];
}

export interface WorkflowStepDef {
  id: string;
  backend?: BackendId;
  capability?: CapabilityTag;
  model?: string;
  effort?: string;
  readonly?: boolean;
  prompt: string;
  json_schema?: Record<string, unknown>;
  timeout_ms?: number;
}

export interface WorkflowPhaseDef {
  name: string;
  mode: "parallel" | "pipeline";
  steps: WorkflowStepDef[];
}

export interface WorkflowDefinition {
  description: string;
  repo_root?: string;
  swarm_id?: string;
  team_id?: string;
  conversation_id?: string;
  phases: WorkflowPhaseDef[];
}

export interface WorkflowRecord {
  id: string;
  swarm_id: string | null;
  description: string;
  definition_json: string;
  status: "running" | "completed" | "failed";
  results_json: string | null;
  logs_json: string;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface UsageAggregate {
  key: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  known_cost_usd?: number;
  priced_turns?: number;
  unpriced_turns?: number;
  duration_ms: number;
  tool_calls_count: number;
  exact_turns: number;
  hook_turns: number;
  estimated_turns: number;
}

export interface WorkerSummary extends WorkerRecord {
  channels: string[];
  latest_turn: TurnRecord | null;
  latest_event: WorkerEvent | null;
  usage: UsageAggregate;
}

export type WorkbenchTab =
  | "detail"
  | "graph"
  | "board"
  | "usage"
  | "settings"
  | "overview"
  | "members";

export type PolicyLayer =
  | "builtin"
  | "global_ui"
  | "project"
  | "session"
  | "worker_explicit";

export type PromptMergeMode = "replace" | "append";

export type PlannedGraphLinkKind =
  | "dispatch"
  | "review"
  | "reports_to"
  | "depends_on"
  | "handoff";

export interface DispatchIdentitySpec {
  id: string;
  label: string;
  description?: string;
  base_role: WorkerRole;
  capability: CapabilityTag;
  preferred_backends?: BackendId[];
  model?: string;
  effort?: string;
  workspace_mode?: WorkspaceMode;
  auto_fallback?: boolean;
  require_cross_vendor?: boolean;
  reports_to?: string;
  review_by?: string;
  system_prompt?: string;
  skill_paths?: string[];
  prompt_mode?: PromptMergeMode;
  enabled?: boolean;
  weight?: number;
}

export interface DispatchIdentityPatch {
  label?: string | null;
  description?: string | null;
  base_role?: WorkerRole | null;
  capability?: CapabilityTag | null;
  preferred_backends?: BackendId[] | null;
  model?: string | null;
  effort?: string | null;
  workspace_mode?: WorkspaceMode | null;
  auto_fallback?: boolean | null;
  require_cross_vendor?: boolean | null;
  reports_to?: string | null;
  review_by?: string | null;
  system_prompt?: string | null;
  skill_paths?: string[] | null;
  prompt_mode?: PromptMergeMode | null;
  enabled?: boolean | null;
  weight?: number | null;
}

export interface PlannedGraphLink {
  from: string;
  to: string;
  kind: PlannedGraphLinkKind;
  label?: string;
  source?: PolicyLayer;
}

export interface BackendPolicyOverride {
  enabled?: boolean | null;
  defaultModel?: string | null;
  defaultEffort?: string | null;
}

export interface DispatchPolicyLayerConfig {
  routes?: Partial<Record<CapabilityTag, BackendId[] | null>>;
  backends?: Partial<Record<BackendId, BackendPolicyOverride | null>>;
  identities?: Record<string, DispatchIdentityPatch | null>;
  topology?: PlannedGraphLink[];
}

export interface FieldProvenance {
  layer: PolicyLayer;
  weight: number;
  detail?: string;
}

export interface ResolvedDispatchIdentity extends DispatchIdentitySpec {
  source: PolicyLayer;
  weight: number;
  builtin: boolean;
  enabled: boolean;
  field_sources: Record<string, FieldProvenance>;
  prompt_layers?: PolicyLayer[];
}

export interface ResolvedBackendPolicy {
  backend: BackendId;
  enabled: boolean;
  globally_disabled: boolean;
  defaultModel?: string;
  defaultEffort?: string;
  enabled_source: FieldProvenance;
  model_source?: FieldProvenance;
  effort_source?: FieldProvenance;
}

export interface PolicyLayerStatus {
  layer: Exclude<PolicyLayer, "worker_explicit">;
  weight: number;
  label: string;
  active: boolean;
  path?: string | null;
  override_count: number;
  raw?: DispatchPolicyLayerConfig | null;
}

export interface ResolvedDispatchPolicy {
  routes: Record<CapabilityTag, BackendId[]>;
  route_sources: Record<CapabilityTag, FieldProvenance>;
  backends: Partial<Record<BackendId, ResolvedBackendPolicy>>;
  identities: Record<string, ResolvedDispatchIdentity>;
  topology: PlannedGraphLink[];
  layers: PolicyLayerStatus[];
  warnings: string[];
  project_config_path: string | null;
  swarm_id: string | null;
}

export interface WorkerPolicySnapshot {
  identity_id: string;
  base_role: WorkerRole;
  capability: CapabilityTag;
  backend: BackendId;
  model: string | null;
  effort: string | null;
  workspace_mode: WorkspaceMode;
  auto_fallback: boolean;
  reports_to: string | null;
  review_by: string | null;
  policy_source: PolicyLayer;
  field_sources: Record<string, FieldProvenance>;
}

export type GraphNodeKind =
  | "coordinator"
  | "user"
  | "worker"
  | "planned"
  | "workflow_step"
  | "repo";

export type GraphEdgeKind =
  | "dispatch"
  | "mention"
  | "handoff"
  | "review"
  | "review_pass"
  | "review_fail"
  | "fallback"
  | "merge"
  | "reports_to"
  | "depends_on";

export interface DispatchEdgeRecord {
  id: number;
  swarm_id: string;
  from_node: string;
  to_node: string;
  kind: GraphEdgeKind;
  seq: number | null;
  turn_id: string | null;
  label: string | null;
  meta_json: string | null;
  created_at: number;
}

export interface DispatchGraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  layer: number;
  is_planned_only: boolean;
  identity_id?: string | null;
  role?: WorkerRole | null;
  capability?: CapabilityTag | null;
  backend?: BackendId | null;
  model?: string | null;
  effort?: string | null;
  state: WorkerState | "active" | "planned" | "completed" | "failed" | "running" | "merged";
  workspace_mode?: WorkspaceMode | null;
  worktree_branch?: string | null;
  review_of?: string | null;
  reports_to?: string | null;
  policy_source?: PolicyLayer | null;
  turns?: number;
  total_tokens?: number;
  cost_usd?: number;
  review_status?: "pending" | "pass" | "fail" | null;
}

export interface DispatchGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  mode: "actual" | "planned";
  count: number;
  label?: string;
  seq?: number | null;
  turn_id?: string | null;
  source_layer?: PolicyLayer | null;
  created_at?: number;
  meta?: Record<string, unknown> | null;
}

export interface DispatchGraphSummary {
  worker_count: number;
  planned_only_count: number;
  actual_edge_count: number;
  planned_edge_count: number;
  review_pass_count: number;
  review_fail_count: number;
  pending_review_count: number;
  fallback_count: number;
  merge_count: number;
}

export interface DispatchGraph {
  swarm_id: string;
  title: string;
  backfilled: boolean;
  nodes: DispatchGraphNode[];
  edges: DispatchGraphEdge[];
  timeline: DispatchEdgeRecord[];
  summary: DispatchGraphSummary;
  generated_at: number;
}

export interface BackendModelOption {
  id: string;
  label?: string;
  source?: "configured" | "detected" | "fallback";
  detected_at?: number | null;
}

export interface BackendConfigEntry {
  enabled: boolean;
  defaultModel?: string;
  defaultEffort?: string;
}

export interface UiFocusState {
  swarm_id: string | null;
  worker_name: string | null;
  tab: WorkbenchTab;
  seq: number;
  updated_at: number;
  workbench_alive: boolean;
}

export interface CandidateGateFailure {
  gate: "G1" | "G2" | "G4" | "G6";
  reason: string;
}

export interface CandidateEvaluation {
  backend: RealBackendId;
  model: string | null;
  effort: string | null;
  vendor_family: string;
  eligible: boolean;
  recommended: boolean;
  reasons: string[];
  gate_failures: CandidateGateFailure[];
}

export interface WorkerDeliverableSummary {
  worker_name: string;
  branch: string | null;
  target_branch: string | null;
  head_sha: string | null;
  dirty: boolean;
  dirty_files: string[];
  latest_review: BoardMessage | null;
  reviewed_sha: string | null;
  needs_independent_reviewer: boolean;
  sha_matches: boolean;
  stale: boolean;
}

export interface WorkerSwitchRecord {
  swarm_id: string;
  worker_name: string;
  from_backend: BackendId;
  to_backend: BackendId;
  from_model: string | null;
  to_model: string | null;
  auto: boolean;
  reason: string | null;
  seq: number | null;
  created_at: number;
}

export interface SwarmBriefSummary {
  worker_count: number;
  active_worker_count: number;
  backends: BackendId[];
  known_cost_usd: number;
  priced_turns: number;
  unpriced_turns: number;
  total_tokens: number;
}

export interface TeamSummary extends SwarmBriefSummary {
  team: TeamRecord;
  waves: SwarmRecord[];
  wave_count: number;
  bound_conversations: number;
  is_bound_to_current: boolean;
  latest_blackboard: BoardMessage[];
}

export interface BackendUsageBreakdown {
  backend: BackendId;
  model: string | null;
  turns: number;
  total_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_hit_rate: number | null;
  known_cost_usd: number;
  estimated_cost_usd: number;
  priced_turns: number;
  unpriced_turns: number;
  duration_ms: number;
  tool_calls_count: number;
}

export interface UsageBreakdownSummary {
  turns: number;
  tool_calls_count: number;
  duration_ms: number;
  avg_output_tps: number | null;
  total_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_hit_rate: number | null;
  known_cost_usd: number;
  estimated_cost_usd: number;
  priced_turns: number;
  unpriced_turns: number;
  exact_turns: number;
  hook_turns: number;
  estimated_turns: number;
  by_backend: BackendUsageBreakdown[];
}

export interface SessionTurnUsageItem {
  turn_id: string;
  worker_name: string;
  backend: BackendId;
  model: string | null;
  accuracy: UsageAccuracy;
  status: TurnRecord["status"] | null;
  trigger_seq: number | null;
  prompt_preview: string | null;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cache_hit_rate: number | null;
  cost_usd: number | null;
  estimated_cost_usd: number | null;
  duration_ms: number;
  tool_calls_count: number;
  created_at: number;
}

export interface VendorUsageSummary {
  backend: BackendId;
  totals: UsageBreakdownSummary;
  models: BackendUsageBreakdown[];
}

export interface ConversationWaveSummary extends SwarmBriefSummary {
  swarm: SwarmRecord;
  team_id: string | null;
  team_name: string | null;
  team_status: TeamStatus | null;
  is_workflow: boolean;
  is_manual_assignment: boolean;
  latest_signal: Pick<BoardMessage, "seq" | "tag" | "sender" | "created_at"> | null;
  last_activity_at: number;
  usage: UsageBreakdownSummary;
}

export interface ConversationArchiveSummary {
  conversation_id: string;
  title: string | null;
  custom_title: string | null;
  host_title: string | null;
  title_source: "custom" | "host" | "binding" | "none";
  is_current: boolean;
  bound_team_id: string | null;
  bound_swarm_id: string | null;
  repo_roots: string[];
  primary_repo_root: string | null;
  team_ids: string[];
  wave_count: number;
  real_wave_count: number;
  workflow_wave_count: number;
  worker_count: number;
  backends: BackendId[];
  known_cost_usd: number;
  priced_turns: number;
  unpriced_turns: number;
  total_tokens: number;
  latest_signal: (Pick<BoardMessage, "seq" | "tag" | "sender" | "created_at"> & { swarm_id: string }) | null;
  last_activity_at: number;
  updated_at: number;
  usage: UsageBreakdownSummary;
  waves: ConversationWaveSummary[];
}

export interface ConversationArchivesPayload {
  sessions: ConversationArchiveSummary[];
  unassigned_waves: ConversationWaveSummary[];
  total_sessions: number;
  total_unassigned: number;
}

export type StaffAvatarId = "aria" | "leo" | "theo" | "jules" | "mia";

export interface AgyAccountOption {
  id: string;
  email: string;
}

export interface AgyCompany {
  id: string;
  name: string;
  enabled: boolean;
  default_model: string | null;
  default_effort: string | null;
  cooldown_until: number | null;
}

export interface AgyCompanyView extends AgyCompany {
  account_available: boolean;
  account_hint?: string;
}

export interface StaffRosterMember {
  id: string;
  name: string;
  title: string;
  avatar: StaffAvatarId;
  backend: RealBackendId;
  model: string;
  effort?: string | null;
  role: WorkerRole;
  capability: CapabilityTag;
  identity_id?: string | null;
  company_id?: string | null;
  bio?: string | null;
  enabled: boolean;
  builtin?: boolean;
  created_at: number;
  updated_at: number;
}

export interface DashboardSnapshot {
  surface?: "workbench" | "inline" | "global";
  swarm: SwarmRecord | null;
  swarms: SwarmRecord[];
  team?: TeamRecord | null;
  teams?: TeamSummary[];
  conversation_archives?: ConversationArchivesPayload;
  team_waves?: SwarmRecord[];
  match_reason?: SessionMatchReason;
  active_conversation_id?: string | null;
  ui_preferences?: UiPreferencesRecord;
  data_dir?: string;
  plugin_version?: string;
  plan: SwarmPlan | null;
  channels: ChannelRecord[];
  workers: WorkerSummary[];
  board_tail: BoardMessage[];
  backends: BackendHealth[];
  workflows: WorkflowRecord[];
  usage_totals: UsageAggregate;
  usage_by_backend: UsageAggregate[];
  usage_by_worker: UsageAggregate[];
  global_usage_by_backend?: UsageAggregate[];
  global_usage_by_vendor?: Partial<Record<BackendId, VendorUsageSummary>>;
  agy_companies?: AgyCompanyView[];
  agy_company_usage?: UsageAggregate[];
  session_usage_breakdown?: UsageBreakdownSummary;
  session_usage_by_worker?: Record<string, UsageBreakdownSummary>;
  session_turn_usages?: SessionTurnUsageItem[];
  swarm_summaries?: Record<string, SwarmBriefSummary>;
  secondment_history?: WorkerSwitchRecord[];
  deliverables?: Record<string, WorkerDeliverableSummary>;
  blackboard_messages?: BoardMessage[];
  read_only_reason?: string | null;
  ui_focus: UiFocusState;
  ui_build_id?: string;
  effective_defaults: Partial<Record<BackendId, { model?: string; effort?: string }>>;
  backend_configs: Partial<Record<RealBackendId, BackendConfigEntry>>;
  staff_roster?: StaffRosterMember[];
  dispatch_policy?: ResolvedDispatchPolicy | null;
  dispatch_graph?: DispatchGraph | null;
  config_path?: string;
  projected?: boolean;
  inline_mode?: "dispatch" | "recap";
  default_collapsed?: boolean;
  generated_at: number;
}

export interface TeamAttachResult {
  team: TeamRecord;
  swarm: SwarmRecord | null;
  binding: SessionBindingRecord | null;
  handoff_context: string;
  snapshot: DashboardSnapshot;
}

export interface WorkspaceDiffResult {
  branch: string | null;
  stat: string;
  files: string[];
  patch_preview: string;
  truncated: boolean;
  head_sha?: string | null;
  dirty?: boolean;
  dirty_files?: string[];
  target_branch?: string | null;
}

export interface WorkerDetailPayload {
  worker: WorkerSummary;
  turns: TurnRecord[];
  latest_turn_events: WorkerEvent[];
  events_by_turn?: Record<string, WorkerEvent[]>;
  trigger_messages?: Record<number, BoardMessage>;
  diff: WorkspaceDiffResult | null;
}
