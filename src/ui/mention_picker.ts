import type { BackendId, ChannelRecord, WorkerSummary } from "../shared/types.js";

export interface MentionCandidate {
  kind: "all" | "worker" | "channel";
  insertText: string;
  label: string;
  sublabel: string;
  avatarLetter: string;
  avatarBg: string;
  searchText: string;
}

export interface MentionTrigger {
  start: number;
  end: number;
  query: string;
}

/**
 * Detects an active `@query` mention token immediately before `cursorPos`.
 * Ignores email-like tokens preceded by ASCII word/dot/hyphen characters, while
 * allowing CJK characters directly before `@` (e.g. `请@grok`).
 */
export function detectMentionTrigger(value: string, cursorPos: number): MentionTrigger | null {
  const clamped = Math.max(0, Math.min(cursorPos, value.length));
  const before = value.slice(0, clamped);
  const match = before.match(/(?:^|[^a-zA-Z0-9._-])(@([a-zA-Z0-9#_-]*))$/);
  if (!match) return null;
  const fullToken = match[1]!;
  const query = match[2] ?? "";
  return {
    start: clamped - fullToken.length,
    end: clamped,
    query,
  };
}

export function buildMentionCandidates(params: {
  workers: WorkerSummary[];
  channels: ChannelRecord[];
  effectiveDefaults?: Partial<Record<BackendId, { model?: string; effort?: string }>>;
  avatarFor: (backend: string) => { letter: string; bg: string };
  stateLabel: (st: string) => string;
}): MentionCandidate[] {
  const activeWorkers = params.workers.filter((w) => w.state !== "killed");
  const out: MentionCandidate[] = [
    {
      kind: "all",
      insertText: "@all",
      label: "@all",
      sublabel: `广播唤醒全部存活成员 (${activeWorkers.length} 位)`,
      avatarLetter: "*",
      avatarBg: "#2563eb",
      searchText: "all 全部 所有 广播",
    },
  ];

  for (const w of activeWorkers) {
    const model = w.model || params.effectiveDefaults?.[w.backend]?.model || "CLI 默认";
    const av = params.avatarFor(w.backend);
    out.push({
      kind: "worker",
      insertText: `@${w.name}`,
      label: `@${w.name}`,
      sublabel: `${w.backend} · ${model} · ${params.stateLabel(w.state)}`,
      avatarLetter: av.letter,
      avatarBg: av.bg,
      searchText: `${w.name} ${w.backend} ${model} ${w.role}`.toLowerCase(),
    });
  }

  for (const c of params.channels) {
    if (c.archived) continue;
    out.push({
      kind: "channel",
      insertText: `@#${c.name}`,
      label: `@#${c.name}`,
      sublabel: c.topic ? `频道 · ${c.topic}` : "频道",
      avatarLetter: "#",
      avatarBg: "#475569",
      searchText: `#${c.name} ${c.name} ${c.topic ?? ""} channel 频道`.toLowerCase(),
    });
  }

  return out;
}

export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates;

  if (q.startsWith("#")) {
    const cq = q.slice(1);
    const channelItems = candidates.filter(
      (c) =>
        c.kind === "channel" &&
        (!cq || c.label.slice(2).toLowerCase().includes(cq) || c.searchText.includes(cq)),
    );
    return channelItems.sort((a, b) => {
      const aPre = a.label.slice(2).toLowerCase().startsWith(cq) ? 0 : 1;
      const bPre = b.label.slice(2).toLowerCase().startsWith(cq) ? 0 : 1;
      return aPre - bPre;
    });
  }

  const matched = candidates.filter(
    (c) => c.label.toLowerCase().includes(q) || c.searchText.includes(q),
  );
  return matched.sort((a, b) => {
    const aName = a.label.slice(1).toLowerCase();
    const bName = b.label.slice(1).toLowerCase();
    const aRank = aName === q ? 0 : aName.startsWith(q) ? 1 : 2;
    const bRank = bName === q ? 0 : bName.startsWith(q) ? 1 : 2;
    return aRank - bRank;
  });
}

export function applyMentionSelection(
  value: string,
  trigger: MentionTrigger,
  insertText: string,
): { nextValue: string; nextCursor: number } {
  const before = value.slice(0, trigger.start);
  const after = value.slice(trigger.end);
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const insertion = needsSpace ? `${insertText} ` : insertText;
  return {
    nextValue: `${before}${insertion}${after}`,
    nextCursor: before.length + insertion.length,
  };
}
