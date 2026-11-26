import type { BackendId, CapabilityTag, TurnRecord } from "../shared/types.js";
import type { PolySwarmDB } from "./db.js";

export interface RouteEvidence {
  observations: number;
  seats: number;
  completed: number;
  score: number | null;
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Smoothed execution reliability, NOT a code quality or acceptance score. */
export function summarizeRoutingObservations(rows: Array<Pick<TurnRecord, "swarm_id" | "worker_name" | "status">>): RouteEvidence {
  const terminal = rows.filter((row) => row.status === "completed" || row.status === "failed");
  // Count only the latest terminal observation for each seat; a single long
  // conversation must not dominate the routing signal.
  const unique = new Map<string, typeof terminal[number]>();
  for (const row of terminal) {
    const key = JSON.stringify([row.swarm_id, row.worker_name]);
    if (!unique.has(key)) unique.set(key, row);
  }
  const seats = unique.size;
  const completed = [...unique.values()].filter((row) => row.status === "completed").length;
  return { observations: terminal.length, seats, completed, score: seats >= 5 ? (completed + 2) / (seats + 4) : null };
}

export function rankRoutes(input: {
  candidates: BackendId[];
  db: PolySwarmDB;
  repoRoot: string | null | undefined;
  capability: CapabilityTag;
  readonly: boolean;
  profile: (backend: BackendId) => { model: string | null; effort: string | null };
  now?: number;
}): { ordered: BackendId[]; evidence: Map<BackendId, RouteEvidence> } {
  const evidence = new Map<BackendId, RouteEvidence>();
  const ordered = [...input.candidates];
  if (!input.repoRoot) return { ordered, evidence };
  const now = input.now ?? Date.now();
  for (const backend of ordered) {
    const { model, effort } = input.profile(backend);
    if (backend === "mock" || !model || /^(auto|default)$/i.test(model)) continue;
    evidence.set(backend, summarizeRoutingObservations(input.db.listRoutingObservations({
      repoRoot: input.repoRoot, capability: input.capability, mode: input.readonly ? "readonly" : "write",
      backend, model, effort, since: now - WINDOW_MS, now,
    })));
  }
  // Insufficient/unknown profiles keep their original slots (including the
  // first slot). Rank only sufficiently sampled profiles, with stable ties.
  const slots = ordered.map((backend, index) => ({ backend, index })).filter(({ backend }) => evidence.get(backend)?.score != null);
  const ranked = [...slots].sort((a, b) => evidence.get(b.backend)!.score! - evidence.get(a.backend)!.score! || a.index - b.index);
  slots.forEach(({ index }, i) => { ordered[index] = ranked[i]!.backend; });
  return { ordered, evidence };
}
