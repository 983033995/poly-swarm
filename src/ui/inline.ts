import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import type { DashboardSnapshot, UiFocusState, UiPreferencesRecord, WorkerDetailPayload, WorkerSummary } from "../shared/types.js";
import { renderBrandLogoSvg, renderEmployeeAvatarSvg } from "./avatars_3d.js";
import { readBrowserWorkbench } from "./browser_workbench.js";
import { applyPreferences, getLanguage, getPreferences, hydratePreferences, t } from "./i18n.js";
import { esc, renderMarkdown } from "./markdown.js";
import { coalesceEvents } from "./trace_model.js";

type InlineSnapshot = DashboardSnapshot & { workbench_url?: string };
declare const __POLY_SWARM_EMBED_WORKBENCH__: boolean;

let app: App | null = null;
let hostTheme: "light" | "dark" | undefined;
let snapshot: DashboardSnapshot | null = null;
let swarmId: string | null = null;
let selected: string | null = null;
let expanded: string | null = null;
let detail: WorkerDetailPayload | null = null;
let detailRequest = 0;
let collapsed = false;
let userToggledCollapse = false;
let inlineMode: "dispatch" | "recap" = "dispatch";
let showGuide = false;
let workbenchUrl: string | null = null;
let showWorkbenchLink = false;
let expandFailed = false;
let hostFullscreen = false;
let displayedSwarm: string | null = null;
let sidebarBusy = false;
let lastFocusSeq = 0;
let error = "";
let previousMarkup = "";
let preferenceBusy = false;

const label = (key: string) => esc(t(key));
const words = (zh: string, en: string) => esc(getLanguage() === "en" ? en : zh);
const compact = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const statusKeys = { working: "running", waiting: "idle", error: "error", stopped: "stopped", killed: "killed" };

function cost(usage: DashboardSnapshot["usage_totals"]): string {
  const known = usage.known_cost_usd;
  return [
    usage.priced_turns && known !== undefined ? `${label("knownCost")} $${esc(known.toFixed(known > 0 && known < 0.01 ? 4 : 2))}` : label("noPricing"),
    usage.unpriced_turns ? `${label("unpricedTurns")}: ${esc(usage.unpriced_turns)}` : "",
  ].filter(Boolean).join(" · ");
}

async function toggleLanguage(): Promise<void> {
  if (preferenceBusy) return;
  preferenceBusy = true;
  render();
  try {
    const patch = { language: getLanguage() === "en" ? "zh-CN" : "en" };
    const result = await call<{ ui_preferences: UiPreferencesRecord }>(
      "app_preferences", { op: "set", patch }, "/api/preferences", "POST", { patch },
    );
    hydratePreferences(result.ui_preferences);
    applyPreferences(hostTheme);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    preferenceBusy = false;
    render();
  }
}

function elapsed(w: WorkerSummary): string {
  const ms = w.latest_turn?.started_at ? Date.now() - w.latest_turn.started_at : 0;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

async function call<T>(
  name: string,
  args: Record<string, unknown>,
  url: string,
  method: "GET" | "POST" = "GET",
  httpBody?: unknown,
): Promise<T> {
  if (app) {
    const result = await app.callServerTool({ name, arguments: args });
    if (!result.isError && result.structuredContent) return result.structuredContent as T;
    const message = result.content.find((item) => item.type === "text")?.text;
    throw new Error(message ?? `Tool ${name} failed`);
  }
  const response = await fetch(url, {
    method, ...(method === "POST" ? {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(httpBody ?? args),
    } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function bindSwarm(id: string | null): void {
  if (swarmId === id) return;
  swarmId = id;
  snapshot = null;
  selected = expanded = null;
  detail = null;
  ++detailRequest;
  lastFocusSeq = 0;
  userToggledCollapse = false;
  showGuide = showWorkbenchLink = expandFailed = false;
  workbenchUrl = null;
  error = "";
}

function applySnapshot(snap: InlineSnapshot): void {
  if (snap.swarm) bindSwarm(snap.swarm.id);
  if (snap.workbench_url) {
    try {
      const url = new URL(snap.workbench_url);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password &&
          url.pathname === "/codex" && url.searchParams.get("swarm_id") === swarmId) {
        workbenchUrl = url.href;
      }
    } catch {
      // Host guidance remains available if there is no usable local workbench URL.
    }
  }
  snapshot = snap;
  if (snap.ui_preferences && !preferenceBusy) {
    hydratePreferences(snap.ui_preferences);
    applyPreferences(hostTheme);
  }
  const focus = snap.ui_focus;
  if (swarmId && focus?.swarm_id === swarmId && focus.seq > lastFocusSeq) {
    lastFocusSeq = focus.seq;
    if (focus.worker_name && snap.workers.some((w) => w.name === focus.worker_name)) selected = focus.worker_name;
  }
  if (!snap.workers.some((w) => w.name === selected)) selected = snap.workers[0]?.name ?? null;
  if (expanded && !snap.workers.some((w) => w.name === expanded)) {
    expanded = null;
    detail = null;
    ++detailRequest;
  }
}

async function refresh(): Promise<void> {
  if (preferenceBusy) return;
  const id = swarmId;
  const query = new URLSearchParams({ surface: "inline", ...(id ? { swarm_id: id } : {}) });
  const next = await call<InlineSnapshot>("app_get_dashboard", {
    surface: "inline", ...(id ? { swarm_id: id } : {}),
  }, `/api/dashboard?${query}`);
  if (id !== swarmId) return;
  const worker = next.workers.find((w) => w.name === expanded);
  const oldWorker = snapshot?.workers.find((w) => w.name === expanded);
  if (!snapshot) error = "";
  applySnapshot(next);
  render();
  if (id && worker && (worker.latest_turn?.id !== oldWorker?.latest_turn?.id || worker.latest_event?.id !== oldWorker?.latest_event?.id)) {
    await loadDetail(id, worker.name);
  }
}

async function loadDetail(id: string, name: string): Promise<void> {
  const request = ++detailRequest;
  const query = new URLSearchParams({ swarm_id: id, name });
  try {
    const next = await call<WorkerDetailPayload>("app_get_worker_detail", { swarm_id: id, name }, `/api/worker?${query}`);
    if (request !== detailRequest) return;
    detail = next;
  } catch (err) {
    if (request !== detailRequest) return;
    error = err instanceof Error ? err.message : String(err);
  }
  render();
}

function toggleWorker(name: string): void {
  if (!swarmId) return;
  selected = name;
  expanded = expanded === name ? null : name;
  detail = null;
  error = "";
  ++detailRequest;
  render();
  if (expanded) void loadDetail(swarmId, expanded);
}

async function openSidebar(): Promise<void> {
  const id = swarmId;
  if (!id || showGuide && !snapshot?.ui_focus?.workbench_alive) {
    showGuide = !showGuide;
    render();
    return;
  }
  if (sidebarBusy) return;
  sidebarBusy = true;
  error = "";
  try {
    const focus = await call<UiFocusState>("app_focus_worker", {
      swarm_id: id, ...(selected ? { worker_name: selected } : {}), tab: "detail",
    }, "/api/focus", "POST");
    if (id !== swarmId) return;
    lastFocusSeq = Math.max(lastFocusSeq, focus.seq);
    showGuide = !focus.workbench_alive;
    if (snapshot) snapshot = { ...snapshot, ui_focus: focus };
  } catch (err) {
    if (id === swarmId) error = err instanceof Error ? err.message : String(err);
  } finally {
    sidebarBusy = false;
    render();
  }
}

function canOpenWorkbench(): boolean {
  return __POLY_SWARM_EMBED_WORKBENCH__
    ? app?.getHostContext()?.availableDisplayModes?.includes("fullscreen") === true
    : Boolean(app?.getHostCapabilities()?.openLinks);
}

function syncWorkbenchDisplay(): void {
  const id = app && workbenchUrl && hostFullscreen ? swarmId : null;
  if (id === displayedSwarm) return;
  const inline = document.getElementById("root");
  const workbench = document.getElementById("inline-workbench");
  const inlineStyle = document.querySelector<HTMLStyleElement>("#inline-style");
  const workbenchStyle = document.querySelector<HTMLStyleElement>("#workbench-style");
  if (!inline || !workbench || !inlineStyle || !workbenchStyle) return;
  displayedSwarm = id;
  inline.hidden = Boolean(id);
  workbench.hidden = !id;
  inlineStyle.media = id ? "not all" : "all";
  workbenchStyle.media = id ? "all" : "not all";
  const client = app;
  if (client && id) {
    void import("./app.js").then(({ openEmbeddedWorkbench, reportDashboardError }) => {
      if (displayedSwarm === id) {
        void openEmbeddedWorkbench({ app: client, rootId: workbench.id, swarmId: id }).catch(reportDashboardError);
      }
    }).catch((err: unknown) => {
      workbench.textContent = String(err);
    });
  }
}

async function openWorkbench(): Promise<void> {
  if (!app || !workbenchUrl || sidebarBusy) return;
  if (!canOpenWorkbench()) {
    showWorkbenchLink = true;
    render();
    document.getElementById("inline-workbench-url")?.focus();
    return;
  }
  const id = swarmId;
  sidebarBusy = true;
  render();
  try {
    if (__POLY_SWARM_EMBED_WORKBENCH__) {
      const result = await app.requestDisplayMode({ mode: "fullscreen" }, { timeout: 5000 });
      if (id === swarmId) {
        hostFullscreen = result.mode === "fullscreen";
        expandFailed = !hostFullscreen;
      }
    } else {
      const result = await app.openLink({ url: workbenchUrl }, { timeout: 5000 });
      if (id === swarmId) expandFailed = result.isError === true;
    }
  } catch {
    if (id === swarmId) expandFailed = true;
  } finally {
    if (id === swarmId && expandFailed) showWorkbenchLink = true;
    sidebarBusy = false;
    render();
  }
}

function renderBack(w: WorkerSummary): string {
  const turn = detail?.turns[0] ?? w.latest_turn;
  const output = turn?.output_text?.trim();
  const err = w.last_error || turn?.error_message;
  const events = coalesceEvents(detail?.latest_turn_events ?? [])
    .filter((ev) => ["thought", "tool_call", "tool_result", "error"].includes(ev.kind)).slice(-4);
  return `<div class="badge-back">
    <div class="badge-meta"><span>${esc(w.workspace_mode)}${w.worktree_branch ? ` · ${esc(w.worktree_branch)}` : ""}</span>
      <span>${esc(compact(w.usage.total_tokens))} tokens · ${cost(w.usage)}</span></div>
    ${err ? `<div class="inline-error">${esc(err.slice(0, 480))}</div>` : ""}
    ${output ? `<div class="drawer-output md-body">${renderMarkdown(output.length > 520 ? `${output.slice(0, 520)}…` : output)}</div>` : ""}
    ${events.map((ev) => `<div class="drawer-event">${esc(ev.title ?? ev.kind)} · ${esc(ev.content.replace(/\s+/g, " ").slice(0, 140))}</div>`).join("")}
    ${!detail && !error ? `<div class="badge-meta">${words("正在加载工牌详情…", "Loading badge details…")}</div>` : ""}
    ${detail && !err && !output && !events.length ? `<div class="badge-meta">${label("noRecords")}</div>` : ""}
  </div>`;
}

function renderWorker(w: WorkerSummary, snap: DashboardSnapshot): string {
  const defaults = snap.effective_defaults?.[w.backend];
  const model = w.model || defaults?.model || "CLI";
  const effort = w.effort || defaults?.effort;
  const isOpen = expanded === w.name;
  const isActive = selected === w.name;
  const cooling = (snap.backends.find((b) => b.backend === w.backend)?.cooldown_until ?? 0) > Date.now();
  return `<div class="node-group ${isOpen ? "is-open" : ""}">
    <button type="button" class="node-row${isActive ? " active" : ""}" data-action="worker" data-worker="${esc(w.name)}" aria-expanded="${isOpen}">
      ${renderEmployeeAvatarSvg({ backend: w.backend, model, name: w.name, role: w.role, size: 36, animated: getPreferences().animatedAvatars })}
      <span class="node-copy"><span class="node-title"><strong>@${esc(w.name)}</strong>${w.needs_handoff ? `<span class="node-state st-warn">${label("reassigning")}</span>` : ""}</span>
        <span class="node-model" title="${esc(model)}">${esc(w.identity_id ?? w.role)} · ${esc(w.backend)} · ${esc(model)}${effort ? ` / ${esc(effort)}` : ""}</span></span>
      <span class="node-state st-${cooling ? "warn" : esc(w.state)}">${label(cooling ? "cooling" : statusKeys[w.state])}${w.state === "working" ? ` <span data-elapsed="${esc(w.name)}"></span>` : ""}</span>
      <span aria-hidden="true">${isOpen ? "⌃" : "›"}</span>
    </button>
    ${isOpen ? renderBack(w) : ""}
  </div>`;
}

function tickElapsed(): void {
  const workers = new Map(snapshot?.workers.map((w) => [w.name, w]));
  document.querySelectorAll<HTMLElement>("[data-elapsed]").forEach((el) => {
    const worker = workers.get(el.dataset.elapsed ?? "");
    if (worker) el.textContent = elapsed(worker);
  });
}

function pillMetaText(workers: WorkerSummary[], snap: DashboardSnapshot | null): string {
  const workingCount = workers.filter((w) => w.state === "working").length;
  if (workingCount > 0) return `${esc(workingCount)} ${words("运行中", "running")}`;
  if (snap?.swarm?.status === "done") return words("已完成", "completed");
  return `${esc(compact(snap?.usage_totals.total_tokens ?? 0))} tokens`;
}

function renderCollapsedPill(
  workers: WorkerSummary[],
  snap: DashboardSnapshot | null,
  sidebarHtml: string,
): string {
  const extraCount = Math.max(0, workers.length - 4);
  const stack = workers
    .slice(0, 4)
    .map((w) =>
      renderEmployeeAvatarSvg({
        backend: w.backend,
        model: w.model,
        name: w.name,
        role: w.role,
        size: 24,
        animated: false,
      }),
    )
    .join("");
  return `<div class="team-pill-bar${inlineMode === "recap" ? " is-recap" : ""}">
    <button type="button" class="team-pill-toggle" data-action="collapse" aria-expanded="false">
      <span class="pill-avatar-stack" aria-hidden="true">${stack}${extraCount > 0 ? `<span class="pill-avatar-more">+${esc(extraCount)}</span>` : ""}</span>
      <span class="pill-count">${esc(workers.length)} ${words("位团队成员", "team members")}</span>
      <span class="pill-meta">${pillMetaText(workers, snap)}</span>
      <span class="pill-chevron" aria-hidden="true">⌄</span>
    </button>
    ${sidebarHtml ? `<div class="pill-actions">${sidebarHtml}</div>` : ""}
  </div>`;
}

function render(): void {
  if (__POLY_SWARM_EMBED_WORKBENCH__) syncWorkbenchDisplay();
  const root = document.getElementById("root");
  if (!root) return;
  const snap = snapshot;
  const workers = snap?.workers ?? [];
  const alive = snap?.ui_focus?.workbench_alive === true;
  const link = workbenchUrl ?? (!app && swarmId ? `/codex?swarm_id=${encodeURIComponent(swarmId)}` : null);
  const openLabel = words("打开工作台", "Open workbench");
  const linkHtml = link ? `<a class="inline-btn" href="${esc(link)}" target="_blank" rel="noopener">${openLabel} ↗</a>` : "";
  const sidebar = link
    ? app
      ? `<button type="button" data-action="open-workbench" class="inline-btn" aria-expanded="${showWorkbenchLink}" ${sidebarBusy ? "disabled" : ""}>${canOpenWorkbench() ? `${openLabel} ↗` : words("查看工作台链接", "Show workbench link")}</button>`
      : linkHtml
    : app ? `<button type="button" data-action="sidebar" class="inline-btn" ${alive ? "" : `aria-expanded="${showGuide}"`}>${alive ? words("定位已打开的侧栏", "Focus open sidebar") : words("侧栏打开指引", "Sidebar help")}</button>` : "";
  const guide = app && link && showWorkbenchLink
    ? `<div class="inline-notice">
      ${expandFailed ? words("宿主未能展开工作台。", "The host could not expand the workbench.") : ""}
      <label for="inline-workbench-url">${words("可复制此工作组链接；如需在 Codex 右侧查看，请在聊天中发送「在右侧打开这个工作台」并附上链接。", "Copy this team's link. To view it on the right in Codex, ask the chat to open the workbench on the right and include the link.")}</label>
      <input id="inline-workbench-url" class="inline-workbench-url" type="url" value="${esc(link)}" readonly>
    </div>`
    : !link && app && showGuide && !alive
      ? `<p class="inline-notice">${words("请使用宿主卡片的 Open in side pane，或从侧栏 + → Poly Swarm 打开。", "Choose Open in side pane on the host card, or use + → Poly Swarm in the sidebar.")}</p>` : "";
  const markup = collapsed && workers.length
    ? `${renderCollapsedPill(workers, snap, sidebar)}
      ${guide}
      ${error ? `<p class="inline-error" role="alert">${esc(error)}</p>` : ""}`
    : `<header class="inline-header">
    <div class="badge-brand">${renderBrandLogoSvg(26)}<div><strong>${esc(snap?.swarm?.title ?? "Poly Swarm")}</strong>
      <div class="badge-meta">${snap?.swarm ? `${esc(workers.length)} ${words("席位", "seats")} · ${esc(compact(snap.usage_totals.total_tokens))} tokens · ${cost(snap.usage_totals)}` : label(snap ? "noProject" : "inlineLoading")}</div></div></div>
    <div class="inline-tools">${sidebar}<button type="button" class="inline-btn" data-action="language" ${preferenceBusy ? "disabled" : ""} aria-label="${label("language")}">${getLanguage() === "en" ? "EN / 中" : "中 / EN"}</button>
      ${workers.length ? `<button type="button" class="inline-btn" data-action="collapse" aria-expanded="true">${words("收起成员 ⌃", "Hide team ⌃")}</button>` : ""}</div></header>
    ${guide}
    ${workers.length && snap ? `<div class="nodes-card">${workers.map((w) => renderWorker(w, snap)).join("")}</div>` : ""}
    ${error ? `<p class="inline-error" role="alert">${esc(error)}</p>` : ""}`;
  if (markup === previousMarkup) return;
  const active = document.activeElement instanceof HTMLButtonElement && root.contains(document.activeElement) ? document.activeElement.dataset : null;
  const restoreAction = active?.action;
  const restoreWorker = active?.worker;
  previousMarkup = markup;
  root.innerHTML = markup;
  if (restoreAction) [...root.querySelectorAll<HTMLButtonElement>("button[data-action]")]
    .find((btn) => btn.dataset.action === restoreAction && btn.dataset.worker === restoreWorker)?.focus({ preventScroll: true });
  tickElapsed();
}

async function loadSnapshot(): Promise<void> {
  try {
    await refresh();
  } catch (err) {
    if (!snapshot) {
      error = err instanceof Error ? err.message : String(err);
      render();
    }
  }
}

function schedulePoll(): void {
  const intervalMs = snapshot?.workers.some((w) => w.state === "working")
    ? 1500
    : snapshot?.swarm?.status === "done" || snapshot?.swarm?.status === "archived"
      ? 15000
      : 4000;
  window.setTimeout(async () => {
    if (!displayedSwarm) await loadSnapshot();
    schedulePoll();
  }, intervalMs);
}

async function main(): Promise<void> {
  const browser = readBrowserWorkbench();
  const query = new URLSearchParams(window.location.search);
  if (query.get("collapsed") === "1" || query.get("mode") === "recap") {
    collapsed = true;
    inlineMode = "recap";
  }
  bindSwarm(browser.swarmId);
  const root = document.getElementById("root");
  root?.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.id === "inline-workbench-url") event.target.select();
  });
  root?.addEventListener("click", (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "worker" && btn.dataset.worker) toggleWorker(btn.dataset.worker);
    if (btn.dataset.action === "sidebar") void openSidebar();
    if (btn.dataset.action === "open-workbench") void openWorkbench();
    if (btn.dataset.action === "collapse") {
      userToggledCollapse = true;
      collapsed = !collapsed;
      render();
    }
    if (btn.dataset.action === "language") void toggleLanguage();
  });
  const frame = browser.isMcp ? null : window.frameElement as HTMLElement | null;
  if (frame && root) new ResizeObserver(() => {
    frame.style.height = `min(230px, 36dvh, ${Math.ceil(root.getBoundingClientRect().height)}px)`;
  }).observe(root);
  applyPreferences();
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyPreferences(hostTheme));

  if (browser.isMcp) {
    const client = new App({ name: "Poly Swarm Nodes", version: "0.5.0" }, __POLY_SWARM_EMBED_WORKBENCH__ ? {
      availableDisplayModes: ["inline", "fullscreen"],
    } : {});
    app = client;
    client.ontoolinput = ({ arguments: args }) => {
      if (typeof args?.swarm_id === "string" && args.swarm_id) bindSwarm(args.swarm_id);
      if (typeof args?.focus_worker === "string" && args.focus_worker) selected = args.focus_worker;
      if (typeof args?.collapsed === "boolean" && !userToggledCollapse) {
        collapsed = args.collapsed;
        render();
      }
    };
    client.ontoolresult = (result) => {
      const snap = result.structuredContent as InlineSnapshot | undefined;
      if (snap?.inline_mode === "recap") inlineMode = "recap";
      if (typeof snap?.default_collapsed === "boolean" && !userToggledCollapse) {
        collapsed = snap.default_collapsed;
      }
      if (snap && Array.isArray(snap.workers)) {
        applySnapshot(snap);
        render();
        if (snap.projected) void loadSnapshot();
      } else {
        void loadSnapshot();
      }
    };
    client.onhostcontextchanged = (ctx) => {
      if (ctx.displayMode) hostFullscreen = ctx.displayMode === "fullscreen";
      hostTheme = ctx.theme ?? hostTheme;
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      applyPreferences(hostTheme);
      render();
    };
    await client.connect();
    const ctx = client.getHostContext();
    hostFullscreen = ctx?.displayMode === "fullscreen";
    hostTheme = ctx?.theme ?? hostTheme;
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    applyPreferences(hostTheme);
  }
  render();
  await loadSnapshot();
  window.setInterval(tickElapsed, 1000);
  schedulePoll();
}

void main().catch((err) => {
  error = err instanceof Error ? err.message : String(err);
  render();
});
