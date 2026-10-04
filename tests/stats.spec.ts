/** Unit and bridge coverage for turn statistics, pricing, and cost reporting. */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AssistantStreamRecord, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'
import {
  DEEPSEEK_PRICE_TABLE,
  TurnStatsCollector,
  buildPriceTable,
  emptySessionStats,
  foldTurnStats,
  formatStatsCard,
  formatTokenCount,
  isPeakUtcTime,
  mergePriceOverrides,
  parsePriceOverrides,
  priceUsage,
  resolvePrice,
  statsCardTitle,
  statsMeta,
  type SessionStats,
  type TurnStats,
} from '../src/stats.ts'

/** 2026-09-28 is a Monday: 07:00 UTC is inside the 06:00–10:00 peak window. */
const PEAK_MS = Date.UTC(2026, 8, 28, 7, 0, 0)
/** The same Monday at 12:00 UTC is off-peak. */
const OFF_PEAK_MS = Date.UTC(2026, 8, 28, 12, 0, 0)
/** The following Sunday is off-peak all day. */
const SUNDAY_MS = Date.UTC(2026, 9, 4, 7, 0, 0)

function textRun(time0: number, dt: readonly number[], texts: readonly string[]): AssistantStreamRecord {
  return { type: 'text-chunks', time0, index: 0, dt, texts }
}

function event(type: 'turn/start' | 'turn/end', turn: number, time: number): SessionEvent {
  return type === 'turn/start'
    ? { type, seq: 1 as never, time, data: { turn } }
    : { type, seq: 2 as never, time, data: { turn, reason: { kind: 'completed' } } }
}

function stepStart(turn: number, step: number, time: number): SessionEvent {
  return { type: 'step/start', seq: 3 as never, time, data: { turn, step } }
}

function assistantMessage(
  turn: number,
  step: number,
  time: number,
  stream: readonly AssistantStreamRecord[],
  usage: TokenUsage | undefined,
): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 4 as never,
    time,
    data: {
      turn,
      step,
      message: { id: 'm1', role: 'assistant', content: [] } as never,
      stream: [...stream],
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SessionEvent
}

function toolCall(turn: number, callId: string, time: number): SessionEvent {
  return { type: 'tool/call', seq: 5 as never, time, data: { turn, step: 0, callId: callId as never, name: 'echo', arguments: '{}' } }
}

function toolResult(turn: number, callId: string, time: number): SessionEvent {
  return {
    type: 'tool/result',
    seq: 6 as never,
    time,
    data: { turn, step: 0, message: { toolCallId: callId as never, role: 'tool', content: [] } as never },
  } as unknown as SessionEvent
}

/** One turn: a model step with a stream, one tool round, then a second model step. */
function collectTwoStepTurn(prices = DEEPSEEK_PRICE_TABLE, model = 'deepseek-flash', atMs = PEAK_MS): TurnStats | undefined {
  const collector = new TurnStatsCollector(7, () => model, prices)
  collector.record(event('turn/start', 7, atMs))
  collector.record(stepStart(7, 0, atMs + 100))
  collector.record(assistantMessage(7, 0, atMs + 2_000, [textRun(atMs + 900, [100], ['a', 'b'])], {
    inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, reasoningTokens: 20,
  }))
  collector.record(toolCall(7, 'c1', atMs + 2_100))
  collector.record(toolResult(7, 'c1', atMs + 2_600))
  collector.record(stepStart(7, 1, atMs + 2_700))
  collector.record(assistantMessage(7, 1, atMs + 4_000, [textRun(atMs + 3_400, [], ['done'])], {
    inputTokens: 1_200, outputTokens: 30,
  }))
  collector.record(event('turn/end', 7, atMs + 4_100))
  return collector.result()
}

describe('turn statistics collection', () => {
  it('derives timing and token totals from durable event times', () => {
    const stats = collectTwoStepTurn()
    expect(stats).toBeDefined()
    if (stats === undefined) return
    expect(stats.turn).toBe(7)
    // Upstream wall time: step/start -> assistant/message per model call,
    // 1900ms and 1300ms; tool time is the call/result gap.
    expect(stats.timing).toEqual({
      llmMs: 3_200,
      toolMs: 500,
      decodeMs: 1_700,
      decodeTokens: 80,
      ttftSumMs: 1_500,
      ttftCalls: 2,
    })
    expect(stats.usage).toEqual({
      uncachedInputTokens: 2_200,
      outputTokens: 80,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      modelCalls: 2,
    })
  })

  it('prices listed models per model call and reports no cost for unlisted ones', () => {
    const priced = collectTwoStepTurn()
    // flash peak: call 1 = 800·0.006 hit + (1000+100)·0.3 miss + 50·1.2 out;
    // call 2 = 1200·0.3 + 30·1.2.
    expect(priced?.cost).toEqual({ amount: 0.000791, currency: 'USD' })

    const unpriced = collectTwoStepTurn(DEEPSEEK_PRICE_TABLE, 'mock')
    expect(unpriced?.cost).toBeUndefined()
  })

  it('keeps a step without stream timing out of the speed reading', () => {
    const collector = new TurnStatsCollector(9, () => 'mock', DEEPSEEK_PRICE_TABLE)
    collector.record(stepStart(9, 0, 1_000))
    collector.record(assistantMessage(9, 0, 6_000, [], { inputTokens: 100, outputTokens: 400 }))
    collector.record(event('turn/end', 9, 6_100))
    const stats = collector.result()
    expect(stats?.timing.llmMs).toBe(5_000)
    expect(stats?.timing.decodeMs).toBe(0)
    expect(stats?.timing.decodeTokens).toBe(0)
    expect(stats?.timing.ttftCalls).toBe(0)
    // The output row still bills every call; only the rate excludes unpaired ones.
    expect(stats?.usage.outputTokens).toBe(400)
  })

  it('ignores events from other turns', () => {
    const collector = new TurnStatsCollector(1, () => 'mock', DEEPSEEK_PRICE_TABLE)
    collector.record(event('turn/start', 2, 0))
    collector.record(stepStart(2, 0, 0))
    collector.record(assistantMessage(2, 0, 10, [textRun(5, [], ['x'])], { inputTokens: 1, outputTokens: 1 }))
    expect(collector.result()).toBeUndefined()
  })

  it('returns undefined when no model call reported usage', () => {
    const collector = new TurnStatsCollector(3, () => 'mock', DEEPSEEK_PRICE_TABLE)
    collector.record(event('turn/start', 3, 0))
    collector.record(stepStart(3, 0, 10))
    collector.record(assistantMessage(3, 0, 20, [textRun(15, [], ['x'])], undefined))
    collector.record(event('turn/end', 3, 30))
    expect(collector.result()).toBeUndefined()
  })
})

describe('DeepSeek list pricing', () => {
  it('classifies weekday peak windows', () => {
    expect(isPeakUtcTime(PEAK_MS)).toBe(true)
    expect(isPeakUtcTime(Date.UTC(2026, 8, 28, 1, 30))).toBe(true)
    expect(isPeakUtcTime(OFF_PEAK_MS)).toBe(false)
    expect(isPeakUtcTime(SUNDAY_MS)).toBe(false)
    expect(isPeakUtcTime(Date.UTC(2026, 8, 28, 4, 0))).toBe(false)
  })

  it('bills tiered models at peak rates and exactly half off-peak', () => {
    const peak = resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-flash', PEAK_MS)
    expect(peak).toEqual({ rates: { hit: 0.006, miss: 0.3, out: 1.2 }, currency: 'USD' })
    const offPeak = resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-flash', OFF_PEAK_MS)
    expect(offPeak).toEqual({ rates: { hit: 0.003, miss: 0.15, out: 0.6 }, currency: 'USD' })
  })

  it('resolves retired aliases and leaves unknown models unpriced', () => {
    expect(resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-v4-flash', PEAK_MS)).toEqual(
      resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-flash', PEAK_MS),
    )
    expect(resolvePrice(DEEPSEEK_PRICE_TABLE, 'some-gateway-model', PEAK_MS)).toBeUndefined()
  })

  it('prices cache reads at the hit rate and uncached plus writes at the miss rate', () => {
    const rates = { hit: 0.006, miss: 0.3, out: 1.2 }
    // `inputTokens` is already uncached input: it is never netted against cache.
    expect(priceUsage(rates, { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800 }))
      .toBeCloseTo(0.0003648, 10)
    expect(priceUsage(rates, { inputTokens: 300, outputTokens: 0, cacheWriteTokens: 200 }))
      .toBeCloseTo(0.00015, 10)
  })
})

describe('DSH_ACP_PRICES overrides', () => {
  it('parses flat entries and lets them shadow tiered and unknown models', () => {
    const overrides = parsePriceOverrides('{"my-model":{"hit":0.1,"miss":1,"out":2,"currency":"CNY"}}')
    const table = mergePriceOverrides(DEEPSEEK_PRICE_TABLE, overrides)
    expect(resolvePrice(table, 'my-model', PEAK_MS)).toEqual({ rates: { hit: 0.1, miss: 1, out: 2 }, currency: 'CNY' })
    const replaced = parsePriceOverrides('{"deepseek-flash":{"hit":0,"miss":0,"out":0}}')
    const zeroed = mergePriceOverrides(DEEPSEEK_PRICE_TABLE, replaced)
    expect(resolvePrice(zeroed, 'deepseek-flash', PEAK_MS)?.rates.miss).toBe(0)
  })

  it('rejects malformed documents with a descriptive error', () => {
    expect(() => parsePriceOverrides('[]')).toThrow(/object/)
    expect(() => parsePriceOverrides('{"m":{"hit":"x","miss":1,"out":1}}')).toThrow(/hit/)
    expect(() => parsePriceOverrides('{"m":{"hit":1,"miss":1,"out":1,"currency":"dollars"}}')).toThrow(/currency/)
    expect(() => parsePriceOverrides('not json')).toThrow()
  })

  it('builds the default table for absent values and warns for malformed ones', () => {
    expect(buildPriceTable(undefined, () => { throw new Error('unreachable') })).toBe(DEEPSEEK_PRICE_TABLE)
    expect(buildPriceTable('  ', () => { throw new Error('unreachable') })).toBe(DEEPSEEK_PRICE_TABLE)
    const warnings: string[] = []
    const table = buildPriceTable('nope', (message) => { warnings.push(message) })
    expect(table).toBe(DEEPSEEK_PRICE_TABLE)
    expect(warnings[0]).toMatch(/DSH_ACP_PRICES ignored/)
  })
})

describe('stats presentation', () => {
  /** A session carrying more turns than the fixture's single one. */
  const session: SessionStats = {
    usage: {
      uncachedInputTokens: 2_700,
      outputTokens: 260,
      cacheReadTokens: 1_500,
      cacheWriteTokens: 200,
      modelCalls: 5,
    },
    timing: { llmMs: 9_400, toolMs: 2_000, decodeMs: 4_400, decodeTokens: 260, ttftSumMs: 3_600, ttftCalls: 5 },
    cost: { amount: 0.001582, currency: 'USD' },
  }

  it('folds turns into session totals and emits machine-readable meta', () => {
    const stats = collectTwoStepTurn()
    if (stats === undefined) throw new Error('expected stats')
    const folded = foldTurnStats(emptySessionStats(), stats)
    expect(folded.usage).toEqual(stats.usage)
    expect(folded.timing).toEqual(stats.timing)
    expect(folded.cost).toEqual({ amount: 0.000791, currency: 'USD' })
    const twice = foldTurnStats(folded, stats)
    expect(twice.usage).toMatchObject({ uncachedInputTokens: 4_400, outputTokens: 160, modelCalls: 4 })
    expect(twice.timing).toMatchObject({ llmMs: 6_400, toolMs: 1_000, decodeTokens: 160, ttftCalls: 4 })

    const meta = statsMeta(stats, session)
    expect(meta.dsh.turn).toMatchObject({
      turn: 7,
      uncachedInputTokens: 2_200,
      cacheReadTokens: 800,
      cacheHitPercent: 25.81,
      llmMs: 3_200,
      toolMs: 500,
      decodeMs: 1_700,
      decodeTokens: 80,
      ttftAvgMs: 750,
      outputTps: 47.06,
    })
    expect(meta.dsh.session).toMatchObject({
      uncachedInputTokens: 2_700,
      cacheHitPercent: 34.09,
      llmMs: 9_400,
      toolMs: 2_000,
      ttftAvgMs: 720,
      outputTps: 59.09,
      cost: { amount: 0.001582, currency: 'USD' },
    })
  })
})

describe('bridge turn-stats delivery', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('emits a collapsed stats tool card and the final usage_update after a completed turn', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('hi')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })

    // The card rides the tool timeline as a collapsed read-kind tool card, so
    // the turn still settles without any synthetic agent message.
    const synthetic = harness.updates.filter(update =>
      update.sessionUpdate === 'agent_message_chunk' && 'messageId' in update && update.messageId?.startsWith('dsh-stats-'))
    expect(synthetic).toEqual([])

    const cardCall = harness.updates.find(update => update.sessionUpdate === 'tool_call'
      && 'toolCallId' in update && update.toolCallId.startsWith('dsh-stats-'))
    expect(cardCall).toMatchObject({
      toolCallId: 'dsh-stats-1',
      kind: 'read',
      status: 'in_progress',
    })
    if (cardCall === undefined || !('title' in cardCall)) throw new Error('expected card title')
    expect(cardCall.title).toMatch(/^Turn stats/)
    const cardDone = harness.updates.filter(update => update.sessionUpdate === 'tool_call_update'
      && 'toolCallId' in update && update.toolCallId === 'dsh-stats-1')
    expect(cardDone).toHaveLength(1)
    expect(cardDone[0]).toMatchObject({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: expect.stringContaining('Turn stats') } }],
    })

    const final = harness.updates.at(-1)
    if (final?.sessionUpdate !== 'usage_update') throw new Error('expected final usage update')
    expect(final._meta?.dsh).toMatchObject({
      turn: expect.objectContaining({ uncachedInputTokens: 5, modelCalls: 1 }),
      session: expect.objectContaining({ modelCalls: 1 }),
    })
    expect(final.cost).toBeUndefined()
  })
})

describe('formatStatsCard', () => {
  it('renders disjoint input buckets, timing, and both cost scopes', () => {
    const turn: TurnStats = {
      turn: 2,
      usage: { uncachedInputTokens: 1_000, outputTokens: 400, cacheReadTokens: 9_000, cacheWriteTokens: 500, modelCalls: 2 },
      timing: { llmMs: 3_200, toolMs: 1_400, decodeMs: 2_000, decodeTokens: 400, ttftSumMs: 640, ttftCalls: 2 },
      cost: { amount: 0.0123, currency: 'USD' },
    }
    const session: SessionStats = foldTurnStats(emptySessionStats(), turn)
    const card = formatStatsCard(turn, session, 'deepseek-chat')

    expect(card).toContain('**Turn stats · deepseek-chat** — llm 3.2s · tools 1.4s')
    expect(card).toContain('| Input · cache read | 9,000 |')
    expect(card).toContain('| Input · cache write | 500 |')
    expect(card).toContain('| Input · uncached | 1,000 |')
    expect(card).toContain('| Output | 400 |')
    expect(card).toContain('cache hit 85.7% · session cache hit 85.7%')
    expect(card).toContain('avg first token 320ms')
    expect(card).toContain('decode 200.0 tok/s')
    expect(card).toContain('turn $0.0123')
    expect(card).toContain('session $0.0123')
  })

  it('omits absent cache rows and ungated timing or cost segments', () => {
    const turn: TurnStats = {
      turn: 1,
      usage: { uncachedInputTokens: 40, outputTokens: 8, modelCalls: 1 },
      timing: { llmMs: 900, toolMs: 0, decodeMs: 0, decodeTokens: 0, ttftSumMs: 0, ttftCalls: 0 },
      cost: undefined,
    }
    const card = formatStatsCard(turn, emptySessionStats(), undefined)

    expect(card).toContain('**Turn stats** — llm 900ms · tools 0ms')
    expect(card).not.toContain('cache read')
    expect(card).not.toContain('cache write')
    expect(card).not.toContain('cache hit')
    expect(card).not.toContain('first token')
    expect(card).not.toContain('tok/s')
    expect(card).not.toContain('$')
  })

  it('suffices non-USD cost currencies with their code', () => {
    const turn: TurnStats = {
      turn: 3,
      usage: { uncachedInputTokens: 10, outputTokens: 2, modelCalls: 1 },
      timing: { llmMs: 100, toolMs: 0, decodeMs: 0, decodeTokens: 0, ttftSumMs: 0, ttftCalls: 0 },
      cost: { amount: 1.5, currency: 'EUR' },
    }
    const session: SessionStats = foldTurnStats(emptySessionStats(), turn)

    expect(formatStatsCard(turn, session, undefined)).toContain('turn 1.5000 EUR · session 1.5000 EUR')
  })
})

describe('collapsed title strip summary', () => {
  it('carries compact usage and priced cost without expansion', () => {
    expect(statsCardTitle('deepseek-flash', {
      inputTokens: 45_200,
      outputTokens: 1_234,
      cost: { amount: 0.0123, currency: 'USD' },
    })).toBe('Turn stats · deepseek-flash · in 45.2k / out 1.2k · $0.0123')
  })

  it('names unpriced models instead of silently dropping the cost segment', () => {
    expect(statsCardTitle('glm-5.3-flash', { inputTokens: 980, outputTokens: 42, cost: undefined }))
      .toBe('Turn stats · glm-5.3-flash · in 980 / out 42 · unpriced')
    expect(statsCardTitle(undefined)).toBe('Turn stats')
    expect(statsCardTitle('deepseek-flash')).toBe('Turn stats · deepseek-flash')
  })

  it('formats token counts compactly across scales', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(980)).toBe('980')
    expect(formatTokenCount(45_200)).toBe('45.2k')
    expect(formatTokenCount(150_000)).toBe('150k')
    expect(formatTokenCount(1_234_567)).toBe('1.2M')
    expect(formatTokenCount(999_950)).toBe('1M')
    expect(formatTokenCount(999_950_000)).toBe('1B')
    expect(formatTokenCount(250_000_000)).toBe('250M')
  })
})
