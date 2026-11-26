import { buildConversationBlocks, coalesceEvents, extractTurnPrompt, formatToolPayload, summarizeToolStep, type CoalescedEvent, type ConversationBlock } from "./trace_model.js";

import type {
  CapabilityTag,
  BoardMessage,
  DashboardSnapshot,
  SessionTurnUsageItem,
  SwarmRecord,
  TeamRecord,
  TurnRecord,
  UsageBreakdownSummary,
  WorkerDetailPayload,
  WorkerEvent,
  WorkerRole,
  WorkerSummary,
  WorkspaceDiffResult,
} from "../shared/types.js";
import { BACKEND_COLORS, renderChatIdentityAvatar, renderEmployeeAvatarSvg, renderMiniOfficeSvg } from "./avatars_3d.js";
import { getLanguage, getPreferences, t } from "./i18n.js";
import { esc, renderMarkdown } from "./markdown.js";
import {
  deriveOkrTree, filterWorkersByStatus, formatWorkerActivity, groupBlackboard, projectBlackboard,
  projectDeliverables, policyLayerShortLabel, workerStatusGroup, type BlackboardSection, type WorkbenchStatusFilter,
} from "./swarm_view_model.js";

const label = (key: string) => esc(t(key));
const words = (zh: string, en: string) => esc(getLanguage() === "en" ? en : zh);
const money = (value: number) => "$" + value.toFixed(4);
const color = (backend: string) => esc(BACKEND_COLORS[backend] ?? BACKEND_COLORS.mock!);
const date = (time: number) => esc(new Date(time).toLocaleString(getLanguage()));
const jump = (seq: number, text = `#${seq}`) =>
  `<button type="button" class="link-btn" data-action="scroll-seq" data-seq="${esc(seq)}">${esc(text)}</button>`;
const avatar = (w: WorkerSummary, size: number, animated = false) =>
  renderEmployeeAvatarSvg({ backend: w.backend, model: w.model, name: w.name, role: w.role, size, animated });
const statusKeys = { working: "running", waiting: "idle", error: "error", stopped: "stopped", killed: "killed", planned: "planned" };

function renderEmployeeCard(worker: WorkerSummary, snap: DashboardSnapshot, animated: boolean, selected = false): string {
  const group = workerStatusGroup(worker, snap);
  const model = worker.model ?? snap.effective_defaults[worker.backend]?.model ?? "CLI";
  const effort = worker.effort ?? snap.effective_defaults[worker.backend]?.effort;
  return `<button type="button" class="employee-card st-${group}${selected ? " is-selected" : ""}"${selected ? ` aria-current="true"` : ""} style="--company:${color(worker.backend)}" data-action="open-worker-detail" data-worker="${esc(worker.name)}">
    ${avatar(worker, 52, animated)}
    <span class="employee-card-copy">
      <span class="employee-name-row"><strong>@${esc(worker.name)}</strong><span class="status-badge status-${group}">${label(group === "idle" || group === "running" ? statusKeys[worker.state] : group)}</span>${worker.needs_handoff ? `<span class="badge badge-warn">${label("reassigning")}</span>` : ""}</span>
      <span class="employee-model" title="${esc(model)}">${esc(worker.backend)} · ${esc(model)}${effort ? ` / ${esc(effort)}` : ""}</span><span class="employee-role">${esc(worker.identity_id || worker.role)}</span>
      <span class="employee-activity muted">${getLanguage() === "en" ? esc(worker.latest_event?.title ?? t(statusKeys[worker.state])) : esc(formatWorkerActivity(worker))}</span>
    </span>
    <span aria-hidden="true">›</span>
  </button>`;
}

export function renderOkrPanel(snap: DashboardSnapshot): string {
  const tree = deriveOkrTree(snap);
  return `<section class="panel-card okr-panel">
    <div class="section-head"><div><h2 class="section-title">${label("objectiveTree")}</h2><strong>${esc(snap.plan?.goal.title ?? snap.swarm?.title ?? "—")}</strong>
    ${snap.plan?.goal.line ? `<p class="muted">${esc(snap.plan.goal.line)}</p>` : ""}</div></div>
    ${snap.plan ? tree.threads.map((thread) => `<details class="okr-thread" open>
      <summary><strong>${esc(thread.title)}</strong> <span class="badge">${esc(thread.done)}/${esc(thread.total)} ${label("done")}</span></summary>
      <p class="muted">${esc(thread.goal)}</p>
      ${thread.tasks.map((task) => `<button type="button" class="okr-task" data-action="open-worker-detail" data-worker="${esc(task.name)}" ${task.worker ? "" : "disabled"}>
        ${task.worker ? avatar(task.worker, 28) : ""}<span><strong>${esc(task.title)}</strong><small class="muted">@${esc(task.name)} · ${task.done ? label("done") : task.worker ? label(statusKeys[task.worker.state]) : words("待派遣", "Planned")}</small></span>
      </button>`).join("")}
    </details>`).join("") : `<p class="muted">${words("本项目组未设置 OKR", "No OKRs set for this project")}</p>`}
  </section>`;
}

export function renderDeliverablesPanel(snap: DashboardSnapshot, readOnly: boolean): string {
  const rows = projectDeliverables(snap);
  return `<section class="panel-card"><h2 class="section-title">${label("deliverables")}</h2><div class="deliverable-list">
  ${rows.map((item) => `<article class="deliverable-row delivery-${item.canMerge ? "green" : "amber"}">
    <div class="section-head"><button type="button" class="link-btn" data-action="open-worker-detail" data-worker="${esc(item.workerName)}">@${esc(item.workerName)}</button>
      ${item.dirty ? `<span class="badge badge-warn">${label("dirty")}</span>` : item.headSha ? `<span class="badge badge-ok">${label("clean")}</span>` : ""}</div>
    <div class="mono">${esc(item.branch || "—")} → ${esc(item.targetBranch || "—")}</div>
    <div class="mono">HEAD ${esc(item.headSha || "—")}</div>
    <div class="pill-row">
      ${item.status === "accepted" ? `<span class="badge badge-ok">${label("reviewPassed")}</span>` : ""}
      ${item.shaMatches ? `<span class="badge badge-ok">${label("shaMatch")}</span>` : ""}
      ${item.status === "stale" ? `<span class="badge badge-warn">${label("staleReview")}</span>` : ""}
      ${snap.deliverables?.[item.workerName]?.latest_review?.tag === "review_fail" ? `<span class="badge badge-err">${label("reviewFailed")}</span>` : ""}
      ${item.independentReviewNeeded ? `<span class="badge badge-warn">${label("independentReview")}</span>` : ""}
      ${item.reviewSeq ? jump(item.reviewSeq) : ""}
    </div>
    ${item.reviewText ? `<details><summary>${words("审校证据", "Review evidence")} · ${esc(item.reviewedSha ?? "—")}</summary><p class="review-text">${esc(item.reviewText)}</p></details>` : ""}
    ${item.dirtyFiles.length ? `<div class="muted mono">${item.dirtyFiles.map(esc).join(" · ")}</div>` : ""}
    <div class="pill-row">
      ${item.independentReviewNeeded ? `<button type="button" class="btn btn-sm-pad" data-action="review-candidates" data-worker="${esc(item.workerName)}">${label("reviewCandidates")}</button>` : ""}
      <button type="button" class="btn btn-sm-pad" data-action="copy-merge" data-worker="${esc(item.workerName)}" ${item.canMerge && !readOnly ? "" : "disabled"}>${label("copyMerge")}</button>
      <button type="button" class="btn btn-sm-pad btn-primary delivery-cta" data-action="safe-merge" data-worker="${esc(item.workerName)}" data-expected-sha="${esc(item.headSha || "")}" ${item.canMerge && !readOnly ? "" : "disabled"}>${label("safeMerge")}</button>
    </div></article>`).join("") || `<p class="muted">${label("noRecords")}</p>`}</div></section>`;
}

function stripLeadingMention(text: string): string {
  return text.replace(/^\s*(?:@[a-z0-9_-]+\s+|all\s+)/i, "").trim();
}

function renderStudioWorkerPopover(worker: WorkerSummary, snap: DashboardSnapshot): string {
  const briefMsg = [...snap.board_tail]
    .reverse()
    .find((m) => m.sender === "coordinator" && m.text.toLowerCase().includes(`@${worker.name.toLowerCase()}`));
  const turnPrompt = worker.latest_turn ? extractTurnPrompt(worker.latest_turn, briefMsg, worker.name).body : "";
  const promptPreview = turnPrompt || briefMsg?.text || snap.swarm?.title || "";
  const cleanPrompt = stripLeadingMention(promptPreview).slice(0, 140) || words("当前席位待命中", "Ready for next task");
  const statusPill =
    worker.state === "working"
      ? `<span class="studio-dot-spinner" aria-label="${label("running")}"><i></i><i></i><i></i><i></i></span>`
      : worker.state === "error"
        ? `<span class="studio-pop-state is-error" aria-label="${label("error")}">!</span>`
        : `<span class="studio-pop-state is-ok" aria-label="${label("waiting")}">✓</span>`;
  const rawSteps: string[] = [];
  if (worker.state === "working") {
    rawSteps.push(words("正在推进执行…", "Working on task…"));
  }
  if (worker.latest_event?.title || worker.latest_event?.content) {
    rawSteps.push(worker.latest_event.title || worker.latest_event.content.slice(0, 64));
  }
  const workerMsgs = [...snap.board_tail].filter((m) => m.sender === worker.name).slice(-2);
  for (const m of workerMsgs) {
    const line = stripLeadingMention(m.text.replace(/\s+/g, " ").trim()).slice(0, 68);
    if (line && !rawSteps.includes(line)) rawSteps.push(line);
  }
  if (rawSteps.length === 0) {
    rawSteps.push(words(`当前状态：${t(statusKeys[worker.state])}`, `Status: ${t(statusKeys[worker.state])}`));
  }
  return `<aside class="studio-popover" role="dialog" aria-label="@${esc(worker.name)}">
    <header class="studio-pop-head">
      ${avatar(worker, 38, true)}
      <div class="studio-pop-meta">
        <strong>@${esc(worker.name)}</strong>
        <small>${esc(roleLabel(worker.role, worker.capability))} · ${esc(worker.backend)}</small>
      </div>
      ${statusPill}
      <button type="button" class="btn btn-icon studio-pop-close" data-action="close-studio-peek" aria-label="${label("cancel")}">×</button>
    </header>
    <div class="studio-pop-task">${esc(cleanPrompt)}</div>
    <ul class="studio-pop-steps">${rawSteps.slice(0, 3).map((step) => `<li>${esc(step)}</li>`).join("")}</ul>
    <footer class="studio-pop-foot">
      <button type="button" class="studio-pop-cta" data-action="open-worker-detail" data-worker="${esc(worker.name)}">${label("studioOpenChat")} ↗</button>
    </footer>
  </aside>`;
}

export function renderCompanyOverview(snap: DashboardSnapshot, options: {
  filter: WorkbenchStatusFilter; officeExpanded: boolean; showOffice: boolean; animated: boolean; selectedName: string | null; studioPeekWorker?: string | null; readOnly: boolean;
}): string {
  const live = snap.workers.filter((w) => w.state !== "killed");
  const filters = ["running", "acceptance", "risk", "idle"] as const;
  const cooling = snap.backends.filter((b) => (b.cooldown_until ?? 0) > Date.now() && live.some((w) => w.backend === b.backend));
  const signals = [...projectBlackboard(snap)].filter((msg) => ["blocked", "stall", "review_fail"].includes(msg.tag)).slice(0, 3);
  const pendingReview = projectDeliverables(snap).filter((d) => d.independentReviewNeeded && (d.dirty ||
    snap.board_tail.some((m) => m.sender === d.workerName && m.tag === "done") ||
    snap.workers.some((worker) => worker.review_of === d.workerName)));
  const matchKey = snap.match_reason === "conversation_binding" ? "matchBinding"
    : snap.match_reason === "repo_match" ? "matchRepo"
    : snap.match_reason === "recent_workbench_focus" || snap.match_reason === "recent_active_team" ? "matchRecent"
    : null;
  const waveTag = snap.swarm?.wave_index ? `#${snap.swarm.wave_index}` : "";
  const peeked = options.studioPeekWorker ? live.find((w) => w.name === options.studioPeekWorker) ?? null : null;
  return `<div class="tab-scroll-pane company-overview">
    ${options.showOffice ? `<section class="panel-card office-panel">
      <button type="button" class="office-heading" data-action="toggle-office" aria-expanded="${options.officeExpanded}"><span><strong>${esc(snap.team?.name || snap.swarm?.title || t("sessionProject"))}</strong>${waveTag ? `<small class="badge office-wave-tag">${esc(waveTag)}</small>` : ""}${matchKey ? `<small class="badge badge-info office-match-pill">${label(matchKey)}</small>` : ""}<small>${esc(live.length)} ${label("headcount")}</small></span><span>${options.officeExpanded ? "⌃" : "⌄"}</span></button>
      ${options.officeExpanded ? `<div class="office-scene">${renderMiniOfficeSvg(live, { compact: true, animated: options.animated, selectedName: peeked?.name ?? options.selectedName, statusTexts: Object.fromEntries(live.map((w) => [w.name, t(statusKeys[w.state])])) })}${peeked ? renderStudioWorkerPopover(peeked, snap) : ""}</div>` : ""}
    </section>` : ""}
    <div class="filter-pills workbench-counts">${filters.map((id) => `<button type="button" class="filter-pill count-${id} ${options.filter === id ? "active" : ""}" aria-pressed="${options.filter === id}" data-action="set-workbench-filter" data-filter="${id}"><i></i><span>${label(id)}</span><strong>${esc(live.filter((worker) => workerStatusGroup(worker, snap) === id).length)}</strong></button>`).join("")}</div>
    ${cooling.length || signals.length || pendingReview.length ? `<section class="risk-banner"><strong>⚠ ${label("risk")}</strong>
      ${cooling.map((b) => `<div class="risk-line"><span>${esc(b.backend)} · ${label("cooling")} ${b.cooldown_reason ? `· ${esc(b.cooldown_reason)}` : ""}</span>${options.readOnly ? "" : live.filter((w) => w.backend === b.backend).map((w) => `<button type="button" class="link-btn" data-action="open-switch" data-worker="${esc(w.name)}">${label("reassign")} @${esc(w.name)}</button>`).join("")}</div>`).join("")}
      ${signals.map((m) => `<div class="risk-line"><span>${esc(m.tag)} · @${esc(m.sender)} · ${esc(m.text.slice(0, 130))}</span>${jump(m.seq)}</div>`).join("")}
      ${pendingReview.map((d) => `<div class="risk-line"><span>@${esc(d.workerName)} · ${label("independentReview")}</span><button type="button" class="link-btn" data-action="review-candidates" data-worker="${esc(d.workerName)}">${label("reviewCandidates")}</button></div>`).join("")}
    </section>` : ""}
    <section class="employee-grid">${filterWorkersByStatus(live, options.filter, snap).map((worker) => renderEmployeeCard(worker, snap, options.animated, worker.name === options.selectedName)).join("") || `<p class="muted">${label("noRecords")}</p>`}</section>
  </div>`;
}

export function boardMessageLabel(tag: BoardMessage["tag"]): { label: string; tone: string } {
  switch (tag) {
    case "done": return { label: words("交付", "Delivery"), tone: "ok" };
    case "review_pass": return { label: words("审校通过", "Review passed"), tone: "ok" };
    case "blocked": return { label: words("阻塞", "Blocked"), tone: "err" };
    case "review_fail": return { label: words("审校打回", "Changes requested"), tone: "err" };
    case "stall": return { label: words("停滞", "Stalled"), tone: "warn" };
    case "brief": return { label: words("任务派发", "Assignment"), tone: "info" };
    case "update": return { label: words("进展", "Update"), tone: "" };
    default: return { label: words("系统", "System"), tone: "" };
  }
}

export function boardSenderLabel(sender: string): string {
  return sender === "coordinator" ? words("主会话", "Coordinator") : sender === "user" ? words("我", "You") : esc(`@${sender}`);
}

export function renderBlackboardPanel(snap: DashboardSnapshot, section: BlackboardSection | "all"): string {
  const groups = groupBlackboard(snap);
  const sections: Array<{ key: BlackboardSection; title: string; mark: string; hint: string }> = [
    { key: "risks", title: words("风险", "Risks"), mark: "!", hint: words("阻塞、停滞与审校打回", "Blockers, stalls and changes requested") },
    { key: "results", title: words("交付与审校", "Outcomes"), mark: "✓", hint: words("交付、合流与审校通过", "Deliveries, merges and approvals") },
    { key: "briefs", title: words("任务派发", "Assignments"), mark: "↗", hint: words("派给成员的工作与边界", "Delegated work and constraints") },
  ];
  const total = sections.reduce((sum, item) => sum + groups[item.key].length, 0);
  const excerpt = (m: BoardMessage) => {
    const compact = m.text.replace(/^\s*(?:\[(?:done|review_pass|review_fail|blocked|stall|merged)\]\s*)+/i, "")
      .replace(/\s+/g, " ").trim();
    return esc(compact.length > 190 ? `${compact.slice(0, 190)}…` : compact);
  };
  return `<aside id="coordination-board" class="blackboard-drawer" aria-labelledby="coordination-board-title">
    <header class="blackboard-header">
      <div><span class="blackboard-kicker">${words("项目记录", "PROJECT RECORD")} <span>·</span> ${esc(total)}</span>
      <h2 id="coordination-board-title" tabindex="-1">${words("协作黑板", "Coordination board")}</h2></div>
      <button type="button" class="btn btn-icon blackboard-close" data-action="toggle-blackboard" aria-label="${words("返回群聊", "Back to chat")}" title="${words("返回群聊", "Back to chat")}">×</button>
      <p>${words("从本轮群聊提取的关键记录。点开原消息看完整上下文。", "Key records from this wave. Open a source message for the full context.")}</p>
    </header>
    <div class="blackboard-filters" role="group" aria-label="${words("黑板分类", "Board categories")}">
      ${sections.map(({key, title, mark}) => `<button type="button" class="blackboard-filter tone-${key}" data-action="filter-blackboard" data-section="${key}" aria-pressed="${section === key}"><b>${mark} <span>${groups[key].length}</span></b><span>${title}</span></button>`).join("")}
      ${section === "all" ? "" : `<button class="link-btn blackboard-show-all" type="button" data-action="filter-blackboard" data-section="all">${words("显示全部", "Show all")}</button>`}
    </div>
    <div class="blackboard-list" tabindex="0" aria-label="${words("黑板记录，可滚动查看", "Scrollable board entries")}">
      ${sections.filter(({key}) => section === key || (section === "all" && groups[key].length > 0)).map(({key, title, hint}) => `<section class="blackboard-section tone-${key}">
        <h3>${title} <small>${groups[key].length}</small></h3><p class="blackboard-section-hint">${hint}</p>
        ${groups[key].map((m) => {
          const type = boardMessageLabel(m.tag);
          return `<article class="blackboard-item note-${key}"><div class="blackboard-item-meta">
            <span class="badge ${type.tone ? `badge-${type.tone}` : ""}">${type.label}</span>
            ${m.sender === "coordinator" || m.sender === "user" ? renderChatIdentityAvatar(m.sender, 18) : ""}<strong>${boardSenderLabel(m.sender)}</strong>
          </div><p>${excerpt(m)}</p><footer><span>#${esc(m.channel)} · <time>${esc(fmtTime(m.created_at))}</time></span>
          ${jump(m.seq, `${getLanguage() === "en" ? "Open" : "原消息"} #${m.seq} ↗`)}</footer></article>`;
        }).join("") || `<p class="blackboard-empty">${words("该类别暂无记录", "No entries in this category")}</p>`}
      </section>`).join("") || `<p class="blackboard-empty">${words("派发、交付、审校结论或阻塞会自动出现在这里。", "Assignments, outcomes, review decisions and blockers will appear here.")}</p>`}
    </div>
    <footer class="blackboard-scope">${words("本轮 · 所有频道 · 近期记录", "This wave · All channels · Recent records")}</footer>
  </aside>`;
}

const fmtTokExact = (n: number): string =>
  `${new Intl.NumberFormat(getLanguage()).format(Math.round(n))} tok`;
const fmtCompactTok = (n: number): string =>
  Intl.NumberFormat(getLanguage(), { notation: "compact", maximumFractionDigits: 1 }).format(n);

function fmtPeopleSpend(u: UsageBreakdownSummary): { text: string; isEstimated: boolean } {
  const hasKnown = u.priced_turns > 0 && u.known_cost_usd > 0;
  const hasEst = u.unpriced_turns > 0 && u.estimated_cost_usd > 0;
  if (hasKnown && hasEst) {
    return { text: `${money(u.known_cost_usd)} + ≈${money(u.estimated_cost_usd)}`, isEstimated: true };
  }
  if (u.priced_turns > 0) {
    return { text: money(u.known_cost_usd), isEstimated: false };
  }
  if (hasEst) {
    return { text: `≈${money(u.estimated_cost_usd)}`, isEstimated: true };
  }
  return { text: "—", isEstimated: false };
}

function renderWaveTelemetryCards(u: UsageBreakdownSummary): string {
  const hitPct = u.cache_hit_rate !== null ? Math.round(u.cache_hit_rate * 100) : null;
  const spendInfo = fmtPeopleSpend(u);
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
          ? money(b.known_cost_usd)
          : b.unpriced_turns > 0 && b.estimated_cost_usd > 0
            ? `≈${money(b.estimated_cost_usd)}`
            : b.priced_turns > 0
              ? "$0.0000"
              : "—";
      return `<div class="telemetry-backend-row">
        <span class="telemetry-backend-name">
          <i class="company-dot" style="--company:${color(b.backend)}"></i>
          <span>${esc(b.backend)}${b.model ? ` · ${esc(b.model)}` : ""}</span>
        </span>
        <span class="telemetry-backend-tokens">${esc(fmtCompactTok(b.uncached_input_tokens))} ${words("新入", "in")} / ${esc(fmtCompactTok(b.cache_read_tokens))} ${words("缓读", "cached")} / ${esc(fmtCompactTok(b.output_tokens))} ${words("出", "out")}${esc(bHit)}</span>
        <span class="telemetry-backend-cost">${esc(bCost)}</span>
      </div>`;
    })
    .join("");

  return `<section class="archive-telemetry-grid" aria-label="${label("peopleCurrentWaveUsage")}">
    <article class="panel-card telemetry-card">
      <header class="telemetry-head">
        <h3>${label("peopleCurrentWaveUsage")}</h3>
        <strong class="telemetry-head-val">${esc(fmtTokExact(u.total_tokens))}</strong>
      </header>
      ${hitPct !== null ? `<div class="telemetry-cache-bar" title="${label("archiveCacheHit")} ${esc(hitPct)}%"><i style="width:${esc(Math.min(100, Math.max(2, hitPct)))}%"></i></div>` : ""}
      <div class="telemetry-kv-list">
        <div class="telemetry-kv-row"><span>${label("archiveCacheHit")}</span><strong>${hitPct !== null ? `${esc(hitPct)}%` : "—"}</strong></div>
        <div class="telemetry-kv-row"><span>${label("archiveUncachedInput")}</span><strong>${esc(fmtTokExact(u.uncached_input_tokens))}</strong></div>
        <div class="telemetry-kv-row"><span>${label("archiveCacheRead")}</span><strong>${esc(fmtTokExact(u.cache_read_tokens))}</strong></div>
        ${u.cache_write_tokens > 0 ? `<div class="telemetry-kv-row"><span>${label("archiveCacheWrite")}</span><strong>${esc(fmtTokExact(u.cache_write_tokens))}</strong></div>` : ""}
        <div class="telemetry-kv-row"><span>${label("archiveOutputTokens")}</span><strong>${esc(fmtTokExact(u.output_tokens))}</strong></div>
        ${u.reasoning_tokens > 0 ? `<div class="telemetry-kv-row"><span>${label("archiveReasoningTokens")}</span><strong>${esc(fmtTokExact(u.reasoning_tokens))}</strong></div>` : ""}
        <div class="telemetry-kv-row"><span>${label("archiveKnownBill")}</span><strong>${u.priced_turns > 0 ? esc(money(u.known_cost_usd)) : "—"}</strong></div>
        ${u.estimated_cost_usd > 0 ? `<div class="telemetry-kv-row"><span>${label("archiveEstBill")}</span><strong class="archive-est-chip" style="padding:1px 6px;border-radius:6px;">≈ ${esc(money(u.estimated_cost_usd))}</strong></div>` : ""}
      </div>
      <p class="telemetry-footnote">${label("archiveEstFootnote")}</p>
    </article>

    <article class="panel-card telemetry-card">
      <header class="telemetry-head">
        <h3>${label("archiveExecStats")}</h3>
        <strong class="telemetry-head-val">${esc(u.turns)} ${label("turns")} · ${esc(u.tool_calls_count)} ${words("次工具", "tools")}</strong>
      </header>
      <div class="telemetry-kv-list">
        <div class="telemetry-kv-row"><span>${label("archiveExecDuration")}</span><strong>${esc(fmtDuration(u.duration_ms))}</strong></div>
        <div class="telemetry-kv-row"><span>${label("archiveAvgTps")}</span><strong>${u.avg_output_tps !== null ? `${esc(u.avg_output_tps)} tok/s` : "—"}</strong></div>
        <div class="telemetry-kv-row"><span>${words("汇总参考花费", "Total / est. spend")}</span><strong>${esc(spendInfo.text)}</strong></div>
        ${accuracyParts.length ? `<div class="telemetry-kv-row"><span>${words("统计口径", "Accuracy")}</span><span>${esc(accuracyParts.join(" · "))}</span></div>` : ""}
      </div>
      ${backendRowsHtml ? `<div class="telemetry-backend-list">${backendRowsHtml}</div>` : `<p class="muted">${label("noRecords")}</p>`}
    </article>
  </section>`;
}

function renderSessionTurnUsageRows(items: readonly SessionTurnUsageItem[]): string {
  if (!items.length) return `<p class="muted">${label("noRecords")}</p>`;
  return `<div class="people-turn-list">${items
    .map((item, idx) => {
      const hitPct = item.cache_hit_rate !== null ? Math.round(item.cache_hit_rate * 100) : null;
      const stMeta = item.status ? turnStatusMeta(item.status) : null;
      const costText =
        item.cost_usd !== null && item.cost_usd !== undefined
          ? `<span class="people-turn-cost">${esc(money(item.cost_usd))}</span>`
          : item.estimated_cost_usd !== null && item.estimated_cost_usd > 0
            ? `<span class="badge archive-est-chip">≈${esc(money(item.estimated_cost_usd))}</span>`
            : `<span class="muted">—</span>`;
      const parts = [
        `${words("新入", "In")} ${fmtTokExact(item.uncached_input_tokens)}`,
        `${words("缓读", "Cache")} ${fmtTokExact(item.cache_read_tokens)}`,
        ...(item.cache_write_tokens > 0 ? [`${words("缓写", "Write")} ${fmtTokExact(item.cache_write_tokens)}`] : []),
        `${words("输出", "Out")} ${fmtTokExact(item.output_tokens)}`,
        ...(item.reasoning_tokens > 0 ? [`${words("推理", "Think")} ${fmtTokExact(item.reasoning_tokens)}`] : []),
      ];
      const accLabel =
        item.accuracy === "exact" ? words("精确", "Exact") : item.accuracy === "hook" ? "Hook" : words("估算", "Est.");
      return `<article class="people-turn-row">
        <header class="people-turn-head">
          <div class="people-turn-who">
            <span class="mono muted">#${esc(items.length - idx)}</span>
            <strong>@${esc(item.worker_name)}</strong>
            <span class="badge"><i class="company-dot" style="--company:${color(item.backend)}"></i>${esc(item.backend)}${item.model ? ` · ${esc(item.model)}` : ""}</span>
            ${stMeta ? `<span class="badge ${esc(stMeta.cls)}">${esc(stMeta.label)}</span>` : ""}
            ${item.trigger_seq ? jump(item.trigger_seq, `#${item.trigger_seq}`) : ""}
          </div>
          <div class="pill-row">
            <time class="muted">${esc(fmtTime(item.created_at))}</time>
            <button type="button" class="link-btn" data-action="open-worker-turn" data-worker="${esc(item.worker_name)}" data-turn="${esc(item.turn_id)}">${label("peopleViewTrace")} ↗</button>
          </div>
        </header>
        ${item.prompt_preview ? `<p class="people-turn-prompt muted" title="${esc(item.prompt_preview)}">${esc(item.prompt_preview)}</p>` : ""}
        <div class="people-turn-metrics">
          <strong>${esc(fmtTokExact(item.total_tokens))}</strong>
          ${hitPct !== null ? `<span class="badge archive-hit-chip">${label("archiveCacheHit")} ${esc(hitPct)}%</span>` : ""}
          <span class="muted mono">${esc(parts.join(" · "))}</span>
          <span class="muted">${esc(fmtDuration(item.duration_ms))} · ${esc(item.tool_calls_count)} ${words("工具", "tools")} · ${accLabel}</span>
          ${costText}
        </div>
      </article>`;
    })
    .join("")}</div>`;
}

export function renderSessionPeople(snap: DashboardSnapshot): string {
  const workers = snap.workers;
  const totals = snap.usage_totals;
  const waveBreakdown = snap.session_usage_breakdown;
  const workerBreakdowns = snap.session_usage_by_worker ?? {};
  const turnUsages = snap.session_turn_usages ?? [];
  const byWorker = new Map(snap.usage_by_worker.map((u) => [u.key, u]));
  const switches = [...(snap.secondment_history ?? [])].sort((a, b) => b.created_at - a.created_at);
  const byCompany = snap.usage_by_backend.filter((usage) => usage.total_tokens > 0);
  const tokens = byCompany.reduce((sum, u) => sum + u.total_tokens, 0);
  const hasWaveTelemetry = Boolean(waveBreakdown && (waveBreakdown.turns > 0 || waveBreakdown.total_tokens > 0));

  return `<div class="tab-scroll-pane people-pane">
    <div class="page-intro"><h2>${label("people")}</h2><p class="muted">${words("会话席位、当前一轮消耗明细与借调记录", "Session seats, current wave usage & reassignments")}</p></div>
    <div class="people-metrics">
      <div class="panel-card metric"><span class="muted">${label("headcount")}</span><strong>${esc(workers.filter((w) => w.state !== "killed").length)}</strong></div>
      <div class="panel-card metric">
        <span class="muted">${label("knownCost")}</span>
        <strong>${esc(!totals.priced_turns || totals.known_cost_usd === undefined ? "—" : money(totals.known_cost_usd))}</strong>
        ${waveBreakdown && waveBreakdown.estimated_cost_usd > 0 ? `<small class="metric-sub archive-est-chip">≈${esc(money(waveBreakdown.estimated_cost_usd))} ${words("参考估算", "est.")}</small>` : ""}
      </div>
      <div class="panel-card metric">
        <span class="muted">${label("unpricedTurns")}</span>
        <strong>${esc(totals.unpriced_turns ?? "—")}</strong>
        ${waveBreakdown && waveBreakdown.cache_hit_rate !== null ? `<small class="metric-sub">${label("archiveCacheHit")} ${esc(Math.round(waveBreakdown.cache_hit_rate * 100))}%</small>` : ""}
      </div>
    </div>
    ${hasWaveTelemetry && waveBreakdown ? renderWaveTelemetryCards(waveBreakdown) : ""}
    <section class="panel-card"><div class="section-head"><h2 class="section-title">${label("people")} · tokens</h2><button type="button" class="btn btn-sm-pad" data-action="go-global-rules">${label("goGlobalRules")}</button></div>
      ${byCompany.length ? `<div class="usage-stack">${byCompany.map((u) => `<span style="--company:${color(u.key)};flex-grow:${esc(u.total_tokens)}" title="${esc(u.key)} · ${esc(u.total_tokens)}"></span>`).join("")}</div>` : ""}
      <div class="pill-row usage-legend">${byCompany.map((u) => `<span><i style="background:${color(u.key)}"></i> ${esc(u.key)} · ${esc(new Intl.NumberFormat(getLanguage(), { style: "percent", maximumFractionDigits: 1 }).format(u.total_tokens / tokens))}</span>`).join("")}</div>
      <div class="compact-staff-list">${workers.map((w) => {
        const u = byWorker.get(w.name) ?? w.usage;
        const wb = workerBreakdowns[w.name];
        const wHitPct = wb?.cache_hit_rate !== null && wb?.cache_hit_rate !== undefined ? Math.round(wb.cache_hit_rate * 100) : null;
        const detailLine = wb && wb.turns > 0
          ? `<small class="staff-usage-detail-line muted mono">${esc(fmtTokExact(wb.total_tokens))}${wHitPct !== null ? ` · ${label("archiveCacheHit")} ${esc(wHitPct)}%` : ""} · ${words("新入", "In")} ${esc(fmtCompactTok(wb.uncached_input_tokens))} / ${words("缓读", "Cache")} ${esc(fmtCompactTok(wb.cache_read_tokens))} / ${words("输出", "Out")} ${esc(fmtCompactTok(wb.output_tokens))}${wb.reasoning_tokens > 0 ? ` / ${words("推理", "Think")} ${esc(fmtCompactTok(wb.reasoning_tokens))}` : ""} · ${esc(fmtDuration(wb.duration_ms))}</small>`
          : "";
        return `<button type="button" class="compact-staff-row" data-action="open-worker-detail" data-worker="${esc(w.name)}">
          ${avatar(w, 42)}<span><strong>@${esc(w.name)}</strong><small>${esc(w.backend)} · ${esc(w.model ?? "CLI")}</small>${detailLine}</span>
          <span class="staff-bill"><small>${esc(u.turns)} ${label("turns")} · ${esc(u.total_tokens)} tokens</small>
          <span>${u.priced_turns ? esc(money(u.known_cost_usd ?? 0)) : ""}${u.unpriced_turns ? ` ${label("unpriced")} (${esc(u.unpriced_turns)})` : !u.priced_turns ? label("noPricing") : ""}</span>
          ${wb && wb.estimated_cost_usd > 0 ? `<small class="archive-est-chip" style="padding:0 5px;border-radius:4px;">≈${esc(money(wb.estimated_cost_usd))}</small>` : ""}
          <small class="muted">${[u.exact_turns && `${words("精确", "Exact")} ${esc(u.exact_turns)}`, u.hook_turns && `Hook ${esc(u.hook_turns)}`, u.estimated_turns && `${words("估算", "Estimated")} ${esc(u.estimated_turns)}`].filter(Boolean).join(" · ")}</small></span>
        </button>`;
      }).join("") || `<p class="muted">${label("noRecords")}</p>`}</div>
    </section>
    ${turnUsages.length > 0 ? `<section class="panel-card"><div class="section-head"><h2 class="section-title">${label("peopleTurnHistory")}</h2><span class="badge">${esc(turnUsages.length)}</span></div>${renderSessionTurnUsageRows(turnUsages)}</section>` : ""}
    <section class="panel-card"><h2 class="section-title">${label("secondments")}</h2>
    <div class="graph-timeline-list">${switches.map((item) => `<div class="graph-timeline-row"><strong>@${esc(item.worker_name)}</strong>
      <span>${esc(item.from_backend)}${item.from_model ? ` · ${esc(item.from_model)}` : ""} → ${esc(item.to_backend)}${item.to_model ? ` · ${esc(item.to_model)}` : ""}</span>
      <span class="badge">${item.auto ? words("自动", "Automatic") : words("手动", "Manual")}</span><time>${date(item.created_at)}</time>${item.seq ? jump(item.seq) : ""}${item.reason ? `<small class="muted">${esc(item.reason)}</small>` : ""}</div>`).join("") || `<p class="muted">${label("noRecords")}</p>`}</div></section>
  </div>`;
}



export interface EmployeeDetailState {
  readOnly: boolean;
  workerDetail: WorkerDetailPayload | null;
  detailViewMode: "chat" | "trace" | "config";
  selectedTurnId: string | null;
  turnEvents: WorkerEvent[];
  chatEventPages: ReadonlyMap<string, ChatEventPage>;
  traceFilter: "all" | "thought" | "tool" | "text" | "error" | "system";
  rawTraceChunks: boolean;
  expandedKeys: ReadonlySet<string>;
  showPatch: boolean;
}

export interface ChatEventPage {
  events: WorkerEvent[];
  loading: boolean;
  complete: boolean;
}

export const CHAT_EVENT_PAGE_SIZE = 500;

const tr = words;

function turnStatusMeta(status: string): { label: string; cls: string } {
  if (status === "completed") return { label: "本轮已结束", cls: "badge-ok" };
  if (status === "running") return { label: "执行中", cls: "badge-info" };
  if (status === "cancelled") return { label: "已取消", cls: "badge-warn" };
  return { label: "失败", cls: "badge-err" };
}

function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtOffsetSec(startTs: number | null | undefined, ts: number): string {
  if (!startTs || ts < startTs) return "";
  const diffMs = ts - startTs;
  return `+${(diffMs / 1000).toFixed(1)}s`;
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function stateLabel(st: string): string {
  if (st === "working") return t("running");
  if (st === "waiting") return t("waiting");
  if (st === "error") return t("error");
  if (st === "stopped") return t("stopped");
  if (st === "killed") return t("killed");
  return st;
}

function roleLabel(role: WorkerRole, capability?: CapabilityTag): string {
  if (capability === "architect") return getLanguage() === "en" ? "Architect" : "架构岗";
  if (role === "author") return getLanguage() === "en" ? "Author" : "实现岗";
  if (role === "verifier") return getLanguage() === "en" ? "Reviewer" : "审校岗";
  if (role === "researcher") return getLanguage() === "en" ? "Researcher" : "调研岗";
  return getLanguage() === "en" ? "Specialist" : "协作岗";
}

function getEventsForTurn(state: EmployeeDetailState, detail: WorkerDetailPayload | null, turn: TurnRecord): WorkerEvent[] {
  if (turn.id === state.selectedTurnId && state.turnEvents.length > 0) {
    return state.turnEvents;
  }
  if (detail?.events_by_turn && Array.isArray(detail.events_by_turn[turn.id])) {
    return detail.events_by_turn[turn.id]!;
  }
  if (detail?.turns[0]?.id === turn.id) {
    return detail.latest_turn_events;
  }
  return [];
}

export function getChatEventsForTurn(state: Pick<EmployeeDetailState, "chatEventPages" | "selectedTurnId" | "turnEvents">, detail: WorkerDetailPayload | null, turn: TurnRecord): WorkerEvent[] {
  const initial = detail?.events_by_turn?.[turn.id] ??
    (detail?.turns[0]?.id === turn.id ? detail.latest_turn_events : []);
  const loaded = state.chatEventPages.get(turn.id)?.events;
  const saved = loaded && loaded.length >= initial.length ? loaded : initial;
  const tail = state.selectedTurnId === turn.id ? state.turnEvents : [];
  const lastSeq = saved.at(-1)?.seq_in_turn ?? 0;
  if (!tail.length || tail[0]!.seq_in_turn > lastSeq + 1 || tail.at(-1)!.seq_in_turn <= lastSeq) return saved;
  return [...saved, ...tail.filter((event) => event.seq_in_turn > lastSeq)];
}

function countDiagnosticIssues(
  detail: WorkerDetailPayload | null,
  currentTurnEvents: WorkerEvent[],
): number {
  const pool =
    currentTurnEvents.length > 0 ? currentTurnEvents : detail?.latest_turn_events ?? [];
  let count = 0;
  for (const ev of pool) {
    if (ev.kind === "error" || (ev.kind === "raw" && ev.title === "stderr")) {
      count += 1;
    }
  }
  if (count === 0 && detail?.turns.some((t) => t.status === "failed")) {
    count = 1;
  }
  return count;
}

function filterCoalescedEvents(state: EmployeeDetailState, events: CoalescedEvent[]): CoalescedEvent[] {
  if (state.traceFilter === "all") return events;
  if (state.traceFilter === "thought") return events.filter((e) => e.kind === "thought");
  if (state.traceFilter === "tool") {
    return events.filter((e) => e.kind === "tool_call" || e.kind === "tool_result");
  }
  if (state.traceFilter === "text") return events.filter((e) => e.kind === "text");
  if (state.traceFilter === "error") {
    return events.filter((e) => e.kind === "error" || (e.kind === "raw" && e.title === "stderr"));
  }
  return events.filter((e) => e.kind === "system" || e.kind === "usage" || e.kind === "raw");
}

function eventHeading(ev: { kind: string; title: string | null }): { cls: string; label: string } {
  if (ev.kind === "thought") return { cls: "event-label-thought", label: "思考" };
  if (ev.kind === "tool_call") {
    return { cls: "event-label-tool_call", label: `工具调用 · ${ev.title || "tool"}` };
  }
  if (ev.kind === "tool_result") {
    return { cls: "event-label-tool_result", label: `工具返回 · ${ev.title || "result"}` };
  }
  if (ev.kind === "error") {
    return { cls: "event-label-error", label: `错误${ev.title ? ` · ${ev.title}` : ""}` };
  }
  if (ev.kind === "usage") {
    return { cls: "event-label-usage", label: ev.title || "用量" };
  }
  if (ev.kind === "text") return { cls: "", label: ev.title || "输出" };
  if (ev.kind === "raw" && ev.title === "stderr") {
    return { cls: "event-label-error", label: "stderr" };
  }
  return { cls: "", label: ev.title ? `${ev.kind} · ${ev.title}` : ev.kind };
}

function renderToolStep(block: Extract<ConversationBlock, { type: "tool" }>, expanded: boolean): string {
  const icon = block.completed
    ? `<span style="color:var(--ok);">✓</span>`
    : `<span style="color:var(--info);">⋯</span>`;
  const summary = summarizeToolStep(block.name, block.input);
  const dur = block.completed && block.endedAt > block.startedAt
    ? ` · ${fmtDuration(block.endedAt - block.startedAt)}`
    : "";
  const formattedIn = expanded && block.input ? formatToolPayload(block.input) : "";
  const formattedOut = expanded && block.output !== null ? formatToolPayload(block.output) : null;
  return `<div class="tool-step">
    <button type="button" class="tool-toggle" data-action="toggle-expand" data-key="${esc(block.key)}" aria-expanded="${expanded}">
      <span class="tool-step-left">
        ${icon}
        <strong>${esc(summary.actionLabel)}</strong>
        ${summary.targetSummary ? `<span class="muted mono">${esc(summary.targetSummary)}</span>` : ""}
      </span>
      <span class="muted" style="flex-shrink:0;">${esc(dur)} ${expanded ? "⌃" : "⌄"}</span>
    </button>
    ${expanded ? `<div class="tool-body">
      ${formattedIn ? `<div class="tool-io-label">输入参数</div><pre class="tool-io-pre">${esc(formattedIn)}</pre>` : ""}
      ${formattedOut !== null ? `<div class="tool-io-label">返回结果</div><pre class="tool-io-pre">${esc(formattedOut)}</pre>` : ""}
    </div>` : ""}
  </div>`;
}

function renderChatBlocks(state: EmployeeDetailState, turn: TurnRecord, blocks: ConversationBlock[]): string {
  type Activity = Extract<ConversationBlock, { type: "tool" | "thought" }>;
  const parts: string[] = [];
  let activity: Activity[] = [];
  const flush = () => {
    if (!activity.length) return;
    const key = `activity:${activity[0]!.key}`;
    const expanded = state.expandedKeys.has(key);
    const toolCount = activity.filter((block) => block.type === "tool").length;
    const title = [
      activity.some((block) => block.type === "thought") ? tr("思考过程", "Thinking") : "",
      toolCount ? `${tr("工具调用", "Tool calls")} ${toolCount}` : "",
    ].filter(Boolean).join(" · ");
    parts.push(`<div class="tool-group">
      <button type="button" class="tool-toggle" data-action="toggle-expand" data-key="${esc(key)}" aria-expanded="${expanded}">
        <strong>${title}</strong>
        <span class="muted" aria-hidden="true">${expanded ? "⌃" : "⌄"}</span>
      </button>
      ${expanded ? `<div class="tool-group-list">${activity.map((block) => block.type === "tool"
        ? renderToolStep(block, state.expandedKeys.has(block.key))
        : `<div class="think-body"><strong class="think-title">${tr("思考过程", "Thinking")}</strong><div>${esc(block.text)}</div></div>`).join("")}</div>` : ""}
    </div>`);
    activity = [];
  };

  for (const block of blocks) {
    if (block.type === "tool" || block.type === "thought") {
      activity.push(block);
      continue;
    }
    flush();
    if (block.type === "error") {
      parts.push(`<div class="chat-error-box">
        <div><strong>${esc(block.title)}:</strong> ${esc(block.text)}</div>
        <div style="margin-top:4px;"><button class="link-btn" data-action="inspect-turn-trace" data-turn="${esc(turn.id)}">去执行流程排查 ↗</button></div>
      </div>`);
      continue;
    }
    const key = `collapse:${block.key}`;
    const expanded = !state.expandedKeys.has(key);
    const action = expanded ? tr("收起文字", "Collapse text") : tr("展开文字", "Expand text");
    parts.push(`<div class="chat-text-block">
      <button type="button" class="link-btn chat-text-toggle" data-action="toggle-expand" data-key="${esc(key)}" aria-expanded="${expanded}" aria-label="${action}">
        ${expanded ? `<span aria-hidden="true">⌃</span>` : `<span>${action} ⌄</span>`}
      </button>
      ${expanded ? `<div class="chat-prose md-body">${renderMarkdown(block.text)}</div>` : ""}
    </div>`);
  }
  flush();
  return parts.join("");
}

function renderChatView(state: EmployeeDetailState, w: WorkerSummary, detail: WorkerDetailPayload | null): string {
  const turns = [...(detail?.turns ?? [])].reverse();
  if (turns.length === 0) {
    return `<div class="chat-feed"><p class="muted empty-inline">${label("noRecords")}</p></div>`;
  }

  const avatar = renderEmployeeAvatarSvg({ backend: w.backend, model: w.model, name: w.name, role: w.role, size: 34 });
  const turnsHtml = turns
    .map((turn, idx) => {
      const turnEvents = getChatEventsForTurn(state, detail, turn);
      const triggerMsg =
        turn.trigger_seq && detail?.trigger_messages
          ? detail.trigger_messages[turn.trigger_seq]
          : undefined;
      const promptInfo = extractTurnPrompt(turn, triggerMsg, w.name);
      const promptKey = `prompt:${turn.id}`;
      const promptLong = promptInfo.body.length > 260;
      const promptExpanded = state.expandedKeys.has(promptKey);
      const shownPrompt =
        promptLong && !promptExpanded
          ? `${promptInfo.body.slice(0, 260)}...`
          : promptInfo.body;

      const page = state.chatEventPages.get(turn.id);
      const moreRecorded = w.latest_turn?.id === turn.id && (w.latest_event?.id ?? 0) > (turnEvents.at(-1)?.id ?? 0);
      const uncached = detail?.turns[0]?.id !== turn.id && !detail?.events_by_turn?.[turn.id];
      const hasMore = moreRecorded || (page ? !page.complete : uncached || turnEvents.length >= CHAT_EVENT_PAGE_SIZE);
      // Don't show a stored final answer before the rest of a partially loaded stream.
      const blocks = buildConversationBlocks(hasMore && turnEvents.length ? { ...turn, output_text: null } : turn, turnEvents);
      const hasErrorBlock = blocks.some((b) => b.type === "error");
      const blocksHtml = renderChatBlocks(state, turn, blocks);
      const loadMoreHtml = hasMore ? `<div>
        <button type="button" class="link-btn" data-action="load-chat-events" data-turn="${esc(turn.id)}" ${page?.loading ? "disabled" : ""}>${page?.loading ? tr("正在加载过程…", "Loading activity…") : tr("加载后续过程", "Load more activity")}</button>
      </div>` : "";

      const fallbackErrorHtml =
        turn.status === "failed" && turn.error_message && !hasErrorBlock
          ? `<div class="chat-error-box">
              <div><strong>失败 (${esc(turn.error_kind)}):</strong> ${esc(turn.error_message)}</div>
              <div style="margin-top:4px;"><button class="link-btn" data-action="inspect-turn-trace" data-turn="${esc(turn.id)}">去执行流程排查 ↗</button></div>
            </div>`
          : "";
      const emptyReplyHtml = !blocksHtml && !fallbackErrorHtml && !loadMoreHtml
        ? `<div class="muted">${turn.status === "running" ? "正在等待模型响应..." : "(本轮无可见文本输出)"}</div>`
        : "";

      const st = turnStatusMeta(turn.status);

      return `<div class="chat-turn">
        <div class="chat-prompt-wrap">
          <div class="chat-prompt-label">任务指令 #${idx + 1} · ${esc(promptInfo.label)} · ${fmtTime(turn.started_at)}</div>
          <div class="chat-prompt-bubble md-body">${renderMarkdown(shownPrompt)}${
            promptLong
              ? `<div style="margin-top:4px;"><button class="link-btn" data-action="toggle-expand" data-key="${esc(promptKey)}">${promptExpanded ? "收起" : "展开全文"}</button></div>`
              : ""
          }</div>
        </div>

        <div class="chat-reply-card">
          <div class="chat-reply-head">
            <span class="chat-reply-who">
              ${avatar}
              <strong>@${esc(w.name)}</strong>
              <span class="model-tag">${esc(turn.model || turn.backend)}</span>
            </span>
            <span class="badge ${st.cls}">${esc(st.label)}</span>
          </div>
          ${blocksHtml || emptyReplyHtml}
          ${loadMoreHtml}
          ${fallbackErrorHtml}
          <div class="turn-footer">
            <span>${turn.status === "running" ? "正在流式执行..." : `耗时 ${fmtDuration(turn.duration_ms)} · 工具调用 ${turn.tool_calls_count}`}</span>
            <button class="link-btn" data-action="inspect-turn-trace" data-turn="${esc(turn.id)}">查看执行流程 ↗</button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  return `<div class="chat-feed">${turnsHtml}</div>`;
}

function renderTraceView(state: EmployeeDetailState, detail: WorkerDetailPayload | null): string {
  const turns = detail?.turns ?? [];
  const currentTurn = turns.find((t) => t.id === state.selectedTurnId) ?? turns[0] ?? null;

  const turnsBar =
    turns.length > 1
      ? `<div class="turns-row">
          ${turns
            .map((t, idx) => {
              const active = currentTurn && t.id === currentTurn.id ? "active" : "";
              return `<button class="turn-chip ${active}" data-action="select-turn" data-turn="${esc(t.id)}">
                #${turns.length - idx} ${esc(t.backend)} (${esc(t.status)})
              </button>`;
            })
            .join("")}
        </div>`
      : "";

  const rawPromptKey = currentTurn ? `rawprompt:${currentTurn.id}` : "rawprompt";
  const rawPromptExpanded = state.expandedKeys.has(rawPromptKey);
  const rawPromptBox = currentTurn
    ? `<div class="raw-prompt-box" style="margin-bottom:8px;">
        <button class="raw-prompt-toggle" data-action="toggle-expand" data-key="${esc(rawPromptKey)}">
          <span>发给 CLI 的原始 Prompt (${currentTurn.prompt_preview.length} 字符)</span>
          <span>${rawPromptExpanded ? "收起 ⌃" : "展开 ⌄"}</span>
        </button>
        ${rawPromptExpanded ? `<pre class="tool-io-pre" style="border:none;border-top:1px solid var(--bd-2);border-radius:0;max-height:220px;">${esc(currentTurn.prompt_preview)}</pre>` : ""}
      </div>`
    : "";

  const rawSourceEvents = currentTurn ? getEventsForTurn(state, detail, currentTurn) : state.turnEvents;
  const displayEvents: CoalescedEvent[] = state.rawTraceChunks
    ? rawSourceEvents.map((ev) => ({
        key: `${ev.turn_id}:raw:${ev.seq_in_turn}`,
        kind: ev.kind,
        title: ev.title,
        content: ev.content,
        firstSeq: ev.seq_in_turn,
        lastSeq: ev.seq_in_turn,
        startedAt: ev.created_at,
        endedAt: ev.created_at,
        chunkCount: 1,
        repeatCount: 1,
      }))
    : coalesceEvents(rawSourceEvents);

  const filtered = filterCoalescedEvents(state, displayEvents);
  const eventsHtml =
    filtered.length === 0
      ? `<div class="muted" style="padding:8px 2px;">${rawSourceEvents.length === 0 ? "暂无实时执行事件。" : "当前过滤条件下暂无事件。"}</div>`
      : filtered
          .map((ev) => {
            const h = eventHeading(ev);
            const seqLabel =
              ev.firstSeq === ev.lastSeq ? `#${ev.firstSeq}` : `#${ev.firstSeq}~#${ev.lastSeq}`;
            const offset = fmtOffsetSec(currentTurn?.started_at, ev.startedAt);
            const countChip =
              ev.chunkCount > 1
                ? `<span class="count-chip">已合并 ${ev.chunkCount} 分片</span>`
                : ev.repeatCount > 1
                  ? `<span class="count-chip">×${ev.repeatCount}</span>`
                  : "";
            const isLong = ev.content.length > 320;
            const expanded = state.expandedKeys.has(ev.key);
            const shownBody = isLong && !expanded ? `${ev.content.slice(0, 320)}...` : ev.content;

            return `<div class="event-row event-${esc(ev.kind)} ${h.cls === "event-label-error" ? "event-negative" : ev.kind === "tool_result" ? "event-positive" : ""}">
              <div class="event-head">
                <span class="${esc(h.cls)}">${esc(seqLabel)} · ${esc(h.label)} ${countChip}</span>
                <span class="trace-meta-right">
                  ${offset ? `<span>${esc(offset)}</span>` : ""}
                  <span>${fmtTime(ev.endedAt)}</span>
                </span>
              </div>
              <div class="event-body">${esc(shownBody)}${
                isLong
                  ? ` <button class="link-btn" data-action="toggle-expand" data-key="${esc(ev.key)}">${expanded ? "收起" : "展开全部"}</button>`
                  : ""
              }</div>
            </div>`;
          })
          .join("");

  return `
    ${turnsBar}
    ${currentTurn ? `<div class="trace-status ${turnStatusMeta(currentTurn.status).cls}"><strong>${esc(turnStatusMeta(currentTurn.status).label)}</strong><span>${esc(currentTurn.error_message || `${fmtDuration(currentTurn.duration_ms)} · ${currentTurn.tool_calls_count} tools`)}</span></div>` : ""}
    ${rawPromptBox}
    <div class="trace-feed">${eventsHtml}</div>
  `;
}

export function renderEmployeeDetail(state: EmployeeDetailState, w: WorkerSummary, snap: DashboardSnapshot): string {
  const detail = state.workerDetail?.worker.name === w.name ? state.workerDetail : null;
  const model = w.model || snap.effective_defaults[w.backend]?.model || "CLI";
  const effort = w.effort || snap.effective_defaults[w.backend]?.effort || "—";
  const disabled = state.readOnly || w.state === "killed" ? "disabled" : "";
  const statusGroup = workerStatusGroup(w, snap);
  const issues = countDiagnosticIssues(detail, state.turnEvents);
  const tab = (mode: EmployeeDetailState["detailViewMode"], key: string) => `<button type="button" class="nav-tab ${state.detailViewMode === mode ? "active" : ""}" data-action="set-detail-mode" data-mode="${esc(mode)}">${esc(t(key))}${mode === "trace" && issues ? ` <span class="err-count-dot">${esc(issues)}</span>` : ""}</button>`;
  const diff = detail?.diff;
  const changedFiles = [...new Set([...(diff?.files ?? []), ...(diff?.dirty_files ?? [])])];
  const metaRows = [
    [tr("外包公司", "Vendor"), w.backend], ["Model", model], ["Effort", effort],
    [tr("岗位", "Role"), roleLabel(w.role, w.capability)],
    [tr("工位分支", "Seat branch"), w.worktree_branch ?? w.workspace_mode],
    [tr("配置来源", "Policy source"), policyLayerShortLabel(w.policy_source)],
  ];
  const summary = diff ? diffCounts(diff) : null;
  const diffStats = summary ? `<span class="diff-add">+${summary.added}</span><span class="diff-del">−${summary.removed}</span>` : "";
  const files = changedFiles.map((file) => `<button type="button" class="file-chip" data-action="open-file" data-file="${esc(file)}" data-ws="${esc(w.workspace_path)}">${esc(file)} ↗</button>`).join("");
  const config = `<div class="employee-config"><section class="panel-card"><dl class="detail-kv">${metaRows.map(([key, val]) => `<div><dt>${key}</dt><dd>${esc(val)}</dd></div>`).join("")}</dl></section>
    <section class="panel-card"><div class="section-head"><strong>Diff ${diffStats}</strong>${diff?.dirty !== undefined ? `<span class="badge ${diff.dirty ? "badge-warn" : "badge-ok"}">${esc(t(diff.dirty ? "dirty" : "clean"))}</span>` : ""}</div>
    ${diff ? `<div class="mono">HEAD ${esc(diff.head_sha ?? "—")}</div><div class="mono">${esc(diff.branch ?? "—")} → ${esc(diff.target_branch ?? "—")}</div><div class="file-chip-list">${files}</div>
      ${diff.patch_preview ? `<button type="button" class="btn btn-sm-pad" data-action="toggle-patch">${state.showPatch ? tr("收起 Patch", "Hide patch") : tr("查看 Patch", "Show patch")}</button>` : ""}
      ${state.showPatch && diff.patch_preview ? `${renderPatch(diff.patch_preview)}${diff.truncated ? `<span class="muted">${tr("预览已截断", "Preview truncated")}</span>` : ""}` : ""}` : `<p class="muted">${tr("暂无独立工位 Diff", "No separate worktree diff")}</p>`}</section></div>`;
  return `<section class="panel-card employee-detail" aria-label="${esc(w.name)}">
    <button type="button" class="link-btn detail-back" data-action="close-worker-detail">${esc(t("backWorkbench"))}</button>
    <header class="employee-detail-head">${renderEmployeeAvatarSvg({ backend: w.backend, model, name: w.name, role: w.role, size: 60, animated: getPreferences().animatedAvatars })}
      <div><strong>@${esc(w.name)}</strong> <span class="status-badge status-${statusGroup}">${esc(stateLabel(w.state))}</span>
      <div class="muted">${esc(roleLabel(w.role, w.capability))} · ${esc(w.backend)} · ${esc(model)} · ${esc(effort)}</div></div>
    </header>
    <div class="detail-actions">${([["follow-up","followUp"],["open-switch","reassign"],["kill","release"],["cancel","interrupt"]] as const).map(([action,key]) => `<button type="button" class="btn btn-sm-pad" data-action="${action}" data-worker="${esc(w.name)}" ${disabled || (action === "cancel" && w.state !== "working" ? "disabled" : "")}>${esc(t(key))}</button>`).join("")}</div>
    <nav class="top-nav">${tab("chat", "conversation")}${tab("trace", "trace")}${tab("config", "configDiff")}</nav>
    ${state.detailViewMode === "config" ? config : state.detailViewMode === "trace" ? renderTraceView(state, detail) : `
      ${renderChatView(state, w, detail)}
      ${diff && changedFiles.length ? `<div class="detail-files"><div class="section-head"><strong>${tr("代码变更", "Code changes")} · ${changedFiles.length} <span class="pill-row">${diffStats}</span></strong><button type="button" class="btn btn-sm-pad" data-action="show-worker-diff">${tr("查看 Diff", "View Diff")} ›</button></div><div class="file-chip-list">${files}</div></div>` : ""}
      <div class="composer"><textarea id="chat-reply-input" class="input-sm composer-textarea" rows="1" placeholder="${tr("追加指令…", "Follow-up instruction…")}" ${disabled}></textarea>
      <button type="button" class="btn btn-primary" data-action="send-worker-chat" data-worker="${esc(w.name)}" ${disabled}>${esc(t("send"))}</button></div>`}
  </section>`;
}


function roundTitle(title: string): string {
  return title.replace(/^(?:wave\s+\d+|第\s*\d+\s*轮)\s*[:：·–—-]\s*(?=\S)/i, "");
}

function roundNumber(wave: SwarmRecord): string {
  return wave.wave_index == null ? words("轮次", "Wave") : words(`第 ${wave.wave_index} 轮`, `Wave ${wave.wave_index}`);
}

function teamDisplayName(team: TeamRecord, waves: readonly SwarmRecord[]): string {
  // Older teams used the first wave's title as their default name.
  if (waves.length > 1 && waves.some((wave) => wave.wave_index === 1 && wave.title === team.name)) {
    return team.repo_root.split("/").filter(Boolean).at(-1) || team.name;
  }
  return team.name;
}

export function renderTeamSwitcher(snap: DashboardSnapshot, selectedTeamId: string | null, busy: boolean): string {
  const summary = snap.teams?.find(({ team }) => team.id === selectedTeamId);
  const selected = snap.team ?? summary?.team;
  const wave = snap.swarm;
  const name = selected ? teamDisplayName(selected, snap.team_waves?.length ? snap.team_waves : summary?.waves ?? []) : wave?.title ?? t("notCreated");
  return `<button type="button" class="team-switcher" data-action="toggle-team-drawer" aria-haspopup="dialog" aria-label="${label("switchTeam")}" title="${esc(name)}${wave && selected ? ` / ${roundNumber(wave)} · ${esc(roundTitle(wave.title))}` : ""}" ${busy ? "disabled" : ""}>
    <span class="team-marker" aria-hidden="true">◈</span><span class="team-switcher-name">${esc(name)}</span>${wave && selected ? `<span class="team-switcher-wave">${roundNumber(wave)}</span>` : ""}<span aria-hidden="true">⌄</span>
  </button>`;
}

export function renderTeamSummaryPreview(snap: DashboardSnapshot, opts: { history: boolean; canManage: boolean; busy: boolean }): string {
  const { team, swarm: current } = snap;
  if (!team) return "";
  const summary = snap.teams?.find((entry) => entry.team.id === team.id);
  const waves = snap.team_waves?.length ? snap.team_waves : summary?.waves?.length ? summary.waves : current ? [current] : [];
  const otherWaves = waves.filter((wave) => wave.id !== current?.id);
  const name = teamDisplayName(team, waves);
  const waveSeatCounts = waves.map((wave) => snap.swarm_summaries?.[wave.id]?.worker_count);
  const seatAssignments = summary?.worker_count ??
    (waveSeatCounts.length && waveSeatCounts.every((count) => count !== undefined)
      ? waveSeatCounts.reduce((total, count) => total + count, 0) : undefined);
  const status = (wave: SwarmRecord) => wave.status === "active" ? words("进行中", "In progress") : label(wave.status);
  const disabled = opts.busy ? "disabled" : "";
  return `<section class="team-current" aria-labelledby="team-current-title">
    <header><p class="team-kicker">${opts.history ? words("正在回看", "Viewing history") : words("当前团队", "Current team")}</p>
      <h3 id="team-current-title" title="${esc(team.name)}">${esc(name)}</h3>
      ${team.goal ? `<p class="muted team-current-goal">${esc(team.goal)}</p>` : ""}</header>
    <div class="team-current-wave">
      ${current ? `<div><span class="team-kicker">${roundNumber(current)}</span><strong title="${esc(current.title)}">${esc(roundTitle(current.title))}</strong></div>
      <span class="badge ${current.status === "active" ? "badge-info" : current.status === "done" ? "badge-ok" : ""}">${status(current)}</span>`
      : `<span class="muted">${words("尚未开启轮次", "No wave yet")}</span>`}
    </div>
    <div class="team-current-stats">
      ${current ? `<span>${opts.history ? words("该轮", "This wave") : words("本轮", "This wave")} <b>${esc(snap.workers.length)}</b> ${words("席", "seats")}</span>` : ""}
      <span><b>${esc(waves.length)}</b> ${words("轮", "waves")}</span>
      ${seatAssignments !== undefined ? `<span>${words("历史累计", "All waves")} <b>${esc(seatAssignments)}</b> ${words("席次", "seat assignments")}</span>` : ""}
    </div>
    ${opts.canManage ? `<details class="team-inline-form"><summary>${words("新开一轮", "Start a new wave")}</summary>
      <form id="team-new-wave-form" data-team-id="${esc(team.id)}">
        <label for="team-wave-title">${words("新轮次名称", "New wave name")}</label>
        <p class="muted">${words("沿用当前团队，保留旧轮记录。新一轮不会自动派发成员。", "Keep this team and its history. Starting a new wave does not dispatch workers.")}</p>
        <input class="input-sm" id="team-wave-title" required maxlength="120" placeholder="${words("例如：生产验收复核", "e.g. Production validation follow-up")}" ${disabled}>
        <button type="submit" class="btn btn-sm-pad btn-primary" ${disabled}>${words("创建轮次", "Create wave")}</button>
      </form>
    </details>
    <details class="team-inline-form"><summary>${words("重命名团队", "Rename team")}</summary>
      <form id="team-rename-form" data-team-id="${esc(team.id)}">
        <label for="team-name-input">${words("团队名称", "Team name")}</label>
        <input class="input-sm" id="team-name-input" required maxlength="120" value="${esc(name)}" ${disabled}>
        <button type="submit" class="btn btn-sm-pad" ${disabled}>${words("保存名称", "Save name")}</button>
      </form>
    </details>` : ""}
  </section>
  ${otherWaves.length ? `<section class="team-wave-list" aria-labelledby="team-waves-title">
    <h3 id="team-waves-title">${words("本团队的其他轮次", "Other waves in this team")}</h3>
    ${otherWaves.map((wave) => `<div class="team-wave-row">
      <div><span class="team-kicker">${roundNumber(wave)} · ${status(wave)}</span><strong title="${esc(wave.title)}">${esc(roundTitle(wave.title))}</strong></div>
      <div class="pill-row"><button type="button" class="btn btn-sm-pad" data-action="open-history-swarm" data-swarm-id="${esc(wave.id)}" data-team-id="${esc(team.id)}">${words("只读回看", "View history")}</button>
      ${wave.status === "active" && opts.canManage ? `<button type="button" class="btn btn-sm-pad" data-action="attach-team" data-swarm-id="${esc(wave.id)}" data-team-id="${esc(team.id)}" ${disabled}>${words("切到此轮", "Switch to wave")}</button>` : ""}</div>
    </div>`).join("")}</section>` : ""}`;
}

/** Project only hunk lines into old/new line numbers; file metadata has no line number. */
export function parsePatchLines(patch: string): Array<{ text: string; oldLine?: number; newLine?: number; kind: "add" | "del" | "context" | "meta" }> {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  return patch.trimEnd().split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      return { text, kind: "meta" };
    }
    if (oldRemaining > 0 && text.startsWith("-")) {
      oldRemaining--;
      return { text, oldLine: oldLine++, kind: "del" };
    }
    if (newRemaining > 0 && text.startsWith("+")) {
      newRemaining--;
      return { text, newLine: newLine++, kind: "add" };
    }
    if (oldRemaining > 0 && newRemaining > 0 && text.startsWith(" ")) {
      oldRemaining--; newRemaining--;
      return { text, oldLine: oldLine++, newLine: newLine++, kind: "context" };
    }
    return { text, kind: "meta" };
  });
}

function renderPatch(patch: string): string {
  return `<div class="diff-box" tabindex="0" aria-label="Git patch"><div class="diff-lines">${parsePatchLines(patch).map((line) =>
    `<div class="diff-line diff-${line.kind}"><span>${line.oldLine ?? ""}</span><span>${line.newLine ?? ""}</span><code>${esc(line.text)}</code></div>`,
  ).join("")}</div></div>`;
}

function diffCounts(diff: WorkspaceDiffResult): { added: number; removed: number } | null {
  const summary = [...diff.stat.matchAll(/(\d+) (insertion|deletion)s?\([+-]\)/g)];
  if (summary.length) return summary.reduce((totals, [, count, kind]) => {
    if (kind === "insertion") totals.added += Number(count);
    else totals.removed += Number(count);
    return totals;
  }, { added: 0, removed: 0 });
  if (diff.truncated || !diff.patch_preview) return null;
  const lines = parsePatchLines(diff.patch_preview);
  return { added: lines.filter((line) => line.kind === "add").length, removed: lines.filter((line) => line.kind === "del").length };
}
