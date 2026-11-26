import type {
  AgyAccountOption,
  AgyCompanyView,
  BackendConfigEntry,
  BackendModelOption,
  BoardMessage,
  CapabilityTag,
  ConversationArchiveSummary,
  ConversationWaveSummary,
  DashboardSnapshot,
  RealBackendId,
  ResolvedDispatchIdentity,
  StaffAvatarId,
  StaffRosterMember,
  TeamSummary,
  UsageBreakdownSummary,
  WorkerRole,
  WorkspaceMode,
} from "../shared/types.js";
import { BACKEND_COLORS, renderBrandLogoSvg, renderEmployeeAvatarSvg, renderVendorBuildingSvg } from "./avatars_3d.js";
import agyLogo from "./assets/agent-logos/agy.webp";
import codebuddyLogo from "./assets/agent-logos/codebuddy.webp";
import codexLogo from "./assets/agent-logos/codex.webp";
import cursorLogo from "./assets/agent-logos/cursor.webp";
import grokLogo from "./assets/agent-logos/grok.webp";
import opencodeLogo from "./assets/agent-logos/opencode.webp";
import qoderLogo from "./assets/agent-logos/qoder.webp";
import traeLogo from "./assets/agent-logos/trae.webp";
import { READONLY_BUILTIN_IDENTITY_IDS } from "../shared/role_skills.js";
import { getLanguage, getPreferences, t } from "./i18n.js";
import { esc } from "./markdown.js";
import {
  blackboardTagTone,
  filterAndSortConversationArchives,
  formatRelativeTime,
  formatShortRepoLabels,
  getLatestBlackboardSignal,
  pickDefaultReviewWave,
  policyLayerBadgeClass,
  policyLayerShortLabel,
  graphEdgeKindLabel,
  type ArchiveSortKey,
  type BackendDraftState,
} from "./swarm_view_model.js";

const REAL_BACKENDS: RealBackendId[] = ["agy", "codex", "cursor", "grok", "opencode", "codebuddy", "qoder", "trae"];

const label = (key: string) => esc(t(key));
const words = (zh: string, en: string) => esc(getLanguage() === "en" ? en : zh);
const compact = (n: number) => Intl.NumberFormat(getLanguage(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
const usd = (n: number | undefined) => n === undefined ? "—" : "$" + n.toFixed(n > 0 && n < 0.01 ? 4 : 2);
const brand = (id: string) => esc(BACKEND_COLORS[id] ?? BACKEND_COLORS.mock!);

function renderRoleSkillField(args: { id: string; value?: string[] | null; layered?: boolean; disabled: boolean }): string {
  return `<div class="cfg-field">
    <label class="cfg-field-label" for="${esc(args.id)}">${words("岗位 Skill", "Role Skills")}</label>
    <textarea id="${esc(args.id)}" class="input-sm" rows="2" aria-describedby="${esc(args.id)}-hint" placeholder=".agents/skills/code-review/SKILL.md" ${args.disabled ? "disabled" : ""}>${esc((args.value ?? []).join("\n"))}</textarea>
    <small id="${esc(args.id)}-hint" class="muted">${words("每行一个工作区相对路径。派发时提示员工按需读取，不安装 Skill，也不增加工具权限。", "Enter one workspace-relative path per line. Workers are prompted to read relevant skills; this installs nothing and grants no access.")}${args.layered ? ` ${words("留空继承；填写后替换下层列表。", "Leave blank to inherit, or enter paths to replace the lower layer.")}` : ""}</small>
  </div>`;
}

const BACKEND_DISPLAY_META: Record<RealBackendId, { title: string; roleHint: string }> = {
  agy: { title: "Antigravity (agy)", roleHint: "架构设计 / 规划 / 多模态审查" },
  codex: { title: "Codex CLI (codex)", roleHint: "核心工程实现 / 测试验证" },
  cursor: { title: "Cursor Agent (cursor)", roleHint: "交互界面 / 多文件协作编辑" },
  grok: { title: "Grok CLI (grok)", roleHint: "深度研究 / 精确计费统计" },
  opencode: { title: "OpenCode (opencode)", roleHint: "高并发扇出 / 免费与多源模型" },
  codebuddy: { title: "CodeBuddy (codebuddy)", roleHint: "企业研发 / 混元与主流模型" },
  qoder: { title: "Qoder CLI (qoder)", roleHint: "多模型协同 / 快速执行" },
  trae: { title: "TRAE CLI (trae)", roleHint: "智能模型路由 / 工程构建" },
};

const EFFORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "CLI 默认" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

const CAMPUS_ANCHORS: Record<RealBackendId, { x: number; y: number }> = {
  codex: { x: 350, y: 126 },
  trae: { x: 650, y: 126 },
  agy: { x: 158, y: 222 },
  cursor: { x: 842, y: 222 },
  opencode: { x: 158, y: 398 },
  grok: { x: 842, y: 398 },
  codebuddy: { x: 350, y: 494 },
  qoder: { x: 650, y: 494 },
};

const CAMPUS_AGENT_LOGOS: Record<RealBackendId, string> = {
  agy: agyLogo, codebuddy: codebuddyLogo, codex: codexLogo, cursor: cursorLogo,
  grok: grokLogo, opencode: opencodeLogo, qoder: qoderLogo, trae: traeLogo,
};

function renderCampusBuilding(id: RealBackendId, size: number): string {
  return `<span class="campus-branded-building" aria-hidden="true">${renderVendorBuildingSvg(id, size)}<span class="campus-agent-sign"><img src="${CAMPUS_AGENT_LOGOS[id]}" alt="" draggable="false" /></span></span>`;
}

function renderAgyEffortHint(): string {
  return `<p class="muted">${words("带强度后缀的型号（如 -high、-xhigh）和 Orchestrator 以型号为准。要调整强度，请选择对应型号。", "Models with an effort suffix (such as -high or -xhigh) and Orchestrator use the selected model's settings. Pick the variant you want.")}</p>`;
}

export function renderCampusLensDock(activeSection: "companies" | "staff" | "rules"): string {
  const items: Array<{ id: "companies" | "staff" | "rules"; icon: string; wideKey: string; narrowKey: string }> = [
    { id: "companies", icon: "🏙", wideKey: "campusPanorama", narrowKey: "campusLensShort" },
    { id: "staff", icon: "🪪", wideKey: "staffGallery", narrowKey: "staffLensShort" },
    { id: "rules", icon: "🧭", wideKey: "dispatchSandbox", narrowKey: "rulesLensShort" },
  ];
  return `<nav class="campus-lens-dock" aria-label="${label("humanResources")}">${items
    .map(
      (item) => `<button type="button" class="lens-pill ${activeSection === item.id ? "active" : ""}" data-hr-section="${item.id}" aria-pressed="${activeSection === item.id}">
        <span aria-hidden="true">${item.icon}</span>
        <span class="label-wide">${label(item.wideKey)}</span>
        <span class="label-narrow">${label(item.narrowKey)}</span>
      </button>`,
    )
    .join("")}</nav>`;
}

export interface CampusViewState {
  selectedVendor: RealBackendId;
  selectedAgyCompany?: string | null;
  agyCompanyDraft?: { id: string; name: string; model: string; effort: string } | null;
  agyCompanySaving?: boolean;
  agyCompanyModels?: AgyCompanyModelsState;
  savingBackends: ReadonlySet<RealBackendId>;
  backendModels: Partial<Record<RealBackendId, BackendModelOption[]>>;
  modelsLoading: boolean;
  draft: (id: RealBackendId) => BackendDraftState;
  saved: (id: RealBackendId) => BackendConfigEntry;
  isDirty: (id: RealBackendId) => boolean;
}

export interface AgyCompanyModelsState {
  models: BackendModelOption[];
  loading: boolean;
  error?: string;
  fetchedAt?: number;
}

function renderAgyModelsStatus(companyId: string, state?: AgyCompanyModelsState): string {
  const status = state?.loading ? words("正在读取该账号的模型…", "Loading models for this account…")
    : state?.error ? esc(state.error)
    : state?.fetchedAt ? `${state.models.length} ${words("个账号可用模型", "models for this account")}`
    : words("尚未读取该账号的模型", "This account's models have not been loaded");
  return `<div class="section-head">
    <small class="muted" role="status">${status}</small>
    <button type="button" class="link-btn" data-action="refresh-agy-company-models" data-company="${esc(companyId)}"
      ${state?.loading ? "disabled" : ""}>↻ ${label("refresh")}</button>
  </div>`;
}

export function renderGlobalCompanies(snap: DashboardSnapshot, state: CampusViewState): string {
  const health = new Map(snap.backends.map((item) => [item.backend, item]));
  const usage = new Map((snap.global_usage_by_backend ?? []).map((item) => [item.key, item]));
  const vendorUsageMap = snap.global_usage_by_vendor ?? {};
  const now = Date.now();
  const companies = snap.agy_companies ?? [];
  const companyUsage = new Map((snap.agy_company_usage ?? []).map((item) => [item.key, item]));
  const selectedCompany = companies.find((entry) => entry.id === state.selectedAgyCompany);
  const legacyTitle = words("Antigravity · 本机默认", "Antigravity · Local default");

  const statusOf = (id: RealBackendId) => {
    const item = health.get(id);
    const cfg = snap.backend_configs?.[id];
    const enabled = cfg?.enabled !== false;
    const cooling = (item?.cooldown_until ?? 0) > now;
    const status = !enabled ? "disabled" : cooling ? "cooling" : item?.installed ? "online" : "notInstalled";
    return { item, cfg, enabled, cooling, status };
  };

  let onlineCount = 0;
  let disabledCount = 0;
  let coolingCount = 0;
  for (const id of REAL_BACKENDS) {
    const s = statusOf(id);
    if (s.status === "online") onlineCount += 1;
    else if (s.status === "disabled") disabledCount += 1;
    else if (s.status === "cooling") coolingCount += 1;
  }

  const sel: RealBackendId = REAL_BACKENDS.includes(state.selectedVendor) ? state.selectedVendor : "codex";
  const selStatus = statusOf(sel);
  const selUsage = sel === "agy" && snap.agy_company_usage ? companyUsage.get("agy") : usage.get(sel);
  const selVendorUsage = sel === "agy" && companies.length ? undefined : vendorUsageMap[sel];
  const selMeta = BACKEND_DISPLAY_META[sel];
  const selStrict = selStatus.item?.supports_strict_readonly === 1;
  const selDraft = state.draft(sel);
  const selDirty = state.isDirty(sel);
  const selSaving = state.savingBackends.has(sel);
  const selModels = state.backendModels[sel] ?? [];
  const selMatched = !selDraft.defaultModel || selModels.some((m) => m.id === selDraft.defaultModel);
  const selCustom = selDraft.customMode || (Boolean(selDraft.defaultModel) && !selMatched);
  const selTitle = sel === "agy" ? legacyTitle : selMeta.title.split(" (")[0] ?? sel;

  const linksSvg = REAL_BACKENDS.map((id) => {
    const pos = CAMPUS_ANCHORS[id];
    const st = statusOf(id);
    const isSel = id === sel && !selectedCompany;
    const cls = [
      "campus-link-path",
      isSel ? "is-selected" : "",
      st.status === "disabled" || st.status === "notInstalled" ? "is-dim" : "",
      st.cooling ? "is-cooling" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const cx = Math.round((500 + pos.x) / 2);
    const cy = Math.round((310 + pos.y) / 2) + (pos.y < 310 ? -24 : 24);
    return `<path class="${cls}" style="--company:${brand(id)}" d="M 500 310 Q ${cx} ${cy} ${pos.x} ${pos.y}" />`;
  }).join("");

  const buildingsHtml = REAL_BACKENDS.map((id) => {
    const pos = CAMPUS_ANCHORS[id];
    const st = statusOf(id);
    const vTotals = id === "agy" && companies.length ? undefined : vendorUsageMap[id]?.totals;
    const agg = id === "agy" && snap.agy_company_usage ? companyUsage.get(id) : usage.get(id);
    const isSel = id === sel && !selectedCompany;
    const shortName = id === "agy" ? legacyTitle : BACKEND_DISPLAY_META[id].title.split(" (")[0] ?? id;
    const dotCls =
      st.status === "online" ? "st-ok" : st.cooling && st.enabled ? "st-warn" : "st-idle";
    const buildingPriced = vTotals ? vTotals.priced_turns : agg?.priced_turns ?? 0;
    const buildingCost = vTotals ? vTotals.known_cost_usd : agg?.known_cost_usd;
    const subTag =
      st.status === "disabled"
        ? `<span class="campus-tag-badge badge">${label("disabled")}</span>`
        : st.status === "notInstalled"
          ? `<span class="campus-tag-badge badge">${label("notInstalled")}</span>`
          : st.cooling
            ? `<span class="campus-tag-badge badge badge-warn">${label("cooling")}</span>`
            : id === "opencode" || st.item?.supports_strict_readonly === 0
              ? `<span class="campus-tag-badge badge badge-warn">${label("noReadonlyLock")}</span>`
              : buildingPriced
                ? `<span class="campus-tag-badge badge badge-ok">${esc(usd(buildingCost))}</span>`
                : "";

    const cls = [
      "campus-building-node",
      isSel ? "is-selected" : "",
      !st.enabled || st.status === "notInstalled" ? "is-disabled" : "",
      st.cooling && st.enabled ? "is-cooling" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `<button type="button" class="${cls}" style="--company:${brand(id)};left:${(pos.x / 10).toFixed(2)}%;top:${(pos.y / 6.2).toFixed(2)}%" data-action="select-vendor" data-vendor="${id}" aria-pressed="${isSel}">
      <span class="campus-spotlight" aria-hidden="true"></span>
      <span class="campus-pedestal" aria-hidden="true"></span>
      <span class="campus-building-3d">${renderCampusBuilding(id, 78)}</span>
      <span class="campus-node-tag">
        <span class="campus-node-name"><i class="campus-status-dot ${dotCls}" aria-hidden="true"></i>${esc(shortName)}</span>
        ${subTag}
      </span>
    </button>`;
  }).join("");

  const modelOptionsHtml = [
    `<option value="" ${!selDraft.defaultModel && !selCustom ? "selected" : ""}>${words("CLI 默认", "CLI default")}</option>`,
    ...selModels.map((m) => {
      const base = m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id;
      const suffix = m.source === "fallback" ? ` [${t("modelFallbackTag")}]` : "";
      return `<option value="${esc(m.id)}" ${!selCustom && selDraft.defaultModel === m.id ? "selected" : ""}>${esc(base)}${esc(suffix)}</option>`;
    }),
    `<option value="__custom__" ${selCustom ? "selected" : ""}>${words("自定义模型 ID...", "Custom model ID...")}</option>`,
  ].join("");

  const effortOptionsHtml = EFFORT_OPTIONS.map(
    (opt) => `<option value="${esc(opt.value)}" ${selDraft.defaultEffort === opt.value ? "selected" : ""}>${esc(opt.label)}</option>`,
  ).join("");

  const animated = getPreferences().animatedAvatars;

  return `<div class="campus-layout">
    <section class="campus-stage-card" aria-label="${label("campusPanorama")}">
      <div class="campus-stage-hud">
        <div class="campus-hud-chip">
          <span>${REAL_BACKENDS.length + companies.length} ${words("家外包公司", "vendors")}</span>
          <span class="hud-sep">·</span>
          <span class="hud-ok">${esc(onlineCount)} ${label("online")}</span>
          ${disabledCount ? `<span class="hud-sep">·</span><span>${esc(disabledCount)} ${label("disabled")}</span>` : ""}
          ${coolingCount ? `<span class="hud-sep">·</span><span class="hud-warn">${esc(coolingCount)} ${label("cooling")}</span>` : ""}
        </div>
        <button type="button" class="btn btn-icon campus-hud-refresh" data-action="refresh-backends" title="${label("refresh")}">↻</button>
      </div>

      <div class="campus-viewport">
        <div class="campus-island">
          <div class="campus-platform" aria-hidden="true"></div>
          <svg class="campus-links-svg" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">${linksSvg}</svg>
          <div class="campus-core-node" aria-hidden="true">${renderBrandLogoSvg(36)}</div>
          ${buildingsHtml}
        </div>
      </div>

      <section class="campus-account-companies" aria-label="${words("Antigravity 外包公司", "Antigravity companies")}">
        <div class="section-head">
          <strong>${words("Antigravity 外包公司", "Antigravity companies")}</strong>
          <button type="button" class="btn btn-sm-pad" data-action="open-agy-company-import">+ ${words("添加账号公司", "Add account companies")}</button>
        </div>
        ${companies.length ? `<div class="campus-account-grid">${companies.map((entry) => {
          const status = agyCompanyStatus(entry);
          return `<button type="button" class="campus-account-tile" data-action="select-agy-company" data-company="${esc(entry.id)}" aria-pressed="${selectedCompany?.id === entry.id}">
            ${renderCampusBuilding("agy", 49)}
            <span><strong>${esc(entry.name)}</strong><small>${status.text}</small></span>
          </button>`;
        }).join("")}</div>`
          : `<p class="muted">${words("把已保存的 Antigravity 账号添加为独立公司，再招募旗下员工。", "Add saved Antigravity accounts as independent companies, then recruit their employees.")}</p>`}
      </section>

      ${renderCampusLensDock("companies")}
    </section>

    ${selectedCompany ? renderAgyCompanyInspector(snap, state, selectedCompany) : `<aside class="panel-card campus-inspector" style="--company:${brand(sel)}" aria-label="${esc(selTitle)}">
      <div class="inspector-hero">
        <span class="status-badge status-${selStatus.status === "online" ? "ok" : selStatus.cooling && selStatus.enabled ? "warn" : "idle"}">${label(selStatus.status)}</span>
        <button type="button" role="switch" aria-checked="${selStatus.enabled}" aria-label="${esc(sel)} ON/OFF" class="company-toggle" data-action="toggle-company" data-backend="${sel}" ${selSaving ? "disabled" : ""}><i></i><span>${selStatus.enabled ? "ON" : "OFF"}</span></button>
        <div class="inspector-hero-stage">${renderCampusBuilding(sel, 112)}</div>
      </div>

      <div class="inspector-title-row">
        <div>
          <h3>${esc(selTitle)}</h3>
          ${sel === "agy" ? `<span class="badge">${words("旧配置", "Legacy")}</span>` : ""}
          <div class="muted mono inspector-version">${esc(selStatus.item?.version || selStatus.cfg?.defaultModel || "CLI")}</div>
        </div>
        ${
          selStrict || sel === "opencode" || selStatus.item?.supports_strict_readonly === 0
            ? `<span class="badge ${selStrict ? "badge-ok" : "badge-warn"}">${label(selStrict ? "readonlyQualified" : "noReadonlyLock")}</span>`
            : ""
        }
      </div>

      <p class="muted inspector-role-hint">${esc(selMeta.roleHint)}</p>

      <div class="inspector-controls">
        <div class="cfg-row-2">
          <label class="cfg-field">
            <span class="cfg-field-label">${words("模型", "Model")}</span>
            <select class="select-sm" data-cfg-model-select="${sel}" ${selSaving ? "disabled" : ""}>${modelOptionsHtml}</select>
          </label>
          <label class="cfg-field">
            <span class="cfg-field-label">${words("推理强度", "Effort")}</span>
            <select class="select-sm" data-cfg-effort="${sel}" ${selSaving ? "disabled" : ""}>${effortOptionsHtml}</select>
          </label>
        </div>
        ${sel === "agy" ? renderAgyEffortHint() : ""}
        ${
          selCustom
            ? `<div class="cfg-field">
                <input class="input-sm" data-cfg-model-custom="${sel}" value="${esc(selDraft.defaultModel)}" placeholder="${words("输入完整模型 ID", "Custom model ID")}" ${selSaving ? "disabled" : ""} />
              </div>`
            : ""
        }
        ${
          selDirty
            ? `<div class="inspector-dirty-bar">
                <button type="button" class="btn btn-sm-pad" data-action="reset-backend-cfg" data-backend="${sel}" ${selSaving ? "disabled" : ""}>${words("还原", "Reset")}</button>
                <button type="button" class="btn btn-sm-pad btn-primary" data-action="save-backend-cfg" data-backend="${sel}" ${selSaving ? "disabled" : ""}>${selSaving ? words("保存中…", "Saving…") : words("保存模型配置", "Save model")}</button>
              </div>`
            : ""
        }
      </div>

      ${(() => {
        if (!selVendorUsage) {
          return `<div class="inspector-metrics">
            <div><strong>${esc(selUsage?.turns ?? 0)}</strong><span>${label("turns")}</span></div>
            <div><strong>${esc(compact(selUsage?.total_tokens ?? 0))}</strong><span>tokens</span></div>
            <div><strong>${esc(selUsage?.priced_turns ? usd(selUsage.known_cost_usd) : "—")}</strong><span>${selUsage?.priced_turns ? "USD" : words("订阅未计价", "Subscription")}</span></div>
          </div>`;
        }
        const vt = selVendorUsage.totals;
        const vHitPct = vt.cache_hit_rate !== null ? Math.round(vt.cache_hit_rate * 100) : null;
        const vSpend = fmtSpendText(vt);
        const vModelsHtml = selVendorUsage.models
          .map((m) => {
            const mHit = m.cache_hit_rate !== null ? Math.round(m.cache_hit_rate * 100) : null;
            const mCost =
              m.priced_turns > 0 && m.known_cost_usd > 0
                ? `<span class="vendor-model-cost">${esc(usd(m.known_cost_usd))}</span>`
                : m.unpriced_turns > 0 && m.estimated_cost_usd > 0
                  ? `<span class="badge archive-est-chip">≈${esc(usd(m.estimated_cost_usd))}</span>`
                  : m.priced_turns > 0
                    ? `<span class="vendor-model-cost">$0.00</span>`
                    : `<span class="muted">—</span>`;
            const modelTitle = m.model?.trim() || t("vendorModelDefault");
            return `<article class="vendor-model-card">
              <header class="vendor-model-head">
                <strong class="mono" title="${esc(modelTitle)}">${esc(modelTitle)}</strong>
                <div class="pill-row">
                  <span class="badge">${esc(m.turns)} ${label("turns")}</span>
                  ${mHit !== null ? `<span class="badge archive-hit-chip">${label("archiveCacheHit")} ${esc(mHit)}%</span>` : ""}
                  ${mCost}
                </div>
              </header>
              <div class="vendor-model-sub">
                <strong title="${esc(fmtTokExact(m.total_tokens))}">${esc(fmtTokExact(m.total_tokens))}</strong>
                <span class="muted">${esc(fmtDurationHuman(m.duration_ms))} · ${esc(m.tool_calls_count)} ${words("工具", "tools")}</span>
              </div>
              <div class="vendor-model-metrics">
                <span title="${esc(fmtTokExact(m.uncached_input_tokens))}"><i>${label("archiveUncachedInput")}</i><b>${esc(compact(m.uncached_input_tokens))}</b></span>
                <span title="${esc(fmtTokExact(m.cache_read_tokens))}"><i>${label("archiveCacheRead")}</i><b>${esc(compact(m.cache_read_tokens))}</b></span>
                <span title="${esc(fmtTokExact(m.output_tokens))}"><i>${label("archiveOutputTokens")}</i><b>${esc(compact(m.output_tokens))}</b></span>
                ${m.cache_write_tokens > 0 ? `<span title="${esc(fmtTokExact(m.cache_write_tokens))}"><i>${label("archiveCacheWrite")}</i><b>${esc(compact(m.cache_write_tokens))}</b></span>` : ""}
                ${m.reasoning_tokens > 0 ? `<span title="${esc(fmtTokExact(m.reasoning_tokens))}"><i>${label("archiveReasoningTokens")}</i><b>${esc(compact(m.reasoning_tokens))}</b></span>` : ""}
              </div>
            </article>`;
          })
          .join("");
        return `<section class="inspector-billing-sec" aria-label="${label("vendorBillingStats")}">
          <div class="section-head">
            <span class="cfg-field-label">${label("vendorBillingStats")} · ${label("vendorTotalLabel")}</span>
            ${vHitPct !== null ? `<span class="badge archive-hit-chip">${label("archiveCacheHit")} ${esc(vHitPct)}%</span>` : ""}
          </div>
          <div class="inspector-metrics">
            <div>
              <strong>${esc(vt.turns)}</strong>
              <span>${label("turns")} · ${esc(vt.tool_calls_count)} ${words("工具", "tools")}</span>
            </div>
            <div>
              <strong title="${esc(fmtTokExact(vt.total_tokens))}">${esc(compact(vt.total_tokens))}</strong>
              <span>tokens</span>
            </div>
            <div>
              <strong title="${esc(vSpend.title)}">${esc(vSpend.text)}</strong>
              <span>${vt.priced_turns > 0 ? "USD" : vSpend.isEstimated ? words("参考估算", "Est.") : words("订阅未计价", "Subscription")}</span>
            </div>
          </div>
          ${
            vt.turns > 0
              ? `${vHitPct !== null ? `<div class="telemetry-cache-bar" title="${label("archiveCacheHit")} ${esc(vHitPct)}%"><i style="width:${esc(Math.min(100, Math.max(2, vHitPct)))}%"></i></div>` : ""}
                <div class="vendor-usage-kv-grid">
                  <div><span>${label("archiveUncachedInput")}</span><strong title="${esc(fmtTokExact(vt.uncached_input_tokens))}">${esc(fmtTokExact(vt.uncached_input_tokens))}</strong></div>
                  <div><span>${label("archiveCacheRead")}</span><strong title="${esc(fmtTokExact(vt.cache_read_tokens))}">${esc(fmtTokExact(vt.cache_read_tokens))}</strong></div>
                  ${vt.cache_write_tokens > 0 ? `<div><span>${label("archiveCacheWrite")}</span><strong>${esc(fmtTokExact(vt.cache_write_tokens))}</strong></div>` : ""}
                  <div><span>${label("archiveOutputTokens")}</span><strong title="${esc(fmtTokExact(vt.output_tokens))}">${esc(fmtTokExact(vt.output_tokens))}</strong></div>
                  ${vt.reasoning_tokens > 0 ? `<div><span>${label("archiveReasoningTokens")}</span><strong>${esc(fmtTokExact(vt.reasoning_tokens))}</strong></div>` : ""}
                  <div><span>${label("archiveExecDuration")}</span><strong>${esc(fmtDurationHuman(vt.duration_ms))}</strong></div>
                  ${vt.priced_turns > 0 ? `<div><span>${label("archiveKnownBill")}</span><strong>${esc(usd(vt.known_cost_usd))}</strong></div>` : ""}
                  ${vt.estimated_cost_usd > 0 ? `<div><span>${label("archiveEstBill")}</span><strong class="archive-est-chip" style="padding:0 5px;border-radius:5px;">≈${esc(usd(vt.estimated_cost_usd))}</strong></div>` : ""}
                </div>
                <div class="section-head" style="margin-top:4px;">
                  <span class="cfg-field-label">${label("vendorModelBreakdown")} (${esc(selVendorUsage.models.length)})</span>
                </div>
                <div class="vendor-model-usage-list">${vModelsHtml}</div>`
              : `<p class="muted inspector-empty-models">${label("vendorNoUsage")}</p>`
          }
        </section>`;
      })()}

      <div class="inspector-models-sec">
        <div class="section-head">
          <span class="cfg-field-label">${label("vendorEmployees")} (${esc(selModels.length)})</span>
          <button type="button" class="link-btn" data-action="refresh-models" ${state.modelsLoading ? "disabled" : ""}>${state.modelsLoading ? words("探测中…", "Loading…") : `↻ ${t("refresh")}`}</button>
        </div>
        <div class="inspector-models-grid">
          ${
            selModels.slice(0, 6).map(
              (m) => `<button type="button" class="inspector-mini-staff" data-action="inspect-vendor-staff" data-backend="${sel}" title="${esc(m.id)}">
                ${renderEmployeeAvatarSvg({ backend: sel, model: m.id, name: m.id, size: 32, animated })}
                <span>${esc(m.label || m.id)}</span>
              </button>`,
            ).join("") || `<span class="muted inspector-empty-models">${state.modelsLoading ? words("正在读取模型目录…", "Loading catalog…") : words("暂无探测模型 · 点击刷新", "No models cached · Click Refresh")}</span>`
          }
        </div>
      </div>

      <button type="button" class="btn btn-primary inspector-cta" data-action="edit-backend-rules" data-backend="${sel}">${label("configureRules")} ›</button>
    </aside>`}
  </div>`;
}

function agyCompanyStatus(company: AgyCompanyView) {
  if (!company.enabled) return { text: label("disabled"), tone: "idle" };
  if (!company.account_available) return { text: words("凭据不可用", "Account unavailable"), tone: "idle" };
  if ((company.cooldown_until ?? 0) > Date.now()) return { text: label("cooling"), tone: "warn" };
  return { text: words("凭据已保存", "Account saved"), tone: "ok" };
}

function renderAgyCompanyInspector(snap: DashboardSnapshot, state: CampusViewState, company: AgyCompanyView): string {
  const status = agyCompanyStatus(company);
  const usage = snap.agy_company_usage?.find((entry) => entry.key === company.id);
  const members = (snap.staff_roster ?? []).filter((entry) => entry.company_id === company.id);
  const draft = state.agyCompanyDraft?.id === company.id ? state.agyCompanyDraft : {
    name: company.name, model: company.default_model ?? "", effort: company.default_effort ?? "",
  };
  const dirty = draft.name !== company.name || draft.model !== (company.default_model ?? "") ||
    draft.effort !== (company.default_effort ?? "");
  const disabled = state.agyCompanySaving ? "disabled" : "";
  const candidates = state.agyCompanyModels?.models ?? [];
  return `<aside class="panel-card campus-inspector" style="--company:${brand("agy")}" aria-label="${esc(company.name)}">
    <div class="inspector-hero">
      <span class="status-badge status-${status.tone}">${status.text}</span>
      <button type="button" role="switch" aria-checked="${company.enabled}" aria-label="${esc(company.name)} ON/OFF" class="company-toggle" data-action="toggle-agy-company" data-company="${esc(company.id)}" ${disabled}><i></i><span>${company.enabled ? "ON" : "OFF"}</span></button>
      <div class="inspector-hero-stage">${renderCampusBuilding("agy", 112)}</div>
    </div>
    <div class="inspector-title-row"><div><h3>${esc(company.name)}</h3>
      <div class="muted mono inspector-version">Antigravity CLI${company.account_hint ? ` · ${esc(company.account_hint)}` : ""}</div></div>
      <span class="badge badge-ok">${label("readonlyQualified")}</span>
    </div>
    <div class="inspector-controls">
      <label class="cfg-field"><span class="cfg-field-label">${words("公司名称", "Company name")}</span>
        <input class="input-sm" maxlength="48" data-agy-company-field="name" value="${esc(draft.name)}" ${disabled}></label>
      <div class="cfg-row-2">
        <label class="cfg-field"><span class="cfg-field-label">${words("默认模型", "Default model")}</span>
          <input class="input-sm" maxlength="160" list="agy-company-models" data-agy-company-field="model" value="${esc(draft.model)}" placeholder="${words("使用调度默认", "Use dispatch default")}" ${disabled}>
          <datalist id="agy-company-models">${candidates.map((m) => `<option value="${esc(m.id)}">${esc(m.label ?? m.id)}</option>`).join("")}</datalist></label>
        <label class="cfg-field"><span class="cfg-field-label">${words("默认推理强度", "Default effort")}</span>
          <select class="select-sm" data-agy-company-field="effort" ${disabled}>${EFFORT_OPTIONS.map((o) =>
            `<option value="${esc(o.value)}" ${o.value === draft.effort ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>
      </div>
      ${renderAgyEffortHint()}
      ${renderAgyModelsStatus(company.id, state.agyCompanyModels)}
      <div class="inspector-dirty-bar"><button type="button" class="btn btn-sm-pad btn-primary"
        data-action="save-agy-company" data-company="${esc(company.id)}" ${state.agyCompanySaving || !dirty ? "disabled" : ""}>${words("保存公司配置", "Save company")}</button></div>
    </div>
    <div class="inspector-metrics">
      <div><strong>${esc(usage?.turns ?? 0)}</strong><span>${label("turns")}</span></div>
      <div><strong>${esc(compact(usage?.total_tokens ?? 0))}</strong><span>tokens</span></div>
      <div><strong>${esc(usage?.priced_turns ? usd(usage.known_cost_usd) : "—")}</strong><span>${usage?.priced_turns ? "USD" : words("订阅未计价", "Subscription")}</span></div>
    </div>
    <div class="inspector-models-sec">
      <div class="section-head"><span class="cfg-field-label">${words("旗下员工", "Employees")} (${members.length})</span>
        <button type="button" class="link-btn" data-action="open-staff-recruit" ${company.enabled ? "" : "disabled"}>+ ${label("recruitStaff")}</button></div>
      <div class="inspector-models-grid">${members.map((member) => `<button type="button" class="inspector-mini-staff" data-action="edit-staff-member" data-staff-id="${esc(member.id)}">
        ${renderEmployeeAvatarSvg({ backend: "agy", model: member.model, avatar: member.avatar, name: member.name, size: 32 })}<span>${esc(member.name)}<small class="muted">${esc(member.model || company.default_model || "")}</small></span>
      </button>`).join("") || `<span class="muted">${words("暂无员工", "No employees yet")}</span>`}</div>
    </div>
  </aside>`;
}

export function renderAgyCompanyImport(params: {
  open: boolean; loading: boolean; failed: boolean; saving: boolean;
  accounts: AgyAccountOption[]; companies: AgyCompanyView[]; picked: ReadonlySet<string>;
}): string {
  if (!params.open) return "";
  const existing = new Set(params.companies.map((entry) => entry.id));
  const accounts = params.accounts.filter((a) => !existing.has(`agy-${a.id}`));
  return `<div class="drawer-scrim staff-modal-scrim" data-action="close-agy-company-import">
    <section class="panel-card staff-editor-modal agy-company-import" role="dialog" aria-modal="true"
      aria-label="${words("添加账号公司", "Add account companies")}" onclick="event.stopPropagation()">
      <header class="section-head"><h3>${words("添加 Antigravity 外包公司", "Add Antigravity companies")}</h3>
        <button type="button" class="btn btn-icon" data-action="close-agy-company-import" aria-label="${label("cancel")}">×</button></header>
      <div class="staff-editor-form">
        <p class="muted">${words("每个已保存的账号只可添加一次，名称添加后可修改。", "Add each saved account once. You can rename the company afterwards.")}</p>
        ${params.loading ? `<p>${words("正在读取已保存的账号…", "Loading saved accounts…")}</p>`
          : params.failed ? `<p>${words("读取失败，请重新打开添加窗口。", "Could not load accounts. Reopen this dialog to retry.")}</p>`
          : !accounts.length ? `<p>${params.accounts.length ? words("已保存的账号都已添加。", "All saved accounts have been added.")
            : words("没有可添加的账号。请先在「账号切换」插件中保存账号。", "Save accounts in Antigravity Account Switch first.")}</p>`
          : accounts.map((a) => `<label class="preference-row"><span>${esc(a.email)}</span>
            <input type="checkbox" data-agy-company-account="${esc(a.id)}" ${params.picked.has(a.id) ? "checked" : ""} ${params.saving ? "disabled" : ""}></label>`).join("")}
      </div>
      <footer class="staff-editor-foot">
        <button type="button" class="btn btn-sm-pad" data-action="close-agy-company-import" ${params.saving ? "disabled" : ""}>${label("cancel")}</button>
        <button type="button" class="btn btn-sm-pad btn-primary" data-action="add-agy-companies" ${params.saving || !params.picked.size ? "disabled" : ""}>${words("添加所选公司", "Add selected")} (${params.picked.size})</button>
      </footer>
    </section>
  </div>`;
}

export interface StaffEditorDraft {
  mode: "create" | "edit";
  id: string;
  name: string;
  title: string;
  avatar: StaffAvatarId;
  backend: RealBackendId;
  model: string;
  effort: string;
  role: WorkerRole;
  capability: CapabilityTag;
  identity_id: string;
  company_id?: string;
  legacyAgy?: boolean;
  bio: string;
  enabled: boolean;
}

const STAFF_AVATAR_CHOICES: Array<{ id: StaffAvatarId; label: string }> = [
  { id: "aria", label: "Aria" },
  { id: "leo", label: "Leo" },
  { id: "theo", label: "Theo" },
  { id: "jules", label: "Jules" },
  { id: "mia", label: "Mia" },
];

export function renderStaffEditorModal(params: {
  draft: StaffEditorDraft | null;
  catalog: Partial<Record<RealBackendId, BackendModelOption[]>>;
  busy: boolean;
  loadingModels: boolean;
  agyCompanies?: AgyCompanyView[];
  agyCompanyModels?: AgyCompanyModelsState;
  identities?: Record<string, ResolvedDispatchIdentity>;
}): string {
  const d = params.draft;
  if (!d) return "";
  const isCreate = d.mode === "create";
  const companies = params.agyCompanies ?? [];
  const company = companies.find((entry) => entry.id === d.company_id);
  const models = d.company_id ? params.agyCompanyModels?.models ?? [] : params.catalog[d.backend] ?? [];
  const hasMatch = Boolean(d.model) && models.some((m) => m.id === d.model);
  const disabled = params.busy ? "disabled" : "";
  const companyValue = d.company_id || d.backend;
  const companyDefault = words("使用公司默认", "Use company default");
  const identityId = d.identity_id || d.role;
  const identity = params.identities?.[identityId];
  const matchingIdentities = Object.values(params.identities ?? {}).filter((item) => item.enabled && item.base_role === d.role);
  return `<div class="drawer-scrim staff-modal-scrim" role="presentation" data-action="close-staff-modal">
    <section class="panel-card staff-editor-modal" role="dialog" aria-modal="true" aria-label="${isCreate ? label("recruitStaff") : label("editProfile")}" onclick="event.stopPropagation()">
      <header class="section-head">
        <h3>${isCreate ? label("recruitStaff") : `${label("editProfile")} · ${esc(d.name || d.id)}`}</h3>
        <button type="button" class="btn btn-icon" data-action="close-staff-modal" aria-label="${label("cancel")}">×</button>
      </header>
      <div class="staff-editor-form">
        <div class="cfg-field">
          <span class="cfg-field-label">${label("staffAvatar")}</span>
          <div class="staff-avatar-picker" role="radiogroup" aria-label="${label("staffAvatar")}">
            ${STAFF_AVATAR_CHOICES.map(
              (ch) => `<button type="button" class="avatar-choice-btn ${d.avatar === ch.id ? "is-selected" : ""}" data-action="pick-staff-avatar" data-avatar="${ch.id}" aria-pressed="${d.avatar === ch.id}" ${disabled}>
                ${renderEmployeeAvatarSvg({ backend: d.backend, avatar: ch.id, model: d.model, name: ch.id, role: d.role, size: 42 })}
                <span>${esc(ch.label)}</span>
              </button>`,
            ).join("")}
          </div>
        </div>
        <div class="cfg-row-2">
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-name">${label("staffName")}</label>
            <input id="staff-edit-name" class="input-sm" value="${esc(d.name)}" placeholder="例如 Aria" ${disabled} />
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-title">${label("staffTitle")}</label>
            <input id="staff-edit-title" class="input-sm" value="${esc(d.title)}" placeholder="例如 全栈核心开发" ${disabled} />
          </div>
        </div>
        <div class="cfg-row-2">
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-backend">${label("staffVendor")}</label>
            <select id="staff-edit-backend" class="select-sm" data-staff-field="backend" ${disabled}>
              ${REAL_BACKENDS.filter((b) => b !== "agy").map((b) => `<option value="${b}" ${companyValue === b ? "selected" : ""}>${esc(BACKEND_DISPLAY_META[b].title)}</option>`).join("")}
              ${companies.map((entry) => `<option value="${esc(entry.id)}" ${companyValue === entry.id ? "selected" : !entry.enabled ? "disabled" : ""}>${esc(entry.name)}${entry.enabled ? "" : ` (${label("disabled")})`}</option>`).join("")}
              ${d.legacyAgy ? `<option value="agy" ${companyValue === "agy" ? "selected" : ""}>${words("Antigravity · 本机默认（旧配置）", "Antigravity · Local default (legacy)")}</option>` : ""}
            </select>
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-effort">${label("staffEffort")}</label>
            <select id="staff-edit-effort" class="select-sm" ${disabled}>
              ${EFFORT_OPTIONS.map((opt) => `<option value="${esc(opt.value)}" ${d.effort === opt.value ? "selected" : ""}>${company && !opt.value ? companyDefault : esc(opt.label)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="cfg-row-2">
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-model-select">${label("staffModel")} ${!d.company_id && params.loadingModels ? `(${words("加载中", "loading")}…)` : ""}</label>
            <select id="staff-edit-model-select" class="select-sm" data-staff-field="model-select" ${disabled}>
              ${company ? `<option value="" ${!d.model ? "selected" : ""}>${companyDefault}${company.default_model ? ` · ${esc(company.default_model)}` : ""}</option>` : ""}
              ${models.map((m) => `<option value="${esc(m.id)}" ${hasMatch && d.model === m.id ? "selected" : ""}>${esc(m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id)}</option>`).join("")}
              <option value="__custom__" ${!hasMatch && (!company || d.model) ? "selected" : ""}>${words("手动输入模型 ID…", "Custom model ID…")}</option>
            </select>
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-model">${words("模型 ID（可直接修改）", "Model ID")}</label>
            <input id="staff-edit-model" class="input-sm" value="${esc(d.model)}" placeholder="${company ? companyDefault : "例如 gpt-6.2-sol"}" ${disabled} />
          </div>
        </div>
        ${d.backend === "codex" && !params.loadingModels && models.length === 0
          ? `<p class="muted">${words("未读到 Codex 模型目录，可手动输入模型 ID。", "No Codex models were loaded. You can enter a model ID manually.")}</p>` : ""}
        ${d.backend === "agy" ? renderAgyEffortHint() : ""}
        ${company ? renderAgyModelsStatus(company.id, params.agyCompanyModels) : ""}
        <div class="cfg-row-2">
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-role">${label("staffRole")}</label>
            <select id="staff-edit-role" class="select-sm" aria-describedby="staff-role-hint" ${disabled}>
              <option value="author" ${d.role === "author" ? "selected" : ""}>${words("工程实现 · 可写，默认独立工作树", "Implement · writable, separate worktree by default")}</option>
              <option value="verifier" ${d.role === "verifier" ? "selected" : ""}>${words("审校验收 · 只读", "Review · read-only")}</option>
              <option value="researcher" ${d.role === "researcher" ? "selected" : ""}>${words("调研分析 · 只读", "Research · read-only")}</option>
              <option value="worker" ${d.role === "worker" ? "selected" : ""}>${words("通用协作 · 可写，默认当前工作区", "General work · writable, current workspace by default")}</option>
            </select>
            <small id="staff-role-hint" class="muted">${words("决定默认读写模式。实际能用哪些工具和文件，由 CLI 的运行配置和权限模式决定。", "Sets the default read or write mode. The CLI profile and permission mode govern actual tool and file access.")}</small>
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label" for="staff-edit-cap">${label("staffCapability")}</label>
            <select id="staff-edit-cap" class="select-sm" aria-describedby="staff-cap-hint" ${disabled}>
              <option value="architect" ${d.capability === "architect" ? "selected" : ""}>architect (${label("architect")})</option>
              <option value="author" ${d.capability === "author" ? "selected" : ""}>author (${label("implement")})</option>
              <option value="verifier" ${d.capability === "verifier" ? "selected" : ""}>verifier (${label("review")})</option>
              <option value="research" ${d.capability === "research" ? "selected" : ""}>research (${label("research")})</option>
              <option value="enterprise" ${d.capability === "enterprise" ? "selected" : ""}>enterprise (${words("协同", "Collaboration")})</option>
              <option value="fanout" ${d.capability === "fanout" ? "selected" : ""}>fanout (${words("并发", "Fanout")})</option>
            </select>
            <small id="staff-cap-hint" class="muted">${words("供自动选后端和筛选后备后端。不会改变已绑定的 CLI，也不会增加权限。", "Used for automatic routing and fallback. Cannot change the bound CLI or grant permissions.")}</small>
          </div>
        </div>
        <div class="cfg-field">
          <label class="cfg-field-label" for="staff-edit-identity">${words("岗位模板", "Role Template")}</label>
          <select id="staff-edit-identity" class="select-sm" aria-describedby="staff-identity-hint" ${disabled}>
            <option value="" ${!d.identity_id ? "selected" : ""}>${words("按默认执行权限", "From the execution role")} · ${esc(d.role)}</option>
            ${matchingIdentities.map((item) => `<option value="${esc(item.id)}" ${d.identity_id === item.id ? "selected" : ""}>${esc(item.label)} · @${esc(item.id)}</option>`).join("")}
            ${d.identity_id && !matchingIdentities.some((item) => item.id === d.identity_id) ? `<option value="${esc(d.identity_id)}" selected>${words("原模板（当前不可选）", "Existing template (unavailable)")} · @${esc(d.identity_id)}</option>` : ""}
          </select>
          <small id="staff-identity-hint" class="muted">${words("按模板共享岗位 Skill。在「立体工牌馆 → 岗位身份模板」中编辑。", "Workers share skills from a template, which you can edit under 3D Staff → Role Templates.")}${identity?.enabled && identity.skill_paths?.length ? ` ${words("当前已配置：", "Configured:")} ${identity.skill_paths.length} ${words("项。", "skills.")}` : ""}</small>
        </div>
        <div class="cfg-field">
          <label class="cfg-field-label" for="staff-edit-bio">${label("staffBio")}</label>
          <input id="staff-edit-bio" class="input-sm" value="${esc(d.bio)}" placeholder="${words("例如 专注架构规划、模块边界与方案评审", "Specialty description")}" ${disabled} />
        </div>
        <label class="preference-row">
          <span>${words("启用该员工（可被调度与招募）", "Active for dispatch")}</span>
          <span class="switch"><input type="checkbox" role="switch" id="staff-edit-enabled" ${d.enabled ? "checked" : ""} ${disabled}><span class="switch-track"></span></span>
        </label>
      </div>
      <footer class="staff-editor-foot">
        <div>${!isCreate ? `<button type="button" class="btn btn-sm-pad btn-danger" data-action="delete-staff-member" data-staff-id="${esc(d.id)}" ${disabled}>${label("dismissStaff")}</button>` : ""}</div>
        <div class="pill-row">
          <button type="button" class="btn btn-sm-pad" data-action="close-staff-modal" ${disabled}>${label("cancel")}</button>
          <button type="button" class="btn btn-sm-pad btn-primary" data-action="save-staff-member" ${disabled}>${isCreate ? label("addStaff") : label("saveStaff")}</button>
        </div>
      </footer>
    </section>
  </div>`;
}

export function renderGlobalStaff(
  snap: DashboardSnapshot,
  _catalog: Partial<Record<RealBackendId, BackendModelOption[]>>,
  filter: string,
  query: string,
  _loading: boolean,
): string {
  const policy = snap.dispatch_policy;
  const health = new Map(snap.backends.map((item) => [item.backend, item]));
  const usageByBackend = new Map((snap.global_usage_by_backend ?? []).map((item) => [item.key, item]));
  const agyCompanies = new Map((snap.agy_companies ?? []).map((entry) => [entry.id, entry]));
  const identities = Object.values(policy?.identities ?? {}).sort((a, b) => a.id.localeCompare(b.id));
  const capabilityLabels: Record<CapabilityTag, string> = {
    architect: "architect",
    author: "implement",
    verifier: "review",
    research: "research",
    enterprise: "enterpriseCap",
    fanout: "fanoutCap",
  };
  const filterCapabilities: CapabilityTag[] = ["architect", "author", "verifier", "research", "enterprise"];
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const animated = getPreferences().animatedAvatars;

  const roster: StaffRosterMember[] = snap.staff_roster ?? [];
  const filteredRoster = roster.filter((member) => {
    const hay = `${member.name} ${member.title} ${member.backend} ${member.model} ${member.bio ?? ""} ${agyCompanies.get(member.company_id ?? "")?.name ?? ""}`;
    if (!matches(hay)) return false;
    if (filter === "all") return true;
    if (filter === "readonly") {
      return (
        ["verifier", "researcher"].includes(member.role) &&
        snap.backends.some((b) => b.backend === member.backend && b.supports_strict_readonly === 1)
      );
    }
    return member.capability === filter;
  });

  return `<div class="tab-scroll-pane staff-gallery-pane">
    <div class="staff-toolbar-bar">
      <div class="staff-search-wrap">
        <input class="input-sm staff-search" id="staff-search" autocomplete="off" aria-label="${label("staffSearch")}" placeholder="${label("staffSearch")}" value="${esc(query)}">
        <button type="button" class="btn btn-sm-pad btn-primary" data-action="open-staff-recruit">+ ${label("recruitStaff")}</button>
        <button type="button" class="btn btn-sm-pad" data-action="reset-staff-roster" title="${label("resetRoster")}">${label("resetRoster")}</button>
      </div>
      <div class="filter-pills">
        ${(["all", ...filterCapabilities, "readonly"] as const)
          .map(
            (id) =>
              `<button type="button" class="filter-pill" aria-pressed="${id === filter}" data-action="staff-filter" data-filter="${id}">${id === "all" ? label("all") : id === "readonly" ? label("readOnlySkill") : id === "enterprise" ? words("协同", "Enterprise") : label(capabilityLabels[id])}</button>`,
          )
          .join("")}
      </div>
    </div>

    <div class="staff-gallery-layout">
      <section class="staff-pedestal-grid" aria-label="${label("employees")}">
        ${
          filteredRoster
            .map((member) => {
              const strictOk = health.get(member.backend)?.supports_strict_readonly === 1;
              const company = agyCompanies.get(member.company_id ?? "");
              const spend = member.backend === "agy" && snap.agy_company_usage
                ? snap.agy_company_usage.find((item) => item.key === (member.company_id ?? "agy")) : usageByBackend.get(member.backend);
              const vendorTitle = company?.name ?? (member.backend === "agy" ? (getLanguage() === "en" ? "Antigravity · Local default" : "Antigravity · 本机默认")
                : BACKEND_DISPLAY_META[member.backend]?.title.split(" (")[0] ?? member.backend);
              return `<article class="staff-pedestal-card ${member.enabled ? "" : "is-staff-disabled"}" style="--company:${brand(member.backend)}">
                <div class="staff-pedestal-head">
                  <div class="staff-title-row">
                    <div>
                      <strong title="${esc(member.title)}">${esc(member.name)}</strong>
                      <div class="staff-role-subtitle">${esc(member.title)}</div>
                    </div>
                    <button type="button" class="btn btn-sm-pad staff-edit-btn" data-action="edit-staff-member" data-staff-id="${esc(member.id)}">${label("editProfile")}</button>
                  </div>
                  <div class="pill-row">
                    <span class="badge staff-vendor-chip"><i class="company-dot" style="--company:${brand(member.backend)}"></i>${esc(vendorTitle)}</span>
                    ${!member.enabled ? `<span class="badge">${label("disabled")}</span>` : ""}
                    ${(!strictOk || member.backend === "opencode") && ["verifier", "researcher"].includes(member.role) ? `<span class="badge badge-warn">⚠ ${label("noReadonlyLock")}</span>` : ""}
                  </div>
                </div>
                <div class="staff-showcase">
                  <div class="staff-dome" aria-hidden="true"></div>
                  <div class="staff-rings" aria-hidden="true"><span></span><span></span></div>
                  <div class="staff-figurine">${renderEmployeeAvatarSvg({ backend: member.backend, avatar: member.avatar, model: member.model, name: member.name, role: member.role, size: 80, animated })}</div>
                </div>
                <div class="staff-pedestal-foot">
                  ${member.bio ? `<p class="staff-card-bio">${esc(member.bio)}</p>` : ""}
                  <div class="pill-row">
                    <span class="badge">${esc(member.role)}</span>
                    ${member.effort ? `<span class="badge">${esc(member.effort)}</span>` : ""}
                    ${spend?.priced_turns ? `<span class="badge badge-ok">${esc(usd(spend.known_cost_usd))}</span>` : ""}
                  </div>
                  <small class="mono muted">${esc(member.model || company?.default_model || "")}</small>
                </div>
              </article>`;
            })
            .join("") || `<div class="panel-card staff-empty-card"><p class="muted">${label("noRecords")}</p><button type="button" class="btn btn-sm-pad btn-primary" data-action="open-staff-recruit">+ ${label("recruitStaff")}</button></div>`
        }
      </section>

      <aside class="panel-card staff-templates-aside">
        <div class="section-head">
          <h2 class="section-title">${label("roleTemplates")}</h2>
          <button type="button" class="btn btn-sm-pad btn-primary" data-action="new-global-identity">+ ${label("customRole")}</button>
        </div>
        <div class="staff-template-list">
          ${
            identities
              .filter(
                (identity) =>
                  matches(`${identity.label} ${identity.id}`) &&
                  (filter === "all" ||
                    (filter === "readonly"
                      ? ["verifier", "researcher"].includes(identity.base_role) || identity.require_cross_vendor
                      : identity.capability === filter)),
              )
              .map(
                (identity) => `<button type="button" class="staff-role-row" data-action="edit-global-identity" data-identity="${esc(identity.id)}">
                  ${renderEmployeeAvatarSvg({ backend: identity.preferred_backends?.[0] || "mock", model: identity.model, name: identity.id, role: identity.base_role, size: 40, animated })}
                  <span class="staff-role-copy">
                    <strong>${esc(identity.label)}</strong>
                    <small>@${esc(identity.id)} · ${esc(policyLayerShortLabel(identity.source))}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>`,
              )
              .join("") || `<p class="muted">${label("noRecords")}</p>`
          }
        </div>
      </aside>
    </div>

    <div class="campus-dock-float">${renderCampusLensDock("staff")}</div>
  </div>`;
}

export interface TeamCardRenderOptions {
  busy?: boolean;
  currentTeam?: string | null;
  density?: "gallery" | "list" | "rail";
  intent?: "browse" | "attach";
}

function signalTagText(tag: BoardMessage["tag"]): string {
  switch (tag) {
    case "done": return t("done");
    case "review_pass": return t("reviewPassed");
    case "review_fail": return t("reviewFailed");
    case "blocked":
    case "stall": return t("risk");
    case "brief": return words("任务指派", "Brief");
    default: return words("状态更新", "Update");
  }
}

export function renderTeamCards(teams: TeamSummary[], options: TeamCardRenderOptions = {}): string {
  const density = options.density ?? "gallery";
  const intent = options.intent ?? "attach";
  const repoLabels = formatShortRepoLabels(teams.map(({ team }) => team.repo_root));
  const lang = getLanguage();
  return (
    teams
      .map(
        ({
          team,
          waves,
          wave_count,
          bound_conversations,
          is_bound_to_current,
          latest_blackboard,
          worker_count,
          backends,
          total_tokens,
          known_cost_usd,
          priced_turns,
        }) => {
          const preferredWave = pickDefaultReviewWave(waves.map((w) => ({
            ...w,
            is_workflow: w.auto_created_by_workflow === 1,
          })));
          const latest = preferredWave ?? waves.find((wave) => wave.id === team.active_swarm_id) ?? waves[0];
          const active = waves.find((wave) => wave.id === team.active_swarm_id) ?? latest;
          const current = is_bound_to_current || options.currentTeam === team.id;
          const target = (wave: typeof latest) => `data-team-id="${esc(team.id)}"${wave ? ` data-swarm-id="${esc(wave.id)}"` : ""}`;
          const disabled = options.busy ? "disabled" : "";
          const shortRepo = repoLabels.get(team.repo_root) ?? team.repo_root;
          const latestSignal = getLatestBlackboardSignal(latest_blackboard);
          const signalTone = latestSignal ? blackboardTagTone(latestSignal.tag) : null;
          const statusLabel = team.status === "active" ? t("archiveTeamEnabled") : t(team.status);
          const statusClass = team.status === "paused" ? "status-warn" : "status-idle";
          const attachBtn = !current && (intent === "attach" || density !== "rail")
            ? `<button type="button" class="btn btn-sm-pad ${intent === "attach" ? "btn-primary" : ""}" data-action="attach-team" ${target(active)} ${disabled}>${esc(t("attachShort"))}</button>`
            : "";

          return `<article class="project-history-card is-${density} ${current ? "is-current-card" : ""}">
      <div class="archive-card-head">
        <div class="archive-card-title-col">
          <div class="archive-chip-row">
            <span class="archive-repo-chip mono" title="${esc(team.repo_root)}">${esc(shortRepo)}</span>
            ${current ? `<span class="archive-current-chip">${esc(t("archiveThisChat"))}</span>` : ""}
          </div>
          <h3 title="${esc(team.name)}">${esc(team.name)}</h3>
        </div>
        <span class="status-badge ${statusClass}">${esc(statusLabel)}</span>
      </div>
      ${team.goal && density !== "rail" ? `<p class="archive-goal-line muted">${esc(team.goal)}</p>` : ""}
      <div class="project-history-stats">
        <span>${esc(t("archiveMembersCount"))} ${esc(worker_count)}</span>
        <span>${esc(wave_count)} ${words("轮", "waves")}</span>
        ${bound_conversations > 0 ? `<span>${esc(bound_conversations)} ${words("个会话关联", "linked chats")}</span>` : ""}
        <span>${esc(priced_turns ? usd(known_cost_usd) : `${compact(total_tokens)} tok`)}</span>
      </div>
      ${
        backends.length
          ? `<div class="pill-row">${backends.slice(0, 3).map((backend) => `<span class="badge"><i class="company-dot" style="--company:${brand(backend)}"></i>${esc(backend)}</span>`).join("")}${backends.length > 3 ? `<span class="badge">+${esc(backends.length - 3)}</span>` : ""}</div>`
          : ""
      }
      ${
        density !== "rail"
          ? latestSignal
            ? `<p class="team-note note-${signalTone}">#${esc(latestSignal.seq)} · ${esc(signalTagText(latestSignal.tag))}</p>`
            : `<p class="team-note is-empty muted">${esc(t("archiveNoSignal"))}</p>`
          : ""
      }
      <footer class="archive-card-foot">
        <time class="muted" title="${esc(new Date(team.updated_at).toLocaleString(lang))}">${esc(formatRelativeTime(team.updated_at, lang))}</time>
        <div class="pill-row">
          ${latest ? `<button type="button" class="btn btn-sm-pad" data-action="open-history-swarm" ${target(latest)}>${esc(t("archiveReviewWave"))}</button>` : ""}
          ${attachBtn}
        </div>
      </footer>
    </article>`;
        },
      )
      .join("") || `<p class="muted">${label("noRecords")}</p>`
  );
}

export interface ArchiveViewState {
  query: string;
  repoFilter: string;
  sort: ArchiveSortKey;
  viewMode: "cards" | "list";
  selectedConvId: string | null;
  unassignedOpen: boolean;
  renamingConvId: string | null;
  busy: boolean;
  canSendMessage: boolean;
  canBackToSession: boolean;
  currentConversationId: string | null;
  currentTeamId: string | null;
}

function sessionDisplayTitle(session: ConversationArchiveSummary): {
  text: string;
  isFallback: boolean;
  isWaveFallback: boolean;
} {
  if (session.title && session.title.trim()) {
    return { text: session.title.trim(), isFallback: false, isWaveFallback: false };
  }
  const preferredWave = pickDefaultReviewWave(session.waves) ?? session.waves[0];
  if (preferredWave?.swarm.title?.trim()) {
    return { text: preferredWave.swarm.title.trim(), isFallback: false, isWaveFallback: true };
  }
  const shortId = session.conversation_id.slice(0, 8);
  return { text: `${t("archiveUnnamed")} · ${shortId}`, isFallback: true, isWaveFallback: false };
}

function emptyBreakdown(summary: {
  total_tokens: number;
  known_cost_usd: number;
  priced_turns: number;
  unpriced_turns: number;
}): UsageBreakdownSummary {
  return {
    turns: summary.priced_turns + summary.unpriced_turns,
    tool_calls_count: 0,
    duration_ms: 0,
    avg_output_tps: null,
    total_tokens: summary.total_tokens,
    uncached_input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_hit_rate: null,
    known_cost_usd: summary.known_cost_usd,
    estimated_cost_usd: 0,
    priced_turns: summary.priced_turns,
    unpriced_turns: summary.unpriced_turns,
    exact_turns: 0,
    hook_turns: 0,
    estimated_turns: 0,
    by_backend: [],
  };
}

function fmtTokExact(n: number): string {
  return `${new Intl.NumberFormat(getLanguage()).format(Math.round(n))} tok`;
}

function fmtDurationHuman(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return getLanguage() === "en" ? `${hrs}h ${remMins}m` : `${hrs} 小时 ${remMins} 分`;
  }
  if (mins > 0) {
    return getLanguage() === "en" ? `${mins}m ${secs}s` : `${mins} 分 ${secs} 秒`;
  }
  return getLanguage() === "en" ? `${secs}s` : `${secs} 秒`;
}

function fmtSpendText(u: UsageBreakdownSummary): { text: string; isEstimated: boolean; title: string } {
  const hasKnown = u.priced_turns > 0 && u.known_cost_usd > 0;
  const hasEst = u.unpriced_turns > 0 && u.estimated_cost_usd > 0;
  if (hasKnown && hasEst) {
    return {
      text: `${usd(u.known_cost_usd)} + ≈${usd(u.estimated_cost_usd)}`,
      isEstimated: true,
      title: words("已知账单 + 订阅参考估算（按公开 API 费率）", "Known bill + reference API estimate"),
    };
  }
  if (u.priced_turns > 0) {
    return {
      text: usd(u.known_cost_usd),
      isEstimated: false,
      title: words("CLI 实报账单", "Reported CLI spend"),
    };
  }
  if (hasEst) {
    return {
      text: `≈${usd(u.estimated_cost_usd)}`,
      isEstimated: true,
      title: words("订阅制未计价轮次，按公开 API 参考费率估算", "Estimated from public API reference rates"),
    };
  }
  return { text: "—", isEstimated: false, title: "" };
}

function renderArchiveSignalLine(signal: { seq: number; tag: BoardMessage["tag"] } | null): string {
  if (!signal) return `<div class="team-note is-empty muted">${esc(t("archiveNoSignal"))}</div>`;
  const tone = blackboardTagTone(signal.tag);
  return `<div class="team-note note-${tone}">#${esc(signal.seq)} · ${esc(signalTagText(signal.tag))}</div>`;
}

function renderConversationCards(
  sessions: readonly ConversationArchiveSummary[],
  repoLabels: Map<string, string>,
  viewMode: "cards" | "list",
): string {
  const lang = getLanguage();
  if (viewMode === "list") {
    return `<div class="archive-list-table">
      <div class="archive-list-head">
        <span>${words("主会话窗口", "Session")}</span>
        <span>${words("仓库", "Repo")}</span>
        <span>${words("调用", "Calls")}</span>
        <span>${words("最新信号", "Signal")}</span>
        <span>${words("Token / 缓存 / 费用", "Tokens / Cache / Spend")}</span>
        <span>${words("最近活动", "Updated")}</span>
        <span></span>
      </div>
      ${sessions.map((s) => {
        const titleInfo = sessionDisplayTitle(s);
        const u = s.usage ?? emptyBreakdown(s);
        const primaryRepo = s.primary_repo_root;
        const shortRepo = primaryRepo ? repoLabels.get(primaryRepo) ?? primaryRepo : "—";
        const extraRepos = s.repo_roots.length > 1 ? ` +${s.repo_roots.length - 1}` : "";
        const spendInfo = fmtSpendText(u);
        const hitStr = u.cache_hit_rate !== null ? ` · ${Math.round(u.cache_hit_rate * 100)}%` : "";
        const spendDisplay = spendInfo.text !== "—" ? `${compact(u.total_tokens)}${hitStr} · ${spendInfo.text}` : `${compact(u.total_tokens)} tok${hitStr}`;
        const tone = s.latest_signal ? blackboardTagTone(s.latest_signal.tag) : null;
        return `<article class="archive-list-row ${s.is_current ? "is-current-card" : ""}" data-open-conv="${esc(s.conversation_id)}">
          <div class="archive-list-title">
            <strong class="${titleInfo.isFallback ? "is-unnamed" : ""}" title="${esc(s.conversation_id)}">${esc(titleInfo.text)}</strong>
            ${s.is_current ? `<span class="archive-current-chip">${esc(t("archiveThisWindow"))}</span>` : ""}
            ${titleInfo.isWaveFallback ? `<span class="badge">${esc(t("archiveFromWave"))}</span>` : ""}
          </div>
          <span class="archive-repo-chip mono" title="${esc(s.repo_roots.join(", "))}">${esc(shortRepo)}${esc(extraRepos)}</span>
          <span class="muted">${esc(s.wave_count)} ${esc(t("archiveWavesCount"))}</span>
          <span class="archive-list-signal ${tone ? `tone-${tone}` : "muted"}">${s.latest_signal ? `#${esc(s.latest_signal.seq)} · ${esc(signalTagText(s.latest_signal.tag))}` : esc(t("archiveNoSignal"))}</span>
          <span class="mono muted" title="${esc(spendInfo.title)}">${esc(spendDisplay)}</span>
          <time class="muted" title="${esc(new Date(s.last_activity_at).toLocaleString(lang))}">${esc(formatRelativeTime(s.last_activity_at, lang))}</time>
          <span class="archive-list-cta">
            <button type="button" class="btn btn-sm-pad" data-action="open-archive-session" data-conv-id="${esc(s.conversation_id)}">${esc(t("archiveOpen"))} ›</button>
          </span>
        </article>`;
      }).join("")}
    </div>`;
  }

  return `<div class="project-history-grid archive-session-grid">
    ${sessions.map((s) => {
      const titleInfo = sessionDisplayTitle(s);
      const u = s.usage ?? emptyBreakdown(s);
      const primaryRepo = s.primary_repo_root;
      const shortRepo = primaryRepo ? repoLabels.get(primaryRepo) ?? primaryRepo : null;
      const extraRepos = s.repo_roots.length > 1 ? ` +${s.repo_roots.length - 1}` : "";
      const latestWave = pickDefaultReviewWave(s.waves) ?? s.waves[0] ?? null;
      const spendInfo = fmtSpendText(u);
      const hitPct = u.cache_hit_rate !== null ? Math.round(u.cache_hit_rate * 100) : null;
      return `<article class="project-history-card archive-session-card ${s.is_current ? "is-current-card" : ""}">
        <div class="archive-card-head">
          <div class="archive-card-title-col">
            <div class="archive-chip-row">
              ${shortRepo ? `<span class="archive-repo-chip mono" title="${esc(s.repo_roots.join(", "))}">${esc(shortRepo)}${esc(extraRepos)}</span>` : ""}
              ${s.is_current ? `<span class="archive-current-chip">${esc(t("archiveThisWindow"))}</span>` : ""}
              ${titleInfo.isWaveFallback ? `<span class="badge">${esc(t("archiveFromWave"))}</span>` : ""}
            </div>
            <h3 class="${titleInfo.isFallback ? "is-unnamed" : ""}" title="${esc(titleInfo.text)} (${esc(s.conversation_id)})">${esc(titleInfo.text)}</h3>
          </div>
          <span class="badge mono archive-id-pill" title="${esc(s.conversation_id)}">${esc(s.conversation_id.slice(0, 8))}</span>
        </div>
        <p class="archive-goal-line muted">${latestWave && !titleInfo.isWaveFallback ? esc(latestWave.swarm.title) : latestWave ? esc(`${words("最近调用", "Latest call")}: ${latestWave.swarm.title}`) : esc(words("已关联团队，尚无波次", "Linked team, no waves yet"))}</p>
        <div class="project-history-stats">
          <span>${esc(s.wave_count)} ${esc(t("archiveWavesCount"))}</span>
          ${s.worker_count > 0 ? `<span>${esc(t("archiveMembersCount"))} ${esc(s.worker_count)}</span>` : ""}
          <span>${esc(compact(u.total_tokens))} tok</span>
          ${hitPct !== null ? `<span class="archive-hit-chip">${esc(t("archiveCacheHit"))} ${esc(hitPct)}%</span>` : ""}
          ${u.duration_ms > 0 ? `<span>${esc(fmtDurationHuman(u.duration_ms))}</span>` : ""}
          ${spendInfo.text !== "—" ? `<span class="${spendInfo.isEstimated ? "archive-est-chip" : ""}" title="${esc(spendInfo.title)}">${esc(spendInfo.text)}</span>` : ""}
        </div>
        <div class="pill-row">
          ${s.backends.slice(0, 3).map((b) => `<span class="badge"><i class="company-dot" style="--company:${brand(b)}"></i>${esc(b)}</span>`).join("")}
          ${s.backends.length > 3 ? `<span class="badge">+${esc(s.backends.length - 3)}</span>` : ""}
        </div>
        ${renderArchiveSignalLine(s.latest_signal)}
        <footer class="archive-card-foot">
          <time class="muted" title="${esc(new Date(s.last_activity_at).toLocaleString(lang))}">${esc(formatRelativeTime(s.last_activity_at, lang))}</time>
          <div class="pill-row">
            <button type="button" class="btn btn-sm-pad btn-primary" data-action="open-archive-session" data-conv-id="${esc(s.conversation_id)}">${esc(t("archiveOpen"))} ›</button>
          </div>
        </footer>
      </article>`;
    }).join("")}
  </div>`;
}

function renderSessionTelemetryPanel(u: UsageBreakdownSummary): string {
  const hitPct = u.cache_hit_rate !== null ? Math.round(u.cache_hit_rate * 100) : null;
  const spendInfo = fmtSpendText(u);
  const accuracyParts = [
    u.exact_turns > 0 ? `${words("精确", "Exact")} ${u.exact_turns}` : "",
    u.hook_turns > 0 ? `Hook ${u.hook_turns}` : "",
    u.estimated_turns > 0 ? `${words("估算", "Est.")} ${u.estimated_turns}` : "",
  ].filter(Boolean);

  const backendRowsHtml = u.by_backend
    .map((b) => {
      const bHit = b.cache_hit_rate !== null ? ` · ${Math.round(b.cache_hit_rate * 100)}% ${words("缓存", "hit")}` : "";
      const bCost =
        b.priced_turns > 0 && b.known_cost_usd > 0
          ? usd(b.known_cost_usd)
          : b.unpriced_turns > 0 && b.estimated_cost_usd > 0
            ? `≈${usd(b.estimated_cost_usd)}`
            : b.priced_turns > 0
              ? "$0.00"
              : "—";
      return `<div class="telemetry-backend-row">
        <span class="telemetry-backend-name">
          <i class="company-dot" style="--company:${brand(b.backend)}"></i>
          <span>${esc(b.backend)}${b.model ? ` · ${esc(b.model)}` : ""}</span>
        </span>
        <span class="telemetry-backend-tokens">${esc(compact(b.uncached_input_tokens))} ${words("新入", "in")} / ${esc(compact(b.cache_read_tokens))} ${words("缓读", "cached")} / ${esc(compact(b.output_tokens))} ${words("出", "out")}${esc(bHit)}</span>
        <span class="telemetry-backend-cost">${esc(bCost)}</span>
      </div>`;
    })
    .join("");

  return `<section class="archive-telemetry-grid" aria-label="${esc(t("archiveTokenUsage"))}">
    <article class="panel-card telemetry-card">
      <header class="telemetry-head">
        <h3>${esc(t("archiveTokenUsage"))}</h3>
        <strong class="telemetry-head-val">${esc(fmtTokExact(u.total_tokens))}</strong>
      </header>
      ${hitPct !== null ? `<div class="telemetry-cache-bar" title="${esc(t("archiveCacheHit"))} ${esc(hitPct)}%"><i style="width:${esc(Math.min(100, Math.max(2, hitPct)))}%"></i></div>` : ""}
      <div class="telemetry-kv-list">
        <div class="telemetry-kv-row"><span>${esc(t("archiveCacheHit"))}</span><strong>${hitPct !== null ? `${esc(hitPct)}%` : "—"}</strong></div>
        <div class="telemetry-kv-row"><span>${esc(t("archiveUncachedInput"))}</span><strong>${esc(fmtTokExact(u.uncached_input_tokens))}</strong></div>
        <div class="telemetry-kv-row"><span>${esc(t("archiveCacheRead"))}</span><strong>${esc(fmtTokExact(u.cache_read_tokens))}</strong></div>
        ${u.cache_write_tokens > 0 ? `<div class="telemetry-kv-row"><span>${esc(t("archiveCacheWrite"))}</span><strong>${esc(fmtTokExact(u.cache_write_tokens))}</strong></div>` : ""}
        <div class="telemetry-kv-row"><span>${esc(t("archiveOutputTokens"))}</span><strong>${esc(fmtTokExact(u.output_tokens))}</strong></div>
        ${u.reasoning_tokens > 0 ? `<div class="telemetry-kv-row"><span>${esc(t("archiveReasoningTokens"))}</span><strong>${esc(fmtTokExact(u.reasoning_tokens))}</strong></div>` : ""}
        <div class="telemetry-kv-row"><span>${esc(t("archiveKnownBill"))}</span><strong>${u.priced_turns > 0 ? esc(usd(u.known_cost_usd)) : "—"}</strong></div>
        ${u.estimated_cost_usd > 0 ? `<div class="telemetry-kv-row"><span>${esc(t("archiveEstBill"))}</span><strong class="archive-est-chip" style="padding:1px 6px;border-radius:6px;">≈ ${esc(usd(u.estimated_cost_usd))}</strong></div>` : ""}
      </div>
      <p class="telemetry-footnote">${esc(t("archiveEstFootnote"))}</p>
    </article>

    <article class="panel-card telemetry-card">
      <header class="telemetry-head">
        <h3>${esc(t("archiveExecStats"))}</h3>
        <strong class="telemetry-head-val">${esc(u.turns)} ${esc(t("turns"))} · ${esc(u.tool_calls_count)} ${words("次工具", "tools")}</strong>
      </header>
      <div class="telemetry-kv-list">
        <div class="telemetry-kv-row"><span>${esc(t("archiveExecDuration"))}</span><strong>${esc(fmtDurationHuman(u.duration_ms))}</strong></div>
        <div class="telemetry-kv-row"><span>${esc(t("archiveAvgTps"))}</span><strong>${u.avg_output_tps !== null ? `${esc(u.avg_output_tps)} tok/s` : "—"}</strong></div>
        <div class="telemetry-kv-row"><span>${words("汇总参考花费", "Total / est. spend")}</span><strong title="${esc(spendInfo.title)}">${esc(spendInfo.text)}</strong></div>
        ${accuracyParts.length ? `<div class="telemetry-kv-row"><span>${words("统计口径", "Accuracy")}</span><span>${esc(accuracyParts.join(" · "))}</span></div>` : ""}
      </div>
      ${backendRowsHtml ? `<div class="telemetry-backend-list">${backendRowsHtml}</div>` : `<p class="muted">${esc(t("noRecords"))}</p>`}
    </article>
  </section>`;
}

function renderSessionArchiveDetail(
  session: ConversationArchiveSummary,
  repoLabels: Map<string, string>,
  state: ArchiveViewState,
): string {
  const lang = getLanguage();
  const titleInfo = sessionDisplayTitle(session);
  const u = session.usage ?? emptyBreakdown(session);
  const isRenaming = state.renamingConvId === session.conversation_id;
  const disabled = state.busy ? "disabled" : "";
  const spendInfo = fmtSpendText(u);

  let jumpBarHtml = "";
  if (session.is_current && state.canBackToSession) {
    jumpBarHtml = `<div class="archive-jump-banner is-current">
      <div class="archive-jump-copy">
        <strong>${esc(t("archiveThisWindow"))}</strong>
        <span>${esc(t("archiveHostNoteCurrent"))}</span>
      </div>
      <div class="pill-row">
        <button type="button" class="btn btn-sm-pad btn-primary" data-action="back-session">${esc(t("archiveBackWorkbench"))}</button>
      </div>
    </div>`;
  } else if (state.canSendMessage) {
    jumpBarHtml = `<div class="archive-jump-banner is-aux">
      <div class="archive-jump-copy">
        <strong>${words("在原会话窗口中打开", "Jump to original window")}</strong>
        <span>${esc(t("archiveHostNoteAux"))}</span>
      </div>
      <div class="pill-row">
        <button type="button" class="btn btn-sm-pad btn-primary" data-action="insert-conv-link" data-conv-id="${esc(session.conversation_id)}" data-conv-title="${esc(titleInfo.text)}" ${disabled}>${esc(t("archiveInsertLink"))}</button>
        ${!titleInfo.isFallback ? `<button type="button" class="btn btn-sm-pad" data-action="copy-conv-title" data-conv-title="${esc(titleInfo.text)}">${esc(t("archiveCopyTitle"))}</button>` : ""}
        <button type="button" class="btn btn-sm-pad" data-action="copy-conv-id" data-conv-id="${esc(session.conversation_id)}">${esc(t("archiveCopyId"))}</button>
      </div>
    </div>`;
  } else {
    jumpBarHtml = `<div class="archive-jump-banner">
      <div class="archive-jump-copy">
        <strong>${words("定位原会话窗口", "Locate original session")}</strong>
        <span>${esc(t("archiveHostNoteGlobal"))}</span>
      </div>
      <div class="pill-row">
        ${!titleInfo.isFallback ? `<button type="button" class="btn btn-sm-pad btn-primary" data-action="copy-conv-title" data-conv-title="${esc(titleInfo.text)}">${esc(t("archiveCopyTitle"))}</button>` : ""}
        <button type="button" class="btn btn-sm-pad ${titleInfo.isFallback ? "btn-primary" : ""}" data-action="copy-conv-id" data-conv-id="${esc(session.conversation_id)}">${esc(t("archiveCopyId"))}</button>
      </div>
    </div>`;
  }

  const wavesHtml = session.waves.map((w: ConversationWaveSummary) => {
    const shortRepo = repoLabels.get(w.swarm.repo_root) ?? w.swarm.repo_root;
    const wu = w.usage ?? emptyBreakdown(w);
    const wSpendInfo = fmtSpendText(wu);
    const wHitPct = wu.cache_hit_rate !== null ? Math.round(wu.cache_hit_rate * 100) : null;
    const tone = w.latest_signal ? blackboardTagTone(w.latest_signal.tag) : null;
    const statusText = w.swarm.status === "done" ? t("done") : w.swarm.status === "archived" ? t("archived") : t("archiveTeamEnabled");
    return `<article class="archive-wave-row">
      <div class="archive-wave-main">
        <div class="archive-wave-head">
          <span class="archive-wave-idx mono">#${esc(w.swarm.wave_index ?? 1)}</span>
          ${w.is_workflow ? `<span class="badge">Workflow</span>` : ""}
          ${w.is_manual_assignment ? `<span class="badge">${words("手动归入", "Manual")}</span>` : ""}
          <span class="archive-repo-chip mono" title="${esc(w.swarm.repo_root)}">${esc(shortRepo)}</span>
          <strong>${esc(w.swarm.title)}</strong>
          <span class="status-badge ${w.swarm.status === "active" ? "status-ok" : "status-idle"}">${esc(statusText)}</span>
        </div>
        <div class="archive-wave-meta">
          ${w.worker_count > 0 ? `<span>${label("waveSeats")} ${esc(w.worker_count)}</span>` : ""}
          <span>${esc(compact(wu.total_tokens))} tok</span>
          ${wHitPct !== null ? `<span class="badge archive-hit-chip">${esc(t("archiveCacheHit"))} ${esc(wHitPct)}%</span>` : ""}
          ${wu.duration_ms > 0 ? `<span>${esc(fmtDurationHuman(wu.duration_ms))}</span>` : ""}
          ${wSpendInfo.text !== "—" ? `<span class="${wSpendInfo.isEstimated ? "archive-est-chip badge" : ""}" title="${esc(wSpendInfo.title)}">${esc(wSpendInfo.text)}</span>` : ""}
          ${w.backends.map((b) => `<span class="badge"><i class="company-dot" style="--company:${brand(b)}"></i>${esc(b)}</span>`).join("")}
          ${w.latest_signal ? `<span class="archive-wave-signal tone-${tone}">#${esc(w.latest_signal.seq)} · ${esc(signalTagText(w.latest_signal.tag))}</span>` : ""}
          <time class="muted" title="${esc(new Date(w.last_activity_at).toLocaleString(lang))}">${esc(formatRelativeTime(w.last_activity_at, lang))}</time>
        </div>
      </div>
      <div class="pill-row">
        ${w.is_manual_assignment ? `<button type="button" class="btn btn-sm-pad" data-action="unassign-wave-conv" data-swarm-id="${esc(w.swarm.id)}" ${disabled}>${esc(t("archiveUnassign"))}</button>` : ""}
        <button type="button" class="btn btn-sm-pad btn-primary" data-action="open-history-swarm" data-swarm-id="${esc(w.swarm.id)}" ${w.team_id ? `data-team-id="${esc(w.team_id)}"` : ""}>${esc(t("archiveReviewWave"))} ›</button>
      </div>
    </article>`;
  }).join("") || `<p class="muted">${esc(t("noRecords"))}</p>`;

  const attachableTeamId = session.bound_team_id && session.bound_team_id !== state.currentTeamId ? session.bound_team_id : null;
  const attachableSwarmId = session.bound_swarm_id ?? pickDefaultReviewWave(session.waves)?.swarm.id ?? null;

  return `<div class="tab-scroll-pane directory-pane archive-detail-pane">
    <div class="archive-detail-topbar">
      <button type="button" class="btn btn-sm-pad" data-action="close-archive-session">${esc(t("archiveBackList"))}</button>
      <span class="mono muted archive-conv-id-chip" title="${esc(session.conversation_id)}">ID: ${esc(session.conversation_id)}</span>
    </div>

    <section class="panel-card archive-detail-hero">
      <div class="archive-detail-title-row">
        <div class="archive-detail-title-main">
          <div class="archive-chip-row">
            ${session.is_current ? `<span class="archive-current-chip">${esc(t("archiveThisWindow"))}</span>` : ""}
            ${titleInfo.isWaveFallback ? `<span class="badge">${esc(t("archiveFromWave"))}</span>` : ""}
            ${session.repo_roots.map((r) => `<span class="archive-repo-chip mono" title="${esc(r)}">${esc(repoLabels.get(r) ?? r)}</span>`).join("")}
          </div>
          ${
            isRenaming
              ? `<div class="archive-rename-form">
                  <input id="archive-rename-input" class="input-sm" value="${esc(session.custom_title ?? session.title ?? "")}" placeholder="${esc(t("archiveRenamePlaceholder"))}" ${disabled} />
                  <button type="button" class="btn btn-sm-pad btn-primary" data-action="save-rename-conv" data-conv-id="${esc(session.conversation_id)}" ${disabled}>${esc(t("archiveSave"))}</button>
                  <button type="button" class="btn btn-sm-pad" data-action="cancel-rename-conv" ${disabled}>${esc(t("cancel"))}</button>
                </div>`
              : `<div class="archive-title-display">
                  <h2>${esc(titleInfo.text)}</h2>
                  <button type="button" class="btn btn-sm-pad" data-action="start-rename-conv" data-conv-id="${esc(session.conversation_id)}" ${disabled}>${esc(t("archiveRename"))}</button>
                </div>`
          }
        </div>
        <div class="archive-detail-kpis">
          <div><strong>${esc(session.wave_count)}</strong><span>${esc(t("archiveWavesCount"))}</span></div>
          <div><strong>${esc(session.worker_count)}</strong><span>${esc(t("archiveMembersCount"))}</span></div>
          <div><strong title="${esc(spendInfo.title)}">${esc(spendInfo.text !== "—" ? spendInfo.text : compact(u.total_tokens))}</strong><span>${spendInfo.text !== "—" ? (spendInfo.isEstimated ? words("参考估算", "Est.") : "USD") : "Tokens"}</span></div>
        </div>
      </div>

      ${jumpBarHtml}
    </section>

    ${renderSessionTelemetryPanel(u)}

    <section class="panel-card archive-waves-panel">
      <header class="section-head">
        <h3>${words("该主会话关联的调用记录", "Calls & waves in this session")} (${esc(session.waves.length)})</h3>
        <span class="muted">${words("按最近活动倒序 · 点击只读回看可检视群聊、成员与 Diff", "Sorted by activity · Read-only review inspects board, workers & diff")}</span>
      </header>
      <div class="archive-wave-list">${wavesHtml}</div>
    </section>

    ${
      !session.is_current && attachableTeamId
        ? `<div class="panel-card archive-attach-foot">
            <span class="muted">${words("需要在当前正在浏览的窗口继续推进该团队？", "Want to continue this team inside your current window?")}</span>
            <button type="button" class="btn btn-sm-pad" data-action="attach-archive-team" data-team-id="${esc(attachableTeamId)}" ${attachableSwarmId ? `data-swarm-id="${esc(attachableSwarmId)}"` : ""} ${disabled}>${esc(t("archiveAttachCurrent"))}</button>
          </div>`
        : ""
    }
  </div>`;
}

export function renderGlobalHistory(snap: DashboardSnapshot, stateOrBusy: ArchiveViewState | boolean = false, currentTeam?: string | null): string {
  const archiveState: ArchiveViewState = typeof stateOrBusy === "boolean"
    ? {
        query: "",
        repoFilter: "all",
        sort: "recent",
        viewMode: "cards",
        selectedConvId: null,
        unassignedOpen: false,
        renamingConvId: null,
        busy: stateOrBusy,
        canSendMessage: false,
        canBackToSession: false,
        currentConversationId: snap.active_conversation_id ?? null,
        currentTeamId: currentTeam ?? null,
      }
    : stateOrBusy;

  const archives = snap.conversation_archives;
  const sessions = archives?.sessions ?? [];
  const unassigned = archives?.unassigned_waves ?? [];
  const allRepos = [...new Set([
    ...sessions.flatMap((s) => s.repo_roots),
    ...unassigned.map((w) => w.swarm.repo_root),
  ].filter(Boolean))];
  const repoLabels = formatShortRepoLabels(allRepos);

  if (archiveState.selectedConvId) {
    const picked = sessions.find((s) => s.conversation_id === archiveState.selectedConvId);
    if (picked) {
      return renderSessionArchiveDetail(picked, repoLabels, archiveState);
    }
  }

  // Fallback for tests or snapshots without conversation_archives populated
  if (!archives) {
    const teams = snap.teams ?? [];
    return `<div class="tab-scroll-pane directory-pane">
      <div class="section-head page-intro"><div><h2>${label("archiveTitle")}</h2><p class="muted">${label("archiveSubtitle")}</p></div><span class="badge">${esc(teams.length)}</span></div>
      <div class="project-history-grid">${renderTeamCards(teams, { busy: archiveState.busy, currentTeam: archiveState.currentTeamId, density: "gallery", intent: "browse" })}</div>
    </div>`;
  }

  const filteredSessions = filterAndSortConversationArchives(sessions, {
    query: archiveState.query,
    repo: archiveState.repoFilter,
    sort: archiveState.sort,
  });

  const totalPriced = sessions.some((s) => s.priced_turns > 0);
  const totalUsd = sessions.reduce((sum, s) => sum + (s.priced_turns > 0 ? s.known_cost_usd : 0), 0);
  const totalEstUsd = sessions.reduce((sum, s) => sum + (s.usage?.estimated_cost_usd ?? 0), 0);
  const hasFilters = Boolean(archiveState.query.trim()) || archiveState.repoFilter !== "all";
  const lang = getLanguage();

  const unassignedHtml = unassigned.length > 0
    ? `<section class="panel-card archive-unassigned-sec">
        <button type="button" class="archive-unassigned-toggle" data-action="toggle-archive-unassigned" aria-expanded="${archiveState.unassignedOpen}">
          <span>${archiveState.unassignedOpen ? "▾" : "▸"} ${esc(t("archiveUnassigned"))} · ${esc(unassigned.length)}</span>
          <small class="muted">${esc(t("archiveUnassignedHint"))}</small>
        </button>
        ${
          archiveState.unassignedOpen
            ? `<div class="archive-wave-list">
                ${unassigned.map((w) => {
                  const shortRepo = repoLabels.get(w.swarm.repo_root) ?? w.swarm.repo_root;
                  const wu = w.usage ?? emptyBreakdown(w);
                  const wSpend = fmtSpendText(wu);
                  const wHit = wu.cache_hit_rate !== null ? Math.round(wu.cache_hit_rate * 100) : null;
                  const assignSelect = sessions.length > 0
                    ? `<select class="select-sm archive-assign-select" data-action="assign-wave-conv" data-swarm-id="${esc(w.swarm.id)}" ${archiveState.busy ? "disabled" : ""}>
                        <option value="">${esc(t("archiveAssignTo"))}</option>
                        ${sessions.map((s) => `<option value="${esc(s.conversation_id)}">${esc(sessionDisplayTitle(s).text)}</option>`).join("")}
                      </select>`
                    : "";
                  return `<article class="archive-wave-row is-unassigned">
                    <div class="archive-wave-main">
                      <div class="archive-wave-head">
                        ${w.is_workflow ? `<span class="badge">Workflow</span>` : ""}
                        <span class="archive-repo-chip mono" title="${esc(w.swarm.repo_root)}">${esc(shortRepo)}</span>
                        <strong>${esc(w.swarm.title)}</strong>
                      </div>
                      <div class="archive-wave-meta">
                          ${w.worker_count > 0 ? `<span>${label("waveSeats")} ${esc(w.worker_count)}</span>` : ""}
                        <span>${esc(compact(wu.total_tokens))} tok</span>
                        ${wHit !== null ? `<span class="badge archive-hit-chip">${esc(t("archiveCacheHit"))} ${esc(wHit)}%</span>` : ""}
                        ${wSpend.text !== "—" ? `<span class="${wSpend.isEstimated ? "badge archive-est-chip" : ""}" title="${esc(wSpend.title)}">${esc(wSpend.text)}</span>` : ""}
                        <time class="muted" title="${esc(new Date(w.last_activity_at).toLocaleString(lang))}">${esc(formatRelativeTime(w.last_activity_at, lang))}</time>
                      </div>
                    </div>
                    <div class="pill-row">
                      ${assignSelect}
                      <button type="button" class="btn btn-sm-pad" data-action="open-history-swarm" data-swarm-id="${esc(w.swarm.id)}" ${w.team_id ? `data-team-id="${esc(w.team_id)}"` : ""}>${esc(t("archiveReviewWave"))} ›</button>
                    </div>
                  </article>`;
                }).join("")}
              </div>`
            : ""
        }
      </section>`
    : "";

  return `<div class="tab-scroll-pane directory-pane archive-directory-pane">
    <div class="section-head page-intro">
      <div>
        <h2>${label("archiveTitle")}</h2>
        <p class="muted">${label("archiveSubtitle")}</p>
      </div>
      <div class="campus-hud-chip">
        <span>${esc(sessions.length)} ${words("个主会话", "sessions")}</span>
        <span class="hud-sep">·</span>
        <span>${esc(allRepos.length)} ${words("个仓库", "repos")}</span>
        ${unassigned.length > 0 ? `<span class="hud-sep">·</span><span>${esc(unassigned.length)} ${words("条未归属", "unassigned")}</span>` : ""}
        ${totalPriced ? `<span class="hud-sep">·</span><span class="hud-ok">${esc(usd(totalUsd))}</span>` : ""}
        ${totalEstUsd > 0 ? `<span class="hud-sep">·</span><span title="${words("订阅制未计价参考估算", "Reference estimate")}">≈${esc(usd(totalEstUsd))}</span>` : ""}
      </div>
    </div>

    <div class="staff-toolbar-bar archive-toolbar">
      <div class="staff-search-wrap archive-search-wrap">
        <input class="input-sm staff-search" id="archive-search" autocomplete="off" aria-label="${label("archiveSearchPlaceholder")}" placeholder="${label("archiveSearchPlaceholder")}" value="${esc(archiveState.query)}">
      </div>
      <div class="archive-filter-controls">
        <select id="archive-repo-filter" class="select-sm" aria-label="${label("archiveAllRepos")}">
          <option value="all" ${archiveState.repoFilter === "all" ? "selected" : ""}>${label("archiveAllRepos")}</option>
          ${allRepos.map((r) => `<option value="${esc(r)}" ${archiveState.repoFilter === r ? "selected" : ""}>${esc(repoLabels.get(r) ?? r)}</option>`).join("")}
        </select>
        <select id="archive-sort" class="select-sm" aria-label="${words("排序", "Sort")}">
          <option value="recent" ${archiveState.sort === "recent" ? "selected" : ""}>${label("archiveSortRecent")}</option>
          <option value="name" ${archiveState.sort === "name" ? "selected" : ""}>${label("archiveSortName")}</option>
          <option value="waves" ${archiveState.sort === "waves" ? "selected" : ""}>${label("archiveSortWaves")}</option>
          <option value="cost" ${archiveState.sort === "cost" ? "selected" : ""}>${label("archiveSortCost")}</option>
        </select>
        <div class="segmented" role="group" aria-label="${words("视图切换", "View mode")}">
          <button type="button" data-action="set-archive-view" data-view="cards" aria-pressed="${archiveState.viewMode === "cards"}">${label("archiveCardsView")}</button>
          <button type="button" data-action="set-archive-view" data-view="list" aria-pressed="${archiveState.viewMode === "list"}">${label("archiveListView")}</button>
        </div>
      </div>
    </div>

    ${
      filteredSessions.length > 0
        ? renderConversationCards(filteredSessions, repoLabels, archiveState.viewMode)
        : hasFilters
          ? `<div class="panel-card archive-empty-state"><p class="muted">${label("archiveNoMatches")}</p><button type="button" class="btn btn-sm-pad" data-action="clear-archive-filters">${label("archiveClearFilters")}</button></div>`
          : `<div class="panel-card archive-empty-state"><p class="muted">${label("noRecords")}</p></div>`
    }

    ${unassignedHtml}
  </div>`;
}

export function renderGlobalPreferences(snap: DashboardSnapshot, busy: boolean): string {
  const prefs = getPreferences();
  const choices = (key: "language" | "theme", options: Array<[string, string]>) =>
    `<div role="group" aria-label="${label(key)}" class="segmented pref-${key}">${options.map(([id, text]) => `<button type="button" data-action="pref-${key}" data-value="${id}" aria-pressed="${prefs[key] === id}" ${busy ? "disabled" : ""}>${text}</button>`).join("")}</div>`;
  return `<div class="tab-scroll-pane directory-pane">
    <div class="page-intro"><h2>${label("settings")}</h2><p class="muted">${words("在本机保存并同步各工作台的显示偏好。", "Save display preferences across workbenches on this device.")}</p></div>
    <section class="panel-card settings-preferences"><h3 class="section-title">${label("interfaceLanguage")}</h3>
      <div class="preference-row"><span>${label("language")}</span>${choices("language", [["zh-CN", "简体中文"], ["en", "English"]])}</div>
      <div class="preference-row"><span>${label("theme")}</span>${choices("theme", [["system", label("system")], ["light", label("light")], ["dark", label("dark")]])}</div>
    </section>
    <section class="panel-card settings-preferences"><h3 class="section-title">${label("displaySettings")}</h3>
      ${([["showOfficeBanner", "officeBanner"], ["animatedAvatars", "animatedAvatars"], ["autoCollapseBannerNarrow", "narrowCollapse"]] as const).map(([key, text]) => `<label class="preference-row"><span>${label(text)}</span><span class="switch"><input type="checkbox" role="switch" data-preference="${key}" ${prefs[key] ? "checked" : ""} ${busy ? "disabled" : ""}><span class="switch-track"></span></span></label>`).join("")}
    </section>
    <section class="panel-card settings-preferences"><h3 class="section-title">${label("storageVersion")}</h3>
      <dl class="detail-kv"><div><dt>${words("插件版本", "Plugin version")}</dt><dd>${esc(snap.plugin_version ?? "—")}</dd></div><div><dt>Build</dt><dd>${esc(snap.ui_build_id ?? "—")}</dd></div><div><dt>${label("dataDirectory")}</dt><dd>${esc(snap.data_dir ?? "—")}</dd></div><div><dt>${words("配置路径", "Configuration path")}</dt><dd>${esc(snap.config_path ?? "—")}</dd></div></dl>
    </section>
  </div>`;
}

interface RuleViewState {
  policyEditScope: "global_ui" | "project" | "session";
  historyBrowsingMode: boolean;
  savingPolicy: boolean;
  newIdentityOpen: boolean;
  expandedIdentityId: string | null;
  savingBackends: ReadonlySet<RealBackendId>;
  savingAllConfigs: boolean;
  backendModels: Partial<Record<RealBackendId, BackendModelOption[]>>;
  modelsLoading: boolean;
  modelsLoaded: boolean;
  draft: (id: RealBackendId) => BackendDraftState;
  saved: (id: RealBackendId) => BackendConfigEntry;
  isDirty: (id: RealBackendId) => boolean;
}

export function renderGlobalRules(snap: DashboardSnapshot, state: RuleViewState): string {
  const healthMap = new Map(snap.backends.map((b) => [b.backend, b]));
  const isReadOnlyHistory = state.historyBrowsingMode;
  const policy = snap.dispatch_policy ?? null;

  const hasProject = Boolean(snap.swarm?.repo_root);
  const hasSession = Boolean(snap.swarm?.id);
  let activeScope = state.policyEditScope;
  if (activeScope === "project" && !hasProject) activeScope = "global_ui";
  if (activeScope === "session" && !hasSession) activeScope = "global_ui";

  const scopeLabel =
    activeScope === "global_ui" ? "主配置 (L2)" : activeScope === "project" ? "项目级 (L3)" : "会话级 (L4)";

  const layerStatusMap = new Map((policy?.layers ?? []).map((l) => [l.layer, l]));
  const activeLayerRaw = layerStatusMap.get(activeScope)?.raw ?? null;
  const canResetActiveScope =
    !isReadOnlyHistory &&
    !state.savingPolicy &&
    (layerStatusMap.get(activeScope)?.override_count ?? 0) > 0;

  const terraceSlabs = [
    ...(policy?.layers ?? []),
    { layer: "worker_explicit" as const, weight: 500, label: words("员工显式", "Explicit"), active: false, path: null, override_count: 0 },
  ];

  const chainHtml = terraceSlabs
    .map((l, idx) => {
      const bridge = idx > 0 ? `<span class="policy-bridge" aria-hidden="true">→</span>` : "";
      const isCurrent = l.layer === activeScope;
      const selectable =
        (l.layer === "global_ui" || (l.layer === "project" && hasProject) || (l.layer === "session" && hasSession)) &&
        !isReadOnlyHistory;
      const subText =
        l.layer === "builtin"
          ? `${l.override_count} ${words("内置身份", "built-ins")}`
          : l.layer === "worker_explicit"
            ? label("highestPriority")
            : l.active
              ? `${words("已覆写", "Overrides")} ${l.override_count}`
              : words("未覆写", "Inherit");
      const inner = `<div class="policy-slab-top">
          <span class="layer-pill ${policyLayerBadgeClass(l.layer)}">${esc(policyLayerShortLabel(l.layer))}</span>
          <strong>${esc(l.label)}</strong>
        </div>
        <div class="policy-slab-sub">${esc(subText)}</div>`;
      if (selectable) {
        return `${bridge}<button type="button" class="policy-slab ${policyLayerBadgeClass(l.layer)} ${isCurrent ? "is-editing" : ""} ${l.active ? "is-active" : ""}" style="--step:${idx}" data-action="set-policy-scope" data-policy-scope="${l.layer}" title="${esc(l.path || l.label)}">${inner}</button>`;
      }
      return `${bridge}<div class="policy-slab ${policyLayerBadgeClass(l.layer)} ${l.active ? "is-active" : ""}" style="--step:${idx}" title="${esc(l.path || l.label)}">${inner}</div>`;
    })
    .join("");

  const warningsHtml =
    policy && policy.warnings.length > 0
      ? `<div class="panel-card policy-warning-card">
          <strong>安全与解析提示 (${policy.warnings.length})</strong>
          <ul style="margin:6px 0 0 18px;padding:0;">
            ${policy.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}
          </ul>
        </div>`
      : "";

  const roNotice = isReadOnlyHistory
    ? `<div class="panel-card muted">只读历史回看模式：为防止误改当前配置，已锁定修改。</div>`
    : "";

  const identitiesList: ResolvedDispatchIdentity[] = policy ? Object.values(policy.identities) : [];
  const layerIdentityMap = activeLayerRaw?.identities ?? {};
  const lockedPolicy = isReadOnlyHistory || state.savingPolicy;

  const newIdentityFormHtml = state.newIdentityOpen
    ? `<div id="new-identity-form" class="identity-editor" style="margin-top:8px;">
        <div class="cfg-row-2">
          <div class="cfg-field">
            <label class="cfg-field-label">身份 ID（小写字母/数字/-/_）</label>
            <input id="new-id-key" class="input-sm" placeholder="例如 sec-audit" ${lockedPolicy ? "disabled" : ""} />
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label">显示名称</label>
            <input id="new-id-label" class="input-sm" placeholder="例如 安全审计官" ${lockedPolicy ? "disabled" : ""} />
          </div>
        </div>
        <div class="cfg-row-3" style="margin-top:6px;">
          <div class="cfg-field">
            <label class="cfg-field-label">基础角色</label>
            <select id="new-id-role" class="select-sm" ${lockedPolicy ? "disabled" : ""}>
              <option value="verifier">verifier (只读审校)</option>
              <option value="researcher">researcher (只读调研)</option>
              <option value="author">author (Worktree 写)</option>
              <option value="worker">worker (协同执行)</option>
            </select>
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label">能力路由</label>
            <select id="new-id-cap" class="select-sm" ${lockedPolicy ? "disabled" : ""}>
              <option value="verifier">verifier</option>
              <option value="architect">architect</option>
              <option value="research">research</option>
              <option value="author">author</option>
              <option value="enterprise">enterprise</option>
              <option value="fanout">fanout</option>
            </select>
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label">工作区模式</label>
            <select id="new-id-ws" class="select-sm" ${lockedPolicy ? "disabled" : ""}>
              <option value="inherit">inherit</option>
              <option value="share">share</option>
              <option value="branch">branch</option>
            </select>
          </div>
        </div>
        <div class="cfg-row-2" style="margin-top:6px;">
          <div class="cfg-field">
            <label class="cfg-field-label">首选后端（逗号分隔，可选）</label>
            <input id="new-id-backends" class="input-sm" placeholder="codex, grok" ${lockedPolicy ? "disabled" : ""} />
          </div>
          <div class="cfg-field">
            <label class="cfg-field-label">默认模型（可选）</label>
            <input id="new-id-model" class="input-sm" placeholder="留空则继承后端默认" ${lockedPolicy ? "disabled" : ""} />
          </div>
        </div>
        <div class="cfg-field" style="margin-top:6px;">
          <label class="cfg-field-label">身份附加 Prompt（可选）</label>
          <textarea id="new-id-prompt" class="input-sm" rows="2" placeholder="注入给该身份冷启动的系统指引..." ${lockedPolicy ? "disabled" : ""}></textarea>
        </div>
        ${renderRoleSkillField({ id: "new-id-skills", disabled: lockedPolicy })}
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px;">
          <button type="button" class="btn btn-sm-pad" data-action="toggle-new-identity">取消</button>
          <button type="button" class="btn btn-primary btn-sm-pad" data-action="create-identity" ${lockedPolicy ? "disabled" : ""}>保存到 ${esc(scopeLabel)}</button>
        </div>
      </div>`
    : "";

  const identitiesHtml = identitiesList
    .map((ident) => {
      const expanded = state.expandedIdentityId === ident.id;
      const layerIdPatch = layerIdentityMap[ident.id] ?? null;
      const hasLayerOverride = Object.prototype.hasOwnProperty.call(layerIdentityMap, ident.id);
      const isReadonlyBuiltin =
        READONLY_BUILTIN_IDENTITY_IDS.includes(ident.id as (typeof READONLY_BUILTIN_IDENTITY_IDS)[number]) &&
        activeScope !== "global_ui";
      const prefStr = (ident.preferred_backends ?? []).join(", ");
      const promptInputValue =
        activeScope === "global_ui" ? ident.system_prompt || "" : layerIdPatch?.system_prompt ?? "";
      const promptModeValue =
        activeScope === "global_ui"
          ? ident.prompt_mode || "replace"
          : layerIdPatch?.prompt_mode || ident.prompt_mode || "append";

      return `<div class="identity-card ${hasLayerOverride ? "is-overridden" : ""} ${!ident.enabled ? "is-disabled" : ""}">
        <div class="identity-card-head">
          <div class="rule-identity-label"><span class="rule-grip" aria-hidden="true">⠿</span>${renderEmployeeAvatarSvg({ backend: ident.preferred_backends?.[0] ?? "mock", model: ident.model, name: ident.id, role: ident.base_role, size: 34 })}
            <strong>${esc(ident.label)}</strong>
            <span class="mono muted">@${esc(ident.id)}</span>
            <span class="badge">${esc(ident.base_role)} · ${esc(ident.capability)}</span>
            <span class="layer-pill ${policyLayerBadgeClass(ident.source)}">${esc(policyLayerShortLabel(ident.source))} w=${ident.weight}</span>
            ${hasLayerOverride ? `<span class="badge badge-info">本层已覆写</span>` : ""}
            ${!ident.enabled ? `<span class="badge badge-err">已禁用</span>` : ""}
          </div>
          <button type="button" class="btn btn-sm-pad" data-action="toggle-identity-edit" data-identity="${esc(ident.id)}">${expanded ? "收起 ⌃" : "编辑 ⌄"}</button>
        </div>
        <div class="muted" style="font-size:11.5px;">
          后端偏好: ${esc(prefStr || "按能力默认路由")} · 模型: ${esc(ident.model || "继承后端")} · 工作区: ${esc(ident.workspace_mode || "inherit")}${ident.reports_to ? ` · 汇报→${esc(ident.reports_to)}` : ""}${ident.review_by ? ` · 审校←${esc(ident.review_by)}` : ""}
        </div>
        ${
          expanded
            ? `<div class="identity-editor" data-identity-editor="${esc(ident.id)}">
                <div class="cfg-row-2">
                  <div class="cfg-field">
                    <label class="cfg-field-label">显示名称</label>
                    <input class="input-sm" data-id-field="label" value="${esc(ident.label)}" ${lockedPolicy ? "disabled" : ""} />
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">启用状态</label>
                    <label class="switch" style="margin-top:4px;">
                      <input type="checkbox" data-id-field="enabled" ${ident.enabled ? "checked" : ""} ${lockedPolicy ? "disabled" : ""} />
                      <span class="switch-track"></span>
                    </label>
                  </div>
                </div>
                <div class="cfg-row-3">
                  <div class="cfg-field">
                    <label class="cfg-field-label">基础角色${isReadonlyBuiltin ? " (只读锁定)" : ""}</label>
                    <select class="select-sm" data-id-field="base_role" ${lockedPolicy || isReadonlyBuiltin ? "disabled" : ""}>
                      ${(["author", "verifier", "researcher", "worker"] as WorkerRole[])
                        .map((r) => `<option value="${r}" ${ident.base_role === r ? "selected" : ""}>${r}</option>`)
                        .join("")}
                    </select>
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">能力路由</label>
                    <select class="select-sm" data-id-field="capability" ${lockedPolicy ? "disabled" : ""}>
                      ${(["architect", "author", "verifier", "research", "enterprise", "fanout"] as CapabilityTag[])
                        .map((c) => `<option value="${c}" ${ident.capability === c ? "selected" : ""}>${c}</option>`)
                        .join("")}
                    </select>
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">工作区模式</label>
                    <select class="select-sm" data-id-field="workspace_mode" ${lockedPolicy ? "disabled" : ""}>
                      ${(["inherit", "share", "branch"] as WorkspaceMode[])
                        .map((wm) => `<option value="${wm}" ${(ident.workspace_mode || "inherit") === wm ? "selected" : ""}>${wm}</option>`)
                        .join("")}
                    </select>
                  </div>
                </div>
                <div class="cfg-row-3">
                  <div class="cfg-field">
                    <label class="cfg-field-label">首选后端（逗号分隔）</label>
                    <input class="input-sm" data-id-field="preferred_backends" value="${esc(prefStr)}" placeholder="codex, cursor" ${lockedPolicy ? "disabled" : ""} />
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">指定模型</label>
                    <input class="input-sm" data-id-field="model" value="${esc(ident.model || "")}" placeholder="留空继承后端默认" ${lockedPolicy ? "disabled" : ""} />
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">思考强度</label>
                    <select class="select-sm" data-id-field="effort" ${lockedPolicy ? "disabled" : ""}>
                      ${EFFORT_OPTIONS.map((o) => `<option value="${esc(o.value)}" ${(ident.effort || "") === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
                    </select>
                  </div>
                </div>
                <div class="cfg-row-3">
                  <div class="cfg-field">
                    <label class="cfg-field-label">汇报对象 (reports_to)</label>
                    <input class="input-sm" data-id-field="reports_to" value="${esc(ident.reports_to || "")}" placeholder="coordinator / architect" ${lockedPolicy ? "disabled" : ""} />
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">审校身份 (review_by)</label>
                    <input class="input-sm" data-id-field="review_by" value="${esc(ident.review_by || "")}" placeholder="例如 verifier" ${lockedPolicy ? "disabled" : ""} />
                  </div>
                  <div class="cfg-field">
                    <label class="cfg-field-label">Prompt 合并模式</label>
                    <select class="select-sm" data-id-field="prompt_mode" ${lockedPolicy ? "disabled" : ""}>
                      <option value="replace" ${promptModeValue === "replace" ? "selected" : ""}>replace (覆盖)</option>
                      <option value="append" ${promptModeValue === "append" ? "selected" : ""}>append (逐层追加)</option>
                    </select>
                  </div>
                </div>
                <div class="cfg-field">
                  <label class="cfg-field-label">${activeScope === "global_ui" ? "身份系统 Prompt" : `本层 (${scopeLabel}) 附加/覆写 Prompt`}</label>
                  <textarea class="input-sm" rows="2" data-id-field="system_prompt" placeholder="${activeScope === "global_ui" ? "注入给该身份的规范与约束..." : "留空则继承低层 Prompt；输入内容将按合并模式作用于当前层..."}" ${lockedPolicy ? "disabled" : ""}>${esc(promptInputValue)}</textarea>
                  ${
                    activeScope !== "global_ui" && ident.system_prompt
                      ? `<div class="muted" style="font-size:11px;white-space:pre-wrap;margin-top:3px;">当前合并生效：${esc(ident.system_prompt)}</div>`
                      : ""
                  }
                </div>
                ${renderRoleSkillField({ id: "identity-edit-skills", value: layerIdPatch?.skill_paths, layered: true, disabled: lockedPolicy })}
                ${ident.skill_paths?.length ? `<small class="muted">${words("当前生效：", "Effective: ")}${esc(ident.skill_paths.join(" · "))}</small>` : ""}
                <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:4px;">
                  ${
                    hasLayerOverride
                      ? `<button type="button" class="btn btn-sm-pad" data-action="reset-identity" data-identity="${esc(ident.id)}" ${lockedPolicy ? "disabled" : ""}>${!ident.builtin && activeScope === "global_ui" ? "删除自定义身份" : "还原继承"}</button>`
                      : ""
                  }
                  <button type="button" class="btn btn-primary btn-sm-pad" data-action="save-identity" data-identity="${esc(ident.id)}" ${lockedPolicy ? "disabled" : ""}>保存至 ${esc(scopeLabel)}</button>
                </div>
              </div>`
            : ""
        }
      </div>`;
    })
    .join("");

  const topologyLinks = policy?.topology ?? [];
  const layerTopology = activeLayerRaw?.topology ?? [];
  const topologyListHtml =
    topologyLinks.length === 0
      ? `<div class="muted" style="font-size:12px;">暂无预规划组织连线，可下方添加后在「流程」Tab 中与实际执行叠加展示。</div>`
      : topologyLinks
          .map((link) => {
            const inActiveLayer = layerTopology.some(
              (l) => l.from === link.from && l.to === link.to && l.kind === link.kind,
            );
            return `<div class="topo-row">
              <span class="mono"><strong>${esc(link.from)}</strong> → <strong>${esc(link.to)}</strong></span>
              <span class="badge badge-info">${esc(graphEdgeKindLabel(link.kind))}</span>
              ${link.label ? `<span class="muted">${esc(link.label)}</span>` : ""}
              ${link.source ? `<span class="layer-pill ${policyLayerBadgeClass(link.source)}">${esc(policyLayerShortLabel(link.source))}</span>` : ""}
              ${
                inActiveLayer
                  ? `<button type="button" class="btn btn-sm-pad btn-danger" style="margin-left:auto;" data-action="remove-topo-link" data-topo-from="${esc(link.from)}" data-topo-to="${esc(link.to)}" data-topo-kind="${esc(link.kind)}" ${lockedPolicy ? "disabled" : ""}>移除</button>`
                  : `<span class="muted" style="margin-left:auto;font-size:11px;">来自低层</span>`
              }
            </div>`;
          })
          .join("");

  let backendsSectionHtml = "";
  if (activeScope === "global_ui") {
    const cardsHtml = REAL_BACKENDS.map((id) => {
      const meta = BACKEND_DISPLAY_META[id];
      const health = healthMap.get(id);
      const building = renderVendorBuildingSvg(id, 42);
      const saved = state.saved(id);
      const draft = state.draft(id);
      const dirty = state.isDirty(id);
      const saving = state.savingBackends.has(id);
      const locked = saving || isReadOnlyHistory;
      const installed = health?.installed === 1;
      const cooling = Boolean(health?.cooldown_until && health.cooldown_until > Date.now());

      const statusBadge = !draft.enabled
        ? `<span class="badge">已禁用</span>`
        : cooling
          ? `<span class="badge badge-warn">冷却中</span>`
          : installed
            ? `<span class="badge badge-ok">${esc(health?.version || "已安装")}</span>`
            : `<span class="badge badge-err">未检测到 CLI</span>`;

      const modelOpts = state.backendModels[id] ?? [];
      const curModel = draft.defaultModel;
      const matchedInList = !curModel || modelOpts.some((m) => m.id === curModel);
      const showCustomInput = draft.customMode || (Boolean(curModel) && !matchedInList);

      const modelSelectOptions = [
        `<option value="" ${!curModel && !showCustomInput ? "selected" : ""}>CLI 默认</option>`,
        ...modelOpts.map(
          (m) =>
            `<option value="${esc(m.id)}" ${!showCustomInput && curModel === m.id ? "selected" : ""}>${esc(m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id)}</option>`,
        ),
        `<option value="__custom__" ${showCustomInput ? "selected" : ""}>自定义模型 ID...</option>`,
      ].join("");

      const effortOptionsHtml = EFFORT_OPTIONS.map(
        (opt) => `<option value="${esc(opt.value)}" ${draft.defaultEffort === opt.value ? "selected" : ""}>${esc(opt.label)}</option>`,
      ).join("");

      const savedSummary = `${saved.enabled ? "启用" : "禁用"} · ${saved.defaultModel || "CLI 默认"}${saved.defaultEffort ? ` / ${saved.defaultEffort}` : ""}`;

      return `<div id="backend-${esc(id)}" class="agent-cfg-card ${dirty ? "is-dirty" : ""} ${!draft.enabled ? "is-disabled" : ""}">
        <div class="agent-cfg-top">
          <div class="agent-cfg-id">
            ${building}
            <div class="agent-cfg-title-col">
              <div class="agent-cfg-title-row">
                <strong>${esc(meta.title.split(" (")[0])}</strong>
                ${statusBadge}
              </div>
              <div class="muted">${esc(meta.roleHint)}</div>
            </div>
          </div>
          <label class="switch" title="${draft.enabled ? "点击禁用此 Agent" : "点击启用此 Agent"}">
            <input type="checkbox" data-rule-toggle="${esc(id)}" ${draft.enabled ? "checked" : ""} ${locked ? "disabled" : ""} />
            <span class="switch-track"></span>
          </label>
        </div>

        <div class="agent-cfg-fields">
          <div class="cfg-row-2">
            <div class="cfg-field">
              <label class="cfg-field-label">默认模型</label>
              <select class="select-sm" data-cfg-model-select="${esc(id)}" ${locked ? "disabled" : ""}>${modelSelectOptions}</select>
            </div>
            <div class="cfg-field">
              <label class="cfg-field-label">思考强度</label>
              <select class="select-sm" data-cfg-effort="${esc(id)}" ${locked ? "disabled" : ""}>${effortOptionsHtml}</select>
            </div>
          </div>
          ${
            showCustomInput
              ? `<div class="cfg-field">
                  <label class="cfg-field-label">自定义模型 ID</label>
                  <input class="input-sm" data-cfg-model-custom="${esc(id)}" value="${esc(curModel)}" placeholder="输入 CLI 支持的完整模型 ID" ${locked ? "disabled" : ""} />
                </div>`
              : ""
          }
        </div>

        <div class="agent-cfg-foot">
          <span class="muted" title="${esc(savedSummary)}">${esc(savedSummary)}</span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            ${dirty ? `<button type="button" class="btn btn-sm-pad" data-action="reset-backend-cfg" data-backend="${esc(id)}" ${locked ? "disabled" : ""}>还原</button>` : ""}
            <button type="button" class="btn btn-sm-pad ${dirty ? "btn-primary" : ""}" data-action="save-backend-cfg" data-backend="${esc(id)}" ${!dirty || locked ? "disabled" : ""}>${saving ? "保存中..." : "保存"}</button>
          </div>
        </div>
      </div>`;
    }).join("");

    backendsSectionHtml = `<section class="panel-card rules-vendors-col">
      <div class="section-head" style="margin-bottom:8px;">
        <div class="settings-head-meta">
          <span class="section-title">外包厂商默认配置（主配置 L2）</span>
          <span class="muted mono">${esc(snap.config_path || "~/.poly-swarm/backends.json")}</span>
        </div>
        <div class="settings-head-actions">
          <button type="button" class="btn btn-sm-pad" data-action="refresh-models" ${state.modelsLoading ? "disabled" : ""}>${state.modelsLoading ? "探测中..." : "↻ 刷新模型"}</button>
        </div>
      </div>
      <div class="rules-vendor-list">${cardsHtml}</div>
    </section>`;
  } else {
    const layerBackends = activeLayerRaw?.backends ?? {};
    const cardsHtml = REAL_BACKENDS.map((id) => {
      const meta = BACKEND_DISPLAY_META[id];
      const building = renderVendorBuildingSvg(id, 42);
      const pol = policy?.backends[id];
      const globallyDisabled = Boolean(pol?.globally_disabled);
      const effectiveEnabled = pol?.enabled !== false;
      const hasOverride = Boolean(layerBackends[id]);
      const modelVal = pol?.defaultModel ?? "";
      const effortVal = pol?.defaultEffort ?? "";
      const modelOpts = state.backendModels[id] ?? [];
      const locked = lockedPolicy || globallyDisabled;

      return `<div id="backend-${esc(id)}" class="agent-cfg-card ${hasOverride ? "is-dirty" : ""} ${!effectiveEnabled ? "is-disabled" : ""}" data-layer-backend-card="${esc(id)}">
        <div class="agent-cfg-top">
          <div class="agent-cfg-id">
            ${building}
            <div class="agent-cfg-title-col">
              <div class="agent-cfg-title-row">
                <strong>${esc(meta.title.split(" (")[0])}</strong>
                ${
                  globallyDisabled
                    ? `<span class="badge badge-err">全局已禁用 (锁定)</span>`
                    : `<span class="layer-pill ${policyLayerBadgeClass(pol?.enabled_source.layer)}">${esc(policyLayerShortLabel(pol?.enabled_source.layer))}</span>`
                }
                ${hasOverride ? `<span class="badge badge-info">本层覆写</span>` : ""}
              </div>
              <div class="muted">${globallyDisabled ? "主配置已全局禁用，不可在本层重新启用" : esc(meta.roleHint)}</div>
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" data-layer-cfg-enabled="${esc(id)}" ${effectiveEnabled ? "checked" : ""} ${locked ? "disabled" : ""} />
            <span class="switch-track"></span>
          </label>
        </div>

        <div class="agent-cfg-fields">
          <div class="cfg-row-2">
            <div class="cfg-field">
              <label class="cfg-field-label">模型覆写 <span class="layer-pill ${policyLayerBadgeClass(pol?.model_source?.layer)}">${esc(policyLayerShortLabel(pol?.model_source?.layer))}</span></label>
              <input class="input-sm" list="dl-models-${esc(id)}" data-layer-cfg-model="${esc(id)}" value="${esc(modelVal)}" placeholder="留空表示 CLI 默认" ${locked ? "disabled" : ""} />
              <datalist id="dl-models-${esc(id)}">
                ${modelOpts.map((m) => {
                  const optLabel = m.source === "fallback" ? `${m.label || m.id} [${t("modelFallbackTag")}]` : m.label;
                  return `<option value="${esc(m.id)}"${optLabel ? ` label="${esc(optLabel)}"` : ""}></option>`;
                }).join("")}
              </datalist>
            </div>
            <div class="cfg-field">
              <label class="cfg-field-label">思考强度 <span class="layer-pill ${policyLayerBadgeClass(pol?.effort_source?.layer)}">${esc(policyLayerShortLabel(pol?.effort_source?.layer))}</span></label>
              <select class="select-sm" data-layer-cfg-effort="${esc(id)}" ${locked ? "disabled" : ""}>
                ${EFFORT_OPTIONS.map((opt) => `<option value="${esc(opt.value)}" ${effortVal === opt.value ? "selected" : ""}>${esc(opt.label)}</option>`).join("")}
              </select>
            </div>
          </div>
        </div>

        <div class="agent-cfg-foot">
          <span class="muted">生效：${effectiveEnabled ? "启用" : "禁用"} · ${esc(modelVal || "CLI 默认")}</span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            ${hasOverride ? `<button type="button" class="btn btn-sm-pad" data-action="reset-layer-backend" data-backend="${esc(id)}" ${lockedPolicy ? "disabled" : ""}>还原继承</button>` : ""}
            <button type="button" class="btn btn-primary btn-sm-pad" data-action="save-layer-backend" data-backend="${esc(id)}" ${locked ? "disabled" : ""}>覆写到 ${esc(scopeLabel)}</button>
          </div>
        </div>
      </div>`;
    }).join("");

    backendsSectionHtml = `<section class="panel-card rules-vendors-col">
      <div class="section-head" style="margin-bottom:8px;">
        <div class="settings-head-meta">
          <span class="section-title">CLI 后端模型覆写（${esc(scopeLabel)}）</span>
          <span class="muted mono">${esc(layerStatusMap.get(activeScope)?.path || "")}</span>
        </div>
        <div class="settings-head-actions">
          <button type="button" class="btn btn-sm-pad" data-action="refresh-models" ${state.modelsLoading ? "disabled" : ""}>${state.modelsLoading ? "探测中..." : "↻ 刷新模型"}</button>
        </div>
      </div>
      <div class="rules-vendor-list">${cardsHtml}</div>
    </section>`;
  }

  return `<div class="tab-scroll-pane rules-sandbox-wrap">
    ${roNotice}
    <section class="panel-card policy-terrace-card">
      <div class="section-head">
        <span class="section-title">调度规则 · 3D 阶梯优先级</span>
        <div class="pill-row">
          <button type="button" class="filter-pill ${activeScope === "global_ui" ? "active" : ""}" data-action="set-policy-scope" data-policy-scope="global_ui">主配置 (L2)</button>
          <button type="button" class="filter-pill ${activeScope === "project" ? "active" : ""}" data-action="set-policy-scope" data-policy-scope="project" ${hasProject ? "" : 'disabled title="需关联仓库目录的 Swarm"'}>项目级 (L3)</button>
          <button type="button" class="filter-pill ${activeScope === "session" ? "active" : ""}" data-action="set-policy-scope" data-policy-scope="session" ${hasSession ? "" : 'disabled title="需先在会话中创建 Swarm"'}>会话级 (L4)</button>
          ${canResetActiveScope ? `<button type="button" class="btn btn-sm-pad btn-danger" data-action="reset-policy-scope">清空本层</button>` : ""}
        </div>
      </div>
      <div class="policy-terrace-stage">${chainHtml}</div>
    </section>

    ${warningsHtml}

    <div class="rules-split-grid">
      <div class="rules-identities-col">
        <section class="panel-card">
          <div class="section-head">
            <span class="section-title">岗位路由规则 (${identitiesList.length})</span>
            <button type="button" class="btn btn-sm-pad btn-primary" data-action="toggle-new-identity" ${lockedPolicy ? "disabled" : ""}>${state.newIdentityOpen ? "收起新建" : "+ 新增自定义"}</button>
          </div>
          ${newIdentityFormHtml}
          <div class="identity-list">${identitiesHtml}</div>
        </section>

        <section class="panel-card">
          <div class="section-head">
            <span class="section-title">组织预规划拓扑 (${topologyLinks.length})</span>
            <span class="muted">当前编辑层：${esc(scopeLabel)}</span>
          </div>
          <div class="topo-list">${topologyListHtml}</div>
          <div id="topo-add-form" class="topo-add-row">
            <input id="topo-from" class="input-sm" placeholder="源节点 (如 coordinator)" ${lockedPolicy ? "disabled" : ""} />
            <select id="topo-kind" class="select-sm" ${lockedPolicy ? "disabled" : ""}>
              <option value="dispatch">派发 (dispatch)</option>
              <option value="review">审校 (review)</option>
              <option value="reports_to">汇报 (reports_to)</option>
              <option value="depends_on">依赖 (depends_on)</option>
              <option value="handoff">交接 (handoff)</option>
            </select>
            <input id="topo-to" class="input-sm" placeholder="目标节点/身份" ${lockedPolicy ? "disabled" : ""} />
            <input id="topo-label" class="input-sm" placeholder="连线说明 (可选)" ${lockedPolicy ? "disabled" : ""} />
            <button type="button" class="btn btn-primary btn-sm-pad" data-action="add-topo-link" ${lockedPolicy ? "disabled" : ""}>添加连线</button>
          </div>
        </section>
      </div>

      ${backendsSectionHtml}
    </div>

    <div class="rules-floating-dock">
      <div class="rules-dock-spacer"></div>
      ${renderCampusLensDock("rules")}
      <div class="rules-dock-actions">
        <button type="button" class="btn" data-action="reset-policy-scope" ${canResetActiveScope ? "" : "disabled"}>${activeScope === "global_ui" ? "恢复默认" : "清空本层"}</button>
        ${activeScope === "global_ui" ? `<button type="button" class="btn btn-primary" data-action="save-all-cfg" ${REAL_BACKENDS.some((id) => state.isDirty(id)) && !state.savingAllConfigs ? "" : "disabled"}>保存更改</button>` : ""}
      </div>
    </div>
  </div>`;
}
