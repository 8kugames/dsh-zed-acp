/**
 * Turn-scoped token and timing statistics derived from committed DSH events,
 * plus DeepSeek list pricing for cumulative session cost reporting.
 *
 * Buckets and timings follow the upstream dsh definitions: `dsh-token-meter`
 * maps `TokenUsage.inputTokens` onto its own `uncachedInputTokens`, so prompt
 * input is three disjoint buckets (`uncachedInputTokens` / `cacheReadTokens` /
 * `cacheWriteTokens`); wall time is `step/start → assistant/message` per model
 * call (`llmMs`) plus `tool/call → tool/result` (`toolMs`); first-token latency
 * is `step/start → first token delta`; and decode time is `first token delta →
 * assistant/message`, counted — together with that step's output tokens — only
 * for steps that recorded both. Nothing here watches the clock at projection
 * time, so replayed facts reproduce identical numbers.
 * @module @8kugames/dsh-zed-acp/stats
 */

import { assistantStreamFirstTokenTime, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Per-1M-token prices for one pricing tier. */
export interface UsagePrice {
  /** 1M input tokens served from cache. */
  hit: number
  /** 1M input tokens not served from cache (cache writes bill here). */
  miss: number
  /** 1M output tokens. */
  out: number
}

/** Env-override entry: flat rates applied at every hour. */
export interface FlatPriceEntry extends UsagePrice {
  /** ISO 4217 code; defaults to USD. */
  currency: string
}

/** Built-in entry: peak rates; off-peak hours bill at exactly half. */
export interface TieredPriceEntry {
  peak: UsagePrice
  currency: string
}

/** Resolved model prices: rate triple plus billing currency. */
export interface ResolvedPrice {
  rates: UsagePrice
  currency: string
}

/** Model → price resolution state, built once per bridge process. */
export interface PriceTable {
  /** Exact-id flat entries (DSH_ACP_PRICES overrides) checked first. */
  flat: ReadonlyMap<string, FlatPriceEntry>
  /** Canonical-id tiered entries for DeepSeek's published list prices. */
  tiered: ReadonlyMap<string, TieredPriceEntry>
  /** Retired model ids redirected to their serving successor. */
  aliases: ReadonlyMap<string, string>
}

/**
 * DeepSeek list prices (USD per 1M tokens), published 2026-09 on
 * api-docs.deepseek.com: peak hours 01:00–04:00 and 06:00–10:00 UTC on
 * weekdays, off-peak exactly half. Chinese-public-holiday exclusion is not
 * modeled; override with DSH_ACP_PRICES when that precision matters.
 */
export const DEEPSEEK_PRICE_TABLE: PriceTable = {
  flat: new Map(),
  tiered: new Map([
    ['deepseek-flash', { peak: { hit: 0.006, miss: 0.3, out: 1.2 }, currency: 'USD' }],
    ['deepseek-v4-pro', { peak: { hit: 0.044, miss: 1.32, out: 3.96 }, currency: 'USD' }],
  ]),
  aliases: new Map([
    ['deepseek-v4-flash', 'deepseek-flash'],
    ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
  ]),
}

/**
 * Whether a UTC instant falls in DeepSeek's published peak window:
 * 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday.
 * @param ms - Unix epoch milliseconds.
 * @returns true inside a weekday peak window.
 */
export function isPeakUtcTime(ms: number): boolean {
  const date = new Date(ms)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** Validate one parsed DSH_ACP_PRICES entry and normalize its currency. */
function normalizeEntry(model: string, value: unknown): FlatPriceEntry {
  if (typeof value !== 'object' || value === null) throw new Error(`entry "${model}" must be an object`)
  const { hit, miss, out, currency } = value as Record<string, unknown>
  const rates = { hit, miss, out } as Record<string, unknown>
  for (const [name, rate] of Object.entries(rates)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`entry "${model}" field "${name}" must be a finite non-negative number`)
    }
  }
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    throw new Error(`entry "${model}" currency must be an ISO 4217 code such as "USD"`)
  }
  return { hit: hit as number, miss: miss as number, out: out as number, currency: currency === undefined ? 'USD' : currency as string }
}

/**
 * Parse the DSH_ACP_PRICES override document: an object mapping model ids to
 * `{ hit, miss, out, currency? }` per-1M flat rates.
 * @param json - raw environment value.
 * @returns validated flat entries by exact model id.
 * @throws Error describing the first malformed aspect.
 */
export function parsePriceOverrides(json: string): Map<string, FlatPriceEntry> {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('value must be a JSON object of model entries')
  }
  const entries = new Map<string, FlatPriceEntry>()
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    entries.set(model, normalizeEntry(model, value))
  }
  return entries
}

/**
 * Overlay flat env entries on a base table; flat entries win over tiered ones
 * for the same resolved id, and extra ids add new coverage.
 */
export function mergePriceOverrides(base: PriceTable, overrides: ReadonlyMap<string, FlatPriceEntry>): PriceTable {
  return { ...base, flat: new Map([...base.flat, ...overrides]) }
}

/**
 * Resolve one model's price at one instant.
 * @param table - merged price table.
 * @param model - model id exactly as selected (aliases resolve first).
 * @param atMs - Unix epoch milliseconds deciding the tier.
 * @returns rates plus currency, or undefined when the model is unlisted.
 */
export function resolvePrice(table: PriceTable, model: string, atMs: number): ResolvedPrice | undefined {
  const canonical = table.aliases.get(model) ?? model
  const flat = table.flat.get(canonical) ?? table.flat.get(model)
  if (flat !== undefined) return { rates: { hit: flat.hit, miss: flat.miss, out: flat.out }, currency: flat.currency }
  const tiered = table.tiered.get(canonical)
  if (tiered === undefined) return undefined
  if (isPeakUtcTime(atMs)) return { rates: tiered.peak, currency: tiered.currency }
  const { hit, miss, out } = tiered.peak
  return { rates: { hit: hit / 2, miss: miss / 2, out: out / 2 }, currency: tiered.currency }
}

/**
 * Price one usage record with dsh's disjoint prompt buckets: cache-read tokens
 * at the hit rate, uncached input plus cache writes at the miss rate (DeepSeek
 * bills writes as misses), output at the out rate.
 * @param rates - per-1M prices.
 * @param usage - one model call's accounting; `inputTokens` is uncached input.
 * @returns cost in the entry's currency unit.
 */
export function priceUsage(rates: UsagePrice, usage: TokenUsage): number {
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  return (read * rates.hit + (usage.inputTokens + write) * rates.miss + usage.outputTokens * rates.out) / 1_000_000
}

/**
 * Compose the process-wide table from the environment, containing malformed
 * overrides with a warning instead of failing the bridge.
 * @param env - raw DSH_ACP_PRICES value, if set.
 * @param warn - warning sink for a rejected document.
 * @returns the effective price table.
 */
export function buildPriceTable(env: string | undefined, warn: (message: string) => void): PriceTable {
  if (env === undefined || env.trim() === '') return DEEPSEEK_PRICE_TABLE
  try {
    return mergePriceOverrides(DEEPSEEK_PRICE_TABLE, parsePriceOverrides(env))
  } catch (error: unknown) {
    warn(`DSH_ACP_PRICES ignored: ${(error as Error).message}`)
    return DEEPSEEK_PRICE_TABLE
  }
}

/** Cumulative token accounting across the model calls of one scope, in dsh buckets. */
export interface UsageTotals {
  /** Prompt input billed at the miss rate — dsh's own `uncachedInputTokens`. */
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Model calls that reported usage. */
  modelCalls: number
}

/** Wall-time aggregates shared by one turn and by the whole session, in dsh's terms. */
export interface TimingTotals {
  /** Σ per model call of (assistant/message − step/start): request to settlement. */
  llmMs: number
  /** Σ over tool calls of (tool/result − tool/call). */
  toolMs: number
  /** Σ per model call of (assistant/message − first token): decode wall time. */
  decodeMs: number
  /** Σ output tokens over the same decode-timed steps as {@link decodeMs}. */
  decodeTokens: number
  /** Σ per model call of (first token − step start). */
  ttftSumMs: number
  /** Model calls that recorded a first token. */
  ttftCalls: number
}

/** Final statistics for one Agent turn, priced where the model is listed. */
export interface TurnStats {
  turn: number
  usage: UsageTotals
  timing: TimingTotals
  /** Priced cost of this turn's usage, when every listing resolved. */
  cost: { amount: number; currency: string } | undefined
}

/** Session-lifetime totals kept by the ACP session for final updates. */
export interface SessionStats {
  usage: UsageTotals
  timing: TimingTotals
  /** Cumulative cost across live turns since this ACP session opened. */
  cost: { amount: number; currency: string } | undefined
  /**
   * Sticky mixed-currency marker: once turns priced in different currencies
   * fold into one session, a single amount+currency figure would lie, so the
   * cost stays `undefined` (reported as unpriced) for the session's life.
   */
  currencyMixed?: boolean
}

/** A fresh, all-zero timing aggregate. */
function zeroTiming(): TimingTotals {
  return { llmMs: 0, toolMs: 0, decodeMs: 0, decodeTokens: 0, ttftSumMs: 0, ttftCalls: 0 }
}

/** Add one scope's timings into another; the speed pairing stays step-level. */
function mergeTiming(totals: TimingTotals, timing: TimingTotals): TimingTotals {
  return {
    llmMs: totals.llmMs + timing.llmMs,
    toolMs: totals.toolMs + timing.toolMs,
    decodeMs: totals.decodeMs + timing.decodeMs,
    decodeTokens: totals.decodeTokens + timing.decodeTokens,
    ttftSumMs: totals.ttftSumMs + timing.ttftSumMs,
    ttftCalls: totals.ttftCalls + timing.ttftCalls,
  }
}

/** A fresh session aggregate: no usage, timing, or cost recorded yet. */
export function emptySessionStats(): SessionStats {
  return {
    usage: { uncachedInputTokens: 0, outputTokens: 0, modelCalls: 0 },
    timing: zeroTiming(),
    cost: undefined,
  }
}

/** One call's prompt/output accounting, as reported or as already folded. */
interface UsageSample {
  /** Prompt input outside cache; dsh's own `uncachedInputTokens`. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Merge one call's accounting into running totals, preserving reported cache
 * fields. `inputTokens` is uncached input in dsh's bucket vocabulary, so it
 * lands in `uncachedInputTokens` rather than being netted against cache.
 */
function mergeUsage(totals: UsageTotals, sample: UsageSample): UsageTotals {
  const read = (totals.cacheReadTokens ?? 0) + (sample.cacheReadTokens ?? 0)
  const write = (totals.cacheWriteTokens ?? 0) + (sample.cacheWriteTokens ?? 0)
  return {
    uncachedInputTokens: totals.uncachedInputTokens + sample.inputTokens,
    outputTokens: totals.outputTokens + sample.outputTokens,
    cacheReadTokens: read === 0 ? undefined : read,
    cacheWriteTokens: write === 0 ? undefined : write,
    modelCalls: totals.modelCalls + 1,
  }
}

/** Round a currency amount away from floating-point noise. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * Accumulate one Agent turn's statistics from its committed events. The
 * collector is created at `turn/start`, fed every event of that turn, and
 * finalized at `turn/end`; events of other turns are ignored.
 */
export class TurnStatsCollector {
  private readonly stepStarts = new Map<number, number>()
  private readonly toolStarts = new Map<string, number>()
  private usage: UsageTotals = { uncachedInputTokens: 0, outputTokens: 0, modelCalls: 0 }
  private timing: TimingTotals = zeroTiming()
  private costAmount = 0
  private costCurrency: string | undefined
  private costCurrencyMixed = false

  /**
   * @param turn - the turn number this collector follows.
   * @param modelId - live model selection at each usage-bearing event.
   * @param prices - effective price table.
   */
  constructor(
    readonly turn: number,
    private readonly modelId: () => string | undefined,
    private readonly prices: PriceTable,
  ) {}

  /**
   * Fold one committed session event into the running statistics when it
   * belongs to this collector's turn.
   * @param event - committed durable event with its authoritative time.
   */
  record(event: SessionEvent): void {
    if (event.type === 'step/start') {
      if (event.data.turn === this.turn) this.stepStarts.set(event.data.step, event.time)
      return
    }
    if (event.type === 'tool/call') {
      if (event.data.turn === this.turn) this.toolStarts.set(event.data.callId, event.time)
      return
    }
    if (event.type === 'tool/result') {
      if (event.data.turn !== this.turn) return
      const start = this.toolStarts.get(event.data.message.toolCallId)
      if (start === undefined) return
      this.toolStarts.delete(event.data.message.toolCallId)
      this.timing.toolMs += Math.max(0, event.time - start)
      return
    }
    if (event.type === 'assistant/message') {
      if (event.data.turn !== this.turn) return
      const { stream, usage } = event.data
      const start = this.stepStarts.get(event.data.step)
      const first = assistantStreamFirstTokenTime(stream)
      if (start !== undefined) this.timing.llmMs += Math.max(0, event.time - start)
      if (first !== undefined) {
        if (start !== undefined) {
          this.timing.ttftSumMs += Math.max(0, first - start)
          this.timing.ttftCalls += 1
        }
        // Upstream pairs decode wall time with that step's output tokens and
        // counts both only together, so a step without recorded stream timing
        // contributes no speed reading instead of inflating one.
        this.timing.decodeMs += Math.max(0, event.time - first)
        if (usage !== undefined) this.timing.decodeTokens += usage.outputTokens
      }
      if (usage === undefined) return
      this.usage = mergeUsage(this.usage, usage)
      const priced = resolvePrice(this.prices, this.modelId() ?? '', event.time)
      if (priced !== undefined) {
        // Currencies are not convertible here; a turn that priced model calls
        // in two currencies reports no cost rather than summing apples and
        // oranges into whichever currency arrived last.
        if (this.costCurrency === undefined) this.costCurrency = priced.currency
        else if (this.costCurrency !== priced.currency) this.costCurrencyMixed = true
        this.costAmount += priceUsage(priced.rates, usage)
      }
    }
  }

  /**
   * Finalize the turn.
   * @returns its statistics, or undefined when no model call reported usage.
   */
  result(): TurnStats | undefined {
    if (this.usage.modelCalls === 0) return undefined
    return {
      turn: this.turn,
      usage: this.usage,
      timing: this.timing,
      cost: this.costCurrencyMixed || this.costCurrency === undefined
        ? undefined
        : { amount: round6(this.costAmount), currency: this.costCurrency },
    }
  }
}

/**
 * Fold one finalized turn into session-lifetime totals.
 * @param session - running session totals.
 * @param turn - the finalized turn's statistics.
 * @returns the next session totals snapshot.
 */
export function foldTurnStats(session: SessionStats, turn: TurnStats): SessionStats {
  const read = (session.usage.cacheReadTokens ?? 0) + (turn.usage.cacheReadTokens ?? 0)
  const write = (session.usage.cacheWriteTokens ?? 0) + (turn.usage.cacheWriteTokens ?? 0)
  const usage: UsageTotals = {
    uncachedInputTokens: session.usage.uncachedInputTokens + turn.usage.uncachedInputTokens,
    outputTokens: session.usage.outputTokens + turn.usage.outputTokens,
    cacheReadTokens: read === 0 ? undefined : read,
    cacheWriteTokens: write === 0 ? undefined : write,
    modelCalls: session.usage.modelCalls + turn.usage.modelCalls,
  }
  // A session that already folded a mixed-currency turn stays unpriced even
  // when later turns agree on one currency again: the session did spend in
  // both, and any single cumulative figure would misreport one of them.
  const mixed = session.currencyMixed === true
    || (session.cost !== undefined && turn.cost !== undefined && session.cost.currency !== turn.cost.currency)
  const cost = mixed
    ? undefined
    : turn.cost === undefined
      ? session.cost
      : {
          amount: round6((session.cost?.amount ?? 0) + turn.cost.amount),
          currency: turn.cost.currency,
        }
  return { usage, timing: mergeTiming(session.timing, turn.timing), cost, ...(mixed ? { currencyMixed: true } : {}) }
}

/** Average first-token latency of a scope, or undefined when no call recorded one. */
function ttftAvgMs(timing: TimingTotals): number | undefined {
  return timing.ttftCalls === 0 ? undefined : Math.round(timing.ttftSumMs / timing.ttftCalls)
}

/** Decode speed of a scope over the steps that recorded both parts, or undefined. */
function outputTps(timing: TimingTotals): number | undefined {
  return timing.decodeMs > 0 ? timing.decodeTokens / (timing.decodeMs / 1000) : undefined
}

/**
 * Share of a scope's prompt tokens served from the prefix cache — DeepSeek's
 * hit bucket over the three disjoint input buckets — or undefined when the
 * adapter reported no cache reads for it.
 * @param usage - one scope's accounting; `uncachedInputTokens` is uncached input.
 * @returns the hit rate as a fraction in (0, 1], or undefined without a read bucket.
 */
function cacheHitRate(usage: UsageTotals): number | undefined {
  const read = usage.cacheReadTokens
  if (read === undefined || read === 0) return undefined
  return read / (read + (usage.cacheWriteTokens ?? 0) + usage.uncachedInputTokens)
}

/** Format a millisecond duration compactly for the stats card. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Compact token-count rendering for always-visible title strips: `980`, `45.2k`, `1.2M`. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) {
    const k = tokens / 1_000
    // The 999.95 guard keeps a near-ceiling count from rounding to "1000k".
    if (k < 999.95) return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`
  }
  const m = tokens / 1_000_000
  if (m >= 999.95) return `${Number((m / 1_000).toFixed(1))}B`
  return `${m >= 100 ? Math.round(m) : Number(m.toFixed(1))}M`
}

/** All prompt tokens across dsh's three disjoint input buckets. Accepts both
 * bucket vocabularies: a call's `TokenUsage.inputTokens` is uncached input,
 * exactly like a scope's `uncachedInputTokens`. */
export function sumPromptTokens(
  usage: { inputTokens?: number; uncachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const uncached = usage.uncachedInputTokens ?? usage.inputTokens ?? 0
  return uncached + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Token and cost facts a collapsed title strip can carry without expansion. */
export interface StatsTitleFacts {
  /** All prompt buckets summed (uncached + cache read + cache write). */
  inputTokens: number
  outputTokens: number
  /** Priced turn cost, when the model's listing resolved. */
  cost: { amount: number; currency: string } | undefined
}

/**
 * The card row title shown while collapsed, naming the serving model when known.
 * With `facts` it also carries the one-line usage summary, because expansion is
 * a client-side decision the protocol cannot force: an unpriced model is named
 * `unpriced` instead of silently dropping the cost segment.
 */
export function statsCardTitle(modelId: string | undefined, facts?: StatsTitleFacts): string {
  const base = modelId === undefined ? 'Turn stats' : `Turn stats · ${modelId}`
  if (facts === undefined) return base
  const usage = `in ${formatTokenCount(facts.inputTokens)} / out ${formatTokenCount(facts.outputTokens)}`
  const cost = facts.cost === undefined ? 'unpriced' : formatMoney(facts.cost.amount, facts.cost.currency)
  return `${base} · ${usage} · ${cost}`
}

/** Format a currency amount with stable precision. */
function formatMoney(amount: number, currency: string): string {
  return currency === 'USD' ? `$${amount.toFixed(4)}` : `${amount.toFixed(4)} ${currency}`
}

/**
 * Render the end-of-turn statistics as the markdown text of the turn-stats
 * card. Cache rows appear only when the adapter reported them; timing and
 * cost segments appear only when their facts exist.
 * @param turn - finalized turn statistics.
 * @param session - session-lifetime totals for the cumulative line.
 * @param modelId - model selection that served the turn, if known.
 * @returns the card's markdown text.
 */
export function formatStatsCard(turn: TurnStats, session: SessionStats, modelId: string | undefined): string {
  const lines: string[] = []
  lines.push(`**${statsCardTitle(modelId)}** — llm ${formatMs(turn.timing.llmMs)} · tools ${formatMs(turn.timing.toolMs)}`, '')
  lines.push('| | tokens |', '|---|---:|')
  if (turn.usage.cacheReadTokens !== undefined) {
    lines.push(`| Input · cache read | ${turn.usage.cacheReadTokens.toLocaleString('en-US')} |`)
  }
  if (turn.usage.cacheWriteTokens !== undefined) {
    lines.push(`| Input · cache write | ${turn.usage.cacheWriteTokens.toLocaleString('en-US')} |`)
  }
  lines.push(`| Input · uncached | ${turn.usage.uncachedInputTokens.toLocaleString('en-US')} |`)
  lines.push(`| Output | ${turn.usage.outputTokens.toLocaleString('en-US')} |`)
  lines.push('')
  const cache: string[] = []
  const turnHit = cacheHitRate(turn.usage)
  if (turnHit !== undefined) cache.push(`cache hit ${(turnHit * 100).toFixed(1)}%`)
  const sessionHit = cacheHitRate(session.usage)
  if (sessionHit !== undefined) cache.push(`session cache hit ${(sessionHit * 100).toFixed(1)}%`)
  if (cache.length > 0) lines.push(cache.join(' · '))
  const tail: string[] = []
  const ttft = ttftAvgMs(turn.timing)
  if (ttft !== undefined) tail.push(`avg first token ${formatMs(ttft)}`)
  const tps = outputTps(turn.timing)
  if (tps !== undefined) tail.push(`decode ${tps.toFixed(1)} tok/s`)
  if (turn.cost !== undefined) tail.push(`turn ${formatMoney(turn.cost.amount, turn.cost.currency)}`)
  if (session.cost !== undefined) tail.push(`session ${formatMoney(session.cost.amount, session.cost.currency)}`)
  if (tail.length > 0) lines.push(tail.join(' · '))
  return lines.join('\n')
}

/**
 * Build the forward-compatibility `_meta` payload for the final usage update:
 * the turn's and session's accounting facts in machine-readable form under a
 * `dsh` namespace ACP clients may ignore.
 * @param turn - finalized turn statistics.
 * @param session - session-lifetime totals.
 * @returns the `_meta` object for `usage_update`.
 */
export function statsMeta(turn: TurnStats, session: SessionStats): { dsh: Record<string, unknown> } {
  const scope = (usage: UsageTotals, timing: TimingTotals, cost: { amount: number; currency: string } | undefined) => {
    const tps = outputTps(timing)
    const hit = cacheHitRate(usage)
    return {
      ...usage,
      cacheHitPercent: hit === undefined ? undefined : Number((hit * 100).toFixed(2)),
      llmMs: timing.llmMs,
      toolMs: timing.toolMs,
      decodeMs: timing.decodeMs,
      decodeTokens: timing.decodeTokens,
      ttftAvgMs: ttftAvgMs(timing),
      outputTps: tps === undefined ? undefined : Number(tps.toFixed(2)),
      cost,
    }
  }
  return {
    dsh: {
      turn: { turn: turn.turn, ...scope(turn.usage, turn.timing, turn.cost) },
      session: scope(session.usage, session.timing, session.cost),
    },
  }
}
