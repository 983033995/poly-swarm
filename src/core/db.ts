import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgyCompany,
  BackendHealth,
  BackendId,
  BoardMessage,
  CapabilityTag,
  ChannelRecord,
  ConversationArchiveSummary,
  ConversationArchivesPayload,
  ConversationWaveSummary,
  DispatchEdgeRecord,
  DispatchPolicyLayerConfig,
  ErrorKind,
  EventKind,
  GraphEdgeKind,
  MessageTag,
  PendingDispatchRecord,
  PendingDispatchStatus,
  PolicyLayer,
  SessionBindingRecord,
  SwarmBriefSummary,
  SwarmPlan,
  SwarmRecord,
  TeamRecord,
  TeamSummary,
  TurnRecord,
  UsageAccuracy,
  UsageAggregate,
  UsageRecord,
  VendorUsageSummary,
  WorkerEvent,
  WorkerRecord,
  WorkerRole,
  WorkerState,
  WorkflowDefinition,
  WorkflowRecord,
  WorkspaceMode,
} from "../shared/types.js";
import { aggregateNormalizedUsage, aggregateUsageByVendor, type SwarmTurnUsageRow } from "./pricing.js";

function normalizeRow<T>(row: unknown): T | null {
  if (!row || typeof row !== "object") return null;
  return { ...(row as Record<string, unknown>) } as T;
}

function normalizeRows<T>(rows: unknown[]): T[] {
  return rows.map((r) => ({ ...(r as Record<string, unknown>) }) as T);
}

export const STAFF_ROSTER_KV_KEY = "staff_roster";
const TALENT_IMPORTED_KEY = "legacy_talent_imported";
const TALENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agy_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    default_model TEXT,
    default_effort TEXT,
    cooldown_until INTEGER
  );
`;

function immediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function readKv(db: DatabaseSync, key: string): unknown {
  const row = db.prepare("SELECT value_json FROM app_kv WHERE key = ?").get(key);
  return row ? JSON.parse(String(row.value_json)) : null;
}

function writeKv(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO app_kv (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now());
}

function openSharedTalent(file: string, legacyFiles: string[]): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    immediateTransaction(db, () => {
      db.exec(TALENT_SCHEMA);
      if (readKv(db, TALENT_IMPORTED_KEY)) return;
      const companies = new Map<string, AgyCompany>();
      const employees = new Map<string, Record<string, unknown>>();
      let savedRoster = false;
      const companyFields = (company: AgyCompany) =>
        JSON.stringify([company.name, company.enabled, company.default_model, company.default_effort]);
      const staffFields = (employee: Record<string, unknown>) =>
        JSON.stringify(Object.keys(employee).sort().filter((key) => key !== "created_at" && key !== "updated_at")
          .map((key) => [key, employee[key]]));
      for (const legacyFile of new Set(legacyFiles.map((item) => path.resolve(item)))) {
        try {
          fs.statSync(legacyFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        const legacy = new DatabaseSync(legacyFile, { readOnly: true });
        try {
          legacy.exec("PRAGMA busy_timeout = 5000; BEGIN;");
          const hasTable = (table: string) => legacy.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
          if (hasTable("agy_companies")) {
            const rows = normalizeRows<Omit<AgyCompany, "enabled"> & { enabled: number }>(
              legacy.prepare("SELECT * FROM agy_companies ORDER BY rowid").all(),
            );
            for (const row of rows) {
              const company = { ...row, enabled: row.enabled === 1 };
              const prev = companies.get(company.id);
              if (prev && companyFields(prev) !== companyFields(company)) {
                throw new Error(`Conflicting company records for '${company.id}' in the host talent catalogs.`);
              }
              companies.set(company.id, { ...company, cooldown_until: Math.max(prev?.cooldown_until ?? 0, company.cooldown_until ?? 0) || null });
            }
          }
          const roster = hasTable("app_kv") ? readKv(legacy, STAFF_ROSTER_KV_KEY) : null;
          if (!Array.isArray(roster)) continue;
          savedRoster = true;
          for (const employee of roster) {
            if (!employee || typeof employee.id !== "string" || !employee.id.trim()) continue;
            const prev = employees.get(employee.id);
            if (prev && staffFields(prev) !== staffFields(employee)) {
              throw new Error(`Conflicting employee records for '${employee.id}' in the host talent catalogs.`);
            }
            if (!prev) employees.set(employee.id, employee);
          }
        } finally {
          legacy.close();
        }
      }
      const insert = db.prepare("INSERT INTO agy_companies (id, name, enabled, default_model, default_effort, cooldown_until) VALUES (?, ?, ?, ?, ?, ?)");
      for (const company of companies.values()) {
        insert.run(company.id, company.name, company.enabled ? 1 : 0, company.default_model, company.default_effort, company.cooldown_until);
      }
      if (savedRoster) writeKv(db, STAFF_ROSTER_KV_KEY, [...employees.values()]);
      writeKv(db, TALENT_IMPORTED_KEY, true);
    });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

// s is the candidate swarm. Workflow steps create turns, not roster members.
const REAL_SWARM = `(s.auto_created_by_workflow = 0
  OR EXISTS (SELECT 1 FROM workers w WHERE w.swarm_id = s.id))`;

export interface ParsedMessageSignals {
  mentions: string[];
  channelMentions: string[];
  refs: number[];
  hasAll: boolean;
}

/**
 * Strips fenced code blocks (``` / ~~~) and paired inline code spans in a single pass
 * while leaving unclosed stray backticks intact so real @mentions are neither leaked nor swallowed.
 */
export function stripMarkdownCode(text: string): string {
  let out = "";
  let i = 0;
  let atLineStart = true;
  const len = text.length;

  while (i < len) {
    if (atLineStart) {
      let sp = 0;
      while (sp < 3 && i + sp < len && text[i + sp] === " ") {
        sp += 1;
      }
      const ch = text[i + sp];
      if (ch === "`" || ch === "~") {
        let fenceLen = 0;
        while (i + sp + fenceLen < len && text[i + sp + fenceLen] === ch) {
          fenceLen += 1;
        }
        if (fenceLen >= 3) {
          const lineBreakIdx = text.indexOf("\n", i + sp + fenceLen);
          const eol = lineBreakIdx === -1 ? len : lineBreakIdx;
          const info = text.slice(i + sp + fenceLen, eol);
          if (ch !== "`" || !info.includes("`")) {
            let pos = eol === len ? len : eol + 1;
            let closedEnd = len;
            while (pos < len) {
              const nextNl = text.indexOf("\n", pos);
              const lineEnd = nextNl === -1 ? len : nextNl;
              const line = text.slice(pos, lineEnd).replace(/\r$/, "");
              const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
              if (
                closeMatch &&
                closeMatch[1]![0] === ch &&
                closeMatch[1]!.length >= fenceLen
              ) {
                closedEnd = nextNl === -1 ? len : nextNl + 1;
                break;
              }
              pos = nextNl === -1 ? len : nextNl + 1;
            }
            out += " \n";
            i = closedEnd;
            atLineStart = true;
            continue;
          }
        }
      }
    }

    if (text[i] === "`") {
      let openLen = 0;
      while (i + openLen < len && text[i + openLen] === "`") {
        openLen += 1;
      }
      let j = i + openLen;
      let closeEnd = -1;
      while (j < len) {
        // Guard against stray single/double backticks swallowing across paragraph breaks
        if (openLen < 3 && text[j] === "\n") {
          const rest = text.slice(j + 1);
          if (/^[ \t]*\r?\n/.test(rest)) {
            break;
          }
        }
        if (text[j] === "`") {
          let closeLen = 0;
          while (j + closeLen < len && text[j + closeLen] === "`") {
            closeLen += 1;
          }
          if (closeLen === openLen) {
            closeEnd = j + closeLen;
            break;
          }
          j += closeLen;
        } else {
          j += 1;
        }
      }
      if (closeEnd !== -1) {
        out += " ";
        i = closeEnd;
        atLineStart = false;
        continue;
      }
      out += text.slice(i, i + openLen);
      i += openLen;
      atLineStart = false;
      continue;
    }

    const cur = text[i]!;
    out += cur;
    atLineStart = cur === "\n";
    i += 1;
  }

  return out;
}

export function parseMessageSignals(text: string): ParsedMessageSignals {
  const channelMentions = new Set<string>();
  const mentions = new Set<string>();
  const refs = new Set<number>();

  const cleaned = stripMarkdownCode(text);

  // Match @#channel first so it isn't also counted as a plain #ref
  const channelRegex = /(?:^|[^a-zA-Z0-9._-])@#([a-z0-9][a-z0-9_-]{0,31})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = channelRegex.exec(cleaned)) !== null) {
    if (m[1]) channelMentions.add(m[1].toLowerCase());
  }

  const mentionRegex = /(?:^|[^a-zA-Z0-9._-])@([a-z0-9][a-z0-9_-]{0,31})\b/gi;
  while ((m = mentionRegex.exec(cleaned)) !== null) {
    if (m[1]) mentions.add(m[1].toLowerCase());
  }

  // Match standalone #123 references (not preceded by @ or identifier char)
  const refRegex = /(?:^|[^a-zA-Z0-9._@-])#(\d{1,7})\b/g;
  while ((m = refRegex.exec(cleaned)) !== null) {
    const seq = Number(m[1]);
    if (Number.isInteger(seq) && seq > 0) refs.add(seq);
  }

  return {
    mentions: [...mentions],
    channelMentions: [...channelMentions],
    refs: [...refs],
    hasAll: mentions.has("all"),
  };
}

export class PolySwarmDB {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;
  private readonly talent: DatabaseSync;

  constructor(dataDir: string, sharedTalent?: { file: string; legacyFiles: string[] }) {
    if (dataDir === ":memory:") {
      this.dbPath = ":memory:";
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      this.dbPath = path.join(dataDir, "poly-swarm.db");
    }
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.init();
      this.talent = sharedTalent
        ? openSharedTalent(sharedTalent.file, [...sharedTalent.legacyFiles, this.dbPath].filter((file) => file !== ":memory:"))
        : this.db;
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.transaction(() => this.migrate());
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        base_branch TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        plan_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT,
        repo_root TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        active_swarm_id TEXT,
        policy_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_bindings (
        conversation_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        active_swarm_id TEXT,
        repo_root TEXT,
        window_label TEXT,
        last_opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_archives (
        conversation_id TEXT PRIMARY KEY,
        custom_title TEXT,
        host_title TEXT,
        host_summary TEXT,
        host_run_state TEXT,
        host_synced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      ${TALENT_SCHEMA}

      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        topic TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(swarm_id, name)
      );

      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        capability TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        state TEXT NOT NULL DEFAULT 'waiting',
        workspace_mode TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        worktree_branch TEXT,
        session_id TEXT,
        needs_handoff INTEGER NOT NULL DEFAULT 0,
        auto_fallback INTEGER NOT NULL DEFAULT 1,
        review_of TEXT,
        channels_json TEXT NOT NULL DEFAULT '["main"]',
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        last_post_seq INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(swarm_id, name)
      );

      CREATE TABLE IF NOT EXISTS board_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        channel TEXT NOT NULL DEFAULT 'main',
        sender TEXT NOT NULL,
        tag TEXT NOT NULL DEFAULT 'update',
        text TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        refs_json TEXT NOT NULL DEFAULT '[]',
        turn_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        worker_name TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT,
        mode TEXT NOT NULL,
        trigger_seq INTEGER,
        prompt_preview TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        error_kind TEXT NOT NULL DEFAULT 'none',
        error_message TEXT,
        output_text TEXT,
        structured_json TEXT,
        session_id_used TEXT,
        session_id_returned TEXT,
        duration_ms INTEGER,
        tool_calls_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS worker_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        swarm_id TEXT NOT NULL,
        worker_name TEXT NOT NULL,
        seq_in_turn INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        meta_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        swarm_id TEXT NOT NULL,
        worker_name TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT,
        accuracy TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tool_calls_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backend_health (
        backend TEXT PRIMARY KEY,
        installed INTEGER NOT NULL DEFAULT 0,
        binary_path TEXT,
        version TEXT,
        supports_acp INTEGER NOT NULL DEFAULT 0,
        supports_headless INTEGER NOT NULL DEFAULT 1,
        supports_resume INTEGER NOT NULL DEFAULT 0,
        supports_exact_usage INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER,
        cooldown_reason TEXT,
        last_checked_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        swarm_id TEXT,
        description TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        results_json TEXT,
        logs_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS server_instances (
        instance_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dispatch_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        kind TEXT NOT NULL,
        seq INTEGER,
        turn_id TEXT,
        label TEXT,
        meta_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_dispatches (
        swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        worker_name TEXT NOT NULL,
        trigger_seq INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        owner_instance_id TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (swarm_id, worker_name)
      );

      CREATE INDEX IF NOT EXISTS idx_board_swarm_seq ON board_messages(swarm_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_turn_id ON worker_events(turn_id, id);
      CREATE INDEX IF NOT EXISTS idx_turns_worker ON turns(swarm_id, worker_name, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_routing ON turns(backend, model, mode, ended_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_swarm ON usage_ledger(swarm_id, backend, worker_name);
      CREATE INDEX IF NOT EXISTS idx_dispatch_edges_swarm ON dispatch_edges(swarm_id, id);
      CREATE INDEX IF NOT EXISTS idx_pending_dispatches_status ON pending_dispatches(status, updated_at ASC);
    `);

    this.ensureColumn("board_messages", "suppress_wake", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workers", "owner_instance_id", "TEXT");
    this.ensureColumn("turns", "owner_instance_id", "TEXT");
    this.ensureColumn("turns", "effort", "TEXT");
    this.ensureColumn("turns", "actual_model", "TEXT");
    this.ensureColumn("backend_health", "supports_strict_readonly", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("backend_health", "cli_supports_acp", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("backend_health", "active_protocol", "TEXT NOT NULL DEFAULT 'headless_cli'");
    this.ensureColumn("swarms", "policy_json", "TEXT");
    this.ensureColumn("swarms", "team_id", "TEXT");
    this.ensureColumn("swarms", "conversation_id", "TEXT");
    this.ensureColumn("swarms", "conversation_source", "TEXT");
    this.ensureColumn("swarms", "wave_index", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("swarms", "auto_created_by_workflow", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workers", "identity_id", "TEXT");
    this.ensureColumn("workers", "agy_account_id", "TEXT");
    this.ensureColumn("workers", "parent_node", "TEXT");
    this.ensureColumn("workers", "policy_source", "TEXT");
    this.ensureColumn("workers", "resolved_policy_json", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_swarms_team ON swarms(team_id, wave_index DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swarms_conversation ON swarms(conversation_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_teams_repo_updated ON teams(repo_root, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_bindings_team ON session_bindings(team_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_bindings_repo ON session_bindings(repo_root, last_opened_at DESC);
    `);
    this.backfillLegacySwarmsToTeams();
  }

  private ensureColumn(table: string, column: string, columnDef: string): void {
    const cols = normalizeRows<{ name: string }>(this.db.prepare(`PRAGMA table_info(${table})`).all());
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
    }
  }

  private backfillLegacySwarmsToTeams(): void {
    const swarms = normalizeRows<SwarmRecord>(
      this.db.prepare("SELECT * FROM swarms WHERE team_id IS NULL ORDER BY created_at ASC").all(),
    );
    const insertTeam = this.db.prepare(`
      INSERT INTO teams (id, name, repo_root, status, active_swarm_id, policy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `);
    const assignTeam = this.db.prepare(`
      UPDATE swarms SET team_id = ?, auto_created_by_workflow = CASE
        WHEN title GLOB 'Workflow:*' AND NOT EXISTS (SELECT 1 FROM workers WHERE swarm_id = swarms.id) THEN 1
        ELSE auto_created_by_workflow END
      WHERE id = ?
    `);
    for (const swarm of swarms) {
      const teamId = `tm-${swarm.id.replace(/^sw-/, "")}`;
      const status = swarm.status === "done" ? "paused" : swarm.status;
      insertTeam.run(teamId, swarm.title, path.resolve(swarm.repo_root), status, swarm.id,
        swarm.policy_json ?? null, swarm.created_at, swarm.updated_at);
      assignTeam.run(teamId, swarm.id);
    }
  }

  transaction<T>(operation: () => T): T {
    return immediateTransaction(this.db, operation);
  }

  talentTransaction<T>(operation: () => T): T {
    return immediateTransaction(this.talent, operation);
  }

  initializeSharedRoster(makeDefault: () => unknown): void {
    if (this.talent === this.db) return;
    this.talentTransaction(() => {
      if (readKv(this.talent, STAFF_ROSTER_KV_KEY) === null) {
        writeKv(this.talent, STAFF_ROSTER_KV_KEY, makeDefault());
      }
    });
  }

  registerInstance(instanceId: string, pid = process.pid, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO server_instances (instance_id, pid, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           pid = excluded.pid,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(instanceId, pid, now, now);
  }

  heartbeatInstance(instanceId: string, now = Date.now()): void {
    this.db
      .prepare(`UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ?`)
      .run(now, instanceId);
  }

  unregisterInstance(instanceId: string): void {
    this.db.prepare(`DELETE FROM server_instances WHERE instance_id = ?`).run(instanceId);
  }

  listInstances(): Array<{ instance_id: string; pid: number; started_at: number; heartbeat_at: number }> {
    const rows = this.db.prepare(`SELECT * FROM server_instances ORDER BY started_at ASC`).all();
    return normalizeRows<{ instance_id: string; pid: number; started_at: number; heartbeat_at: number }>(rows);
  }

  close(): void {
    if (this.talent !== this.db) this.talent.close();
    this.db.close();
  }

  // --- Teams and session bindings ---

  createTeam(input: {
    id?: string;
    name: string;
    goal?: string | null;
    repo_root: string;
    status?: TeamRecord["status"];
    active_swarm_id?: string | null;
    policy_json?: string | null;
  }): TeamRecord {
    const id = input.id ?? `tm-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO teams (id, name, goal, repo_root, status, active_swarm_id, policy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.goal ?? null, path.resolve(input.repo_root), input.status ?? "active",
      input.active_swarm_id ?? null, input.policy_json ?? null, now, now);
    return this.getTeam(id)!;
  }

  getTeam(id: string): TeamRecord | null {
    return normalizeRow<TeamRecord>(this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id));
  }

  listTeams(limit = 30): TeamRecord[] {
    return normalizeRows<TeamRecord>(this.db.prepare(`
      SELECT * FROM teams ORDER BY updated_at DESC, rowid DESC LIMIT ?
    `).all(limit));
  }

  updateTeam(
    id: string,
    patch: Partial<Pick<TeamRecord, "name" | "goal" | "repo_root" | "status" | "active_swarm_id" | "policy_json">>,
  ): TeamRecord {
    const team = this.getTeam(id);
    if (!team) throw new Error(`Team '${id}' not found.`);
    this.db.prepare(`
      UPDATE teams SET name = ?, goal = ?, repo_root = ?, status = ?, active_swarm_id = ?, policy_json = ?,
        updated_at = ? WHERE id = ?
    `).run(patch.name ?? team.name, patch.goal === undefined ? team.goal : patch.goal,
      patch.repo_root === undefined ? team.repo_root : path.resolve(patch.repo_root), patch.status ?? team.status,
      patch.active_swarm_id === undefined ? team.active_swarm_id : patch.active_swarm_id,
      patch.policy_json === undefined ? team.policy_json ?? null : patch.policy_json, Date.now(), id);
    return this.getTeam(id)!;
  }

  listTeamSwarms(teamId: string): SwarmRecord[] {
    return normalizeRows<SwarmRecord>(this.db.prepare(`
      SELECT * FROM swarms WHERE team_id = ? ORDER BY wave_index DESC, updated_at DESC, rowid DESC
    `).all(teamId));
  }

  findLatestTeamByRepo(repoRoot: string, options?: { excludeEmptyWorkflow?: boolean }): TeamRecord | null {
    return normalizeRow<TeamRecord>(this.db.prepare(`
      SELECT t.* FROM teams t WHERE t.repo_root = ?
      ${options?.excludeEmptyWorkflow ? `AND (
        NOT EXISTS (SELECT 1 FROM swarms WHERE team_id = t.id)
        OR EXISTS (SELECT 1 FROM swarms s WHERE s.team_id = t.id AND ${REAL_SWARM})
      )` : ""}
      ORDER BY (t.status = 'active') DESC, t.updated_at DESC, t.rowid DESC LIMIT 1
    `).get(path.resolve(repoRoot)));
  }

  upsertSessionBinding(input: {
    conversation_id: string;
    team_id: string;
    active_swarm_id?: string | null;
    repo_root?: string | null;
    window_label?: string | null;
    last_opened_at?: number;
  }): SessionBindingRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_bindings
        (conversation_id, team_id, active_swarm_id, repo_root, window_label, last_opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET team_id = excluded.team_id,
        active_swarm_id = excluded.active_swarm_id, repo_root = excluded.repo_root,
        window_label = CASE WHEN ? THEN excluded.window_label ELSE session_bindings.window_label END,
        last_opened_at = excluded.last_opened_at, updated_at = excluded.updated_at
    `).run(input.conversation_id, input.team_id, input.active_swarm_id ?? null,
      input.repo_root ? path.resolve(input.repo_root) : null, input.window_label ?? null, input.last_opened_at ?? now,
      now, input.window_label !== undefined ? 1 : 0);
    return this.getSessionBinding(input.conversation_id)!;
  }

  getSessionBinding(conversationId: string): SessionBindingRecord | null {
    return normalizeRow<SessionBindingRecord>(
      this.db.prepare("SELECT * FROM session_bindings WHERE conversation_id = ?").get(conversationId),
    );
  }

  listSessionBindingsByTeam(teamId: string): SessionBindingRecord[] {
    return normalizeRows<SessionBindingRecord>(this.db.prepare(`
      SELECT * FROM session_bindings WHERE team_id = ? ORDER BY updated_at DESC, rowid DESC
    `).all(teamId));
  }

  findLatestBindingByRepo(repoRoot: string): SessionBindingRecord | null {
    return normalizeRow<SessionBindingRecord>(this.db.prepare(`
      SELECT b.* FROM session_bindings b
      JOIN teams t ON t.id = b.team_id
      LEFT JOIN swarms s ON s.id = b.active_swarm_id AND s.team_id = t.id
      WHERE b.repo_root = ? AND (s.id IS NULL OR ${REAL_SWARM})
      ORDER BY (t.status = 'active') DESC, b.last_opened_at DESC, b.rowid DESC LIMIT 1
    `).get(path.resolve(repoRoot)));
  }

  getAppKv<T>(key: string): T | null {
    return readKv(key === STAFF_ROSTER_KV_KEY ? this.talent : this.db, key) as T | null;
  }

  setAppKv<T>(key: string, value: T): void {
    writeKv(key === STAFF_ROSTER_KV_KEY ? this.talent : this.db, key, value);
  }

  listTeamBlackboard(teamId: string, limit = 3): BoardMessage[] {
    return normalizeRows<BoardMessage>(this.db.prepare(`
      SELECT * FROM (
        SELECT m.* FROM board_messages m JOIN swarms s ON s.id = m.swarm_id
        WHERE s.team_id = ? AND m.tag IN ('brief','done','review_pass','review_fail','blocked','stall')
        ORDER BY m.seq DESC LIMIT ?
      ) ORDER BY seq ASC
    `).all(teamId, limit));
  }

  listTeamSummaries(limit = 30, currentConversationId?: string | null): TeamSummary[] {
    const currentTeamId = currentConversationId ? this.getSessionBinding(currentConversationId)?.team_id : null;
    return this.listTeams(limit).map((team) => {
      const waves = this.listTeamSwarms(team.id);
      const stats = Object.values(this.listSwarmBriefSummaries(waves.map((s) => s.id)));
      const sum = (key: Exclude<keyof SwarmBriefSummary, "backends">) =>
        stats.reduce((total, s) => total + s[key], 0);
      return {
        team, waves, wave_count: waves.length,
        worker_count: sum("worker_count"), active_worker_count: sum("active_worker_count"),
        backends: [...new Set(stats.flatMap((s) => s.backends))].sort(),
        known_cost_usd: sum("known_cost_usd"), priced_turns: sum("priced_turns"),
        unpriced_turns: sum("unpriced_turns"), total_tokens: sum("total_tokens"),
        bound_conversations: this.listSessionBindingsByTeam(team.id).length,
        is_bound_to_current: team.id === currentTeamId,
        latest_blackboard: this.listTeamBlackboard(team.id),
      };
    });
  }

  ensureConversationArchive(conversationId: string, now = Date.now()): void {
    const id = conversationId.trim();
    if (!id) return;
    this.db.prepare(`
      INSERT INTO conversation_archives (conversation_id, created_at, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING
    `).run(id, now, now);
  }

  getConversationArchiveMeta(conversationId: string): {
    conversation_id: string;
    custom_title: string | null;
    host_title: string | null;
    host_summary: string | null;
    host_run_state: string | null;
    host_synced_at: number | null;
    created_at: number;
    updated_at: number;
  } | null {
    return normalizeRow(
      this.db.prepare("SELECT * FROM conversation_archives WHERE conversation_id = ?").get(conversationId),
    );
  }

  upsertConversationMeta(
    conversationId: string,
    patch: {
      custom_title?: string | null;
      host_title?: string | null;
      host_summary?: string | null;
      host_run_state?: string | null;
      host_synced_at?: number | null;
    },
  ): void {
    const id = conversationId.trim();
    if (!id) return;
    const now = Date.now();
    this.ensureConversationArchive(id, now);
    const cur = this.getConversationArchiveMeta(id);
    if (!cur) return;
    const clean = (v: string | null | undefined, fallback: string | null): string | null => {
      if (v === undefined) return fallback;
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed : null;
    };
    this.db.prepare(`
      UPDATE conversation_archives
      SET custom_title = ?, host_title = ?, host_summary = ?, host_run_state = ?, host_synced_at = ?, updated_at = ?
      WHERE conversation_id = ?
    `).run(
      clean(patch.custom_title, cur.custom_title),
      clean(patch.host_title, cur.host_title),
      clean(patch.host_summary, cur.host_summary),
      clean(patch.host_run_state, cur.host_run_state),
      patch.host_synced_at === undefined ? cur.host_synced_at : patch.host_synced_at,
      now,
      id,
    );
  }

  assignSwarmConversation(swarmId: string, targetConversationId: string | null): SwarmRecord {
    const swarm = this.getSwarm(swarmId);
    if (!swarm) throw new Error(`Swarm '${swarmId}' not found.`);
    const target = targetConversationId?.trim() || null;
    if (target) {
      if (swarm.conversation_id && swarm.conversation_id !== target && swarm.conversation_source !== "manual") {
        throw new Error(`Swarm '${swarmId}' already belongs to conversation '${swarm.conversation_id}'.`);
      }
      this.transaction(() => {
        this.ensureConversationArchive(target);
        this.db.prepare(`
          UPDATE swarms SET conversation_id = ?, conversation_source = 'manual' WHERE id = ?
        `).run(target, swarmId);
      });
    } else {
      if (swarm.conversation_id && swarm.conversation_source !== "manual") {
        throw new Error(`Swarm '${swarmId}' has native conversation ownership and cannot be unassigned.`);
      }
      this.db.prepare(`
        UPDATE swarms SET conversation_id = NULL, conversation_source = NULL WHERE id = ?
      `).run(swarmId);
    }
    return this.getSwarm(swarmId)!;
  }

  listConversationArchives(currentConversationId?: string | null, swarmLimit = 500): ConversationArchivesPayload {
    const swarms = normalizeRows<SwarmRecord>(
      this.db.prepare(`SELECT * FROM swarms ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(swarmLimit),
    );
    const teams = normalizeRows<TeamRecord>(this.db.prepare(`SELECT * FROM teams`).all());
    const teamMap = new Map(teams.map((t) => [t.id, t]));
    const bindings = normalizeRows<SessionBindingRecord>(
      this.db.prepare(`SELECT * FROM session_bindings ORDER BY updated_at DESC`).all(),
    );
    const bindingMap = new Map(bindings.map((b) => [b.conversation_id, b]));
    const metas = normalizeRows<{
      conversation_id: string;
      custom_title: string | null;
      host_title: string | null;
      host_summary: string | null;
      host_run_state: string | null;
      host_synced_at: number | null;
      created_at: number;
      updated_at: number;
    }>(this.db.prepare(`SELECT * FROM conversation_archives`).all());
    const metaMap = new Map(metas.map((m) => [m.conversation_id, m]));

    const swarmIds = swarms.map((s) => s.id);
    const briefBySwarm = this.listSwarmBriefSummaries(swarmIds);
    const signalBySwarm = new Map<string, Pick<BoardMessage, "seq" | "tag" | "sender" | "created_at">>();
    const turnAtBySwarm = new Map<string, number>();
    const usageRowsBySwarm = new Map<string, UsageRecord[]>();

    if (swarmIds.length > 0) {
      const placeholders = swarmIds.map(() => "?").join(", ");
      const signalRows = normalizeRows<Pick<BoardMessage, "swarm_id" | "seq" | "tag" | "sender" | "created_at">>(
        this.db.prepare(`
          SELECT m.swarm_id, m.seq, m.tag, m.sender, m.created_at
          FROM board_messages m
          JOIN (
            SELECT swarm_id, MAX(seq) AS max_seq
            FROM board_messages
            WHERE swarm_id IN (${placeholders})
              AND tag IN ('brief','done','review_pass','review_fail','blocked','stall')
            GROUP BY swarm_id
          ) latest ON latest.swarm_id = m.swarm_id AND latest.max_seq = m.seq
        `).all(...swarmIds),
      );
      for (const row of signalRows) {
        signalBySwarm.set(row.swarm_id, {
          seq: row.seq,
          tag: row.tag,
          sender: row.sender,
          created_at: row.created_at,
        });
      }

      const turnRows = normalizeRows<{ swarm_id: string; last_turn_at: number | null }>(
        this.db.prepare(`
          SELECT swarm_id, MAX(COALESCE(ended_at, started_at)) AS last_turn_at
          FROM turns
          WHERE swarm_id IN (${placeholders})
          GROUP BY swarm_id
        `).all(...swarmIds),
      );
      for (const row of turnRows) {
        if (typeof row.last_turn_at === "number" && row.last_turn_at > 0) {
          turnAtBySwarm.set(row.swarm_id, row.last_turn_at);
        }
      }

      const usageRows = normalizeRows<UsageRecord>(
        this.db.prepare(`SELECT * FROM usage_ledger WHERE swarm_id IN (${placeholders})`).all(...swarmIds),
      );
      for (const row of usageRows) {
        const list = usageRowsBySwarm.get(row.swarm_id);
        if (list) list.push(row);
        else usageRowsBySwarm.set(row.swarm_id, [row]);
      }
    }

    const toWave = (swarm: SwarmRecord): ConversationWaveSummary => {
      const brief = briefBySwarm[swarm.id] ?? {
        worker_count: 0,
        active_worker_count: 0,
        backends: [],
        known_cost_usd: 0,
        priced_turns: 0,
        unpriced_turns: 0,
        total_tokens: 0,
      };
      const rawUsageRows = usageRowsBySwarm.get(swarm.id) ?? [];
      const usage = aggregateNormalizedUsage(rawUsageRows);
      const team = swarm.team_id ? teamMap.get(swarm.team_id) ?? null : null;
      const latestSignal = signalBySwarm.get(swarm.id) ?? null;
      const lastTurnAt = turnAtBySwarm.get(swarm.id) ?? 0;
      const lastActivityAt = Math.max(swarm.updated_at, lastTurnAt, latestSignal?.created_at ?? 0);
      const backends = [...new Set([...brief.backends, ...usage.by_backend.map((b) => b.backend)])].sort();
      return {
        ...brief,
        backends,
        total_tokens: usage.total_tokens,
        known_cost_usd: usage.known_cost_usd,
        priced_turns: usage.priced_turns,
        unpriced_turns: usage.unpriced_turns,
        swarm,
        team_id: swarm.team_id ?? null,
        team_name: team?.name ?? null,
        team_status: team?.status ?? null,
        is_workflow: swarm.auto_created_by_workflow === 1,
        is_manual_assignment: swarm.conversation_source === "manual",
        latest_signal: latestSignal,
        last_activity_at: lastActivityAt,
        usage,
      };
    };

    const grouped = new Map<string, ConversationWaveSummary[]>();
    const unassigned: ConversationWaveSummary[] = [];
    for (const s of swarms) {
      const wave = toWave(s);
      const cid = s.conversation_id?.trim() || null;
      if (cid) {
        const list = grouped.get(cid);
        if (list) list.push(wave);
        else grouped.set(cid, [wave]);
      } else {
        unassigned.push(wave);
      }
    }

    const allConvIds = new Set<string>([...grouped.keys(), ...bindings.map((b) => b.conversation_id)]);
    const currentId = currentConversationId?.trim() || null;
    const sessions: ConversationArchiveSummary[] = [];

    for (const cid of allConvIds) {
      const waves = (grouped.get(cid) ?? []).sort((a, b) => b.last_activity_at - a.last_activity_at);
      const binding = bindingMap.get(cid) ?? null;
      const meta = metaMap.get(cid) ?? null;
      if (waves.length === 0 && !binding) continue;

      const customTitle = meta?.custom_title?.trim() || null;
      const hostTitle = meta?.host_title?.trim() || meta?.host_summary?.trim() || null;
      const bindingTitle = binding?.window_label?.trim() || null;
      const title = customTitle ?? hostTitle ?? bindingTitle ?? null;
      const titleSource: ConversationArchiveSummary["title_source"] = customTitle
        ? "custom"
        : hostTitle
          ? "host"
          : bindingTitle
            ? "binding"
            : "none";

      const repoSet = new Set<string>();
      const teamIdSet = new Set<string>();
      const backendSet = new Set<BackendId>();
      const sessionUsageRows: UsageRecord[] = [];
      let workerCount = 0;
      let workflowWaveCount = 0;
      let latestSignal: ConversationArchiveSummary["latest_signal"] = null;
      let lastActivityAt = binding?.last_opened_at ?? binding?.updated_at ?? meta?.updated_at ?? 0;
      let updatedAt = binding?.updated_at ?? meta?.updated_at ?? 0;

      for (const w of waves) {
        if (w.swarm.repo_root) repoSet.add(path.resolve(w.swarm.repo_root));
        if (w.team_id) teamIdSet.add(w.team_id);
        for (const b of w.backends) backendSet.add(b);
        const rowsForWave = usageRowsBySwarm.get(w.swarm.id);
        if (rowsForWave) sessionUsageRows.push(...rowsForWave);
        workerCount += w.worker_count;
        if (w.is_workflow) workflowWaveCount += 1;
        if (w.last_activity_at > lastActivityAt) lastActivityAt = w.last_activity_at;
        if (w.swarm.updated_at > updatedAt) updatedAt = w.swarm.updated_at;
        if (w.latest_signal && (!latestSignal || w.latest_signal.seq > latestSignal.seq)) {
          latestSignal = { ...w.latest_signal, swarm_id: w.swarm.id };
        }
      }
      const sessionUsage = aggregateNormalizedUsage(sessionUsageRows);

      if (repoSet.size === 0 && binding?.repo_root) {
        repoSet.add(path.resolve(binding.repo_root));
      }
      if (teamIdSet.size === 0 && binding?.team_id) {
        teamIdSet.add(binding.team_id);
      }

      const repoRoots = [...repoSet];
      const primaryRepo =
        (binding?.repo_root ? path.resolve(binding.repo_root) : null) ??
        waves[0]?.swarm.repo_root ??
        repoRoots[0] ??
        null;

      sessions.push({
        conversation_id: cid,
        title,
        custom_title: customTitle,
        host_title: meta?.host_title ?? null,
        title_source: titleSource,
        is_current: Boolean(currentId && cid === currentId),
        bound_team_id: binding?.team_id ?? waves.find((w) => !w.is_workflow && w.team_id)?.team_id ?? waves[0]?.team_id ?? null,
        bound_swarm_id: binding?.active_swarm_id ?? waves.find((w) => !w.is_workflow)?.swarm.id ?? waves[0]?.swarm.id ?? null,
        repo_roots: repoRoots,
        primary_repo_root: primaryRepo,
        team_ids: [...teamIdSet],
        wave_count: waves.length,
        real_wave_count: waves.length - workflowWaveCount,
        workflow_wave_count: workflowWaveCount,
        worker_count: workerCount,
        backends: [...backendSet].sort(),
        known_cost_usd: sessionUsage.known_cost_usd,
        priced_turns: sessionUsage.priced_turns,
        unpriced_turns: sessionUsage.unpriced_turns,
        total_tokens: sessionUsage.total_tokens,
        latest_signal: latestSignal,
        last_activity_at: lastActivityAt,
        updated_at: updatedAt,
        usage: sessionUsage,
        waves,
      });
    }

    sessions.sort((a, b) => b.last_activity_at - a.last_activity_at);
    unassigned.sort((a, b) => b.last_activity_at - a.last_activity_at);

    return {
      sessions,
      unassigned_waves: unassigned,
      total_sessions: sessions.length,
      total_unassigned: unassigned.length,
    };
  }

  // --- Swarms ---

  createSwarm(input: {
    id?: string;
    title: string;
    repo_root: string;
    base_branch?: string | null;
    policy?: DispatchPolicyLayerConfig | null;
    team_id?: string | null;
    conversation_id?: string | null;
    wave_index?: number;
    auto_created_by_workflow?: boolean | number;
  }): SwarmRecord {
    const now = Date.now();
    const id = input.id || `sw-${crypto.randomUUID().slice(0, 8)}`;
    const policyJson = input.policy ? JSON.stringify(input.policy) : null;
    this.db
      .prepare(
        `INSERT INTO swarms (id, title, repo_root, base_branch, status, policy_json, created_at, updated_at,
          team_id, conversation_id, wave_index, auto_created_by_workflow)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title, input.repo_root, input.base_branch ?? null, policyJson, now, now,
        input.team_id ?? null, input.conversation_id ?? null, input.wave_index ?? 1, input.auto_created_by_workflow ? 1 : 0);

    this.createChannel(id, "main", "Shared coordinator and cross-area channel");
    return this.getSwarm(id)!;
  }

  updateSwarmPolicy(swarmId: string, policy: DispatchPolicyLayerConfig | null): void {
    const policyJson = policy ? JSON.stringify(policy) : null;
    this.db
      .prepare(`UPDATE swarms SET policy_json = ?, updated_at = ? WHERE id = ?`)
      .run(policyJson, Date.now(), swarmId);
  }

  getSwarm(id: string): SwarmRecord | null {
    const row = this.db.prepare(`SELECT * FROM swarms WHERE id = ?`).get(id);
    return normalizeRow<SwarmRecord>(row);
  }

  getLatestActiveSwarm(): SwarmRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM swarms ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
      )
      .get();
    return normalizeRow<SwarmRecord>(row);
  }

  getLatestRealActiveSwarm(teamId?: string): SwarmRecord | null {
    return normalizeRow<SwarmRecord>(this.db.prepare(`
      SELECT s.* FROM swarms s WHERE ${REAL_SWARM} ${teamId ? "AND s.team_id = ?" : ""}
      ORDER BY (s.status = 'active') DESC, s.updated_at DESC, s.rowid DESC LIMIT 1
    `).get(...(teamId ? [teamId] : [])));
  }

  isRealSwarm(swarmId: string): boolean {
    return normalizeRow(this.db.prepare(`
      SELECT s.id FROM swarms s WHERE s.id = ? AND ${REAL_SWARM}
    `).get(swarmId)) !== null;
  }

  listSwarms(limit = 30): SwarmRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM swarms ORDER BY updated_at DESC LIMIT ?`)
      .all(limit);
    return normalizeRows<SwarmRecord>(rows);
  }

  listSwarmBriefSummaries(swarmIds: string[]): Record<string, SwarmBriefSummary> {
    if (!swarmIds.length) return {};
    const ids = [...new Set(swarmIds)];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      WITH selected AS (SELECT id FROM swarms WHERE id IN (${placeholders})),
      members AS (
        SELECT swarm_id, COUNT(*) AS worker_count,
               SUM(CASE WHEN state <> 'killed' THEN 1 ELSE 0 END) AS active_worker_count,
               GROUP_CONCAT(DISTINCT backend ORDER BY backend) AS backends_csv
        FROM workers WHERE swarm_id IN (SELECT id FROM selected) GROUP BY swarm_id
      ), spend AS (
        SELECT swarm_id, SUM(cost_usd) AS known_cost_usd, COUNT(cost_usd) AS priced_turns,
               COUNT(*) - COUNT(cost_usd) AS unpriced_turns, SUM(total_tokens) AS total_tokens
        FROM usage_ledger WHERE swarm_id IN (SELECT id FROM selected) GROUP BY swarm_id
      )
      SELECT id, COALESCE(worker_count, 0) AS worker_count,
             COALESCE(active_worker_count, 0) AS active_worker_count, backends_csv,
             COALESCE(known_cost_usd, 0) AS known_cost_usd, COALESCE(priced_turns, 0) AS priced_turns,
             COALESCE(unpriced_turns, 0) AS unpriced_turns, COALESCE(total_tokens, 0) AS total_tokens
      FROM selected LEFT JOIN members ON members.swarm_id = id LEFT JOIN spend ON spend.swarm_id = id
    `).all(...ids);
    return Object.fromEntries(
      normalizeRows<Omit<SwarmBriefSummary, "backends"> & { id: string; backends_csv: string | null }>(rows)
        .map(({ id, backends_csv, ...summary }) => [
          id,
          { ...summary, backends: backends_csv ? backends_csv.split(",") as BackendId[] : [] },
        ]),
    );
  }

  updateSwarmPlan(swarmId: string, plan: SwarmPlan): void {
    this.db
      .prepare(`UPDATE swarms SET plan_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(plan), Date.now(), swarmId);
  }

  updateSwarmStatus(swarmId: string, status: "active" | "done" | "archived"): void {
    this.db
      .prepare(`UPDATE swarms SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), swarmId);
  }

  // --- Channels ---

  createChannel(swarmId: string, name: string, topic?: string | null): ChannelRecord {
    const now = Date.now();
    const normalized = name.toLowerCase().replace(/^#/, "");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channels (swarm_id, name, topic, archived, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(swarmId, normalized, topic ?? null, now);
    const row = this.db
      .prepare(`SELECT * FROM channels WHERE swarm_id = ? AND name = ?`)
      .get(swarmId, normalized);
    return normalizeRow<ChannelRecord>(row)!;
  }

  listChannels(swarmId: string): ChannelRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM channels WHERE swarm_id = ? ORDER BY id ASC`)
      .all(swarmId);
    return normalizeRows<ChannelRecord>(rows);
  }

  archiveChannel(swarmId: string, name: string): void {
    this.db
      .prepare(`UPDATE channels SET archived = 1 WHERE swarm_id = ? AND name = ?`)
      .run(swarmId, name.toLowerCase().replace(/^#/, ""));
  }

  // --- Workers ---

  addWorker(input: {
    swarm_id: string;
    name: string;
    role: WorkerRole;
    capability: CapabilityTag;
    backend: BackendId;
    model?: string | null;
    effort?: string | null;
    workspace_mode: WorkspaceMode;
    workspace_path: string;
    worktree_branch?: string | null;
    auto_fallback?: boolean;
    review_of?: string | null;
    channels?: string[];
    identity_id?: string | null;
    agy_account_id?: string | null;
    parent_node?: string | null;
    policy_source?: PolicyLayer | null;
    resolved_policy_json?: string | null;
  }): WorkerRecord {
    const now = Date.now();
    const id = `wk-${crypto.randomUUID().slice(0, 8)}`;
    const channels = [...new Set(["main", ...(input.channels ?? []).map((c) => c.toLowerCase())])];
    for (const ch of channels) {
      this.createChannel(input.swarm_id, ch);
    }
    this.db
      .prepare(
        `INSERT INTO workers (
          id, swarm_id, name, role, capability, backend, model, effort,
          state, workspace_mode, workspace_path, worktree_branch, session_id,
          needs_handoff, auto_fallback, review_of, channels_json,
          last_read_seq, last_post_seq, identity_id, agy_account_id, parent_node, policy_source, resolved_policy_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, NULL, 0, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.swarm_id,
        input.name,
        input.role,
        input.capability,
        input.backend,
        input.model ?? null,
        input.effort ?? null,
        input.workspace_mode,
        input.workspace_path,
        input.worktree_branch ?? null,
        input.auto_fallback === false ? 0 : 1,
        input.review_of ?? null,
        JSON.stringify(channels),
        input.identity_id ?? null,
        input.agy_account_id ?? null,
        input.parent_node ?? null,
        input.policy_source ?? null,
        input.resolved_policy_json ?? null,
        now,
        now,
      );
    this.touchSwarm(input.swarm_id);
    return this.getWorker(input.swarm_id, input.name)!;
  }

  getWorker(swarmId: string, name: string): WorkerRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM workers WHERE swarm_id = ? AND name = ?`)
      .get(swarmId, name);
    return normalizeRow<WorkerRecord>(row);
  }

  listWorkers(swarmId: string): WorkerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM workers WHERE swarm_id = ? ORDER BY created_at ASC`)
      .all(swarmId);
    return normalizeRows<WorkerRecord>(rows);
  }

  updateWorkerState(
    swarmId: string,
    name: string,
    state: WorkerState,
    lastError?: string | null,
    ownerInstanceId?: string | null,
  ): void {
    const owner = state === "working" ? (ownerInstanceId ?? null) : null;
    this.db
      .prepare(
        `UPDATE workers SET state = ?, last_error = ?, owner_instance_id = ?, updated_at = ? WHERE swarm_id = ? AND name = ?`,
      )
      .run(state, lastError ?? null, owner, Date.now(), swarmId, name);
  }

  updateWorkerSession(
    swarmId: string,
    name: string,
    sessionId: string | null,
    needsHandoff: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE workers SET session_id = ?, needs_handoff = ?, updated_at = ? WHERE swarm_id = ? AND name = ?`,
      )
      .run(sessionId, needsHandoff ? 1 : 0, Date.now(), swarmId, name);
  }

  updateWorkerBackend(
    swarmId: string,
    name: string,
    backend: BackendId,
    model?: string | null,
    effort?: string | null,
    resolvedPolicyJson?: string | null,
  ): void {
    if (resolvedPolicyJson !== undefined) {
      this.db
        .prepare(
          `UPDATE workers
           SET backend = ?, model = ?, effort = CASE WHEN ? THEN effort ELSE ? END,
               session_id = NULL, needs_handoff = 1, state = 'waiting',
               last_error = NULL, resolved_policy_json = ?, updated_at = ?
           WHERE swarm_id = ? AND name = ?`,
        )
        .run(backend, model ?? null, effort === undefined ? 1 : 0, effort ?? null, resolvedPolicyJson, Date.now(), swarmId, name);
      return;
    }
    this.db
      .prepare(
        `UPDATE workers
         SET backend = ?, model = ?, effort = CASE WHEN ? THEN effort ELSE ? END,
             session_id = NULL, needs_handoff = 1, state = 'waiting',
             last_error = NULL, updated_at = ?
         WHERE swarm_id = ? AND name = ?`,
      )
      .run(backend, model ?? null, effort === undefined ? 1 : 0, effort ?? null, Date.now(), swarmId, name);
  }

  updateWorkerChannels(swarmId: string, name: string, channels: string[]): void {
    const normalized = [...new Set(["main", ...channels.map((c) => c.toLowerCase())])];
    this.db
      .prepare(`UPDATE workers SET channels_json = ?, updated_at = ? WHERE swarm_id = ? AND name = ?`)
      .run(JSON.stringify(normalized), Date.now(), swarmId, name);
  }

  updateWorkerCursors(
    swarmId: string,
    name: string,
    cursors: { last_read_seq?: number; last_post_seq?: number },
  ): void {
    if (cursors.last_read_seq !== undefined) {
      this.db
        .prepare(`UPDATE workers SET last_read_seq = MAX(last_read_seq, ?) WHERE swarm_id = ? AND name = ?`)
        .run(cursors.last_read_seq, swarmId, name);
    }
    if (cursors.last_post_seq !== undefined) {
      this.db
        .prepare(`UPDATE workers SET last_post_seq = MAX(last_post_seq, ?) WHERE swarm_id = ? AND name = ?`)
        .run(cursors.last_post_seq, swarmId, name);
    }
  }

  // --- Board Messages ---

  postBoardMessage(input: {
    swarm_id: string;
    sender: string;
    channel?: string;
    tag?: MessageTag;
    text: string;
    turn_id?: string | null;
    suppress_wake?: boolean;
  }): { message: BoardMessage; signals: ParsedMessageSignals } {
    const now = Date.now();
    const channel = (input.channel || "main").toLowerCase().replace(/^#/, "");
    this.createChannel(input.swarm_id, channel);
    const signals = parseMessageSignals(input.text);

    const res = this.db
      .prepare(
        `INSERT INTO board_messages (
          swarm_id, channel, sender, tag, text, mentions_json, refs_json, turn_id, suppress_wake, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.swarm_id,
        channel,
        input.sender,
        input.tag ?? "update",
        input.text,
        JSON.stringify(signals.mentions),
        JSON.stringify(signals.refs),
        input.turn_id ?? null,
        input.suppress_wake ? 1 : 0,
        now,
      );

    const seq = Number(res.lastInsertRowid);
    if (input.sender !== "coordinator" && input.sender !== "watchdog") {
      this.updateWorkerCursors(input.swarm_id, input.sender, { last_post_seq: seq });
    }
    this.touchSwarm(input.swarm_id);

    const row = this.db.prepare(`SELECT * FROM board_messages WHERE seq = ?`).get(seq);
    return {
      message: normalizeRow<BoardMessage>(row)!,
      signals,
    };
  }

  enqueuePendingDispatch(swarmId: string, workerName: string, triggerSeq: number, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO pending_dispatches (
           swarm_id, worker_name, trigger_seq, status, owner_instance_id, claimed_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)
         ON CONFLICT(swarm_id, worker_name) DO UPDATE SET
           trigger_seq = MAX(pending_dispatches.trigger_seq, excluded.trigger_seq),
           status = 'pending',
           owner_instance_id = NULL,
           claimed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(swarmId, workerName, triggerSeq, now, now);
  }

  postBoardMessageWithWakes(
    input: Parameters<PolySwarmDB["postBoardMessage"]>[0],
    wakeWorkerNames: string[],
  ): { message: BoardMessage; signals: ParsedMessageSignals } {
    const uniqueTargets = [...new Set(wakeWorkerNames.map((w) => w.trim()).filter(Boolean))];
    return this.transaction(() => {
      const posted = this.postBoardMessage(input);
      if (!input.suppress_wake && uniqueTargets.length > 0) {
        const now = Date.now();
        for (const workerName of uniqueTargets) {
          this.enqueuePendingDispatch(input.swarm_id, workerName, posted.message.seq, now);
        }
      }
      return posted;
    });
  }

  claimPendingDispatch(swarmId: string, workerName: string, instanceId: string): PendingDispatchRecord | null {
    return this.transaction(() => {
      const existing = normalizeRow<PendingDispatchRecord>(
        this.db
          .prepare(
            `SELECT * FROM pending_dispatches
             WHERE swarm_id = ? AND worker_name = ? AND status = 'pending'`,
          )
          .get(swarmId, workerName),
      );
      if (!existing) return null;
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE pending_dispatches
           SET status = 'claimed', owner_instance_id = ?, claimed_at = ?, updated_at = ?
           WHERE swarm_id = ? AND worker_name = ?`,
        )
        .run(instanceId, now, now, swarmId, workerName);
      return normalizeRow<PendingDispatchRecord>(
        this.db
          .prepare(`SELECT * FROM pending_dispatches WHERE swarm_id = ? AND worker_name = ?`)
          .get(swarmId, workerName),
      );
    });
  }

  completePendingDispatch(swarmId: string, workerName: string, claimedTriggerSeq: number): void {
    this.db
      .prepare(
        `DELETE FROM pending_dispatches
         WHERE swarm_id = ? AND worker_name = ? AND trigger_seq <= ?`,
      )
      .run(swarmId, workerName, claimedTriggerSeq);
  }

  clearPendingDispatch(swarmId: string, workerName?: string): void {
    if (workerName) {
      this.db
        .prepare(`DELETE FROM pending_dispatches WHERE swarm_id = ? AND worker_name = ?`)
        .run(swarmId, workerName);
    } else {
      this.db.prepare(`DELETE FROM pending_dispatches WHERE swarm_id = ?`).run(swarmId);
    }
  }

  getPendingDispatch(swarmId: string, workerName: string): PendingDispatchRecord | null {
    return normalizeRow<PendingDispatchRecord>(
      this.db
        .prepare(`SELECT * FROM pending_dispatches WHERE swarm_id = ? AND worker_name = ?`)
        .get(swarmId, workerName),
    );
  }

  listPendingDispatches(status?: PendingDispatchStatus, swarmId?: string): PendingDispatchRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (swarmId) {
      clauses.push("swarm_id = ?");
      params.push(swarmId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return normalizeRows<PendingDispatchRecord>(
      this.db.prepare(`SELECT * FROM pending_dispatches ${where} ORDER BY updated_at ASC`).all(...params),
    );
  }

  readBoardMessages(input: {
    swarm_id: string;
    since?: number;
    channel?: string;
    limit?: number;
  }): BoardMessage[] {
    const since = input.since ?? 0;
    const limit = input.limit ?? 100;
    if (input.channel && input.channel !== "*") {
      const ch = input.channel.toLowerCase().replace(/^#/, "");
      const rows = this.db
        .prepare(
          `SELECT * FROM board_messages
           WHERE swarm_id = ? AND seq > ? AND channel = ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(input.swarm_id, since, ch, limit);
      return normalizeRows<BoardMessage>(rows);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM board_messages
         WHERE swarm_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(input.swarm_id, since, limit);
    return normalizeRows<BoardMessage>(rows);
  }

  listBlackboardMessages(swarmId: string, limit = 30): BoardMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM board_messages WHERE swarm_id = ?
          AND tag IN ('brief','done','review_pass','review_fail','blocked','stall')
        ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq ASC
    `).all(swarmId, limit);
    return normalizeRows<BoardMessage>(rows);
  }

  listLatestDeliverableReviews(swarmId: string): Array<BoardMessage & { review_of: string }> {
    const rows = this.db.prepare(`
      WITH latest AS (
        SELECT w.review_of, MAX(m.seq) AS seq
        FROM workers w JOIN board_messages m ON m.swarm_id = w.swarm_id AND m.sender = w.name
        WHERE w.swarm_id = ? AND w.review_of IS NOT NULL AND m.tag IN ('review_pass','review_fail')
        GROUP BY w.review_of
      )
      SELECT m.*, latest.review_of FROM latest JOIN board_messages m ON m.seq = latest.seq
    `).all(swarmId);
    return normalizeRows<BoardMessage & { review_of: string }>(rows);
  }

  readBoardTail(swarmId: string, limit = 60, channel?: string): BoardMessage[] {
    if (channel && channel !== "*") {
      const ch = channel.toLowerCase().replace(/^#/, "");
      const rows = this.db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM board_messages WHERE swarm_id = ? AND channel = ? ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq ASC`,
        )
        .all(swarmId, ch, limit);
      return normalizeRows<BoardMessage>(rows);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM board_messages WHERE swarm_id = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(swarmId, limit);
    return normalizeRows<BoardMessage>(rows);
  }

  getMessagesBySeqs(swarmId: string, seqs: number[]): BoardMessage[] {
    if (seqs.length === 0) return [];
    const placeholders = seqs.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM board_messages WHERE swarm_id = ? AND seq IN (${placeholders}) ORDER BY seq ASC`,
      )
      .all(swarmId, ...seqs);
    return normalizeRows<BoardMessage>(rows);
  }

  getLatestBoardSeq(swarmId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM board_messages WHERE swarm_id = ?`)
      .get(swarmId) as { max_seq: number } | undefined;
    return Number(row?.max_seq ?? 0);
  }

  // --- Turns & Events ---

  createTurn(input: {
    id?: string;
    swarm_id: string;
    worker_name: string;
    backend: BackendId;
    model?: string | null;
    effort?: string | null;
    mode: "readonly" | "write";
    trigger_seq?: number | null;
    prompt_preview: string;
    session_id_used?: string | null;
    owner_instance_id?: string | null;
  }): TurnRecord {
    const now = Date.now();
    const id = input.id || `turn-${crypto.randomUUID().slice(0, 10)}`;
    this.db
      .prepare(
        `INSERT INTO turns (
          id, swarm_id, worker_name, backend, model, effort, mode, trigger_seq,
          prompt_preview, status, error_kind, session_id_used, owner_instance_id, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'none', ?, ?, ?)`,
      )
      .run(
        id,
        input.swarm_id,
        input.worker_name,
        input.backend,
        input.model ?? null,
        input.effort ?? null,
        input.mode,
        input.trigger_seq ?? null,
        input.prompt_preview.slice(0, 4000),
        input.session_id_used ?? null,
        input.owner_instance_id ?? null,
        now,
      );
    return this.getTurn(id)!;
  }

  getTurn(turnId: string): TurnRecord | null {
    const row = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(turnId);
    return normalizeRow<TurnRecord>(row);
  }

  completeTurn(
    turnId: string,
    patch: {
      status: "completed" | "failed" | "cancelled";
      error_kind: ErrorKind;
      error_message?: string | null;
      output_text?: string | null;
      structured_json?: string | null;
      session_id_returned?: string | null;
      actual_model?: string | null;
      duration_ms: number;
      tool_calls_count: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE turns
         SET status = ?, error_kind = ?, error_message = ?, output_text = ?,
             structured_json = ?, session_id_returned = ?, actual_model = COALESCE(?, actual_model),
             duration_ms = ?, tool_calls_count = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.error_kind,
        patch.error_message ?? null,
        patch.output_text ?? null,
        patch.structured_json ?? null,
        patch.session_id_returned ?? null,
        patch.actual_model ?? null,
        patch.duration_ms,
        patch.tool_calls_count,
        Date.now(),
        turnId,
      );
  }

  listWorkerTurns(swarmId: string, workerName: string, limit = 25): TurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns WHERE swarm_id = ? AND worker_name = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(swarmId, workerName, limit);
    return normalizeRows<TurnRecord>(rows);
  }

  /** Bounded, project-local terminal observations for the exact requested execution profile. */
  listRoutingObservations(input: { repoRoot: string; capability: CapabilityTag; mode: "readonly" | "write";
    backend: BackendId; model: string; effort: string | null; since: number; now: number }): Array<Pick<TurnRecord, "swarm_id" | "worker_name" | "status">> {
    return normalizeRows<Pick<TurnRecord, "swarm_id" | "worker_name" | "status">>(this.db.prepare(`
      SELECT t.swarm_id, t.worker_name, t.status
      FROM turns t JOIN workers w ON w.swarm_id = t.swarm_id AND w.name = t.worker_name
      JOIN swarms s ON s.id = t.swarm_id
      WHERE s.repo_root = ? AND w.capability = ? AND t.mode = ?
        AND t.backend = ? AND t.model = ? AND t.effort IS ?
        AND t.status IN ('completed', 'failed') AND t.ended_at >= ? AND t.ended_at <= ?
      ORDER BY t.ended_at DESC, t.id DESC LIMIT 30
    `).all(path.resolve(input.repoRoot), input.capability, input.mode, input.backend, input.model,
      input.effort, input.since, input.now));
  }

  getLatestWorkerTurn(swarmId: string, workerName: string): TurnRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM turns WHERE swarm_id = ? AND worker_name = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(swarmId, workerName);
    return normalizeRow<TurnRecord>(row);
  }

  insertEvent(input: {
    turn_id: string;
    swarm_id: string;
    worker_name: string;
    seq_in_turn: number;
    kind: EventKind;
    title?: string | null;
    content: string;
    meta?: Record<string, unknown> | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO worker_events (
          turn_id, swarm_id, worker_name, seq_in_turn, kind, title, content, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.turn_id,
        input.swarm_id,
        input.worker_name,
        input.seq_in_turn,
        input.kind,
        input.title ?? null,
        input.content,
        input.meta ? JSON.stringify(input.meta) : null,
        Date.now(),
      );
    return Number(res.lastInsertRowid);
  }

  listTurnEvents(turnId: string, afterEventId = 0, limit = 300): WorkerEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_events
         WHERE turn_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(turnId, afterEventId, limit);
    return normalizeRows<WorkerEvent>(rows);
  }

  getLatestWorkerEvent(swarmId: string, workerName: string): WorkerEvent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worker_events WHERE swarm_id = ? AND worker_name = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(swarmId, workerName);
    return normalizeRow<WorkerEvent>(row);
  }

  // --- Usage Ledger ---

  insertUsage(input: {
    turn_id: string;
    swarm_id: string;
    worker_name: string;
    backend: BackendId;
    model?: string | null;
    accuracy: UsageAccuracy;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    total_tokens?: number;
    cost_usd?: number | null;
    duration_ms: number;
    tool_calls_count: number;
  }): void {
    const reasoning = input.reasoning_tokens ?? 0;
    const cacheRead = input.cache_read_tokens ?? 0;
    const cacheWrite = input.cache_write_tokens ?? 0;
    const total =
      input.total_tokens ??
      input.input_tokens + input.output_tokens + reasoning + cacheRead + cacheWrite;
    this.db
      .prepare(
        `INSERT INTO usage_ledger (
          turn_id, swarm_id, worker_name, backend, model, accuracy,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_usd, duration_ms, tool_calls_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.turn_id,
        input.swarm_id,
        input.worker_name,
        input.backend,
        input.model ?? null,
        input.accuracy,
        input.input_tokens,
        input.output_tokens,
        reasoning,
        cacheRead,
        cacheWrite,
        total,
        input.cost_usd ?? null,
        input.duration_ms,
        input.tool_calls_count,
        Date.now(),
      );
  }

  listUsageForTurn(turnId: string): UsageRecord | null {
    const row = this.db.prepare(`SELECT * FROM usage_ledger WHERE turn_id = ?`).get(turnId);
    return normalizeRow<UsageRecord>(row);
  }

  aggregateUsage(swarmId: string, groupBy: "all" | "backend" | "worker"): UsageAggregate[] {
    return this.queryUsage(groupBy, swarmId);
  }

  aggregateGlobalUsageByBackend(): UsageAggregate[] {
    return this.queryUsage("backend");
  }

  listAgyCompanies(): AgyCompany[] {
    const rows = this.talent.prepare("SELECT * FROM agy_companies ORDER BY rowid").all();
    return normalizeRows<Omit<AgyCompany, "enabled"> & { enabled: number }>(rows)
      .map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  addAgyCompany(id: string, name: string): void {
    this.talent.prepare("INSERT OR IGNORE INTO agy_companies (id, name) VALUES (?, ?)").run(id, name);
  }

  updateAgyCompany(company: AgyCompany): void {
    this.talent.prepare("UPDATE agy_companies SET name = ?, enabled = ?, default_model = ?, default_effort = ? WHERE id = ?")
      .run(company.name, company.enabled ? 1 : 0, company.default_model, company.default_effort, company.id);
  }

  setAgyCompanyCooldown(id: string, until: number): void {
    this.talent.prepare("UPDATE agy_companies SET cooldown_until = ? WHERE id = ?").run(until, id);
  }

  disableAgyCompany(id: string): void {
    this.talent.prepare("UPDATE agy_companies SET enabled = 0 WHERE id = ?").run(id);
  }

  listHistoricalAgyAccountIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT agy_account_id FROM workers WHERE agy_account_id IS NOT NULL").all();
    return rows.map((row) => String(row.agy_account_id));
  }

  aggregateAgyCompanyUsage(): UsageAggregate[] {
    return this.queryUsage("agy-company");
  }

  listSwarmUsageWithTurns(swarmId: string, limit = 80): SwarmTurnUsageRow[] {
    const rows = this.db
      .prepare(
        `SELECT
           u.*,
           t.status AS turn_status,
           t.trigger_seq AS trigger_seq,
           t.prompt_preview AS prompt_preview,
           COALESCE(
             NULLIF(TRIM(u.model), ''),
             NULLIF(TRIM(t.actual_model), ''),
             NULLIF(TRIM(t.model), ''),
             NULLIF(TRIM(w.model), '')
           ) AS resolved_model
         FROM usage_ledger u
         LEFT JOIN turns t ON t.id = u.turn_id
         LEFT JOIN workers w ON w.swarm_id = u.swarm_id AND w.name = u.worker_name
         WHERE u.swarm_id = ?
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT ?`,
      )
      .all(swarmId, limit);
    return normalizeRows<SwarmTurnUsageRow>(rows);
  }

  listGlobalUsageByVendor(): Partial<Record<BackendId, VendorUsageSummary>> {
    const rows = this.db
      .prepare(
        `SELECT
           u.id, u.turn_id, u.swarm_id, u.worker_name, u.backend,
           COALESCE(
             NULLIF(TRIM(u.model), ''),
             NULLIF(TRIM(t.actual_model), ''),
             NULLIF(TRIM(t.model), ''),
             NULLIF(TRIM(w.model), '')
           ) AS model,
           u.accuracy, u.input_tokens, u.output_tokens, u.reasoning_tokens,
           u.cache_read_tokens, u.cache_write_tokens, u.total_tokens,
           u.cost_usd, u.duration_ms, u.tool_calls_count, u.created_at
         FROM usage_ledger u
         LEFT JOIN turns t ON t.id = u.turn_id
         LEFT JOIN workers w ON w.swarm_id = u.swarm_id AND w.name = u.worker_name
         ORDER BY u.created_at DESC, u.id DESC`,
      )
      .all();
    return aggregateUsageByVendor(normalizeRows<UsageRecord>(rows));
  }

  private queryUsage(groupBy: "all" | "backend" | "worker" | "agy-company", swarmId?: string): UsageAggregate[] {
    const byCompany = groupBy === "agy-company";
    const col = byCompany ? "COALESCE('agy-' || w.agy_account_id, 'agy')"
      : groupBy === "all" ? "'total'" : groupBy === "backend" ? "u.backend" : "u.worker_name";
    const rows = this.db
      .prepare(
        `SELECT
           ${col} AS key,
           COUNT(*) AS turns,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
           COALESCE(SUM(cost_usd), 0) AS known_cost_usd,
           COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced_turns,
           COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_turns,
           COALESCE(SUM(duration_ms), 0) AS duration_ms,
           COALESCE(SUM(tool_calls_count), 0) AS tool_calls_count,
           COALESCE(SUM(CASE WHEN accuracy = 'exact' THEN 1 ELSE 0 END), 0) AS exact_turns,
           COALESCE(SUM(CASE WHEN accuracy = 'hook' THEN 1 ELSE 0 END), 0) AS hook_turns,
           COALESCE(SUM(CASE WHEN accuracy = 'estimated' THEN 1 ELSE 0 END), 0) AS estimated_turns
         FROM usage_ledger u ${byCompany
           ? "LEFT JOIN workers w ON w.swarm_id = u.swarm_id AND w.name = u.worker_name WHERE u.backend = 'agy'"
           : swarmId === undefined ? "" : "WHERE u.swarm_id = ?"}
         ${groupBy === "all" ? "" : `GROUP BY ${col} ORDER BY total_tokens DESC, key ASC`}`,
      )
      .all(...(swarmId === undefined ? [] : [swarmId]));
    return normalizeRows<UsageAggregate>(rows);
  }

  // --- Backend Health ---

  upsertBackendHealth(health: Omit<BackendHealth, "cooldown_until" | "cooldown_reason">): void {
    this.db
      .prepare(
        `INSERT INTO backend_health (
          backend, installed, binary_path, version, supports_acp, cli_supports_acp, active_protocol,
          supports_headless, supports_resume, supports_exact_usage, supports_strict_readonly, last_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(backend) DO UPDATE SET
          installed = excluded.installed,
          binary_path = excluded.binary_path,
          version = excluded.version,
          supports_acp = excluded.supports_acp,
          cli_supports_acp = excluded.cli_supports_acp,
          active_protocol = excluded.active_protocol,
          supports_headless = excluded.supports_headless,
          supports_resume = excluded.supports_resume,
          supports_exact_usage = excluded.supports_exact_usage,
          supports_strict_readonly = excluded.supports_strict_readonly,
          last_checked_at = excluded.last_checked_at`,
      )
      .run(
        health.backend,
        health.installed,
        health.binary_path,
        health.version,
        health.supports_acp,
        health.cli_supports_acp ?? 0,
        health.active_protocol ?? "headless_cli",
        health.supports_headless,
        health.supports_resume,
        health.supports_exact_usage,
        health.supports_strict_readonly ?? 1,
        health.last_checked_at,
      );
  }

  setBackendCooldown(backend: BackendId, cooldownUntil: number | null, reason: string | null): void {
    this.db
      .prepare(
        `INSERT INTO backend_health (backend, installed, last_checked_at, cooldown_until, cooldown_reason)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(backend) DO UPDATE SET
           cooldown_until = excluded.cooldown_until,
           cooldown_reason = excluded.cooldown_reason`,
      )
      .run(backend, Date.now(), cooldownUntil, reason);
  }

  listBackendHealth(): BackendHealth[] {
    const rows = this.db.prepare(`SELECT * FROM backend_health ORDER BY backend ASC`).all();
    return normalizeRows<BackendHealth>(rows);
  }

  getBackendHealth(backend: BackendId): BackendHealth | null {
    const row = this.db.prepare(`SELECT * FROM backend_health WHERE backend = ?`).get(backend);
    return normalizeRow<BackendHealth>(row);
  }

  isCoolingDown(backend: BackendId, now = Date.now()): boolean {
    const h = this.getBackendHealth(backend);
    return Boolean(h?.cooldown_until && h.cooldown_until > now);
  }

  // --- Workflows ---

  createWorkflow(input: {
    id?: string;
    swarm_id?: string | null;
    description: string;
    definition: WorkflowDefinition;
  }): WorkflowRecord {
    const id = input.id || `wf-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO workflows (id, swarm_id, description, definition_json, status, logs_json, started_at)
         VALUES (?, ?, ?, ?, 'running', '[]', ?)`,
      )
      .run(id, input.swarm_id ?? null, input.description, JSON.stringify(input.definition), Date.now());
    return this.getWorkflow(id)!;
  }

  getWorkflow(id: string): WorkflowRecord | null {
    const row = this.db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id);
    return normalizeRow<WorkflowRecord>(row);
  }

  listWorkflows(swarmId?: string | null, limit = 20): WorkflowRecord[] {
    if (swarmId) {
      const rows = this.db
        .prepare(`SELECT * FROM workflows WHERE swarm_id = ? ORDER BY started_at DESC LIMIT ?`)
        .all(swarmId, limit);
      return normalizeRows<WorkflowRecord>(rows);
    }
    const rows = this.db
      .prepare(`SELECT * FROM workflows ORDER BY started_at DESC LIMIT ?`)
      .all(limit);
    return normalizeRows<WorkflowRecord>(rows);
  }

  appendWorkflowLog(id: string, line: string): void {
    const wf = this.getWorkflow(id);
    if (!wf) return;
    const logs = JSON.parse(wf.logs_json || "[]") as string[];
    logs.push(line);
    this.db
      .prepare(`UPDATE workflows SET logs_json = ? WHERE id = ?`)
      .run(JSON.stringify(logs.slice(-200)), id);
  }

  completeWorkflow(
    id: string,
    patch: { status: "completed" | "failed"; results?: Record<string, unknown>; error?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE workflows SET status = ?, results_json = ?, error = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.results ? JSON.stringify(patch.results) : null,
        patch.error ?? null,
        Date.now(),
        id,
      );
  }

  recoverStaleRunningState(options?: {
    currentInstanceId?: string;
    staleHeartbeatMs?: number;
    isPidAlive?: (pid: number) => boolean;
    now?: number;
  }): {
    recoveredWorkers: number;
    recoveredTurns: number;
    pendingDispatches: PendingDispatchRecord[];
    uncertainDispatches: PendingDispatchRecord[];
  } {
    const now = options?.now ?? Date.now();
    const staleHeartbeatMs = options?.staleHeartbeatMs ?? 60_000;
    const checkPid =
      options?.isPidAlive ??
      ((pid: number) => {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException)?.code === "EPERM";
        }
      });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const instances = this.listInstances();
      const liveIds: string[] = [];
      const deadIds: string[] = [];
      for (const inst of instances) {
        if (options?.currentInstanceId && inst.instance_id === options.currentInstanceId) {
          continue;
        }
        const fresh = now - inst.heartbeat_at <= staleHeartbeatMs;
        if (fresh && checkPid(inst.pid)) {
          liveIds.push(inst.instance_id);
        } else {
          deadIds.push(inst.instance_id);
        }
      }
      if (deadIds.length > 0) {
        const delPlaceholders = deadIds.map(() => "?").join(",");
        this.db
          .prepare(`DELETE FROM server_instances WHERE instance_id IN (${delPlaceholders})`)
          .run(...deadIds);
      }

      let workerRes: { changes?: number | bigint };
      let turnRes: { changes?: number | bigint };
      if (liveIds.length > 0) {
        const placeholders = liveIds.map(() => "?").join(",");
        workerRes = this.db
          .prepare(
            `UPDATE workers
             SET state = 'stopped',
                 last_error = COALESCE(last_error, 'Recovered after owner server restart while turn was running'),
                 owner_instance_id = NULL,
                 updated_at = ?
             WHERE state = 'working'
               AND owner_instance_id IS NOT NULL
               AND owner_instance_id NOT IN (${placeholders})`,
          )
          .run(now, ...liveIds);
        turnRes = this.db
          .prepare(
            `UPDATE turns
             SET status = 'failed',
                 error_kind = 'cancelled',
                 error_message = COALESCE(error_message, 'Recovered after owner server restart while turn was running'),
                 ended_at = COALESCE(ended_at, ?)
             WHERE status = 'running'
               AND owner_instance_id IS NOT NULL
               AND owner_instance_id NOT IN (${placeholders})`,
          )
          .run(now, ...liveIds);
      } else {
        workerRes = this.db
          .prepare(
            `UPDATE workers
             SET state = 'stopped',
                 last_error = COALESCE(last_error, 'Recovered after server restart while turn was running'),
                 owner_instance_id = NULL,
                 updated_at = ?
             WHERE state = 'working'`,
          )
          .run(now);
        turnRes = this.db
          .prepare(
            `UPDATE turns
             SET status = 'failed',
                 error_kind = 'cancelled',
                 error_message = COALESCE(error_message, 'Recovered after server restart while turn was running'),
                 ended_at = COALESCE(ended_at, ?)
             WHERE status = 'running'`,
          )
          .run(now);
      }

      // Clean orphaned pending_dispatches for inactive swarms or missing/killed workers
      this.db
        .prepare(
          `DELETE FROM pending_dispatches
           WHERE NOT EXISTS (
             SELECT 1 FROM swarms s
             JOIN workers w ON w.swarm_id = s.id AND w.name = pending_dispatches.worker_name
             WHERE s.id = pending_dispatches.swarm_id
               AND s.status = 'active'
               AND w.state != 'killed'
           )`,
        )
        .run();

      const protectedIds = options?.currentInstanceId ? [...liveIds, options.currentInstanceId] : liveIds;
      const staleClaimedSql = protectedIds.length > 0
        ? `SELECT pd.*, w.role AS worker_role
           FROM pending_dispatches pd
           JOIN workers w ON w.swarm_id = pd.swarm_id AND w.name = pd.worker_name
           WHERE pd.status = 'claimed'
             AND (pd.owner_instance_id IS NULL OR pd.owner_instance_id NOT IN (${protectedIds.map(() => "?").join(",")}))`
        : `SELECT pd.*, w.role AS worker_role
           FROM pending_dispatches pd
           JOIN workers w ON w.swarm_id = pd.swarm_id AND w.name = pd.worker_name
           WHERE pd.status = 'claimed'`;
      const staleClaimed = normalizeRows<PendingDispatchRecord & { worker_role: WorkerRole }>(
        this.db.prepare(staleClaimedSql).all(...protectedIds),
      );
      for (const row of staleClaimed) {
        if (row.worker_role === "researcher" || row.worker_role === "verifier") {
          this.db
            .prepare(
              `UPDATE pending_dispatches
               SET status = 'pending', owner_instance_id = NULL, claimed_at = NULL, updated_at = ?
               WHERE swarm_id = ? AND worker_name = ?`,
            )
            .run(now, row.swarm_id, row.worker_name);
        } else {
          const completedTurn = normalizeRow<{ id: string }>(
            this.db
              .prepare(
                `SELECT id FROM turns
                 WHERE swarm_id = ? AND worker_name = ? AND trigger_seq = ? AND status = 'completed'
                 LIMIT 1`,
              )
              .get(row.swarm_id, row.worker_name, row.trigger_seq),
          );
          if (completedTurn) {
            this.db
              .prepare(`DELETE FROM pending_dispatches WHERE swarm_id = ? AND worker_name = ?`)
              .run(row.swarm_id, row.worker_name);
          } else {
            this.db
              .prepare(
                `UPDATE pending_dispatches
                 SET status = 'uncertain', owner_instance_id = NULL, updated_at = ?
                 WHERE swarm_id = ? AND worker_name = ?`,
              )
              .run(now, row.swarm_id, row.worker_name);
          }
        }
      }

      const pendingDispatches = normalizeRows<PendingDispatchRecord>(
        this.db
          .prepare(
            `SELECT pd.* FROM pending_dispatches pd
             JOIN swarms s ON s.id = pd.swarm_id
             WHERE pd.status = 'pending' AND s.status = 'active'
             ORDER BY pd.updated_at ASC`,
          )
          .all(),
      );
      const uncertainDispatches = normalizeRows<PendingDispatchRecord>(
        this.db
          .prepare(
            `SELECT pd.* FROM pending_dispatches pd
             JOIN swarms s ON s.id = pd.swarm_id
             WHERE pd.status = 'uncertain' AND s.status = 'active'
             ORDER BY pd.updated_at ASC`,
          )
          .all(),
      );

      this.db.exec("COMMIT");
      return {
        recoveredWorkers: Number(workerRes.changes ?? 0),
        recoveredTurns: Number(turnRes.changes ?? 0),
        pendingDispatches,
        uncertainDispatches,
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
  }

  // --- Dispatch Graph Edges ---

  insertDispatchEdge(input: {
    swarm_id: string;
    from_node: string;
    to_node: string;
    kind: GraphEdgeKind;
    seq?: number | null;
    turn_id?: string | null;
    label?: string | null;
    meta?: Record<string, unknown> | null;
  }): DispatchEdgeRecord {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO dispatch_edges (
          swarm_id, from_node, to_node, kind, seq, turn_id, label, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.swarm_id,
        input.from_node,
        input.to_node,
        input.kind,
        input.seq ?? null,
        input.turn_id ?? null,
        input.label ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        now,
      );
    const row = this.db
      .prepare(`SELECT * FROM dispatch_edges WHERE id = ?`)
      .get(Number(res.lastInsertRowid));
    return normalizeRow<DispatchEdgeRecord>(row)!;
  }

  listDispatchEdges(swarmId: string, limit = 500): DispatchEdgeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM dispatch_edges WHERE swarm_id = ? ORDER BY id ASC LIMIT ?`)
      .all(swarmId, limit);
    return normalizeRows<DispatchEdgeRecord>(rows);
  }

  listWorkerSwitchEdges(swarmId: string, limit = 100): DispatchEdgeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM dispatch_edges WHERE swarm_id = ? AND kind = 'fallback' ORDER BY id DESC LIMIT ?
    `).all(swarmId, limit);
    return normalizeRows<DispatchEdgeRecord>(rows).reverse();
  }

  private touchSwarm(swarmId: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE swarms SET updated_at = ? WHERE id = ?`).run(now, swarmId);
    this.db.prepare(`UPDATE teams SET updated_at = ? WHERE id = (SELECT team_id FROM swarms WHERE id = ?)`)
      .run(now, swarmId);
  }
}
