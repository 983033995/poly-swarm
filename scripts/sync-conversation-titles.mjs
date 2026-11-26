import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  let dataDir = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "poly-swarm");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--data-dir" && argv[i + 1]) {
      dataDir = argv[i + 1];
      i += 1;
    }
  }
  return { dataDir };
}

async function fetchConversationMeta(conversationId) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!addr || !csrf) return null;
  const url = /^https?:\/\//i.test(addr)
    ? `${addr.replace(/\/$/, "")}/product.v1.ConversationService/GetConversation`
    : `http://${addr}/product.v1.ConversationService/GetConversation`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-antigravity-csrf-token": csrf,
    },
    body: JSON.stringify({ conversationId }),
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) return null;
  const raw = await res.json();
  const body = raw?.conversation && typeof raw.conversation === "object" ? raw.conversation : raw;
  const title = typeof body?.annotations?.title === "string" && body.annotations.title.trim()
    ? body.annotations.title.trim()
    : null;
  const summary = typeof body?.state?.summary === "string" && body.state.summary.trim()
    ? body.state.summary.trim()
    : null;
  const runState = typeof body?.state?.runState === "string" && body.state.runState.trim()
    ? body.state.runState.trim()
    : null;
  return { title, summary, runState };
}

async function main() {
  const { dataDir } = parseArgs(process.argv.slice(2));
  const dbPath = path.join(dataDir, "poly-swarm.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`[sync-titles] database not found: ${dbPath}`);
    return;
  }
  if (!process.env.ANTIGRAVITY_LS_ADDRESS || !process.env.ANTIGRAVITY_CSRF_TOKEN) {
    console.error("[sync-titles] ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN not set; skipping.");
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    const ids = new Set();
    for (const row of db.prepare("SELECT DISTINCT conversation_id FROM swarms WHERE conversation_id IS NOT NULL").all()) {
      const cid = String(row.conversation_id || "").trim();
      if (cid) ids.add(cid);
    }
    for (const row of db.prepare("SELECT conversation_id FROM session_bindings").all()) {
      const cid = String(row.conversation_id || "").trim();
      if (cid) ids.add(cid);
    }

    let updated = 0;
    for (const cid of ids) {
      const meta = await fetchConversationMeta(cid);
      if (!meta) continue;
      const now = Date.now();
      db.prepare(
        `INSERT INTO conversation_archives (conversation_id, created_at, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING`,
      ).run(cid, now, now);
      db.prepare(
        `UPDATE conversation_archives
         SET host_title = COALESCE(?, host_title),
             host_summary = COALESCE(?, host_summary),
             host_run_state = COALESCE(?, host_run_state),
             host_synced_at = ?,
             updated_at = ?
         WHERE conversation_id = ?`,
      ).run(meta.title, meta.summary, meta.runState, now, now, cid);
      if (meta.title || meta.summary) updated += 1;
      console.error(`[sync-titles] ${cid.slice(0, 8)}: title=${JSON.stringify(meta.title)} summary=${Boolean(meta.summary)}`);
    }
    console.error(`[sync-titles] synced ${updated}/${ids.size} conversation(s).`);
  } finally {
    db.close();
  }
}

void main();
