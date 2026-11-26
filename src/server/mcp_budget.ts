import type {
  BoardMessage,
  TurnRecord,
  WorkerDetailPayload,
  WorkerEvent,
  WorkerSummary,
} from "../shared/types.js";

export const DEFAULT_MCP_RESULT_MAX_BYTES = 28 * 1024;

export function safeTruncateUtf8(
  text: string,
  maxBytes: number,
  suffix = "\n…[truncated]",
): string {
  if (maxBytes <= 0 || !text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes > maxBytes) {
    let usedSuffix = 0;
    let partialSuffix = "";
    for (const cp of suffix) {
      const cb = Buffer.byteLength(cp, "utf8");
      if (usedSuffix + cb > maxBytes) break;
      usedSuffix += cb;
      partialSuffix += cp;
    }
    return partialSuffix;
  }
  const budget = maxBytes - suffixBytes;
  let used = 0;
  let acc = "";
  for (const cp of text) {
    const cb = Buffer.byteLength(cp, "utf8");
    if (used + cb > budget) break;
    used += cb;
    acc += cp;
  }
  return `${acc}${suffix}`;
}

export function measureMcpPayloadBytes(
  text: string,
  structuredContent?: Record<string, unknown>,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text" as const, text }],
      ...(structuredContent ? { structuredContent } : {}),
    }),
    "utf8",
  );
}

export type PackedBoardMessage = BoardMessage & { item_truncated?: boolean };

export interface PackedBoardResult {
  messages: PackedBoardMessage[];
  text: string;
  truncated: boolean;
  omitted_count: number;
  next_since: number;
}

function formatBoardLine(m: BoardMessage, itemTruncated = false): string {
  const tagNote = itemTruncated ? " [truncated]" : "";
  return `#${m.seq} [${m.channel}] ${m.sender} (${m.tag})${tagNote}: ${m.text}`;
}

function fitSingleBoardMessage(
  msg: BoardMessage,
  maxBytes: number,
  omittedAfter: number,
  extraStructured?: Record<string, unknown>,
): { packed: PackedBoardMessage; text: string } {
  const buildCandidate = (msgText: string, itemTruncated: boolean) => {
    const packed: PackedBoardMessage = itemTruncated
      ? { ...msg, text: msgText, item_truncated: true }
      : { ...msg };
    const line = formatBoardLine(packed, itemTruncated);
    const footer = omittedAfter > 0
      ? `\n\n[Truncated: omitted ${omittedAfter} message(s) to fit ${maxBytes}B budget. Call again with since=${msg.seq}.]`
      : `\n\n[Truncated long message #${msg.seq} to fit ${maxBytes}B budget. Next cursor: since=${msg.seq}.]`;
    const fullText = `${line}${footer}`;
    const sc: Record<string, unknown> = {
      ...(extraStructured ?? {}),
      messages: [packed],
      truncated: true,
      omitted_count: omittedAfter,
      next_since: msg.seq,
    };
    return { packed, fullText, sc };
  };

  let lo = 0;
  let hi = Buffer.byteLength(msg.text, "utf8");
  let best = buildCandidate("", true);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidateText = safeTruncateUtf8(msg.text, mid, "\n…[message truncated]");
    const cand = buildCandidate(candidateText, true);
    if (measureMcpPayloadBytes(cand.fullText, cand.sc) <= maxBytes) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { packed: best.packed, text: best.fullText };
}

export function packBoardMessagesWithinBudget(
  messages: BoardMessage[],
  opts?: {
    maxBytes?: number;
    nextSinceFallback?: number;
    emptyText?: string;
    extraStructured?: Record<string, unknown>;
  },
): PackedBoardResult {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MCP_RESULT_MAX_BYTES;
  const fallbackSince = opts?.nextSinceFallback ?? 0;

  if (messages.length === 0) {
    return {
      messages: [],
      text: opts?.emptyText ?? "No new messages.",
      truncated: false,
      omitted_count: 0,
      next_since: fallbackSince,
    };
  }

  const packed: PackedBoardMessage[] = [];
  const lines: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const nextPacked: PackedBoardMessage[] = [...packed, { ...msg }];
    const nextLines = [...lines, formatBoardLine(msg)];
    const omittedAfter = messages.length - nextPacked.length;
    const truncatedFlag = omittedAfter > 0;
    const footer = omittedAfter > 0
      ? `\n\n[Truncated: omitted ${omittedAfter} message(s) to fit ${maxBytes}B budget. Call again with since=${msg.seq}.]`
      : "";
    const candidateText = `${nextLines.join("\n")}${footer}`;
    const candidateStructured: Record<string, unknown> = {
      ...(opts?.extraStructured ?? {}),
      messages: nextPacked,
      truncated: truncatedFlag,
      omitted_count: omittedAfter,
      next_since: msg.seq,
    };

    if (measureMcpPayloadBytes(candidateText, candidateStructured) <= maxBytes) {
      packed.push({ ...msg });
      lines.push(formatBoardLine(msg));
    } else {
      if (packed.length === 0) {
        const fitted = fitSingleBoardMessage(msg, maxBytes, omittedAfter, opts?.extraStructured);
        return {
          messages: [fitted.packed],
          text: fitted.text,
          truncated: true,
          omitted_count: omittedAfter,
          next_since: msg.seq,
        };
      }
      break;
    }
  }

  const omittedCount = messages.length - packed.length;
  const lastSeq = packed[packed.length - 1]!.seq;
  const truncated = omittedCount > 0;
  const footer = truncated
    ? `\n\n[Truncated: omitted ${omittedCount} message(s) to fit ${maxBytes}B budget. Call again with since=${lastSeq}.]`
    : "";
  const finalText = `${lines.join("\n")}${footer}`;

  return {
    messages: packed,
    text: finalText,
    truncated,
    omitted_count: omittedCount,
    next_since: lastSeq,
  };
}

export interface PackedWorkerInspectResult {
  text: string;
  structuredContent: Record<string, unknown>;
  truncated: boolean;
  events_truncated: boolean;
  next_after_event_id: number | null;
  diff_truncated: boolean;
}

function compactWorkerSummary(worker: WorkerSummary, maxErrBytes = 1024): WorkerSummary {
  return {
    ...worker,
    resolved_policy_json: null,
    last_error: worker.last_error ? safeTruncateUtf8(worker.last_error, maxErrBytes) : null,
    latest_turn: worker.latest_turn
      ? {
          ...worker.latest_turn,
          prompt_preview: "",
          output_text: worker.latest_turn.output_text
            ? safeTruncateUtf8(worker.latest_turn.output_text, 512)
            : null,
          structured_json: null,
        }
      : null,
    latest_event: worker.latest_event
      ? {
          ...worker.latest_event,
          content: safeTruncateUtf8(worker.latest_event.content, 512),
          meta_json: null,
        }
      : null,
  };
}

function compactTurnRecord(
  turn: TurnRecord,
  isTarget: boolean,
  limits: { promptBytes: number; outputBytes: number; structuredBytes: number },
): TurnRecord {
  if (!isTarget) {
    return {
      ...turn,
      prompt_preview: "",
      output_text: null,
      structured_json: null,
      error_message: turn.error_message ? safeTruncateUtf8(turn.error_message, 300) : null,
    };
  }
  return {
    ...turn,
    prompt_preview: safeTruncateUtf8(turn.prompt_preview, limits.promptBytes),
    output_text: turn.output_text ? safeTruncateUtf8(turn.output_text, limits.outputBytes) : null,
    structured_json: turn.structured_json ? safeTruncateUtf8(turn.structured_json, limits.structuredBytes) : null,
    error_message: turn.error_message ? safeTruncateUtf8(turn.error_message, 1024) : null,
  };
}

export function packWorkerInspectWithinBudget(params: {
  detail: WorkerDetailPayload;
  events: WorkerEvent[];
  targetTurnId?: string | null;
  afterEventId?: number;
  include: { turns: boolean; events: boolean; diff: boolean };
  turnLimit?: number;
  maxBytes?: number;
}): PackedWorkerInspectResult {
  const maxBytes = params.maxBytes ?? DEFAULT_MCP_RESULT_MAX_BYTES;
  const turnLimit = params.turnLimit ?? 10;
  const targetTurnId = params.targetTurnId ?? params.detail.turns[0]?.id ?? null;

  const compactWorker = compactWorkerSummary(params.detail.worker);
  const rawTurns = params.include.turns
    ? params.detail.turns.slice(0, turnLimit)
    : params.detail.turns.slice(0, 3);

  let turnOutputLimit = 4096;
  let turnPromptLimit = 1024;
  let turnStructuredLimit = 2048;

  const buildTurns = () =>
    rawTurns.map((t) =>
      compactTurnRecord(t, t.id === targetTurnId, {
        promptBytes: turnPromptLimit,
        outputBytes: turnOutputLimit,
        structuredBytes: turnStructuredLimit,
      }),
    );

  const rawDiff = params.include.diff ? params.detail.diff : null;
  let patchLimit = 4096;
  const buildDiff = () => {
    if (!rawDiff) return null;
    const rawPatch = rawDiff.patch_preview || "";
    const truncatedPatch = patchLimit > 0 ? safeTruncateUtf8(rawPatch, patchLimit) : "";
    const patchWasClipped =
      rawDiff.truncated ||
      truncatedPatch !== rawPatch;
    return {
      branch: rawDiff.branch,
      target_branch: rawDiff.target_branch ?? null,
      head_sha: rawDiff.head_sha ?? null,
      dirty: rawDiff.dirty ?? false,
      dirty_files: (rawDiff.dirty_files ?? []).slice(0, 60),
      files: rawDiff.files.slice(0, 100),
      stat: safeTruncateUtf8(rawDiff.stat || "", 1536),
      patch_preview: truncatedPatch,
      truncated: patchWasClipped,
    };
  };

  let singleEventContentLimit = 1536;
  let anyEventContentTruncated = false;
  const compactEvent = (ev: WorkerEvent, contentLimit: number): { event: WorkerEvent; clipped: boolean } => {
    const c = safeTruncateUtf8(ev.content, contentLimit);
    const meta = ev.meta_json && Buffer.byteLength(ev.meta_json, "utf8") <= 256 ? ev.meta_json : null;
    return { event: { ...ev, content: c, meta_json: meta }, clipped: c !== ev.content };
  };

  const buildHeaderText = (
    packedEvents: WorkerEvent[],
    eventsTruncated: boolean,
    nextAfterEventId: number | null,
    diff: ReturnType<typeof buildDiff>,
    diffTruncated: boolean,
  ): string => {
    const w = compactWorker;
    const costDisplay = w.usage.cost_usd.toFixed(4);
    const lines = [
      `Worker @${w.name} (${w.backend}${w.model ? `/${w.model}` : ""}, ${w.role}, ${w.state})`,
      `Session: ${w.session_id ?? "none"} | Turns: ${w.usage.turns} | Tokens: ${w.usage.total_tokens} (in=${w.usage.input_tokens}, out=${w.usage.output_tokens}, cache_r=${w.usage.cache_read_tokens}) | Cost: $${costDisplay}`,
    ];
    if (params.include.events) {
      const shownLines = packedEvents.slice(-25).map(
        (ev) =>
          `  [${ev.seq_in_turn}] (#${ev.id} ${ev.kind}${ev.title ? `:${ev.title}` : ""}) ${safeTruncateUtf8(ev.content, 240, "…")}`,
      );
      lines.push(`Events (returned=${packedEvents.length}/${params.events.length}):`);
      lines.push(...shownLines);
      if (eventsTruncated && nextAfterEventId !== null) {
        lines.push(
          `[Events truncated to fit ${maxBytes}B budget. Call poly_worker_inspect again with after_event_id=${nextAfterEventId}.]`,
        );
      }
    }
    if (diff) {
      lines.push(`Diff files (${diff.files.length}): ${diff.files.slice(0, 20).join(", ")}${diff.files.length > 20 ? " …" : ""}`);
      if (diff.stat) lines.push(diff.stat);
      if (diffTruncated) {
        lines.push(`[Diff patch_preview truncated to fit ${maxBytes}B budget.]`);
      }
    }
    return lines.join("\n");
  };

  // Determine how many turns + diff baseline fit, leaving head room for events
  let turns = buildTurns();
  let diff = buildDiff();
  const baseCheck = (t: TurnRecord[], d: ReturnType<typeof buildDiff>) =>
    measureMcpPayloadBytes(buildHeaderText([], false, null, d, Boolean(d?.truncated)), {
      worker: compactWorker,
      turns: t,
      events: [],
      diff: d,
      truncated: false,
      events_truncated: false,
      next_after_event_id: null,
      diff_truncated: Boolean(d?.truncated),
    });

  // Shrink patch & turn preview if base payload already takes too much of maxBytes (> 60% when events exist)
  const reserveTarget = params.include.events && params.events.length > 0
    ? Math.floor(maxBytes * 0.55)
    : maxBytes - 512;

  if (baseCheck(turns, diff) > reserveTarget) {
    patchLimit = Math.min(patchLimit, 1024);
    diff = buildDiff();
  }
  if (baseCheck(turns, diff) > reserveTarget) {
    patchLimit = 0;
    diff = buildDiff();
  }
  if (baseCheck(turns, diff) > reserveTarget) {
    turnOutputLimit = 1024;
    turnPromptLimit = 512;
    turnStructuredLimit = 512;
    turns = buildTurns();
  }
  if (baseCheck(turns, diff) > reserveTarget) {
    turnOutputLimit = 256;
    turnPromptLimit = 256;
    turnStructuredLimit = 0;
    turns = buildTurns();
  }

  const packedEvents: WorkerEvent[] = [];
  if (params.include.events && params.events.length > 0) {
    for (let i = 0; i < params.events.length; i++) {
      const { event: ev, clipped } = compactEvent(params.events[i]!, singleEventContentLimit);
      const nextEvents = [...packedEvents, ev];
      const nextTruncated =
        nextEvents.length < params.events.length || anyEventContentTruncated || clipped;
      const nextAfterId = ev.id;
      const diffClipped = Boolean(diff?.truncated);
      const text = buildHeaderText(nextEvents, nextTruncated, nextAfterId, diff, diffClipped);
      const sc: Record<string, unknown> = {
        worker: compactWorker,
        turns,
        events: nextEvents,
        diff,
        truncated: nextTruncated || diffClipped || turnOutputLimit < 4096,
        events_truncated: nextTruncated,
        next_after_event_id: nextAfterId,
        diff_truncated: diffClipped,
      };
      if (measureMcpPayloadBytes(text, sc) <= maxBytes) {
        if (clipped) anyEventContentTruncated = true;
        packedEvents.push(ev);
      } else {
        if (packedEvents.length === 0) {
          // Ensure at least 1 event fits by trimming event content
          let lo = 0;
          let hi = Math.min(singleEventContentLimit, Buffer.byteLength(params.events[i]!.content, "utf8"));
          let chosen = compactEvent(params.events[i]!, 0).event;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const candEv = { ...params.events[i]!, content: safeTruncateUtf8(params.events[i]!.content, mid), meta_json: null };
            const candText = buildHeaderText([candEv], true, candEv.id, diff, Boolean(diff?.truncated));
            const candSc: Record<string, unknown> = {
              worker: compactWorker,
              turns,
              events: [candEv],
              diff,
              truncated: true,
              events_truncated: true,
              next_after_event_id: candEv.id,
              diff_truncated: Boolean(diff?.truncated),
            };
            if (measureMcpPayloadBytes(candText, candSc) <= maxBytes) {
              chosen = candEv;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          anyEventContentTruncated = true;
          packedEvents.push(chosen);
        }
        break;
      }
    }
  }

  const eventsTruncated =
    params.include.events &&
    (packedEvents.length < params.events.length || anyEventContentTruncated);
  const nextAfterEventId =
    packedEvents.length > 0
      ? packedEvents[packedEvents.length - 1]!.id
      : params.afterEventId ?? null;
  const diffTruncated = Boolean(diff?.truncated);
  const overallTruncated = eventsTruncated || diffTruncated || turnOutputLimit < 4096;

  let text = buildHeaderText(packedEvents, eventsTruncated, nextAfterEventId, diff, diffTruncated);
  const structuredContent: Record<string, unknown> = {
    worker: compactWorker,
    turns,
    events: packedEvents,
    diff,
    truncated: overallTruncated,
    events_truncated: eventsTruncated,
    next_after_event_id: nextAfterEventId,
    diff_truncated: diffTruncated,
  };

  // Final hard safety clamp
  while (measureMcpPayloadBytes(text, structuredContent) > maxBytes) {
    if (diff && diff.patch_preview) {
      diff.patch_preview = "";
      diff.truncated = true;
      structuredContent.diff_truncated = true;
      structuredContent.truncated = true;
      text = buildHeaderText(packedEvents, eventsTruncated, nextAfterEventId, diff, true);
      continue;
    }
    if (packedEvents.length > 1) {
      packedEvents.pop();
      const tailId = packedEvents[packedEvents.length - 1]?.id ?? params.afterEventId ?? null;
      structuredContent.events_truncated = true;
      structuredContent.truncated = true;
      structuredContent.next_after_event_id = tailId;
      text = buildHeaderText(packedEvents, true, tailId, diff, Boolean(structuredContent.diff_truncated));
      continue;
    }
    const over = measureMcpPayloadBytes(text, structuredContent) - maxBytes;
    const textBytes = Buffer.byteLength(text, "utf8");
    const nextTextBytes = Math.max(64, textBytes - over - 32);
    if (nextTextBytes < textBytes) {
      text = safeTruncateUtf8(text, nextTextBytes);
      continue;
    }
    if (packedEvents.length === 1 && packedEvents[0]!.content) {
      packedEvents[0]!.content = safeTruncateUtf8(
        packedEvents[0]!.content,
        Math.max(0, Buffer.byteLength(packedEvents[0]!.content, "utf8") - over - 64),
      );
      structuredContent.events_truncated = true;
      structuredContent.truncated = true;
      continue;
    }
    break;
  }

  return {
    text,
    structuredContent,
    truncated: Boolean(structuredContent.truncated),
    events_truncated: Boolean(structuredContent.events_truncated),
    next_after_event_id: (structuredContent.next_after_event_id as number | null) ?? null,
    diff_truncated: Boolean(structuredContent.diff_truncated),
  };
}
