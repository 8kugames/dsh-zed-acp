/** The `_session/steering` extension: injecting a follow-up into a running turn. */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, readSessionLog, textResponse } from './harness.ts'
import type { BridgeHarness } from './harness.ts'

/** Text carried by one model request's message list. */
function requestTexts(messages: readonly { content: unknown }[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') texts.push(text)
      }
    }
  }
  return texts
}

/** Direct human prompt texts committed in one stored log, in order. */
function userPromptTexts(events: readonly SessionEvent[]): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    for (const block of event.data.content) {
      if (block.type === 'text') texts.push(block.text)
    }
  }
  return texts
}

/** A canonical-base64 1x1 PNG, small enough for the harness image limits. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

describe('_session/steering', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Assistant text committed so far in one session. */
  async function assistantText(sessionId: string): Promise<string[]> {
    const events = await readSessionLog(harness!.ctx, sessionId)
    const texts: string[] = []
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'text') texts.push(block.text)
      }
    }
    return texts
  }

  /**
   * Resolve once the session has a claimed turn, so a steered message has a
   * target. The model call is the signal: the agent loop claims the prompt and
   * allocates its turn before it reaches the adapter, and a hanging response
   * keeps that turn open. (A partial assistant message is not one — the bridge
   * projects committed events only, so nothing streams out mid-message.)
   */
  async function waitForRunningTurn(): Promise<void> {
    await vi.waitFor(() => { expect(harness!.adapter.requests.length).toBeGreaterThan(0) })
  }

  it('advertises steering support at initialize', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(response.agentCapabilities?._meta).toMatchObject({ steering: { supported: true } })
  })

  it('injects into the running turn and leaves the open prompt in charge', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('after steering')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    // The first response hangs, so the turn stays open across the steering call.
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()

    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'also check the logs' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    } as never)).resolves.toEqual({ outcome: 'injected' })

    // The client still owns the turn: the very same prompt request answers it.
    await harness.client.cancel({ sessionId: session.sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('delivers the steered message to the model, and the turn continues for it', async () => {
    // The first step must *return* for the driver to reach the next step
    // boundary where a steered message is consumed — a model call still in
    // flight has no boundary yet.
    harness = await makeBridgeHarness({
      script: [{ chunks: textResponse('first'), holdMs: 250 }, textResponse('after steering')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()
    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'also check the logs' }],
    } as never)).resolves.toEqual({ outcome: 'injected' })
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })

    // The second model call carries the steered text, and its answer is
    // committed into the same turn.
    expect(harness.adapter.requests).toHaveLength(2)
    expect(requestTexts(harness.adapter.requests[1].messages)).toContain('also check the logs')
    expect(await assistantText(session.sessionId)).toEqual(['first', 'after steering'])
    expect(userPromptTexts(await readSessionLog(harness.ctx, session.sessionId)))
      .toEqual(['original', 'also check the logs'])
  })

  it('drops a steered message that never reached a step boundary when the turn is cancelled', async () => {
    // A model call in flight has no step boundary, so the message stays parked
    // in the inbox; cancellation discards it. The outcome was still `injected`
    // at accept time, and the transcript records only the original prompt.
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()
    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'never lands' }],
    } as never)).resolves.toEqual({ outcome: 'injected' })
    await harness.client.cancel({ sessionId: session.sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(userPromptTexts(await readSessionLog(harness.ctx, session.sessionId))).toEqual(['original'])
  })

  it('reports promptRequired when no turn is running', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    // Idle: no prompt has been sent, so there is nothing to join.
    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'too early' }],
    } as never)).resolves.toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })

    // Idle again after a completed turn.
    await harness.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'original' }] })
    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'too late' }],
    } as never)).resolves.toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })
    expect(await assistantText(session.sessionId)).toEqual(['done'])
  })

  it('reports promptRequired when the turn ended before the message was admitted', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('quick')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'original' }] })

    // Racing a just-settled turn must not throw and must not start one.
    const outcomes = await Promise.all([
      harness.client.steer({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'a' }] } as never),
      harness.client.steer({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'b' }] } as never),
    ])
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })
    }
  })

  it('accepts several steering messages inside one turn', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('after steering')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()

    // Both are accepted against the same live turn; neither opens a second one.
    await expect(harness.client.steer({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'one' }] } as never))
      .resolves.toEqual({ outcome: 'injected' })
    await expect(harness.client.steer({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'two' }] } as never))
      .resolves.toEqual({ outcome: 'injected' })
    expect(harness.adapter.requests).toHaveLength(1)

    await harness.client.cancel({ sessionId: session.sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it.each([
    ['a missing prompt', { sessionId: 'x' }, /non-empty content-block array/],
    ['a blank sessionId', { sessionId: '  ', prompt: [{ type: 'text', text: 'hi' }] }, /sessionId must be a non-empty string/],
  ])('rejects %s', async (_label, params, expected) => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.steer(params as never)).rejects.toThrow(expected)
  })

  it('rejects an unknown session', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.steer({
      sessionId: 'no-such-session',
      prompt: [{ type: 'text', text: 'hi' }],
    } as never)).rejects.toThrow(/unknown session/)
  })

  it('refuses an inline image the connection never advertised', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()

    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    } as never)).rejects.toThrow(/inline image prompts were not advertised/)

    await harness.client.cancel({ sessionId: session.sessionId })
    await prompt
  })

  it('answers promptRequired when the turn is cancelled while image admission is in flight', async () => {
    // The second steerable() re-check exists for exactly this window: the
    // turn the message aimed at must stay live through admission, which for
    // an image awaits attachment storage. Cancelling behind that await must
    // land on promptRequired, never on a steered message with no owning turn.
    harness = await makeBridgeHarness({ imageCapable: true, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()

    // Hold the attachment write open so admission is observably in flight.
    const store = harness.attachments
    if (store === undefined) throw new Error('expected the harness attachment store')
    const originalSave = store.saveImages.bind(store)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const saveImages = vi.spyOn(store, 'saveImages')
      .mockImplementation(async inputs => { await gate; return originalSave(inputs) })
    const steered = harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }],
    } as never)
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalled() })

    await harness.client.cancel({ sessionId: session.sessionId })
    release()
    await expect(steered).resolves.toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })
    saveImages.mockRestore()

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    // The steered image never entered the durable transcript.
    expect(userPromptTexts(await readSessionLog(harness.ctx, session.sessionId))).toEqual(['original'])
  })

  it('admits a steered image against the route the running turn is pinned to', async () => {
    // A model option change mid-turn rewrites the session's live selection but
    // leaves the running turn pinned to the route it started on, so admission
    // must read the pinned route. Reading the live selection instead refuses an
    // image-capable turn after a switch to `plain`, and admits one the pinned
    // route could not take.
    harness = await makeBridgeHarness({ imageCapable: true, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()

    // `mock` is the image-capable route the turn pinned; `plain` never is.
    await harness.client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: '["mock","plain"]',
    })

    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }],
    } as never)).resolves.toEqual({ outcome: 'injected' })

    await harness.client.cancel({ sessionId: session.sessionId })
    await prompt
  })

  it('answers promptRequired when admission spans a turn handover', async () => {
    // Image admission awaits attachment storage, and that await spans whole
    // turn handovers: T1 can settle and a later prompt can claim T2 while the
    // message is still being admitted. The block was admitted on T1's pinned
    // route, so injecting it into T2 would deliver it on terms T2 never had —
    // the re-check must pin the identity of the aimed turn, not merely ask
    // whether some turn happens to be live.
    harness = await makeBridgeHarness({
      imageCapable: true,
      script: [{ chunks: textResponse('first'), holdMs: 500 }, 'hang'],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt1 = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    })
    await waitForRunningTurn()

    const store = harness.attachments
    if (store === undefined) throw new Error('expected the harness attachment store')
    const originalSave = store.saveImages.bind(store)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const saveImages = vi.spyOn(store, 'saveImages')
      .mockImplementation(async inputs => { await gate; return originalSave(inputs) })

    // Aimed at T1 while T1 is live: reaching saveImages proves the first
    // steerable() check passed, and admission is now held open.
    const steered = harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }],
    } as never)
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalled() })

    // T1 finishes on its own while admission is still held; its inflight slot
    // is cleared before the prompt resolves.
    await expect(prompt1).resolves.toEqual({ stopReason: 'end_turn' })

    // Retarget the session, then start T2 pinned to the new route: by the time
    // admission resumes, the only live turn is one this message never aimed at.
    await harness.client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: '["mock","plain"]',
    })
    const prompt2 = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'two' }],
    })
    await vi.waitFor(() => { expect(harness!.adapter.requests.length).toBe(2) })

    release()
    await expect(steered).resolves.toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })
    saveImages.mockRestore()

    await harness.client.cancel({ sessionId: session.sessionId })
    await expect(prompt2).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('refuses to steer a driver that already reports idle', async () => {
    // The window where the driver has retired but the bridge has not yet seen
    // its `turn/end` is not reachable through the harness, so it is forced here:
    // without this guard the injected message would wake an idle driver into a
    // turn no ACP request owns.
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'original' }],
    })
    await waitForRunningTurn()

    const agent = harness.ctx.agents.get(SessionId(session.sessionId))
    if (agent === undefined) throw new Error('expected the session agent')
    Object.defineProperty(agent, 'status', { value: 'idle', configurable: true, writable: true })

    await expect(harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'after the driver retired' }],
    } as never)).resolves.toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })

    await harness.client.cancel({ sessionId: session.sessionId })
    await prompt
  })

  it('rejects an idleBehavior this bridge does not implement', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    // Only `promptRequired` is defined; an unimplemented policy must fail
    // rather than silently be answered with the one policy it never asked for,
    // and it must fail under the invalid-params code the extension promises.
    const rejection = await harness.client.steer({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
      _meta: { steering: { idleBehavior: 'autoPrompt' } },
    } as never).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as { code?: unknown }).code).toBe(-32602)
    expect((rejection as Error).message).toMatch(/idleBehavior/)
  })
})
