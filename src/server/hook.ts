import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fetchHostConversationMeta, hasHostConversationEnv } from "../core/host_conversations.js";

interface TranscriptStep {
  step_index?: unknown;
  type?: unknown;
  created_at?: unknown;
  tool_calls?: unknown;
}

interface SessionBindingRow {
  conversation_id: string;
  team_id: string;
  active_swarm_id: string | null;
}

interface SwarmRow {
  id: string;
  title: string;
  status: string;
  updated_at: number;
}

interface WorkerRow {
  name: string;
  role: string;
  backend: string;
  model: string | null;
  state: string;
  total_tokens: number;
}

interface HookDedupeState {
  entries: Record<string, number>;
}

const MAX_DEDUPE_ENTRIES = 100;

function extractLogicalToolName(call: unknown): string {
  if (!call || typeof call !== "object") return "";
  const rec = call as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (name !== "call_mcp_tool") return name;
  let argsObj: Record<string, unknown> | null = null;
  if (typeof rec.args === "string") {
    try {
      const parsed = JSON.parse(rec.args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        argsObj = parsed as Record<string, unknown>;
      }
    } catch {
      argsObj = null;
    }
  } else if (rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)) {
    argsObj = rec.args as Record<string, unknown>;
  }
  const inner = argsObj && typeof argsObj.ToolName === "string" ? argsObj.ToolName.trim() : "";
  return inner || name;
}

function isToolMatch(toolName: string, target: string): boolean {
  return toolName === target || toolName.endsWith(`_${target}`) || toolName.endsWith(`/${target}`);
}

function isPolySwarmTool(toolName: string): boolean {
  return /(?:^|[_/])poly_(?:swarm|board|worker|workflow)(?:$|[_a-z0-9]*)/i.test(toolName);
}

function formatCompactTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.max(0, Math.round(tokens)));
}

function parseTranscriptLines(transcriptPath: string): TranscriptStep[] {
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const steps: TranscriptStep[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        steps.push(parsed as TranscriptStep);
      }
    } catch {
      // Ignore malformed or truncated JSONL tail lines
    }
  }
  return steps;
}

function readDedupeState(statePath: string): HookDedupeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rawEntries = (parsed as { entries?: unknown }).entries;
      if (rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries)) {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(rawEntries)) {
          if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
        }
        return { entries: clean };
      }
    }
  } catch {
    // Missing or corrupted cache file; treat as empty
  }
  return { entries: {} };
}

function writeDedupeState(statePath: string, state: HookDedupeState): void {
  const ordered = Object.entries(state.entries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DEDUPE_ENTRIES);
  const next: HookDedupeState = { entries: Object.fromEntries(ordered) };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, statePath);
}

export function evaluatePostInvocationHook(
  payload: Record<string, unknown>,
  opts: { dataDir?: string } = {},
): Record<string, unknown> {
  if (payload.hookEventName !== "PostInvocation") return {};

  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
  const transcriptPath = typeof payload.transcriptPath === "string" ? payload.transcriptPath.trim() : "";
  if (!conversationId || !transcriptPath || !fs.existsSync(transcriptPath)) return {};

  const dataDir =
    opts.dataDir?.trim() ||
    process.env.POLY_SWARM_HOOK_DATA_DIR?.trim() ||
    process.env.PLUGIN_DATA?.trim() ||
    path.join(os.homedir(), ".poly-swarm", "data");
  const dbPath = path.join(dataDir, "poly-swarm.db");
  if (!fs.existsSync(dbPath)) return {};

  const steps = parseTranscriptLines(transcriptPath);
  if (steps.length === 0) return {};

  let lastUserPos = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.type === "USER_INPUT") {
      lastUserPos = i;
      break;
    }
  }
  if (lastUserPos === -1) return {};

  const lastUser = steps[lastUserPos]!;
  const turnSteps = steps.slice(lastUserPos);
  let lastPlanner: TranscriptStep | null = null;
  for (let i = turnSteps.length - 1; i >= 0; i -= 1) {
    if (turnSteps[i]?.type === "PLANNER_RESPONSE") {
      lastPlanner = turnSteps[i]!;
      break;
    }
  }
  if (!lastPlanner) return {};
  if (Array.isArray(lastPlanner.tool_calls) && lastPlanner.tool_calls.length > 0) {
    return {};
  }

  const calledTools: string[] = [];
  for (const step of turnSteps) {
    if (step.type !== "PLANNER_RESPONSE" || !Array.isArray(step.tool_calls)) continue;
    for (const tc of step.tool_calls) {
      const logical = extractLogicalToolName(tc);
      if (logical) calledTools.push(logical);
    }
  }

  if (calledTools.some((name) => isToolMatch(name, "poly_swarm_recap"))) {
    return {};
  }
  const lastCalledTool = calledTools[calledTools.length - 1] ?? "";
  if (lastCalledTool && isToolMatch(lastCalledTool, "poly_swarm_dispatch")) {
    return {};
  }

  const touchedPolySwarmInTurn = calledTools.some((name) => isPolySwarmTool(name));

  let swarm: SwarmRow | null = null;
  let workers: WorkerRow[] = [];
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rawBinding = sqlite
      .prepare("SELECT conversation_id, team_id, active_swarm_id FROM session_bindings WHERE conversation_id = ?")
      .get(conversationId) as Record<string, unknown> | undefined;
    if (!rawBinding) return {};
    const binding = { ...rawBinding } as unknown as SessionBindingRow;

    if (binding.active_swarm_id) {
      const rawSwarm = sqlite
        .prepare("SELECT id, title, status, updated_at FROM swarms WHERE id = ?")
        .get(binding.active_swarm_id) as Record<string, unknown> | undefined;
      if (rawSwarm) swarm = { ...rawSwarm } as unknown as SwarmRow;
    }
    if (!swarm) {
      const rawFallback = sqlite
        .prepare(
          `SELECT s.id, s.title, s.status, s.updated_at
           FROM swarms s
           WHERE s.team_id = ?
             AND EXISTS (SELECT 1 FROM workers w WHERE w.swarm_id = s.id)
           ORDER BY s.updated_at DESC
           LIMIT 1`,
        )
        .get(binding.team_id) as Record<string, unknown> | undefined;
      if (rawFallback) swarm = { ...rawFallback } as unknown as SwarmRow;
    }
    if (!swarm) return {};

    const rawWorkers = sqlite
      .prepare(
        `SELECT w.name, w.role, w.backend, w.model, w.state,
                COALESCE((SELECT SUM(u.total_tokens) FROM usage_ledger u WHERE u.swarm_id = w.swarm_id AND u.worker_name = w.name), 0) AS total_tokens
         FROM workers w
         WHERE w.swarm_id = ?
         ORDER BY w.created_at ASC`,
      )
      .all(swarm.id) as Record<string, unknown>[];
    workers = rawWorkers.map((row) => ({ ...row }) as unknown as WorkerRow);
  } finally {
    sqlite.close();
  }

  if (workers.length === 0) return {};

  const userInputMs = typeof lastUser.created_at === "string" ? Date.parse(lastUser.created_at) || 0 : 0;
  if (!touchedPolySwarmInTurn && !(userInputMs > 0 && Number(swarm.updated_at) >= userInputMs - 5000)) {
    return {};
  }

  const lastUserStepIndex =
    typeof lastUser.step_index === "number" && Number.isFinite(lastUser.step_index)
      ? lastUser.step_index
      : lastUserPos;
  const dedupeKey = `${conversationId}:${lastUserStepIndex}:${swarm.id}`;
  const statePath = path.join(dataDir, "hook-recap-state.json");
  const dedupeState = readDedupeState(statePath);
  const previousUpdatedAt = dedupeState.entries[dedupeKey];
  if (typeof previousUpdatedAt === "number" && previousUpdatedAt >= Number(swarm.updated_at)) {
    return {};
  }

  dedupeState.entries[dedupeKey] = Number(swarm.updated_at);
  writeDedupeState(statePath, dedupeState);

  const statusText = swarm.status === "done" ? "已完成" : "进行中";
  const lines = workers.map((w) => {
    const modelPart = w.model ? `/${w.model}` : "";
    return `- **@${w.name}** · \`${w.backend}${modelPart}\` · ${w.role} · ${w.state} · ${formatCompactTokens(Number(w.total_tokens) || 0)} tokens`;
  });
  const markdown = [
    `**${workers.length} 位团队成员** · \`${swarm.title}\` (\`${swarm.id}\`, ${statusText})`,
    ...lines,
  ].join("\n");

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: "",
          metadata: {
            user_markdown: markdown,
          },
        },
      },
    ],
  };
}

function readStdinUtf8(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function extractFirstUserInputSummary(steps: readonly TranscriptStep[]): string | null {
  for (const step of steps) {
    if (step.type !== "USER_INPUT") continue;
    const rec = step as Record<string, unknown>;
    const candidates: string[] = [];
    const ui = (rec.userInput ?? rec.user_input ?? rec) as Record<string, unknown>;
    if (typeof ui.text === "string") candidates.push(ui.text);
    if (typeof rec.text === "string") candidates.push(rec.text);
    if (Array.isArray(ui.items)) {
      for (const item of ui.items) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          candidates.push(String((item as Record<string, unknown>).text));
        }
      }
    }
    const joined = candidates.join(" ").replace(/\s+/g, " ").trim();
    if (joined) return joined.slice(0, 80);
  }
  return null;
}

export async function syncHookConversationTitles(
  payload: Record<string, unknown>,
  opts: {
    dataDir?: string;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const dataDir =
    opts.dataDir?.trim() ||
    process.env.POLY_SWARM_HOOK_DATA_DIR?.trim() ||
    process.env.PLUGIN_DATA?.trim() ||
    path.join(os.homedir(), ".poly-swarm", "data");
  const dbPath = path.join(dataDir, "poly-swarm.db");
  if (!fs.existsSync(dbPath)) return 0;

  const env = opts.env ?? process.env;
  const payloadCid = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
  const transcriptPath = typeof payload.transcriptPath === "string" ? payload.transcriptPath.trim() : "";

  const sqlite = new DatabaseSync(dbPath);
  const candidateIds: string[] = [];
  let hasTable = false;
  try {
    const tbl = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_archives'")
      .get();
    hasTable = Boolean(tbl);
    if (!hasTable) return 0;

    if (payloadCid) candidateIds.push(payloadCid);
    const missingRows = sqlite
      .prepare(
        `SELECT DISTINCT s.conversation_id
         FROM swarms s
         LEFT JOIN conversation_archives ca ON ca.conversation_id = s.conversation_id
         WHERE s.conversation_id IS NOT NULL
           AND TRIM(s.conversation_id) <> ''
           AND (ca.host_title IS NULL OR TRIM(ca.host_title) = '')
         ORDER BY s.updated_at DESC
         LIMIT 8`,
      )
      .all() as Array<{ conversation_id?: string }>;
    for (const r of missingRows) {
      const cid = typeof r.conversation_id === "string" ? r.conversation_id.trim() : "";
      if (cid && !candidateIds.includes(cid)) candidateIds.push(cid);
    }
  } finally {
    sqlite.close();
  }

  if (candidateIds.length === 0) return 0;

  let synced = 0;
  const updates: Array<{ cid: string; title: string | null; summary: string | null; runState: string | null }> = [];
  if (hasHostConversationEnv(env)) {
    const now = Date.now();
    const toFetch = candidateIds.slice(0, 8);
    const results = await Promise.all(
      toFetch.map(async (cid) => ({
        cid,
        meta: await fetchHostConversationMeta(cid, {
          fetchImpl: opts.fetchImpl,
          env,
          timeoutMs: opts.timeoutMs ?? 600,
        }),
      })),
    );
    for (const item of results) {
      if (item.meta && (item.meta.title || item.meta.summary || item.meta.runState)) {
        updates.push({
          cid: item.cid,
          title: item.meta.title,
          summary: item.meta.summary,
          runState: item.meta.runState,
        });
      }
    }
    void now;
  }

  if (updates.length === 0 && payloadCid && transcriptPath && fs.existsSync(transcriptPath)) {
    const fallbackSummary = extractFirstUserInputSummary(parseTranscriptLines(transcriptPath));
    if (fallbackSummary) {
      updates.push({ cid: payloadCid, title: null, summary: fallbackSummary, runState: null });
    }
  }

  if (updates.length === 0) return 0;

  const writeDb = new DatabaseSync(dbPath);
  try {
    writeDb.exec("PRAGMA busy_timeout = 3000;");
    const now = Date.now();
    const ensureStmt = writeDb.prepare(
      `INSERT INTO conversation_archives (conversation_id, created_at, updated_at)
       VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING`,
    );
    const updateStmt = writeDb.prepare(
      `UPDATE conversation_archives
       SET host_title = COALESCE(?, host_title),
           host_summary = COALESCE(?, host_summary),
           host_run_state = COALESCE(?, host_run_state),
           host_synced_at = ?,
           updated_at = ?
       WHERE conversation_id = ?`,
    );
    for (const u of updates) {
      ensureStmt.run(u.cid, now, now);
      updateStmt.run(u.title, u.summary, u.runState, now, now, u.cid);
      synced += 1;
    }
  } finally {
    writeDb.close();
  }
  return synced;
}

export async function runPostInvocationHookCli(): Promise<void> {
  let output: Record<string, unknown> = {};
  try {
    const raw = readStdinUtf8().trim();
    if (raw) {
      const payload = JSON.parse(raw) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const rec = payload as Record<string, unknown>;
        await syncHookConversationTitles(rec).catch(() => 0);
        output = evaluatePostInvocationHook(rec);
      }
    }
  } catch (err) {
    console.error("[poly-swarm-hook] error:", err instanceof Error ? err.message : String(err));
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
