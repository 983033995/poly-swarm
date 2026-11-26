import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REAL_BACKEND_IDS } from "../core/adapters/registry.js";
import type { PolySwarmEngine } from "../core/engine.js";
import { AGY_COMPANY_ID, AGY_COMPANY_REQUEST, UI_PREFERENCES_PATCH } from "../core/engine.js";
import { packBoardMessagesWithinBudget, packWorkerInspectWithinBudget } from "./mcp_budget.js";
import { runTeamAction, SESSION_FIELDS, SURFACE, TEAM_ACTION_SCHEMA } from "./team_actions.js";
import { formatDispatchGraphSummary } from "../core/graph.js";
import { WorkflowRunner } from "../core/workflow.js";
import type {
  BackendId,
  CapabilityTag,
  DashboardSnapshot,
  DispatchPolicyLayerConfig,
  MessageTag,
  RealBackendId,
  StaffAvatarId,
  SwarmPlan,
  WorkerRole,
  WorkbenchTab,
  WorkflowDefinition,
  WorkspaceMode,
} from "../shared/types.js";

export const APP_URI = "ui://poly-swarm/dashboard.html";
export const INLINE_APP_URI = "ui://poly-swarm/inline-nodes.html";

const BACKEND_ENUM = z.enum([...REAL_BACKEND_IDS, "mock"] as const);
const REAL_BACKEND_ENUM = z.enum(REAL_BACKEND_IDS);

const WORKBENCH_TAB_ENUM = z.enum([
  "detail",
  "graph",
  "board",
  "usage",
  "settings",
  "overview",
  "members",
]);

const ROLE_ENUM = z.enum(["author", "verifier", "researcher", "worker"]);
const CAPABILITY_ENUM = z.enum([
  "architect",
  "author",
  "verifier",
  "research",
  "enterprise",
  "fanout",
]);
const WORKSPACE_MODE_ENUM = z.enum(["inherit", "share", "branch"]);

const IDENTITY_PATCH_SCHEMA = z
  .object({
    label: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    base_role: ROLE_ENUM.nullable().optional(),
    capability: CAPABILITY_ENUM.nullable().optional(),
    preferred_backends: z.array(BACKEND_ENUM).nullable().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    workspace_mode: WORKSPACE_MODE_ENUM.nullable().optional(),
    auto_fallback: z.boolean().nullable().optional(),
    require_cross_vendor: z.boolean().nullable().optional(),
    reports_to: z.string().nullable().optional(),
    review_by: z.string().nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    skill_paths: z.array(z.string()).nullable().optional(),
    prompt_mode: z.enum(["replace", "append"]).nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    weight: z.number().int().nullable().optional(),
  })
  .nullable();

const PLANNED_LINK_SCHEMA = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["dispatch", "review", "reports_to", "depends_on", "handoff"]),
  label: z.string().optional(),
});

const BACKEND_POLICY_OVERRIDE_SCHEMA = z
  .object({
    enabled: z.boolean().nullable().optional(),
    defaultModel: z.string().nullable().optional(),
    defaultEffort: z.string().nullable().optional(),
  })
  .nullable();

const POLICY_LAYER_CONFIG_SCHEMA = z.object({
  routes: z.record(z.string(), z.array(BACKEND_ENUM).nullable()).optional(),
  backends: z.record(z.string(), BACKEND_POLICY_OVERRIDE_SCHEMA).optional(),
  identities: z.record(z.string(), IDENTITY_PATCH_SCHEMA).optional(),
  topology: z.array(PLANNED_LINK_SCHEMA).optional(),
});
const MESSAGE_TAG_ENUM = z.enum([
  "brief",
  "update",
  "done",
  "blocked",
  "stall",
  "review_pass",
  "review_fail",
  "system",
]);

function readMetaString(meta: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!meta) return undefined;
  const pickVal = (value: unknown): string | undefined => {
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first.trim() || undefined : undefined;
  };
  for (const key of keys) {
    const direct = pickVal(meta[key]);
    if (direct) return direct;
  }
  for (const [metaKey, metaVal] of Object.entries(meta)) {
    if (keys.some((k) => metaKey.endsWith(`/${k}`))) {
      const namespaced = pickVal(metaVal);
      if (namespaced) return namespaced;
    }
    if (metaVal && typeof metaVal === "object" && !Array.isArray(metaVal)) {
      const nestedObj = metaVal as Record<string, unknown>;
      for (const key of keys) {
        const nested = pickVal(nestedObj[key]);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

export function extractHostSessionHints(extra: unknown): {
  conversationId?: string;
  repoRoot?: string;
  conversationTitle?: string;
} {
  const context = extra as { _meta?: Record<string, unknown>; mcpReq?: { _meta?: Record<string, unknown> } } | undefined;
  const meta = context?.mcpReq?._meta ?? context?._meta;
  const conversationId = readMetaString(meta, ["conversationId", "conversation_id", "chatId", "threadId"]);
  const conversationTitle = readMetaString(meta, [
    "conversationTitle",
    "conversation_title",
    "windowLabel",
    "window_label",
    "chatTitle",
    "threadTitle",
  ]);
  const rawRepo = readMetaString(meta, ["workspacePath", "workspace_path", "repoRoot", "repo_root"]);
  if (rawRepo) {
    try {
      const repoRoot = /^file:/i.test(rawRepo) ? fileURLToPath(rawRepo) : rawRepo;
      if (path.isAbsolute(repoRoot)) {
        return {
          conversationId,
          repoRoot,
          ...(conversationTitle ? { conversationTitle } : {}),
        };
      }
    } catch {
      // Ignore malformed host hints
    }
  }
  return {
    conversationId,
    ...(conversationTitle ? { conversationTitle } : {}),
  };
}

function withSessionHints<T extends { conversation_id?: string; conversation_title?: string; repo_root?: string }>(
  args: T,
  extra: unknown,
  engine?: PolySwarmEngine,
): T {
  const hints = extractHostSessionHints(extra);
  const resolvedConvId = args.conversation_id?.trim() || hints.conversationId;
  const resolvedTitle = args.conversation_title?.trim() || hints.conversationTitle;
  if (engine && resolvedConvId && resolvedTitle) {
    try {
      engine.recordConversationTitle(resolvedConvId, resolvedTitle, "host");
    } catch {
      // ignore metadata recording failures
    }
  }
  return {
    ...args,
    conversation_id: resolvedConvId,
    repo_root: args.repo_root?.trim() || hints.repoRoot,
  };
}

export function resolveDashboardHtmlPath(): string {
  if (process.env.POLY_SWARM_UI_HTML && fs.existsSync(process.env.POLY_SWARM_UI_HTML)) {
    return process.env.POLY_SWARM_UI_HTML;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "dashboard.html"),
    path.resolve(here, "../../dist/dashboard.html"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

function readDashboardHtml(): string {
  const htmlPath = resolveDashboardHtmlPath();
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, "utf8");
  }
  return `<!doctype html><html><body><h3>Poly Swarm UI not built</h3><p>Expected: ${htmlPath}</p></body></html>`;
}

export function resolveInlineHtmlPath(codex = false): string {
  if (process.env.POLY_SWARM_INLINE_HTML && fs.existsSync(process.env.POLY_SWARM_INLINE_HTML)) {
    return process.env.POLY_SWARM_INLINE_HTML;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(codex ? [path.join(here, "codex-inline-nodes.html"), path.resolve(here, "../../dist/codex-inline-nodes.html")] : []),
    path.join(here, "inline-nodes.html"),
    path.resolve(here, "../../dist/inline-nodes.html"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(here, "inline-nodes.html");
}

function readInlineHtml(codex: boolean): string {
  const htmlPath = resolveInlineHtmlPath(codex);
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, "utf8");
  }
  return `<!doctype html><html><body><h3>Poly Swarm Inline UI not built</h3><p>Expected: ${htmlPath}</p></body></html>`;
}

function okJson(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function errJson(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

function formatSwarmRosterReceipt(
  snapshot: DashboardSnapshot,
  opts: { codex?: boolean; workbenchUrl?: string; summary?: string },
): string {
  if (!snapshot.swarm) {
    return opts.codex ? "没有找到可展示的 Poly Swarm 任务。" : "No swarm found.";
  }
  const workingCount = snapshot.workers.filter((w) => w.state === "working").length;
  const statusLabel =
    snapshot.swarm.status === "done"
      ? opts.codex ? "已完成" : "done"
      : workingCount > 0
        ? opts.codex ? `${workingCount} 位运行中` : `${workingCount} working`
        : opts.codex ? "待命中" : snapshot.swarm.status;
  const header = opts.codex
    ? `「${snapshot.swarm.title}」（${snapshot.swarm.id}）· ${snapshot.workers.length} 位团队成员 · ${statusLabel} · ${snapshot.usage_totals.total_tokens} tokens`
    : `Swarm '${snapshot.swarm.title}' (${snapshot.swarm.id}) [${statusLabel}] · ${snapshot.workers.length} team member(s) · ${snapshot.usage_totals.total_tokens} tokens`;
  const lines = snapshot.workers.map(
    (w) =>
      `- @${w.name} · ${w.backend}${w.model ? `/${w.model}` : ""} · ${w.identity_id ?? w.role} · ${w.state} · ${w.usage.total_tokens} tokens`,
  );
  const parts = [header];
  if (opts.summary?.trim()) parts.push(opts.summary.trim());
  if (lines.length > 0) parts.push(lines.join("\n"));
  if (opts.workbenchUrl) {
    parts.push(
      opts.codex ? `[打开本次工作台](${opts.workbenchUrl})` : `Local workbench: ${opts.workbenchUrl}`,
    );
  }
  return parts.join("\n");
}

export function createPolySwarmMcpServer(
  engine: PolySwarmEngine,
  getWorkbenchUrl?: (swarmId?: string) => string | undefined,
  codex = false,
): McpServer {
  const server = new McpServer({
    name: "poly-swarm",
    version: engine.version,
  }, {
    instructions: "In Codex desktop, when the user wants the workbench, open the returned workbench_url as a browser panel on the right using the host tool open_in_codex if available. Use the URL of the swarm just dispatched or explicitly selected.",
  });
  const workflowRunner = new WorkflowRunner(engine);

  registerAppResource(
    server,
    "Poly Swarm Dashboard",
    APP_URI,
    {
      description: "Live multi-agent CLI orchestrator workbench, traces, sessions, and cost ledger.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readDashboardHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  registerAppResource(
    server,
    "Poly Swarm Inline Nodes",
    INLINE_APP_URI,
    {
      description: "Minimalist inline streaming node list rendered inside the main conversation.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: INLINE_APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readInlineHtml(codex),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  // 1. poly_swarm_open (side pane + global workbench entrypoint)
  registerAppTool(
    server,
    "poly_swarm_open",
    {
      title: "Poly Swarm",
      description:
        "Open the Poly Swarm side workbench to inspect worker configurations, live execution traces, diffs, board messages, and token/cost usage. When opening or focusing a specific session workbench from the coordinator, pass explicit swarm_id (and conversation_id if known) to keep windows isolated.",
      inputSchema: z.object({
        ...SESSION_FIELDS,
        worker_name: z.string().optional().describe("Optional worker name to focus immediately."),
        tab: WORKBENCH_TAB_ENUM.optional().describe("Optional workbench tab to focus."),
        surface: SURFACE.optional(),
        auto_select: z.boolean().optional(),
      }),
      _meta: {
        ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Poly Swarm" },
          ],
        },
      },
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      const surface = args.surface ?? "workbench";
      const autoSelectLatest = !codex && (args.auto_select ??
        (surface === "workbench" && !args.swarm_id && !args.team_id && !args.conversation_id));
      const allowRepoHint = Boolean(args.conversation_id || raw.repo_root?.trim() || autoSelectLatest);
      let repoRoot = !codex && allowRepoHint ? args.repo_root : undefined;
      if (autoSelectLatest && !repoRoot && !engine.hasRecentWorkbenchFocus()) {
        repoRoot = (await engine.workspace.getRepoRoot(process.cwd())) ?? undefined;
      }
      const snapshot = await engine.getModelSnapshot(args.swarm_id, {
        teamId: args.team_id,
        conversationId: args.conversation_id,
        repoRoot,
        surface,
        autoSelectLatest,
        ...(codex ? { bind: false } : {}),
      });
      const trustedMatch = Boolean(
        snapshot.swarm &&
          ["explicit_swarm", "explicit_team", "conversation_binding"].includes(snapshot.match_reason ?? "none"),
      );
      if (surface === "workbench" && (trustedMatch || args.worker_name !== undefined || args.tab !== undefined)) {
        snapshot.ui_focus = engine.setUiFocus({
          swarm_id: trustedMatch ? snapshot.swarm?.id ?? null : null,
          ...(args.worker_name !== undefined ? { worker_name: args.worker_name } : {}),
          ...(args.tab !== undefined ? { tab: args.tab } : {}),
        });
      }
      const summary = snapshot.swarm
        ? `Opened Poly Swarm '${snapshot.swarm.title}' (${snapshot.swarm.id}): ${snapshot.workers.length} worker(s), ${snapshot.usage_totals.total_tokens} tokens.`
        : codex ? "没有找到这个 Codex 聊天的任务。请使用聊天中的派发记录，或打开 Poly Swarm 总控查看历史。"
          : `Poly Swarm ready. Select a team or swarm to continue. ${snapshot.backends.filter((b) => b.installed === 1).length} CLI backend(s) detected.`;
      const workbenchUrl = snapshot.swarm && getWorkbenchUrl?.(snapshot.swarm.id);
      return okJson(`${summary} Match: ${snapshot.match_reason}.${codex && workbenchUrl ? `\n[打开本次工作台](${workbenchUrl})` : ""}`, {
        ...(snapshot as unknown as Record<string, unknown>),
        ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}),
      });
    },
  );

  // 1a. poly_swarm_hub (left sidebar global HR campus entrypoint)
  registerAppTool(
    server,
    "poly_swarm_hub",
    {
      title: "Poly Swarm",
      description:
        "Open the Poly Swarm global Human Resources campus, project archive, and dispatch rules hub.",
      inputSchema: z.object({
        ...SESSION_FIELDS,
        surface: SURFACE.optional(),
      }),
      _meta: {
        ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [{ type: "global", title: "Poly Swarm" }],
        },
      },
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      const snapshot = await engine.getModelSnapshot(null, {
        conversationId: args.conversation_id,
        repoRoot: args.repo_root,
        surface: "global",
        autoSelectLatest: false,
        bind: false,
      });
      const onlineCount = snapshot.backends.filter((b) => b.installed === 1).length;
      const summary = `Poly Swarm Global HR Hub: ${onlineCount}/${snapshot.backends.length} CLI vendor(s) ready, ${(snapshot.teams ?? []).length} project team(s).`;
      const workbenchUrl = codex ? getWorkbenchUrl?.() : undefined;
      return okJson(workbenchUrl ? `${summary}\n[打开 Poly Swarm 总控](${workbenchUrl})` : summary, {
        ...(snapshot as unknown as Record<string, unknown>),
        surface: "global",
        ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}),
      });
    },
  );

  // 1b. poly_swarm_dispatch (minimalist inline streaming nodes card in main chat)
  registerAppTool(
    server,
    "poly_swarm_dispatch",
    {
      title: "Dispatch Poly Swarm Nodes",
      description:
        "Dispatch one or more heterogeneous CLI workers (optionally creating a swarm) and render a minimalist inline streaming-node summary card in chat that links to the side workbench.",
      inputSchema: z.object({
        ...SESSION_FIELDS,
        title: z.string().optional(),
        team_name: z.string().optional(),
        goal: z.string().nullable().optional(),
        reuse_team: z.boolean().optional(),
        base_branch: z.string().optional(),
        focus_worker: z.string().optional(),
        policy: POLICY_LAYER_CONFIG_SCHEMA.optional(),
        workers: z
          .array(
            z.object({
              name: z.string(),
              staff_id: z.string().optional().describe("Talent Park employee ID (poly_swarm action staff); uses the employee's assigned company."),
              company_id: AGY_COMPANY_ID.optional().describe("Specific AGY company when dispatching without a staff_id. List IDs with action companies."),
              identity: z.string().optional(),
              role: ROLE_ENUM.optional(),
              backend: BACKEND_ENUM.optional(),
              capability: CAPABILITY_ENUM.optional(),
              model: z.string().optional(),
              effort: z.string().optional(),
              workspace_mode: WORKSPACE_MODE_ENUM.optional(),
              review_of: z.string().optional(),
              reports_to: z.string().optional(),
              depends_on: z.array(z.string()).optional(),
              channels: z.array(z.string()).optional(),
              brief: z.string(),
              auto_fallback: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
      _meta: {
        ui: { resourceUri: INLINE_APP_URI },
        "openai/ui": { preferredModelDisplayMode: "inline" },
      },
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      try {
        let targetSwarmId = args.swarm_id?.trim() || null;
        if (codex) {
          if (!args.conversation_id) return errJson("Codex dispatch requires conversation_id: pass the current CODEX_THREAD_ID.");
          const binding = engine.db.getSessionBinding(args.conversation_id);
          if (targetSwarmId && targetSwarmId !== binding?.active_swarm_id) {
            return errJson(`Swarm '${targetSwarmId}' is not the active task of this Codex chat.`);
          }
          if (args.team_id && args.team_id !== binding?.team_id) {
            return errJson(`Team '${args.team_id}' is not bound to this Codex chat.`);
          }
        }
        const repoRoot = args.repo_root ?? (args.team_id ? engine.db.getTeam(args.team_id)?.repo_root : undefined);
        if (!targetSwarmId && args.title && repoRoot) {
          const created = await engine.createSwarm({
            ...args, title: args.title, repo_root: repoRoot,
          });
          targetSwarmId = created.id;
        } else {
          if (targetSwarmId && args.team_id && engine.db.getSwarm(targetSwarmId)?.team_id !== args.team_id) {
            return errJson(`Swarm '${targetSwarmId}' does not belong to team '${args.team_id}'.`);
          }
          if (!targetSwarmId && (args.team_id || args.conversation_id)) {
            targetSwarmId = engine.resolveSessionTarget({
              teamId: args.team_id, conversationId: args.conversation_id, autoSelect: false,
            }).swarm?.id ?? null;
          }
        }
        if (targetSwarmId && args.policy && !(args.title && repoRoot && !args.swarm_id?.trim())) {
          await engine.updateDispatchPolicy({
            scope: "session",
            swarm_id: targetSwarmId,
            patch: args.policy as DispatchPolicyLayerConfig,
          });
        }

        const dispatchedWorkers: string[] = [];
        if (args.workers && args.workers.length > 0) {
          if (!targetSwarmId) {
            return errJson("poly_swarm_dispatch with 'workers' requires 'swarm_id' or ('title' and 'repo_root').");
          }
          for (const w of args.workers) {
            const added = await engine.addWorker({
              swarm_id: targetSwarmId,
              name: w.name,
              staff_id: w.staff_id,
              company_id: w.company_id,
              identity: w.identity,
              role: w.role as WorkerRole | undefined,
              backend: w.backend as BackendId | undefined,
              capability: w.capability as CapabilityTag | undefined,
              model: w.model,
              effort: w.effort,
              workspace_mode: w.workspace_mode as WorkspaceMode | undefined,
              review_of: w.review_of,
              reports_to: w.reports_to,
              depends_on: w.depends_on,
              channels: w.channels,
              brief: w.brief,
              auto_fallback: w.auto_fallback,
            });
            dispatchedWorkers.push(added.worker.name);
          }
        }

        const snapshot = await engine.getModelSnapshot(targetSwarmId, {
          teamId: args.team_id, conversationId: args.conversation_id, surface: "inline",
          ...(codex ? { bind: false } : {}),
        });
        const focusTarget = args.focus_worker ?? dispatchedWorkers[0] ?? snapshot.workers[0]?.name ?? null;
        if (snapshot.swarm && focusTarget) {
          snapshot.ui_focus = engine.setUiFocus({
            swarm_id: snapshot.swarm.id,
            worker_name: focusTarget,
            tab: "detail",
          });
        }

        const baseSummary = snapshot.swarm
          ? dispatchedWorkers.length > 0
            ? `Dispatched ${dispatchedWorkers.map((n) => `@${n}`).join(", ")} in '${snapshot.swarm.title}' (${snapshot.swarm.id}).`
            : `Showing ${snapshot.workers.length} worker node(s) in '${snapshot.swarm.title}' (${snapshot.swarm.id}).`
          : "No swarm found.";
        const workbenchUrl = (snapshot.swarm ? getWorkbenchUrl?.(snapshot.swarm.id) : undefined) ?? undefined;
        const receipt = codex && snapshot.swarm && dispatchedWorkers.length
          ? `已派发「${snapshot.swarm.title}」（${snapshot.swarm.id}）\n${snapshot.workers
            .filter((worker) => dispatchedWorkers.includes(worker.name))
            .map((worker) => `- @${worker.name} · ${worker.backend} · ${worker.role}`)
            .join("\n")}`
          : baseSummary;
        const tip = workbenchUrl
          ? codex ? `\n[打开本次工作台](${workbenchUrl})` : `\nLocal workbench: ${workbenchUrl}`
          : snapshot.swarm && !snapshot.ui_focus.workbench_alive
            ? `\nTip: call poly_swarm_open({"swarm_id":"${snapshot.swarm.id}"}) to focus the side workbench on this session, and optionally poly_swarm(action="plan") to record goal/threads.`
            : "";
        return okJson(`${receipt}${tip}`, {
          ...(snapshot as unknown as Record<string, unknown>),
          ...(dispatchedWorkers.length > 0 ? { dispatched_workers: dispatchedWorkers } : {}),
          ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}),
        });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // 1c. poly_swarm_recap (compact persistent team pill for end-of-turn / end-of-session retention)
  registerAppTool(
    server,
    "poly_swarm_recap",
    {
      title: "Poly Swarm Team Recap",
      description:
        "Render a compact, persistent inline team-members pill in chat (ideal at the end of a turn/session to retain invoked subagents, or mid-session to recap active members). Pass finish=true to mark the swarm done and render the final team pill in one step.",
      inputSchema: z.object({
        ...SESSION_FIELDS,
        finish: z.boolean().optional().describe("Mark the target swarm done before rendering the final team pill."),
        summary: z.string().optional().describe("Completion summary posted to the board when finish=true."),
        collapsed: z.boolean().optional().describe("Start collapsed as a single-line team pill (defaults to true)."),
      }),
      _meta: {
        ui: { resourceUri: INLINE_APP_URI },
        "openai/ui": { preferredModelDisplayMode: "inline" },
      },
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      try {
        let targetSwarmId = args.swarm_id?.trim() || null;
        if (codex) {
          if (args.finish) {
            if (!args.conversation_id) {
              return errJson("Codex recap with finish=true requires conversation_id: pass the current CODEX_THREAD_ID.");
            }
            const binding = engine.db.getSessionBinding(args.conversation_id);
            if (targetSwarmId && targetSwarmId !== binding?.active_swarm_id) {
              return errJson(`Swarm '${targetSwarmId}' is not the active task of this Codex chat.`);
            }
            if (args.team_id && args.team_id !== binding?.team_id) {
              return errJson(`Team '${args.team_id}' is not bound to this Codex chat.`);
            }
            targetSwarmId = targetSwarmId || binding?.active_swarm_id || null;
          } else if (!targetSwarmId) {
            targetSwarmId =
              engine.resolveSessionTarget({
                teamId: args.team_id,
                conversationId: args.conversation_id,
                bind: false,
                autoSelect: false,
              }).swarm?.id ?? null;
          }
        } else if (!targetSwarmId) {
          targetSwarmId =
            engine.resolveSessionTarget({
              teamId: args.team_id,
              conversationId: args.conversation_id,
              repoRoot: args.repo_root,
              autoSelect: !args.conversation_id,
            }).swarm?.id ?? null;
        }

        if (!targetSwarmId || !engine.db.getSwarm(targetSwarmId)) {
          return errJson("No swarm found for this session.");
        }
        if (args.finish && engine.db.getSwarm(targetSwarmId)?.status === "active") {
          await engine.finishSwarm(targetSwarmId, args.summary);
        }
        const snapshot = await engine.getModelSnapshot(targetSwarmId, {
          teamId: args.team_id,
          conversationId: args.conversation_id,
          surface: "inline",
          ...(codex ? { bind: false } : {}),
        });
        const workbenchUrl = (snapshot.swarm ? getWorkbenchUrl?.(snapshot.swarm.id) : undefined) ?? undefined;
        const defaultCollapsed = args.collapsed ?? true;
        return okJson(
          formatSwarmRosterReceipt(snapshot, { codex, workbenchUrl, summary: args.summary }),
          {
            ...(snapshot as unknown as Record<string, unknown>),
            inline_mode: "recap",
            default_collapsed: defaultCollapsed,
            ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}),
          },
        );
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // 2. poly_swarm (headless lifecycle & roster control without inline iframe clutter)
  server.registerTool(
    "poly_swarm",
    {
      title: "Poly Swarm Control",
      description:
        "Manage multi-CLI swarms: detect backends, create swarm, add/inspect/switch/merge/kill workers, manage channels, update plan, or finish swarm.",
      inputSchema: z.object({
        action: z.enum([
          "backends",
          "staff",
          "companies",
          "create",
          "add",
          "status",
          "switch",
          "merge",
          "kill",
          "channel",
          "plan",
          "graph",
          "policy",
          "finish",
          "teams",
          "attach",
          "reopen",
          "new_wave",
        ]),
        ...SESSION_FIELDS,
        title: z.string().optional(),
        team_name: z.string().optional(),
        goal: z.string().nullable().optional(),
        reuse_team: z.boolean().optional(),
        reopen: z.boolean().optional(),
        base_branch: z.string().optional(),
        name: z.string().optional(),
        staff_id: z.string().optional().describe("Talent Park employee ID for add. List IDs with action staff."),
        company_id: AGY_COMPANY_ID.optional().describe("Specific AGY company for add. List IDs with action companies."),
        identity: z.string().optional(),
        role: ROLE_ENUM.optional(),
        backend: BACKEND_ENUM.optional(),
        capability: CAPABILITY_ENUM.optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        workspace_mode: WORKSPACE_MODE_ENUM.optional(),
        review_of: z.string().optional(),
        reports_to: z.string().optional(),
        depends_on: z.array(z.string()).optional(),
        channels: z.array(z.string()).optional(),
        brief: z.string().optional(),
        auto_fallback: z.boolean().optional(),
        reason: z.string().optional(),
        resume_prompt: z.string().optional(),
        expected_sha: z.string().optional().describe("For merge, bind the operation to the reviewed commit SHA."),
        cleanup_workspace: z.boolean().optional(),
        channel_op: z.enum(["create", "list", "archive"]).optional(),
        channel: z.string().optional(),
        topic: z.string().optional(),
        policy_op: z.enum(["get", "set", "reset"]).optional(),
        policy_scope: z.enum(["effective", "global_ui", "project", "session"]).optional(),
        policy: POLICY_LAYER_CONFIG_SCHEMA.optional(),
        plan: z
          .object({
            goal: z.object({ title: z.string(), line: z.string() }),
            tasks: z.record(z.string(), z.string()),
            threads: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                goal: z.string(),
                tasks: z.array(z.string()),
              }),
            ),
          })
          .optional(),
        summary: z.string().optional(),
      }),
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      try {
        switch (args.action) {
          case "teams":
          case "attach":
          case "reopen":
          case "new_wave": {
            const result = await runTeamAction(engine, { ...args, action: args.action === "teams" ? "list" : args.action });
            return okJson(`Team action '${args.action}' completed.`, result);
          }
          case "backends": {
            const health = await engine.refreshBackends();
            const lines = health.map((h) => {
              const status = h.installed
                ? `installed (${h.version || h.binary_path})`
                : h.version === "disabled in config"
                  ? "disabled (in config)"
                  : "not installed";
              const cooldown = h.cooldown_until && h.cooldown_until > Date.now() ? " [COOLDOWN]" : "";
              return `- ${h.backend}: ${status}${cooldown}`;
            });
            const snap = await engine.getDashboardSnapshot(args.swarm_id ?? null);
            return okJson(
              `CLI Backends:\n${lines.join("\n")}`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "staff": {
            const staff = engine.getStaffRoster().filter((entry) => entry.enabled).map((entry) => ({
              id: entry.id, name: entry.name, backend: entry.backend, model: entry.model, role: entry.role,
              company_id: entry.company_id ?? entry.backend,
            }));
            return okJson("Enabled Talent Park employees. Dispatch with staff_id to use their configured seat.", { staff });
          }

          case "companies": {
            const companies = engine.getAgyCompanies().map(({ account_hint: _, ...company }) => ({ ...company, backend: "agy" }));
            return okJson("AGY companies. Use the company ID to dispatch to its account.", { companies });
          }

          case "create": {
            const repoRoot = args.repo_root ?? (args.team_id ? engine.db.getTeam(args.team_id)?.repo_root : undefined);
            if (!args.title || !repoRoot) {
              return errJson("create requires 'title' and 'repo_root'.");
            }
            const swarm = await engine.createSwarm({
              ...args, title: args.title, repo_root: repoRoot,
            });
            const snap = await engine.getDashboardSnapshot(swarm.id, { conversationId: args.conversation_id });
            return okJson(
              `Created swarm '${swarm.title}' (${swarm.id}) at ${swarm.repo_root} (base: ${swarm.base_branch ?? "detached"}).`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "add": {
            if (!args.swarm_id || !args.name || !args.brief) {
              return errJson("add requires 'swarm_id', 'name', and 'brief'.");
            }
            const res = await engine.addWorker({
              swarm_id: args.swarm_id,
              name: args.name,
              staff_id: args.staff_id,
              company_id: args.company_id,
              identity: args.identity,
              role: args.role as WorkerRole | undefined,
              backend: args.backend as BackendId | undefined,
              capability: args.capability as CapabilityTag | undefined,
              model: args.model,
              effort: args.effort,
              workspace_mode: args.workspace_mode as WorkspaceMode | undefined,
              review_of: args.review_of,
              reports_to: args.reports_to,
              depends_on: args.depends_on,
              channels: args.channels,
              brief: args.brief,
              auto_fallback: args.auto_fallback,
            });
            const snap = await engine.getDashboardSnapshot(args.swarm_id);
            return okJson(
              `Added worker @${res.worker.name} (identity=${res.worker.identity_id ?? res.worker.role}, backend=${res.worker.backend}, role=${res.worker.role}, workspace=${res.worker.workspace_mode} -> ${res.worker.workspace_path}). Brief posted as #${res.brief_message.seq}.`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "status": {
            const snap = await engine.getDashboardSnapshot(args.swarm_id ?? null, {
              teamId: args.team_id, conversationId: args.conversation_id,
              repoRoot: codex ? undefined : args.repo_root, autoSelectLatest: !codex,
              ...(codex ? { bind: false } : {}),
            });
            if (!snap.swarm) {
              return okJson("No swarms created yet.", snap as unknown as Record<string, unknown>);
            }
            const lines = snap.workers.map(
              (w) =>
                `- @${w.name} [${w.state}] backend=${w.backend}${w.model ? `/${w.model}` : ""} role=${w.role} tokens=${w.usage.total_tokens} turns=${w.usage.turns}${w.last_error ? ` err=${w.last_error}` : ""}`,
            );
            return okJson(
              `Swarm '${snap.swarm.title}' (${snap.swarm.id}) [${snap.swarm.status}] | total_tokens=${snap.usage_totals.total_tokens} cost=$${snap.usage_totals.cost_usd.toFixed(4)}\n${lines.join("\n") || "(no workers)"}`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "switch": {
            if (!args.swarm_id || !args.name || !args.backend) {
              return errJson("switch requires 'swarm_id', 'name', and 'backend'.");
            }
            const updated = await engine.switchWorkerBackend({
              swarm_id: args.swarm_id,
              name: args.name,
              backend: args.backend as BackendId,
              model: args.model,
              effort: args.effort,
              reason: args.reason,
              resume_prompt: args.resume_prompt,
            });
            const snap = await engine.getDashboardSnapshot(args.swarm_id);
            return okJson(
              `Switched @${updated.name} to backend '${updated.backend}'${updated.model ? ` (${updated.model})` : ""}.`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "merge": {
            if (!args.swarm_id || !args.name) {
              return errJson("merge requires 'swarm_id' and 'name'.");
            }
            const mergeRes = await engine.mergeWorker(args.swarm_id, args.name, { expectedSha: args.expected_sha });
            const snap = await engine.getDashboardSnapshot(args.swarm_id);
            if (!mergeRes.ok) {
              return errJson(mergeRes.message);
            }
            return okJson(mergeRes.message, snap as unknown as Record<string, unknown>);
          }

          case "kill": {
            if (!args.swarm_id || !args.name) {
              return errJson("kill requires 'swarm_id' and 'name'.");
            }
            const w = await engine.killWorker(
              args.swarm_id,
              args.name,
              args.cleanup_workspace ?? false,
            );
            const snap = await engine.getDashboardSnapshot(args.swarm_id);
            return okJson(
              `Killed worker @${w.name}.`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "channel": {
            if (!args.swarm_id) return errJson("channel requires 'swarm_id'.");
            const op = args.channel_op ?? "list";
            if (op !== "list") engine.assertSwarmWritable(args.swarm_id);
            if (op === "create") {
              if (!args.channel) return errJson("channel create requires 'channel'.");
              const ch = engine.db.createChannel(args.swarm_id, args.channel, args.topic);
              return okJson(`Created channel #${ch.name}.`);
            }
            if (op === "archive") {
              if (!args.channel) return errJson("channel archive requires 'channel'.");
              engine.db.archiveChannel(args.swarm_id, args.channel);
              return okJson(`Archived channel #${args.channel}.`);
            }
            const list = engine.db.listChannels(args.swarm_id);
            return okJson(
              list.map((c) => `#${c.name}${c.archived ? " (archived)" : ""}: ${c.topic || ""}`).join("\n"),
            );
          }

          case "plan": {
            if (!args.swarm_id || !args.plan) {
              return errJson("plan requires 'swarm_id' and 'plan'.");
            }
            engine.assertSwarmWritable(args.swarm_id);
            engine.db.updateSwarmPlan(args.swarm_id, args.plan as SwarmPlan);
            const snap = await engine.getDashboardSnapshot(args.swarm_id);
            return okJson(
              `Updated swarm plan for ${args.swarm_id}.`,
              snap as unknown as Record<string, unknown>,
            );
          }

          case "graph": {
            if (!args.swarm_id) {
              return errJson("graph requires 'swarm_id'.");
            }
            const graph = engine.getDispatchGraph(args.swarm_id);
            return okJson(formatDispatchGraphSummary(graph), {
              graph: graph as unknown as Record<string, unknown>,
            });
          }

          case "policy": {
            const op = args.policy_op ?? "get";
            const scope = args.policy_scope ?? (op === "get" ? "effective" : "session");
            if (op !== "get" && scope === "effective") {
              return errJson(
                `policy_op '${op}' requires policy_scope 'global_ui', 'project', or 'session'.`,
              );
            }
            const resolved =
              op === "get"
                ? engine.resolvePolicy({
                    swarmId: args.swarm_id ?? null,
                    repoRoot: args.repo_root ?? null,
                  })
                : await engine.updateDispatchPolicy({
                    scope: scope as "global_ui" | "project" | "session",
                    swarm_id: args.swarm_id ?? null,
                    repo_root: args.repo_root ?? null,
                    patch: (args.policy as DispatchPolicyLayerConfig | undefined) ?? null,
                    reset: op === "reset",
                  });
            const layerSummary = resolved.layers
              .map(
                (l) =>
                  `- ${l.layer} (w=${l.weight}): ${l.active ? "active" : "empty"} (${l.override_count} items)${l.path ? ` [${l.path}]` : ""}`,
              )
              .join("\n");
            const idSummary = Object.values(resolved.identities)
              .map(
                (id) =>
                  `- ${id.id} (${id.label}): role=${id.base_role} cap=${id.capability} src=${id.source}(w=${id.weight}) enabled=${id.enabled}`,
              )
              .join("\n");
            const warnText =
              resolved.warnings.length > 0
                ? `\nWarnings:\n${resolved.warnings.map((w) => `- ${w}`).join("\n")}`
                : "";
            return okJson(
              `Dispatch Policy Layers:\n${layerSummary}\n\nEffective Identities:\n${idSummary}${warnText}`,
              { policy: resolved as unknown as Record<string, unknown> },
            );
          }

          case "finish": {
            if (!args.swarm_id) return errJson("finish requires 'swarm_id'.");
            if (codex && args.conversation_id) {
              const binding = engine.db.getSessionBinding(args.conversation_id);
              if (args.swarm_id !== binding?.active_swarm_id) {
                return errJson(`Swarm '${args.swarm_id}' is not the active task of this Codex chat.`);
              }
            }
            await engine.finishSwarm(args.swarm_id, args.summary);
            const snap = await engine.getDashboardSnapshot(args.swarm_id);
            const workbenchUrl = getWorkbenchUrl?.(args.swarm_id);
            return okJson(
              codex
                ? formatSwarmRosterReceipt(snap, { codex: true, workbenchUrl, summary: args.summary })
                : `Swarm ${args.swarm_id} marked done.${workbenchUrl ? `\nLocal workbench: ${workbenchUrl}` : ""}`,
              {
                ...(snap as unknown as Record<string, unknown>),
                ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}),
              },
            );
          }
        }
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // 3. poly_board_post
  server.registerTool(
    "poly_board_post",
    {
      title: "Post to Poly Board",
      description:
        "Post a message to the shared swarm board. Mentioning @worker, @all, or @#channel wakes the target worker(s).",
      inputSchema: z.object({
        swarm_id: z.string(),
        text: z.string(),
        channel: z.string().optional(),
        tag: MESSAGE_TAG_ENUM.optional(),
        sender: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        const res = await engine.postMessage({
          swarm_id: args.swarm_id,
          sender: args.sender ?? "coordinator",
          channel: args.channel ?? "main",
          tag: (args.tag as MessageTag | undefined) ?? "update",
          text: args.text,
        });
        return okJson(
          `Posted #${res.message.seq} in #${res.message.channel}. Woken: ${res.woken.length > 0 ? res.woken.map((w) => `@${w}`).join(", ") : "none"}.`,
          res as unknown as Record<string, unknown>,
        );
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // 4. poly_board_read
  server.registerTool(
    "poly_board_read",
    {
      title: "Read Poly Board",
      description: "Read board messages after a sequence number, optionally filtered by channel.",
      inputSchema: z.object({
        swarm_id: z.string(),
        since: z.number().int().min(0).optional(),
        channel: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async (args) => {
      const msgs = engine.db.readBoardMessages({
        swarm_id: args.swarm_id,
        since: args.since ?? 0,
        channel: args.channel,
        limit: args.limit ?? 50,
      });
      const packed = packBoardMessagesWithinBudget(msgs, {
        nextSinceFallback: args.since ?? 0,
        emptyText: "No new messages.",
      });
      return okJson(packed.text, {
        messages: packed.messages,
        truncated: packed.truncated,
        omitted_count: packed.omitted_count,
        next_since: packed.next_since,
      });
    },
  );

  // 5. poly_board_wait
  server.registerTool(
    "poly_board_wait",
    {
      title: "Wait on Poly Board",
      description:
        "Sleep until a new matching message arrives on the board (zero LLM token polling cost).",
      inputSchema: z.object({
        swarm_id: z.string(),
        since: z.number().int().min(0),
        channel: z.string().optional(),
        mentions_only: z.boolean().optional(),
        timeout_ms: z.number().int().min(500).max(120000).optional(),
      }),
    },
    async (args) => {
      const msgs = await engine.waitForBoard({
        swarm_id: args.swarm_id,
        since: args.since,
        channel: args.channel,
        mentions_only_for: args.mentions_only === false ? undefined : "coordinator",
        timeout_ms: args.timeout_ms ?? 30000,
      });
      const packed = packBoardMessagesWithinBudget(msgs, {
        nextSinceFallback: args.since,
        emptyText: "Timed out waiting for new board message.",
      });
      return okJson(packed.text, {
        messages: packed.messages,
        truncated: packed.truncated,
        omitted_count: packed.omitted_count,
        next_since: packed.next_since,
      });
    },
  );

  // 6. poly_worker_inspect
  server.registerTool(
    "poly_worker_inspect",
    {
      title: "Inspect Worker Trace & Diff",
      description:
        "On-demand drill-down into a specific worker's turns, execution events (thoughts/tool calls/outputs), token/cost ledger, and git diff.",
      inputSchema: z.object({
        swarm_id: z.string(),
        name: z.string(),
        turn_id: z.string().optional(),
        after_event_id: z.number().int().min(0).optional(),
        include: z.enum(["summary", "events", "diff", "all"]).optional(),
      }),
    },
    async (args) => {
      try {
        const detail = await engine.getWorkerDetail(args.swarm_id, args.name);
        const include = args.include ?? "all";
        const targetTurnId = args.turn_id ?? detail.turns[0]?.id;
        const events =
          (include === "events" || include === "all") && targetTurnId
            ? engine.db.listTurnEvents(targetTurnId, args.after_event_id ?? 0, 120)
            : [];
        const packed = packWorkerInspectWithinBudget({
          detail,
          events,
          targetTurnId,
          afterEventId: args.after_event_id,
          include: {
            turns: include === "summary" || include === "all",
            events: include === "events" || include === "all",
            diff: include === "diff" || include === "all",
          },
        });
        return okJson(packed.text, packed.structuredContent);
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // 7. poly_workflow
  server.registerTool(
    "poly_workflow",
    {
      title: "Run Heterogeneous Workflow DAG",
      description:
        "Execute a declarative multi-phase workflow (parallel/pipeline) across different CLI backends with {{step_id}} template interpolation and JSON Schema validation.",
      inputSchema: z.object({
        description: z.string(),
        ...SESSION_FIELDS,
        background: z.boolean().optional(),
        phases: z.array(
          z.object({
            name: z.string(),
            mode: z.enum(["parallel", "pipeline"]),
            steps: z.array(
              z.object({
                id: z.string(),
                backend: BACKEND_ENUM.optional(),
                capability: CAPABILITY_ENUM.optional(),
                model: z.string().optional(),
                effort: z.string().optional(),
                readonly: z.boolean().optional(),
                prompt: z.string(),
                json_schema: z.record(z.string(), z.unknown()).optional(),
                timeout_ms: z.number().int().min(500).optional(),
              }),
            ),
          }),
        ),
      }),
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      const def: WorkflowDefinition = {
        description: args.description,
        repo_root: args.repo_root,
        swarm_id: args.swarm_id,
        team_id: args.team_id,
        conversation_id: args.conversation_id,
        phases: args.phases,
      };
      if (args.background) {
        const promise = workflowRunner.run(def);
        void promise.catch((err) => console.error("[poly-swarm] background workflow failed:", err));
        return okJson(`Started background workflow '${args.description}'. Watch progress in Poly Swarm dashboard.`);
      }
      const record = await workflowRunner.run(def);
      if (record.status === "failed") {
        return errJson(`Workflow ${record.id} failed: ${record.error}`);
      }
      return okJson(
        `Workflow ${record.id} completed.\nResults: ${record.results_json ?? "{}"}`,
        { workflow: record },
      );
    },
  );

  // --- App-Only Tools (hidden from model, zero coordinator context cost) ---

  server.registerTool(
    "app_get_dashboard",
    {
      title: "App: Get Dashboard Snapshot",
      description: "Internal UI tool to refresh dashboard snapshot.",
      inputSchema: z.object({
        ...SESSION_FIELDS,
        surface: SURFACE.optional(),
        auto_select: z.boolean().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (raw, extra) => {
      const args = withSessionHints(raw, extra, engine);
      const autoSelectLatest =
        args.auto_select ??
        (args.surface === "workbench" && !args.swarm_id && !args.team_id && !args.conversation_id);
      const allowRepoHint = Boolean(args.conversation_id || raw.repo_root?.trim() || autoSelectLatest);
      let repoRoot = allowRepoHint ? args.repo_root : undefined;
      if (autoSelectLatest && !repoRoot && !engine.hasRecentWorkbenchFocus()) {
        repoRoot = (await engine.workspace.getRepoRoot(process.cwd())) ?? undefined;
      }
      const snap = await engine.getDashboardSnapshot(args.swarm_id ?? null, {
        surface: args.surface,
        teamId: args.team_id,
        conversationId: args.conversation_id,
        repoRoot,
        autoSelectLatest,
        bind: false,
      });
      const workbenchUrl = codex && args.surface === "inline" && snap.swarm ? getWorkbenchUrl?.(snap.swarm.id) : undefined;
      return okJson("ok", { ...snap, ...(workbenchUrl ? { workbench_url: workbenchUrl } : {}) });
    },
  );

  server.registerTool(
    "app_team_action",
    {
      title: "App: Manage Teams",
      description: "List, attach, reopen, rename, or start a new wave for a team.",
      inputSchema: TEAM_ACTION_SCHEMA,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args, extra) => {
      try {
        return okJson("ok", await runTeamAction(engine, withSessionHints(args, extra, engine)));
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_preferences",
    {
      title: "App: UI Preferences",
      description: "Read or update persistent UI preferences.",
      inputSchema: z.object({ op: z.enum(["get", "set"]), patch: UI_PREFERENCES_PATCH.optional() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => okJson("ok", {
      ui_preferences: args.op === "set" ? engine.setUiPreferences(args.patch ?? {}) : engine.getUiPreferences(),
    }),
  );

  server.registerTool(
    "app_focus_worker",
    {
      title: "App: Focus Worker Across Surfaces",
      description: "Internal UI tool to synchronize active worker focus between inline nodes and side workbench.",
      inputSchema: z.object({
        swarm_id: z.string().optional(),
        worker_name: z.string().optional(),
        tab: WORKBENCH_TAB_ENUM.optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      const focus = engine.setUiFocus({
        ...(args.swarm_id !== undefined ? { swarm_id: args.swarm_id } : {}),
        ...(args.worker_name !== undefined ? { worker_name: args.worker_name } : {}),
        ...(args.tab !== undefined ? { tab: args.tab as WorkbenchTab } : {}),
      });
      return okJson("ok", focus as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "app_get_worker_detail",
    {
      title: "App: Get Worker Detail",
      description: "Internal UI tool to inspect worker turns, events, and git diff.",
      inputSchema: z.object({ swarm_id: z.string(), name: z.string() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const detail = await engine.getWorkerDetail(args.swarm_id, args.name);
        return okJson("ok", detail as unknown as Record<string, unknown>);
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_get_turn_events",
    {
      title: "App: Poll Turn Events",
      description: "Internal UI tool for incremental turn trace streaming.",
      inputSchema: z.object({
        turn_id: z.string(),
        after_event_id: z.number().int().min(0).optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      const data = engine.getTurnEvents(args.turn_id, args.after_event_id ?? 0);
      return okJson("ok", data as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "app_board_post",
    {
      title: "App: Post Board Message",
      description: "Internal UI tool allowing the user to post a message directly to the board.",
      inputSchema: z.object({
        swarm_id: z.string(),
        text: z.string(),
        channel: z.string().optional(),
        suppress_wake: z.boolean().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const res = await engine.postMessage({
          swarm_id: args.swarm_id,
          sender: "user",
          channel: args.channel ?? "main",
          tag: "update",
          text: args.text,
          suppressWake: Boolean(args.suppress_wake),
        });
        return okJson(`Posted #${res.message.seq}`, res as unknown as Record<string, unknown>);
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_worker_action",
    {
      title: "App: Worker Action",
      description: "Internal UI tool for cancel/switch/merge/kill/refresh_backends actions.",
      inputSchema: z.object({
        action: z.enum(["cancel", "switch", "merge", "kill", "refresh_backends"]),
        swarm_id: z.string().optional(),
        name: z.string().optional(),
        backend: BACKEND_ENUM.optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        reason: z.string().optional(),
        resume_prompt: z.string().optional(),
        expected_sha: z.string().optional(),
        cleanup_workspace: z.boolean().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        if (args.action === "refresh_backends") {
          const backends = await engine.refreshBackends();
          return okJson("ok", { backends });
        }
        if (!args.swarm_id || !args.name) {
          return errJson("swarm_id and name are required.");
        }
        if (args.action === "cancel") {
          const cancelled = engine.cancelWorkerTurn(args.swarm_id, args.name);
          return okJson(cancelled ? "Cancelled" : "No running turn", { cancelled });
        }
        if (args.action === "switch") {
          if (!args.backend) return errJson("backend is required for switch.");
          const w = await engine.switchWorkerBackend({
            swarm_id: args.swarm_id,
            name: args.name,
            backend: args.backend as BackendId,
            model: args.model,
            effort: args.effort,
            reason: args.reason ?? "Switched from dashboard",
            resume_prompt: args.resume_prompt,
          });
          return okJson(`Switched to ${w.backend}`, { worker: w });
        }
        if (args.action === "merge") {
          const res = await engine.mergeWorker(args.swarm_id, args.name, { expectedSha: args.expected_sha });
          return okJson(res.message, res as unknown as Record<string, unknown>);
        }
        if (args.action === "kill") {
          const w = await engine.killWorker(
            args.swarm_id,
            args.name,
            args.cleanup_workspace ?? false,
          );
          return okJson(`Killed ${w.name}`, { worker: w });
        }
        return errJson("Unknown action");
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_evaluate_candidates",
    {
      title: "App: Evaluate Backend Candidates",
      description: "Internal UI tool for read-only evaluation of backend dispatch gates.",
      inputSchema: z.object({
        swarm_id: z.string().nullish(),
        repo_root: z.string().nullish(),
        capability: CAPABILITY_ENUM,
        role: ROLE_ENUM.optional(),
        identity_id: z.string().nullish(),
        review_of: z.string().nullish(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const candidates = await engine.evaluateCandidates({
          swarmId: args.swarm_id,
          repoRoot: args.repo_root,
          capability: args.capability,
          role: args.role,
          identityId: args.identity_id,
          reviewOf: args.review_of,
        });
        return okJson("ok", { candidates });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_list_backend_models",
    {
      title: "App: List Backend Models",
      description: "Internal UI tool to list local available models for each CLI backend.",
      inputSchema: z.object({
        refresh: z.boolean().optional(),
        company_id: AGY_COMPANY_ID.optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        if (args.company_id) {
          const models = await engine.listAgyCompanyModels(args.company_id, Boolean(args.refresh));
          return okJson("ok", { company_id: args.company_id, models });
        }
        const models = await engine.listAllBackendModels(Boolean(args.refresh));
        return okJson("ok", { models });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_update_backend_config",
    {
      title: "App: Update Backend Configuration",
      description:
        "Internal UI tool to enable/disable backends or update their default model and effort in backends.json.",
      inputSchema: z.object({
        swarm_id: z.string().optional(),
        surface: z.enum(["workbench", "inline", "global"]).optional(),
        updates: z.array(
          z.object({
            backend: REAL_BACKEND_ENUM,
            enabled: z.boolean().optional(),
            defaultModel: z.string().nullable().optional(),
            defaultEffort: z.string().nullable().optional(),
          }),
        ),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const backendConfigs = await engine.updateBackendConfigs(
          args.updates.map((u) => ({
            backend: u.backend as RealBackendId,
            enabled: u.enabled,
            defaultModel: u.defaultModel,
            defaultEffort: u.defaultEffort,
          })),
        );
        const snapshot = await engine.getDashboardSnapshot(args.swarm_id ?? null, {
          surface: args.surface,
        });
        return okJson("Updated backend settings", {
          backend_configs: backendConfigs,
          snapshot: snapshot as unknown as Record<string, unknown>,
        });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_get_dispatch_graph",
    {
      title: "App: Get Dispatch Graph",
      description: "Internal UI tool to fetch full dispatch flow graph for a swarm.",
      inputSchema: z.object({
        swarm_id: z.string(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const graph = engine.getDispatchGraph(args.swarm_id);
        return okJson("ok", { graph: graph as unknown as Record<string, unknown> });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_get_dispatch_policy",
    {
      title: "App: Get Dispatch Policy",
      description: "Internal UI tool to inspect four-layer dispatch policy and provenance.",
      inputSchema: z.object({
        swarm_id: z.string().optional(),
        repo_root: z.string().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const policy = engine.resolvePolicy({
          swarmId: args.swarm_id ?? null,
          repoRoot: args.repo_root ?? null,
        });
        return okJson("ok", { policy: policy as unknown as Record<string, unknown> });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_update_dispatch_policy",
    {
      title: "App: Update Dispatch Policy",
      description:
        "Internal UI tool to update global_ui, project, or session dispatch policy layers.",
      inputSchema: z.object({
        scope: z.enum(["global_ui", "project", "session"]),
        swarm_id: z.string().optional(),
        repo_root: z.string().optional(),
        surface: z.enum(["workbench", "inline", "global"]).optional(),
        patch: POLICY_LAYER_CONFIG_SCHEMA.nullable().optional(),
        reset: z.boolean().optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        const dispatchPolicy = await engine.updateDispatchPolicy({
          scope: args.scope,
          swarm_id: args.swarm_id ?? null,
          repo_root: args.repo_root ?? null,
          patch: (args.patch as DispatchPolicyLayerConfig | null | undefined) ?? null,
          reset: Boolean(args.reset),
        });
        const snapshot = await engine.getDashboardSnapshot(args.swarm_id ?? null, {
          surface: args.surface,
        });
        return okJson("Updated dispatch policy", {
          dispatch_policy: dispatchPolicy as unknown as Record<string, unknown>,
          snapshot: snapshot as unknown as Record<string, unknown>,
        });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "app_agy_companies",
    {
      title: "App: Manage Antigravity Companies",
      description: "Internal UI tool for registering saved logins as companies and editing company settings.",
      inputSchema: AGY_COMPANY_REQUEST,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try { return okJson("ok", engine.handleAgyCompanies(args)); }
      catch (err) { return errJson(err instanceof Error ? err.message : String(err)); }
    },
  );

  server.registerTool(
    "app_staff_roster",
    {
      title: "App: Manage Curated Staff Roster",
      description:
        "Internal UI tool to list, recruit/update, remove, or reset curated 3D staff cards.",
      inputSchema: z.object({
        op: z.enum(["list", "upsert", "delete", "reset"]),
        id: z.string().optional(),
        member: z
          .object({
            id: z.string().optional(),
            name: z.string(),
            title: z.string().optional(),
            avatar: z.enum(["aria", "leo", "theo", "jules", "mia"]).optional(),
            backend: REAL_BACKEND_ENUM,
            model: z.string().optional(),
            effort: z.string().nullable().optional(),
            role: ROLE_ENUM,
            capability: CAPABILITY_ENUM.optional(),
            identity_id: z.string().nullable().optional(),
            company_id: AGY_COMPANY_ID.nullable().optional(),
            bio: z.string().nullable().optional(),
            enabled: z.boolean().optional(),
          })
          .optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        if (args.op === "list") {
          return okJson("ok", { staff_roster: engine.getStaffRoster() });
        }
        if (args.op === "reset") {
          return okJson("Reset staff roster", { staff_roster: engine.resetStaffRoster() });
        }
        if (args.op === "delete") {
          if (!args.id?.trim()) return errJson("id is required for delete");
          return okJson("Removed employee", { staff_roster: engine.deleteStaffMember(args.id) });
        }
        if (!args.member) return errJson("member is required for upsert");
        const next = engine.upsertStaffMember({
          ...args.member,
          avatar: args.member.avatar as StaffAvatarId | undefined,
          backend: args.member.backend as RealBackendId,
          role: args.member.role as WorkerRole,
          capability: args.member.capability as CapabilityTag | undefined,
        });
        return okJson("Saved employee profile", { staff_roster: next });
      } catch (err) {
        return errJson(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
