import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { errorResponse, makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

import { DESCENDANT_ACTIVITY_TITLE } from '../src/updates.ts'
import { DESCENDANT_WAKE_LIMIT, planDescendantReplay } from '../src/session.ts'

type DescendantCardUpdate =
  | Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>
  | Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>

let descendantSeq = 0

/**
 * Minimal delegated agent, the only shape the bridge's routing reads: the
 * spawn tool stamps both `parentSession` and `origin: 'subagent'` on a child,
 * and the bridge requires the origin stamp so a fork-lineage session is never
 * mistaken for delegated work.
 */
function fakeDescendant(parentSessionId: string): Agent {
  descendantSeq += 1
  const id = `descendant-${descendantSeq}`
  return {
    id,
    session: {
      id: SessionId(id),
      header: { id: SessionId(id), parentSession: SessionId(parentSessionId), origin: 'subagent' },
      // The shared `session/event` emit also reaches the harness's projection
      // registry, whose eager drive folds `snapshotEvents` on first contact.
      inheritedEventCount: 0,
      snapshotEvents: () => [],
    },
  } as unknown as Agent
}

function descendantCards(harness: BridgeHarness, sessionId: string, stage: 'tool_call' | 'tool_call_update'): DescendantCardUpdate[] {
  const cards: DescendantCardUpdate[] = []
  for (const { sessionId: sid, update } of harness.sessionUpdates) {
    if (sid !== sessionId) continue
    if (update.sessionUpdate === 'tool_call' && stage === 'tool_call' && update.toolCallId.startsWith('dsh-subagent-')) {
      cards.push(update)
    } else if (
      update.sessionUpdate === 'tool_call_update' && stage === 'tool_call_update'
      && update.status !== undefined && update.toolCallId.startsWith('dsh-subagent-')
    ) {
      // Live progress/title patches carry no `status`; only settling updates do.
      cards.push(update)
    }
  }
  return cards
}

/** Concatenated assistant text the client received for one ACP session. */
function assistantText(harness: BridgeHarness, sessionId: string): string {
  let text = ''
  for (const { sessionId: sid, update } of harness.sessionUpdates) {
    if (sid !== sessionId) continue
    if (update.sessionUpdate !== 'agent_message_chunk') continue
    const content = update.content
    if (content.type === 'text') text += content.text
  }
  return text
}

describe('descendant history reload projection', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Clone the parent's complete persisted event sequence with the first user
   * text and the last turn/end reason overridden, so the child log is
   * structurally valid for the store's turn-structure read validation. */
  async function cloneParentEvents(
    parentSessionId: string,
    taskText: string,
    endKind: 'completed' | 'interrupted',
  ): Promise<readonly SessionEvent[]> {
    const parentHandle = await harness!.ctx.sessionPersistence.open(SessionId(parentSessionId), 'read')
    let events: readonly SessionEvent[]
    try {
      events = (await parentHandle.read(0, undefined)).events
    } finally {
      await parentHandle.close()
    }
    let rewroteUser = false
    return events.map(event => {
      if (!rewroteUser && event.type === 'user/message' && event.data.source.kind === 'user') {
        rewroteUser = true
        const block = event.data.content.find(candidate => candidate.type === 'text')
        if (block === undefined) throw new Error('expected a text block in the persisted prompt')
        return { ...event, data: { ...event.data, content: [{ ...block, text: taskText }] } } as SessionEvent
      }
      if (event.type === 'turn/end') {
        return { ...event, data: { ...event.data, reason: { kind: endKind } } } as SessionEvent
      }
      return event
    }) as readonly SessionEvent[]
  }

  async function persistSession(header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const handle = await harness!.ctx.sessionPersistence.create(header)
    try {
      await handle.append(events)
    } finally {
      await handle.close()
    }
  }

  async function persistChild(
    parentSessionId: string,
    id: string,
    createdAt: number,
    taskText: string,
    endKind: 'completed' | 'interrupted',
  ): Promise<void> {
    await persistSession({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt,
      cwd: process.cwd(),
      parentSession: SessionId(parentSessionId),
      isSeeded: false,
      origin: 'subagent',
    }, await cloneParentEvents(parentSessionId, taskText, endKind))
  }

  it('projects one settled fate card per persisted subagent child on session/load', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    // Closing first flushes the parent log (the clone source) and frees the
    // session id for session/load.
    await harness.client.closeSession({ sessionId })
    await persistChild(sessionId, 'child-a', 1, 'Audit the parser', 'completed')
    await persistChild(sessionId, 'child-b', 2, 'Refactor the codec', 'interrupted')
    // A crash-orphaned child: its log never received a turn/end closer.
    await persistSession({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('child-c'),
      createdAt: 3,
      cwd: process.cwd(),
      parentSession: SessionId(sessionId),
      isSeeded: false,
      origin: 'subagent',
    }, (await cloneParentEvents(sessionId, 'Investigate the flake', 'completed')).filter(event => event.type !== 'turn/end'))
    // A grandchild below child-a: reload coverage must match the live routing.
    await persistChild('child-a', 'grandchild-a', 4, 'Narrow the regression', 'completed')
    harness.sessionUpdates.length = 0
    await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    const cards = descendantCards(harness, sessionId, 'tool_call')
    const settled = descendantCards(harness, sessionId, 'tool_call_update')
    expect(cards.map(update => update.toolCallId)).toEqual([
      'dsh-subagent-child-a',
      'dsh-subagent-child-b',
      'dsh-subagent-child-c',
      'dsh-subagent-grandchild-a',
    ])
    expect(cards.map(update => update.title)).toEqual([
      'Audit the parser',
      'Refactor the codec',
      'Investigate the flake',
      'Narrow the regression',
    ])
    expect(settled.map(update => [update.toolCallId, update.status])).toEqual([
      ['dsh-subagent-child-a', 'completed'],
      ['dsh-subagent-child-b', 'failed'],
      ['dsh-subagent-child-c', 'failed'],
      ['dsh-subagent-grandchild-a', 'completed'],
    ])
    // The summary carries the descendant's last assistant text.
    const summary = settled.find(update => update.toolCallId === 'dsh-subagent-child-a')
    expect(summary).toMatchObject({
      content: [expect.objectContaining({
        content: expect.objectContaining({ text: 'parent done' }),
      })],
    })
  })

  it('skips children whose logs show no work and keeps non-subagent lineage out', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await harness.client.closeSession({ sessionId })
    // An empty subagent child log: no events worth surfacing.
    await persistSession({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('child-empty'),
      createdAt: 3,
      cwd: process.cwd(),
      parentSession: SessionId(sessionId),
      isSeeded: false,
      origin: 'subagent',
    }, [])
    // A fork-lineage child carrying real work events but no subagent origin
    // stamp is not delegated work and must stay out of the projection.
    await persistSession({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('fork-child'),
      createdAt: 4,
      cwd: process.cwd(),
      parentSession: SessionId(sessionId),
      isSeeded: false,
    }, await cloneParentEvents(sessionId, 'Forked exploration', 'completed'))
    harness.sessionUpdates.length = 0
    await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(descendantCards(harness, sessionId, 'tool_call')).toHaveLength(0)
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(0)
  })

  it('anchors each fate card at its spawn record instead of stacking the batch at the tail', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await harness.client.closeSession({ sessionId })
    // The anchored child is the *later* spawn, so a projection still ordering by
    // creation time would emit it second: the anchor must win over that order.
    await persistChild(sessionId, 'child-early', 1, 'Audit the parser', 'completed')
    await persistChild(sessionId, 'child-late', 2, 'Refactor the codec', 'completed')
    const parentHandle = await harness.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
    let nextSeq: number
    try {
      nextSeq = Math.max(...(await parentHandle.read(0, undefined)).events.map(event => event.seq as number)) + 1
    } finally {
      await parentHandle.close()
    }
    const writer = await harness.ctx.sessionPersistence.open(SessionId(sessionId), 'write')
    try {
      await writer.append([{
        type: 'subagent/catalog',
        seq: nextSeq as never,
        time: Date.now(),
        data: { version: 0, childId: 'child-late', childCreatedAt: 2, mode: 'continuable', label: 'Codec audit' },
      }] as unknown as readonly SessionEvent[])
    } finally {
      await writer.close()
    }
    harness.sessionUpdates.length = 0
    await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(descendantCards(harness, sessionId, 'tool_call').map(update => update.toolCallId)).toEqual([
      'dsh-subagent-child-late',
      'dsh-subagent-child-early',
    ])
  })
})

describe('descendant replay placement', () => {
  function rosterHeader(id: string, createdAt: number): SessionHeader {
    return { id: SessionId(id), createdAt } as SessionHeader
  }

  function anchor(childId: unknown, seq: number): SessionEvent {
    return { type: 'subagent/catalog', seq: seq as never, time: seq, data: { childId } } as unknown as SessionEvent
  }

  function assistantLine(text: string, seq: number): SessionEvent {
    return {
      type: 'assistant/message',
      seq: seq as never,
      time: seq,
      data: {
        turn: 1,
        step: 0,
        stream: [],
        message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      },
    } as unknown as SessionEvent
  }

  /** The plan rendered as a transcript: parent events as text, cards by child id. */
  function transcript(plan: ReturnType<typeof planDescendantReplay>): string[] {
    return plan.map(step => step.kind === 'event'
      ? (step.event.data as { message?: { content: { text: string }[] } }).message?.content[0]?.text ?? step.event.type
      : `card:${step.header.id}`)
  }

  it('places each card at its own spawn anchor', () => {
    const plan = planDescendantReplay([
      assistantLine('first', 1),
      anchor('child-a', 2),
      assistantLine('second', 3),
      anchor('child-b', 4),
      assistantLine('third', 5),
    ], [rosterHeader('child-a', 1), rosterHeader('child-b', 2)])
    expect(transcript(plan)).toEqual(['first', 'card:child-a', 'second', 'card:child-b', 'third'])
  })

  it('keeps descendants no anchor named in the tail, creation-ordered', () => {
    const roster = [
      rosterHeader('anchored', 1),
      rosterHeader('older-tail', 2),
      rosterHeader('newer-tail', 3),
    ]
    expect(transcript(planDescendantReplay([assistantLine('only', 1)], roster)))
      .toEqual(['only', 'card:anchored', 'card:older-tail', 'card:newer-tail'])
    expect(transcript(planDescendantReplay([anchor('anchored', 0), assistantLine('only', 1)], roster)))
      .toEqual(['card:anchored', 'only', 'card:older-tail', 'card:newer-tail'])
  })

  it('grants a card only to rostered children and only once', () => {
    const plan = planDescendantReplay([
      anchor('foreign-child', 1),
      anchor('child-a', 2),
      anchor('child-a', 3),
      anchor(undefined, 4),
      anchor('', 5),
      anchor(42, 6),
      assistantLine('done', 7),
    ], [rosterHeader('child-a', 1)])
    expect(transcript(plan)).toEqual(['card:child-a', 'done'])
  })
})

describe('descendant progress cards', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** Committed child-session events driving one live progress card. */
  function childUserMessage(text: string): SessionEvent {
    return {
      type: 'user/message',
      seq: 1 as never,
      time: Date.now(),
      data: { id: 'u1', content: [{ type: 'text', text }], source: { kind: 'user' } },
    } as unknown as SessionEvent
  }

  function childToolCall(): SessionEvent {
    return {
      type: 'tool/call',
      seq: 2 as never,
      time: Date.now(),
      data: { turn: 1, step: 0, callId: 'c1' as never, name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
    } as unknown as SessionEvent
  }

  function childAssistantMessage(): SessionEvent {
    return {
      type: 'assistant/message',
      seq: 3 as never,
      time: Date.now(),
      data: {
        turn: 1,
        step: 0,
        stream: [],
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Found the bug' }] },
        usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 100 },
      },
    } as unknown as SessionEvent
  }

  function childTurnEnd(kind: string): SessionEvent {
    return { type: 'turn/end', seq: 4 as never, time: Date.now(), data: { turn: 1, reason: { kind } } } as unknown as SessionEvent
  }

  /** Live progress/title patches: `dsh-subagent-*` updates that carry no status. */
  function descendantPatches(harness: BridgeHarness, sessionId: string): DescendantCardUpdate[] {
    const patches: DescendantCardUpdate[] = []
    for (const { sessionId: sid, update } of harness.sessionUpdates) {
      if (sid !== sessionId || update.sessionUpdate !== 'tool_call_update') continue
      if (!update.toolCallId.startsWith('dsh-subagent-')) continue
      if (update.status === undefined) patches.push(update)
    }
    return patches
  }

  function patchText(update: DescendantCardUpdate): string {
    const content = 'content' in update ? update.content : undefined
    const block = content?.find(candidate => candidate.type === 'content') as
      { content?: { type?: string; text?: string } } | undefined
    return block?.content?.type === 'text' ? block.content.text ?? '' : ''
  }

  it('learns the task title and streams live progress into the open card', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await harness.ctx.emit('session/event', child.session, childUserMessage('Audit the parser'))
    await harness.ctx.emit('session/event', child.session, childToolCall())
    await harness.ctx.emit('session/event', child.session, childAssistantMessage())
    await harness.ctx.emit('session/event', child.session, childTurnEnd('completed'))
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    // The card opens generic; the first committed user message patches its title.
    const opened = descendantCards(harness, sessionId, 'tool_call')
    expect(opened[0]!.title).toBe(DESCENDANT_ACTIVITY_TITLE)
    const patches = descendantPatches(harness, sessionId)
    expect(patches.some(update => update.title === 'Audit the parser')).toBe(true)
    // The live body carried the tool activity and the accumulated token facts.
    expect(patches.map(patchText).some(text => text.includes('`npm test`'))).toBe(true)
    expect(patches.map(patchText).some(text => text.includes('in 1.1k'))).toBe(true)
    // The settle follows the child's own turn fate and carries its last line.
    const settled = descendantCards(harness, sessionId, 'tool_call_update')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.status).toBe('completed')
    expect(patchText(settled[0]!)).toBe('Found the bug')
  })

  it('settles a failed card from the child\'s error turn/end', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await harness.ctx.emit('session/event', child.session, childAssistantMessage())
    await harness.ctx.emit('session/event', child.session, childTurnEnd('error'))
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    await prompt
    const settled = descendantCards(harness, sessionId, 'tool_call_update')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.status).toBe('failed')
    expect(patchText(settled[0]!)).toBe('Found the bug')
  })

  it('reconciles a stale running state against the mirrored agent status', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done'), textResponse('after descendants')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .then(result => { settled = true; return result })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    // The terminal idle never arrives (the wedge this reconciliation exists
    // for); the agent's mirrored status ground truth moves on without us.
    ;(child as unknown as { status: string }).status = 'idle'
    // Any later descendant input drives the reconciliation pass, so the gate
    // cannot stay wedged on the stale entry.
    const sibling = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: sibling, source: 'startup' })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    await harness.ctx.emit('agent/status', { agent: sibling, status: 'idle' })
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    const settledCards = descendantCards(harness, sessionId, 'tool_call_update')
    expect(settledCards.map(update => update.status)).toEqual(['completed', 'completed'])
  })

  it('reconciles from the periodic timer when no descendant input arrives', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done'), textResponse('after descendants')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    // Fake only the reconciliation interval: the parent turn's streaming and
    // the harness's waits keep their real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      const child = fakeDescendant(sessionId)
      await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
      await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
      await vi.waitFor(() => {
        expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
      })
      // The terminal idle is lost; only the mocked 15s tick can reconcile.
      ;(child as unknown as { status: string }).status = 'idle'
      await vi.advanceTimersByTimeAsync(15_000)
      const result = await prompt
      expect(result.stopReason).toBe('end_turn')
      expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('continuable-descendant visibility', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('holds the prompt until a continuable descendant goes idle and projects its activity card', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('parent done'), textResponse('after descendants')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .then(result => { settled = true; return result })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await new Promise(resolve => setImmediate(resolve))
    // The parent turn finished, but the prompt must still be in flight and the
    // activity card open on the parent session.
    expect(settled).toBe(false)
    const opened = descendantCards(harness, sessionId, 'tool_call')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.status).toBe('in_progress')
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    const settledCards = descendantCards(harness, sessionId, 'tool_call_update')
    expect(settledCards).toHaveLength(1)
    expect(settledCards[0]!.toolCallId).toBe(opened[0]!.toolCallId)
    expect(settledCards[0]!.status).toBe('completed')
    // The turn ended while the descendant still worked, so the bridge woke the
    // agent with a continuation under the same open prompt instead of settling
    // it: the client receives the continuation turn's answer.
    expect(assistantText(harness, sessionId)).toContain('after descendants')
    expect(harness.adapter.requests).toHaveLength(2)
    // The one stats card this prompt emits carries both of its turns, not just
    // the continuation's: the mock bills 5 in / 11 out for `parent done` and
    // 5 in / 17 out for `after descendants`, and the card is numbered by the
    // latest turn.
    const statsCard = harness.updates.find(update => update.sessionUpdate === 'tool_call'
      && 'toolCallId' in update && update.toolCallId === 'dsh-stats-2')
    expect(statsCard !== undefined && 'title' in statsCard ? statsCard.title : '').toMatch(/↑ 10 · ↓ 28/)
  })

  it('settles promptly on cancel while the descendant keeps running', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('working')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await harness.client.cancel({ sessionId })
    const result = await prompt
    expect(result.stopReason).toBe('cancelled')
    // The activity card stays open: the cancelled remainder remains visible.
    expect(descendantCards(harness, sessionId, 'tool_call')).toHaveLength(1)
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(0)
  })

  it('opens a fresh card for each new activity period and forgets the agent at disposal', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    await prompt
    // A later wake is a new activity period with its own card id.
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await harness.ctx.emit('agent/disposed', { agent: child })
    // Post-settlement card operations have no settlement-driven output flush,
    // so wait for the wire delivery before asserting the full lifecycle.
    await vi.waitFor(() => {
      expect(descendantCards(harness!, sessionId, 'tool_call')).toHaveLength(2)
      expect(descendantCards(harness!, sessionId, 'tool_call_update')).toHaveLength(2)
    })
    const opened = descendantCards(harness, sessionId, 'tool_call')
    const settledCards = descendantCards(harness, sessionId, 'tool_call_update')
    expect(new Set(opened.map(update => update.toolCallId)).size).toBe(2)
    for (const update of settledCards) expect(update.status).toBe('completed')
  })

  it('tracks grandchildren through lineage transitively', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done'), textResponse('after descendants')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .then(result => { settled = true; return result })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    const grandchild = fakeDescendant(child.session.id as string)
    await harness.ctx.emit('agent/created', { agent: grandchild, source: 'startup' })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    // Both periods surface as cards on the root ACP session.
    expect(descendantCards(harness, sessionId, 'tool_call')).toHaveLength(2)
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    await harness.ctx.emit('agent/disposed', { agent: grandchild })
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(2)
  })

  it('settles without a continuation when the descendant already settled at turn end', async () => {
    // A single scripted response makes an unwanted wake observable: the mock
    // adapter throws once its script is exhausted, so a spurious continuation
    // fails this test instead of passing silently.
    harness = await makeBridgeHarness({ script: [textResponse('parent done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    expect(harness.adapter.requests).toHaveLength(1)
    expect(assistantText(harness, sessionId)).toBe('parent done')
  })

  it('stops waking once the continuation limit is spent and settles the prompt', async () => {
    const turns = DESCENDANT_WAKE_LIMIT + 1
    harness = await makeBridgeHarness({
      // Each turn is held open briefly so the test can mark the descendant active
      // while that turn is genuinely live — the exact wake-up condition.
      script: Array.from(
        { length: turns + 1 },
        (_, index) => ({ chunks: textResponse(`turn ${index}`), holdMs: 120 }),
      ),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    for (let turn = 1; turn <= turns; turn += 1) {
      await vi.waitFor(() => { expect(harness!.adapter.requests.length).toBe(turn) }, { interval: 5, timeout: 4000 })
      await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
      await vi.waitFor(
        () => { expect(assistantText(harness!, sessionId)).toContain(`turn ${turn - 1}`) },
        { interval: 5, timeout: 4000 },
      )
      await new Promise(resolve => setImmediate(resolve))
      await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    }
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    // The bound is what keeps a delegation chain from holding the prompt open
    // forever, so the prompt must settle on the last turn the budget allows.
    expect(harness.adapter.requests).toHaveLength(turns)
  })

  it('rejects a failed turn instead of buying a continuation for its descendants', async () => {
    // One scripted response only: any spurious continuation exhausts the mock
    // and changes the rejection, so the request count alone is proof that the
    // gate stayed shut once the turn had failed.
    harness = await makeBridgeHarness({ script: [{ chunks: errorResponse('provider boom'), holdMs: 120 }] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await vi.waitFor(() => { expect(descendantCards(harness!, sessionId, 'tool_call')).toHaveLength(1) })
    // The descendant is live before the turn runs and the turn has ended by the
    // time the agent reports idle, so the failed turn really does finish inside
    // an open descendant period.
    await vi.waitFor(() => { expect(harness!.adapter.requests).toHaveLength(1) })
    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    // Prove the settlement is parked on that descendant — that is the exact
    // state a continuation used to be issued from. Only then does releasing it
    // put the wake decision itself to the test; releasing earlier would let the
    // prompt settle before anyone looked at `endReason`.
    let settled = false
    void prompt.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    await expect(prompt).rejects.toThrow(/turn failed: provider boom/)
    expect(harness.adapter.requests).toHaveLength(1)
    // The failure settles no stats card, and the descendant's own card still
    // closes through the ordinary idle path rather than being abandoned by the
    // skipped continuation.
    expect(harness.updates.some(update => 'toolCallId' in update && String(update.toolCallId).startsWith('dsh-stats-'))).toBe(false)
    const settledCards = descendantCards(harness, sessionId, 'tool_call_update')
    expect(settledCards).toHaveLength(1)
    expect(settledCards[0]!.status).toBe('completed')
  })

  it('leaves the leftover descendant of a cancelled prompt out of the next gate', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first'), textResponse('second')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    // The leftover keeps running and keeps its card: cancellation abandons the
    // request, not the visibility of the work it started.
    expect(descendantCards(harness, sessionId, 'tool_call')).toHaveLength(1)
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(0)
    // The next prompt must neither wait for that leftover nor wake for it. With
    // the mark missing the gate never opens and this never resolves; with a
    // wake the mock would serve a third request.
    const second = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] })
    expect(second.stopReason).toBe('end_turn')
    expect(harness.adapter.requests).toHaveLength(2)
    // Ignoring the leftover cost it nothing: its card is still open.
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(0)
  })

  it('keeps a turn the prompt never claimed out of its stats card', async () => {
    harness = await makeBridgeHarness({
      script: [
        { chunks: textResponse('parent done'), holdMs: 120 },
        textResponse('after descendants'),
      ],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const child = fakeDescendant(sessionId)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    // Hold the prompt inside its settlement window: turn one has finished, the
    // descendant has not, and nothing claims the slot in between.
    await vi.waitFor(() => { expect(assistantText(harness!, sessionId)).toBe('parent done') })
    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(0)
    const owned = agent.session.snapshotEvents().find(
      (event): event is Extract<SessionEvent, { type: 'assistant/message' }> =>
        event.type === 'assistant/message' && event.data.usage !== undefined,
    )
    expect(owned).toBeDefined()
    // A second turn runs on this session that this prompt never claimed: the
    // mock bills the same 5 in / 11 out again, which the card must not carry.
    await harness.ctx.emit('session/event', agent.session, { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 99 } })
    await harness.ctx.emit('session/event', agent.session, { ...owned!, data: { ...owned!.data, turn: 99 } })
    await harness.ctx.emit('session/event', agent.session, {
      type: 'turn/end',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 99, reason: { kind: 'completed' } },
    })
    await harness.ctx.emit('agent/status', { agent: child, status: 'idle' })
    const result = await prompt
    expect(result.stopReason).toBe('end_turn')
    // Both turns this prompt did claim: 5 in / 11 out for `parent done` and
    // 5 in / 17 out for `after descendants`. The unclaimed turn's own 5 / 11
    // would push the card to 15 / 39 if it were folded in.
    const statsCard = harness.updates.find(
      update => update.sessionUpdate === 'tool_call' && 'toolCallId' in update && update.toolCallId === 'dsh-stats-2',
    )
    const title = statsCard !== undefined && 'title' in statsCard ? statsCard.title : ''
    expect(title).toMatch(/↑ 10 · ↓ 28/)
  })

  it('releases the gate on its own descendant while a cancelled leftover stays active', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('first'), { chunks: textResponse('again'), holdMs: 120 }, textResponse('third')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const orphan = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: orphan, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: orphan, status: 'running' })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    // The leftover never goes idle, so the session's active count stays above
    // zero for the rest of this test — precisely the condition under which a
    // release keyed to that count would never fire again.
    const second = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] })
    const own = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: own, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: own, status: 'running' })
    await vi.waitFor(() => { expect(descendantCards(harness!, sessionId, 'tool_call')).toHaveLength(2) })
    await vi.waitFor(() => { expect(harness!.adapter.requests).toHaveLength(2) })
    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    // Parked on the descendant this prompt spawned, not on the leftover: the
    // gate is non-empty, so the waiter really is queued right now.
    let settled = false
    void second.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
    // Releasing that one descendant is the whole test: a release keyed to the
    // session total still sees the leftover and sleeps forever here.
    await harness.ctx.emit('agent/status', { agent: own, status: 'idle' })
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' })
    // Two turns were issued because an open gate for a successful turn buys its
    // own continuation; the leftover, being excluded, never added a third.
    expect(harness.adapter.requests).toHaveLength(3)
    // Only the descendant this prompt waited for settles a card; the leftover's
    // stays open, untouched by the gate that ignored it.
    expect(descendantCards(harness, sessionId, 'tool_call_update')).toHaveLength(1)
  })

  it('lets a recreated same-id descendant back into the gate after disposal', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first'), textResponse('again')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const child = fakeDescendant(sessionId)
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    // Cancel marks it as a leftover, disposal forgets it, and the very same id
    // is then born again. The mark belongs to the disposed period: without
    // dropping it here the new period inherits it and is excluded from the gate
    // for good — `onDescendantBorn` sets `known` before any reconcile pass
    // could clear the mark, so nothing else ever would.
    await harness.ctx.emit('agent/disposed', { agent: child })
    await harness.ctx.emit('agent/created', { agent: child, source: 'startup' })
    await harness.ctx.emit('agent/status', { agent: child, status: 'running' })
    const second = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] })
    await vi.waitFor(() => { expect(harness!.adapter.requests).toHaveLength(2) })
    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    // Re-admitted, so the prompt waits on it; with the stale mark it would see
    // an empty gate and settle the moment its own turn ended.
    let settled = false
    void second.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
    // Release through cancellation rather than waking, which keeps the request
    // count at exactly the two turns this test actually issued.
    await harness.client.cancel({ sessionId })
    await expect(second).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toHaveLength(2)
  })
})
