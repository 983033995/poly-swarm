import fs from "node:fs";
import http from "node:http";
import { z } from "zod";
import { REAL_BACKEND_IDS } from "../core/adapters/registry.js";
import type { PolySwarmEngine } from "../core/engine.js";
import { AGY_COMPANY_ID, AGY_COMPANY_REQUEST, UI_PREFERENCES_PATCH } from "../core/engine.js";
import type {
  BackendId,
  CapabilityTag,
  DispatchPolicyLayerConfig,
  RealBackendId,
  StaffAvatarId,
  WorkbenchTab,
  WorkerRole,
} from "../shared/types.js";
import { resolveDashboardHtmlPath, resolveInlineHtmlPath } from "./mcp.js";
import { runTeamAction, SURFACE, TEAM_ACTION_SCHEMA, TeamActionError } from "./team_actions.js";

const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const VALID_BACKENDS = new Set<string>([...REAL_BACKEND_IDS, "mock"]);
const PREFERENCES_BODY = z.union([
  z.strictObject({ patch: UI_PREFERENCES_PATCH }).transform(({ patch }) => patch),
  UI_PREFERENCES_PATCH,
]);
const CANDIDATE_QUERY = z.object({
  swarm_id: z.string().optional(),
  repo_root: z.string().optional(),
  capability: z.enum(["architect", "author", "verifier", "research", "enterprise", "fanout"]),
  role: z.enum(["author", "verifier", "researcher", "worker"]).optional(),
  identity_id: z.string().optional(),
  review_of: z.string().optional(),
});
const STAFF_ROSTER_BODY = z.object({
  op: z.enum(["list", "upsert", "delete", "reset"]),
  id: z.string().optional(),
  member: z
    .object({
      id: z.string().optional(),
      name: z.string().min(1),
      title: z.string().optional(),
      avatar: z.enum(["aria", "leo", "theo", "jules", "mia"]).optional(),
      backend: z.enum(REAL_BACKEND_IDS),
      model: z.string().optional(),
      effort: z.string().nullable().optional(),
      role: z.enum(["author", "verifier", "researcher", "worker"]),
      capability: z.enum(["architect", "author", "verifier", "research", "enterprise", "fanout"]).optional(),
      identity_id: z.string().nullable().optional(),
      company_id: AGY_COMPANY_ID.nullable().optional(),
      bio: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
});

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Invalid JSON request body");
  }
}

export function startDashboardHttpServer(engine: PolySwarmEngine, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = String(req.headers.host || "").trim().toLowerCase();
      const hostName = hostHeader.startsWith("[")
        ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
        : hostHeader.split(":")[0] ?? "";
      if (hostHeader && !ALLOWED_LOCAL_HOSTS.has(hostName)) {
        sendJson(res, 403, { error: "Forbidden host header" });
        return;
      }
      if (req.method === "POST") {
        const fetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
        if (fetchSite === "cross-site") {
          sendJson(res, 403, { error: "Forbidden cross-site request" });
          return;
        }
        const originHeader = String(req.headers.origin || "").trim();
        if (originHeader) {
          let originHost = "";
          try {
            originHost = new URL(originHeader).hostname.toLowerCase();
          } catch {
            sendJson(res, 403, { error: "Forbidden origin header" });
            return;
          }
          if (!ALLOWED_LOCAL_HOSTS.has(originHost)) {
            sendJson(res, 403, { error: "Forbidden origin header" });
            return;
          }
        }
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (!ct.includes("application/json")) {
          sendJson(res, 415, { error: "Unsupported Media Type: expected application/json" });
          return;
        }
      }

      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/codex") {
        const swarmId = url.searchParams.get("swarm_id")?.trim();
        const conversationId = url.searchParams.get("conversation_id")?.trim();
        if (!swarmId && conversationId) {
          const { swarm } = engine.resolveSessionTarget({ conversationId, bind: false, autoSelect: false });
          if (!swarm) throw new HttpError(404, "No task is bound to this Codex chat");
          res.writeHead(302, {
            Location: `/codex?${new URLSearchParams({ swarm_id: swarm.id })}`,
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        if (!swarmId) throw new HttpError(400, "swarm_id is required");
        if (!engine.db.getSwarm(swarmId)) throw new HttpError(404, "Swarm not found");
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/codex")) {
        const htmlPath = resolveDashboardHtmlPath();
        const html = fs.existsSync(htmlPath)
          ? fs.readFileSync(htmlPath, "utf8")
          : "<html><body>dashboard.html not built</body></html>";
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          ...(url.pathname === "/codex" ? { "Cache-Control": "no-store" } : {}),
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/inline") {
        const htmlPath = resolveInlineHtmlPath();
        const html = fs.existsSync(htmlPath)
          ? fs.readFileSync(htmlPath, "utf8")
          : "<html><body>inline-nodes.html not built</body></html>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/dashboard") {
        const swarmId = url.searchParams.get("swarm_id");
        const surface = SURFACE.safeParse(url.searchParams.get("surface")).data;
        const autoSelect = url.searchParams.get("auto_select");
        const snap = await engine.getDashboardSnapshot(swarmId, {
          teamId: url.searchParams.get("team_id"),
          conversationId: url.searchParams.get("conversation_id"),
          repoRoot: url.searchParams.get("repo_root"),
          surface,
          autoSelectLatest: autoSelect === "1",
          bind: false,
        });
        sendJson(res, 200, snap);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/teams") {
        sendJson(res, 200, await runTeamAction(engine, {
          action: "list",
          conversation_id: url.searchParams.get("conversation_id") ?? undefined,
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/team-action") {
        const body = TEAM_ACTION_SCHEMA.safeParse(await readJsonBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        sendJson(res, 200, await runTeamAction(engine, body.data));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/preferences") {
        sendJson(res, 200, { ui_preferences: engine.getUiPreferences() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/preferences") {
        const body = PREFERENCES_BODY.safeParse(await readJsonBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        sendJson(res, 200, { ui_preferences: engine.setUiPreferences(body.data) });
        return;
      }

      if (url.pathname === "/api/agy-companies" && (req.method === "GET" || req.method === "POST")) {
        const parsed = AGY_COMPANY_REQUEST.safeParse(
          req.method === "GET" ? { op: "list" } : await readJsonBody(req),
        );
        if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
        sendJson(res, 200, engine.handleAgyCompanies(parsed.data));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/staff-roster") {
        sendJson(res, 200, { staff_roster: engine.getStaffRoster() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/staff-roster") {
        const parsed = STAFF_ROSTER_BODY.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
        const { op, id, member } = parsed.data;
        if (op === "list") {
          sendJson(res, 200, { staff_roster: engine.getStaffRoster() });
          return;
        }
        if (op === "reset") {
          sendJson(res, 200, { staff_roster: engine.resetStaffRoster() });
          return;
        }
        if (op === "delete") {
          if (!id?.trim()) throw new HttpError(400, "id is required for delete");
          sendJson(res, 200, { staff_roster: engine.deleteStaffMember(id) });
          return;
        }
        if (!member) throw new HttpError(400, "member is required for upsert");
        sendJson(res, 200, {
          staff_roster: engine.upsertStaffMember({
            ...member,
            avatar: member.avatar as StaffAvatarId | undefined,
            backend: member.backend as RealBackendId,
            role: member.role as WorkerRole,
            capability: member.capability as CapabilityTag | undefined,
          }),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/focus") {
        const body = await readJsonBody(req);
        const tab = body.tab;
        const focus = engine.setUiFocus({
          ...(typeof body.swarm_id === "string" || body.swarm_id === null
            ? { swarm_id: body.swarm_id }
            : {}),
          ...(typeof body.worker_name === "string" || body.worker_name === null
            ? { worker_name: body.worker_name }
            : {}),
          ...(typeof tab === "string" &&
          ["overview", "board", "members", "settings", "detail", "usage", "graph"].includes(tab)
            ? { tab: tab as WorkbenchTab }
            : {}),
        });
        sendJson(res, 200, focus);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/backend-models") {
        const refresh = url.searchParams.get("refresh") === "1";
        const company = url.searchParams.get("company_id");
        if (company !== null) {
          const id = AGY_COMPANY_ID.safeParse(company);
          if (!id.success) throw new HttpError(400, "Invalid AGY company ID.");
          try {
            const models = await engine.listAgyCompanyModels(id.data, refresh);
            sendJson(res, 200, { company_id: id.data, models });
          } catch (err) {
            throw new HttpError(422, err instanceof Error ? err.message : "Unable to load AGY company models.");
          }
          return;
        }
        const models = await engine.listAllBackendModels(refresh);
        sendJson(res, 200, { models });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/backend-config") {
        const body = await readJsonBody(req);
        const rawUpdates = Array.isArray(body.updates) ? body.updates : [];
        const updates = rawUpdates
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => {
            const backend = String(item.backend || "");
            if (!REAL_BACKEND_IDS.includes(backend as RealBackendId)) {
              throw new HttpError(400, `Unsupported backend '${backend}'`);
            }
            return {
              backend: backend as RealBackendId,
              ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
              ...(item.defaultModel !== undefined
                ? { defaultModel: item.defaultModel === null ? null : String(item.defaultModel) }
                : {}),
              ...(item.defaultEffort !== undefined
                ? { defaultEffort: item.defaultEffort === null ? null : String(item.defaultEffort) }
                : {}),
            };
          });
        const backendConfigs = await engine.updateBackendConfigs(updates);
        const swarmId = typeof body.swarm_id === "string" ? body.swarm_id : null;
        const snapshot = await engine.getDashboardSnapshot(swarmId);
        sendJson(res, 200, { backend_configs: backendConfigs, snapshot });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/graph") {
        const swarmId = url.searchParams.get("swarm_id") || "";
        if (!swarmId) {
          throw new HttpError(400, "swarm_id is required");
        }
        const graph = engine.getDispatchGraph(swarmId);
        sendJson(res, 200, { graph });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/policy") {
        const swarmId = url.searchParams.get("swarm_id");
        const repoRoot = url.searchParams.get("repo_root");
        const policy = engine.resolvePolicy({
          swarmId: swarmId || null,
          repoRoot: repoRoot || null,
        });
        sendJson(res, 200, { policy });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/policy") {
        const body = await readJsonBody(req);
        const scope = String(body.scope || "");
        if (!["global_ui", "project", "session"].includes(scope)) {
          throw new HttpError(400, `Unsupported policy scope '${scope}'`);
        }
        const swarmId = typeof body.swarm_id === "string" ? body.swarm_id : null;
        const repoRoot = typeof body.repo_root === "string" ? body.repo_root : null;
        const surface =
          body.surface === "workbench" || body.surface === "inline" || body.surface === "global"
            ? body.surface
            : undefined;
        const patch =
          body.patch && typeof body.patch === "object" && !Array.isArray(body.patch)
            ? (body.patch as DispatchPolicyLayerConfig)
            : null;
        const dispatchPolicy = await engine.updateDispatchPolicy({
          scope: scope as "global_ui" | "project" | "session",
          swarm_id: swarmId,
          repo_root: repoRoot,
          patch,
          reset: Boolean(body.reset),
        });
        const snapshot = await engine.getDashboardSnapshot(swarmId, { surface });
        sendJson(res, 200, { dispatch_policy: dispatchPolicy, snapshot });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/worker") {
        const swarmId = url.searchParams.get("swarm_id") || "";
        const name = url.searchParams.get("name") || "";
        const detail = await engine.getWorkerDetail(swarmId, name);
        sendJson(res, 200, detail);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/candidates") {
        const query = CANDIDATE_QUERY.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) throw new HttpError(400, "Invalid candidate capability or role");
        const args = query.data;
        const candidates = await engine.evaluateCandidates({
          swarmId: args.swarm_id,
          repoRoot: args.repo_root,
          capability: args.capability,
          role: args.role,
          identityId: args.identity_id,
          reviewOf: args.review_of,
        });
        sendJson(res, 200, { candidates });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/turn-events") {
        const turnId = url.searchParams.get("turn_id") || "";
        const after = Number(url.searchParams.get("after_event_id") || "0");
        const data = engine.getTurnEvents(turnId, Number.isFinite(after) ? after : 0);
        sendJson(res, 200, data);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/board") {
        const body = await readJsonBody(req);
        const result = await engine.postMessage({
          swarm_id: String(body.swarm_id || ""),
          sender: "user",
          channel: typeof body.channel === "string" ? body.channel : "main",
          tag: "update",
          text: String(body.text || ""),
          suppressWake: Boolean(body.suppress_wake),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/worker-action") {
        const body = await readJsonBody(req);
        const action = String(body.action || "");
        if (action === "refresh_backends") {
          const backends = await engine.refreshBackends();
          sendJson(res, 200, { backends });
          return;
        }
        const swarmId = String(body.swarm_id || "");
        const name = String(body.name || "");
        if (action === "cancel") {
          sendJson(res, 200, { cancelled: engine.cancelWorkerTurn(swarmId, name) });
          return;
        }
        if (action === "switch") {
          const nextBackend = String(body.backend || "");
          if (!VALID_BACKENDS.has(nextBackend)) {
            throw new HttpError(400, `Invalid backend '${nextBackend}'`);
          }
          const w = await engine.switchWorkerBackend({
            swarm_id: swarmId,
            name,
            backend: nextBackend as BackendId,
            model: typeof body.model === "string" ? body.model : null,
            effort: typeof body.effort === "string" ? body.effort : null,
            reason: typeof body.reason === "string" ? body.reason : "Switched from web UI",
            resume_prompt: typeof body.resume_prompt === "string" ? body.resume_prompt : undefined,
          });
          sendJson(res, 200, { worker: w });
          return;
        }
        if (action === "merge") {
          if (body.expected_sha !== undefined && typeof body.expected_sha !== "string") {
            throw new HttpError(400, "expected_sha must be a string");
          }
          sendJson(res, 200, await engine.mergeWorker(swarmId, name, { expectedSha: body.expected_sha }));
          return;
        }
        if (action === "kill") {
          sendJson(res, 200, {
            worker: await engine.killWorker(swarmId, name, Boolean(body.cleanup_workspace)),
          });
          return;
        }
        sendJson(res, 400, { error: `Unknown action: ${action}` });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const status = err instanceof HttpError || err instanceof TeamActionError ? err.status : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on("error", (err) => {
    console.error(`[poly-swarm] HTTP dashboard error on port ${port}:`, err);
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      console.error(`[poly-swarm] HTTP dashboard listening at http://127.0.0.1:${address.port}`);
    }
  });

  return server;
}
