import type {
  BackendId,
  BackendUsageBreakdown,
  SessionTurnUsageItem,
  TurnRecord,
  UsageBreakdownSummary,
  UsageRecord,
  VendorUsageSummary,
} from "../shared/types.js";

export interface ModelPriceRate {
  /** USD per 1M uncached input tokens */
  inputPerMillion: number;
  /** USD per 1M cache read tokens */
  cacheReadPerMillion: number;
  /** USD per 1M cache write tokens */
  cacheWritePerMillion: number;
  /** USD per 1M output (+ reasoning) tokens */
  outputPerMillion: number;
}

export interface NormalizedUsageMetrics {
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  effective_total_tokens: number;
}

const INCLUSIVE_CACHE_BACKENDS = new Set<BackendId>(["codex", "trae", "agy", "codebuddy"]);

const RATES = {
  gptFlagship: { inputPerMillion: 2.5, cacheReadPerMillion: 0.25, cacheWritePerMillion: 2.5, outputPerMillion: 15.0 },
  gptMini: { inputPerMillion: 0.25, cacheReadPerMillion: 0.025, cacheWritePerMillion: 0.25, outputPerMillion: 2.0 },
  claudeOpus: { inputPerMillion: 15.0, cacheReadPerMillion: 1.5, cacheWritePerMillion: 18.75, outputPerMillion: 75.0 },
  claudeSonnet: { inputPerMillion: 3.0, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75, outputPerMillion: 15.0 },
  claudeHaiku: { inputPerMillion: 0.8, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1.0, outputPerMillion: 4.0 },
  grokFlagship: { inputPerMillion: 3.0, cacheReadPerMillion: 0.75, cacheWritePerMillion: 3.0, outputPerMillion: 15.0 },
  grokFast: { inputPerMillion: 0.6, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0.6, outputPerMillion: 3.0 },
  geminiPro: { inputPerMillion: 1.25, cacheReadPerMillion: 0.31, cacheWritePerMillion: 1.25, outputPerMillion: 10.0 },
  geminiFlash: { inputPerMillion: 0.3, cacheReadPerMillion: 0.075, cacheWritePerMillion: 0.3, outputPerMillion: 2.5 },
  deepseek: { inputPerMillion: 0.27, cacheReadPerMillion: 0.07, cacheWritePerMillion: 0.27, outputPerMillion: 1.1 },
  kimi: { inputPerMillion: 0.6, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0.6, outputPerMillion: 2.5 },
  free: { inputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0 },
} satisfies Record<string, ModelPriceRate>;

/**
 * Resolves a public-API reference rate table for unpriced/subscription turns.
 * Returns null only for synthetic/unknown mock backends.
 */
export function resolveReferencePriceRate(backend: BackendId, model: string | null): ModelPriceRate | null {
  const m = (model ?? "").trim().toLowerCase();
  if (m) {
    if (m.includes("free") || m === "mock") return RATES.free;
    if (m.includes("opus")) return RATES.claudeOpus;
    if (m.includes("sonnet")) return RATES.claudeSonnet;
    if (m.includes("haiku")) return RATES.claudeHaiku;
    if (m.includes("grok")) {
      return m.includes("fast") || m.includes("mini") || m.includes("lite") ? RATES.grokFast : RATES.grokFlagship;
    }
    if (m.includes("gemini")) {
      return m.includes("flash") || m.includes("lite") || m.includes("argon") || m.includes("hydrogen")
        ? RATES.geminiFlash
        : RATES.geminiPro;
    }
    if (m.includes("deepseek")) return RATES.deepseek;
    if (m.includes("kimi") || m.includes("moonshot")) return RATES.kimi;
    // Reference estimates for these model families use comparable rate tiers.
    if (m.includes("doubao") || /(?:^|\/)seed(?:-|$)/.test(m)) return RATES.deepseek;
    if (m.includes("minimax")) return RATES.kimi;
    if (m.includes("gpt") || m.includes("codex") || /^o[134]/.test(m)) {
      return m.includes("mini") || m.includes("nano") ? RATES.gptMini : RATES.gptFlagship;
    }
  }

  switch (backend) {
    case "codex":
      return RATES.gptFlagship;
    case "cursor":
      return RATES.claudeSonnet;
    case "agy":
      return RATES.geminiPro;
    case "grok":
      return RATES.grokFlagship;
    case "codebuddy":
      return RATES.kimi;
    case "opencode":
    case "qoder":
    case "trae":
      return RATES.deepseek;
    case "mock":
      return null;
  }
}

/**
 * Normalizes inclusive vs exclusive cached-input accounting across heterogeneous CLIs:
 * - Codex / TRAE / Agy / CodeBuddy report input_tokens inclusive of cache_read_tokens.
 * - Grok / OpenCode / Cursor / Qoder report input_tokens exclusive of cache_read_tokens.
 */
export function normalizeUsageRow(
  row: Pick<
    UsageRecord,
    "backend" | "input_tokens" | "output_tokens" | "reasoning_tokens" | "cache_read_tokens" | "cache_write_tokens"
  >,
): NormalizedUsageMetrics {
  const input = Math.max(0, Number(row.input_tokens) || 0);
  const output = Math.max(0, Number(row.output_tokens) || 0);
  const reasoning = Math.max(0, Number(row.reasoning_tokens) || 0);
  const cacheRead = Math.max(0, Number(row.cache_read_tokens) || 0);
  const cacheWrite = Math.max(0, Number(row.cache_write_tokens) || 0);

  const inclusive = INCLUSIVE_CACHE_BACKENDS.has(row.backend) && cacheRead > 0 && input >= cacheRead;
  if (inclusive) {
    const uncached = input - cacheRead;
    const totalInput = input + cacheWrite;
    return {
      uncached_input_tokens: uncached,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_input_tokens: totalInput,
      output_tokens: output,
      reasoning_tokens: reasoning,
      effective_total_tokens: totalInput + output + reasoning,
    };
  }

  const totalInput = input + cacheRead + cacheWrite;
  return {
    uncached_input_tokens: input,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_input_tokens: totalInput,
    output_tokens: output,
    reasoning_tokens: reasoning,
    effective_total_tokens: totalInput + output + reasoning,
  };
}

export function estimateUsageCostUsd(
  row: Pick<UsageRecord, "backend" | "model" | "cost_usd">,
  normalized: NormalizedUsageMetrics,
): number | null {
  if (row.cost_usd !== null && row.cost_usd !== undefined) return null;
  const rate = resolveReferencePriceRate(row.backend, row.model);
  if (!rate) return null;
  const usd =
    (normalized.uncached_input_tokens * rate.inputPerMillion +
      normalized.cache_read_tokens * rate.cacheReadPerMillion +
      normalized.cache_write_tokens * rate.cacheWritePerMillion +
      (normalized.output_tokens + normalized.reasoning_tokens) * rate.outputPerMillion) /
    1_000_000;
  return Number(usd.toFixed(6));
}

export function aggregateNormalizedUsage(rows: readonly UsageRecord[]): UsageBreakdownSummary {
  let turns = 0;
  let toolCallsCount = 0;
  let durationMs = 0;
  let totalTokens = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let knownCostUsd = 0;
  let estimatedCostUsd = 0;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  let exactTurns = 0;
  let hookTurns = 0;
  let estimatedTurns = 0;

  const byKey = new Map<
    string,
    {
      backend: BackendId;
      model: string | null;
      turns: number;
      total_tokens: number;
      uncached_input_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      known_cost_usd: number;
      estimated_cost_usd: number;
      priced_turns: number;
      unpriced_turns: number;
      duration_ms: number;
      tool_calls_count: number;
    }
  >();

  for (const row of rows) {
    const norm = normalizeUsageRow(row);
    const estCost = estimateUsageCostUsd(row, norm);
    const dur = Math.max(0, Number(row.duration_ms) || 0);
    const tools = Math.max(0, Number(row.tool_calls_count) || 0);

    turns += 1;
    toolCallsCount += tools;
    durationMs += dur;
    totalTokens += norm.effective_total_tokens;
    uncachedInputTokens += norm.uncached_input_tokens;
    cacheReadTokens += norm.cache_read_tokens;
    cacheWriteTokens += norm.cache_write_tokens;
    totalInputTokens += norm.total_input_tokens;
    outputTokens += norm.output_tokens;
    reasoningTokens += norm.reasoning_tokens;

    if (row.cost_usd !== null && row.cost_usd !== undefined) {
      knownCostUsd += Number(row.cost_usd) || 0;
      pricedTurns += 1;
    } else {
      unpricedTurns += 1;
      if (estCost !== null) estimatedCostUsd += estCost;
    }

    if (row.accuracy === "exact") exactTurns += 1;
    else if (row.accuracy === "hook") hookTurns += 1;
    else estimatedTurns += 1;

    const model = row.model?.trim() || null;
    const key = `${row.backend}::${model ?? ""}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        backend: row.backend,
        model,
        turns: 0,
        total_tokens: 0,
        uncached_input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        known_cost_usd: 0,
        estimated_cost_usd: 0,
        priced_turns: 0,
        unpriced_turns: 0,
        duration_ms: 0,
        tool_calls_count: 0,
      };
      byKey.set(key, bucket);
    }
    bucket.turns += 1;
    bucket.total_tokens += norm.effective_total_tokens;
    bucket.uncached_input_tokens += norm.uncached_input_tokens;
    bucket.cache_read_tokens += norm.cache_read_tokens;
    bucket.cache_write_tokens += norm.cache_write_tokens;
    bucket.total_input_tokens += norm.total_input_tokens;
    bucket.output_tokens += norm.output_tokens;
    bucket.reasoning_tokens += norm.reasoning_tokens;
    bucket.duration_ms += dur;
    bucket.tool_calls_count += tools;
    if (row.cost_usd !== null && row.cost_usd !== undefined) {
      bucket.known_cost_usd += Number(row.cost_usd) || 0;
      bucket.priced_turns += 1;
    } else {
      bucket.unpriced_turns += 1;
      if (estCost !== null) bucket.estimated_cost_usd += estCost;
    }
  }

  const byBackend: BackendUsageBreakdown[] = [...byKey.values()]
    .map((b) => ({
      backend: b.backend,
      model: b.model,
      turns: b.turns,
      total_tokens: b.total_tokens,
      uncached_input_tokens: b.uncached_input_tokens,
      cache_read_tokens: b.cache_read_tokens,
      cache_write_tokens: b.cache_write_tokens,
      output_tokens: b.output_tokens,
      reasoning_tokens: b.reasoning_tokens,
      cache_hit_rate:
        b.cache_read_tokens > 0 && b.total_input_tokens > 0
          ? b.cache_read_tokens / b.total_input_tokens
          : null,
      known_cost_usd: Number(b.known_cost_usd.toFixed(6)),
      estimated_cost_usd: Number(b.estimated_cost_usd.toFixed(6)),
      priced_turns: b.priced_turns,
      unpriced_turns: b.unpriced_turns,
      duration_ms: b.duration_ms,
      tool_calls_count: b.tool_calls_count,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.backend.localeCompare(b.backend));

  return {
    turns,
    tool_calls_count: toolCallsCount,
    duration_ms: durationMs,
    avg_output_tps:
      durationMs > 0 && outputTokens > 0
        ? Number((outputTokens / (durationMs / 1000)).toFixed(1))
        : null,
    total_tokens: totalTokens,
    uncached_input_tokens: uncachedInputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    total_input_tokens: totalInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    cache_hit_rate:
      cacheReadTokens > 0 && totalInputTokens > 0
        ? cacheReadTokens / totalInputTokens
        : null,
    known_cost_usd: Number(knownCostUsd.toFixed(6)),
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    priced_turns: pricedTurns,
    unpriced_turns: unpricedTurns,
    exact_turns: exactTurns,
    hook_turns: hookTurns,
    estimated_turns: estimatedTurns,
    by_backend: byBackend,
  };
}

export interface SwarmTurnUsageRow extends UsageRecord {
  turn_status?: TurnRecord["status"] | null;
  trigger_seq?: number | null;
  prompt_preview?: string | null;
  resolved_model?: string | null;
}

export function buildSessionTurnUsageItem(row: SwarmTurnUsageRow): SessionTurnUsageItem {
  const norm = normalizeUsageRow(row);
  const model = row.resolved_model?.trim() || row.model?.trim() || null;
  const estCost = estimateUsageCostUsd(
    { backend: row.backend, model, cost_usd: row.cost_usd },
    norm,
  );
  const rawPreview = row.prompt_preview ? row.prompt_preview.replace(/\s+/g, " ").trim() : "";
  const promptPreview = rawPreview ? rawPreview.slice(0, 160) : null;
  return {
    turn_id: row.turn_id,
    worker_name: row.worker_name,
    backend: row.backend,
    model,
    accuracy: row.accuracy,
    status: row.turn_status ?? null,
    trigger_seq: row.trigger_seq ?? null,
    prompt_preview: promptPreview,
    uncached_input_tokens: norm.uncached_input_tokens,
    cache_read_tokens: norm.cache_read_tokens,
    cache_write_tokens: norm.cache_write_tokens,
    total_input_tokens: norm.total_input_tokens,
    output_tokens: norm.output_tokens,
    reasoning_tokens: norm.reasoning_tokens,
    total_tokens: norm.effective_total_tokens,
    cache_hit_rate:
      norm.cache_read_tokens > 0 && norm.total_input_tokens > 0
        ? norm.cache_read_tokens / norm.total_input_tokens
        : null,
    cost_usd: row.cost_usd ?? null,
    estimated_cost_usd: estCost,
    duration_ms: Math.max(0, Number(row.duration_ms) || 0),
    tool_calls_count: Math.max(0, Number(row.tool_calls_count) || 0),
    created_at: row.created_at,
  };
}

export function aggregateUsageByVendor(
  rows: readonly UsageRecord[],
): Partial<Record<BackendId, VendorUsageSummary>> {
  const grouped = new Map<BackendId, UsageRecord[]>();
  for (const row of rows) {
    let bucket = grouped.get(row.backend);
    if (!bucket) {
      bucket = [];
      grouped.set(row.backend, bucket);
    }
    bucket.push(row);
  }
  const result: Partial<Record<BackendId, VendorUsageSummary>> = {};
  for (const [backend, groupRows] of grouped.entries()) {
    const totals = aggregateNormalizedUsage(groupRows);
    result[backend] = {
      backend,
      totals,
      models: totals.by_backend,
    };
  }
  return result;
}
