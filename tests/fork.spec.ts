/** Inclusive `session/fork` and the `jetbrains.air.fork` message-point extension. */

import { describe, it, expect, afterEach } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createHash } from 'node:crypto'
import { makeBridgeHarness, readSessionLog, textResponse } from './harness.ts'
import type { BridgeHarness } from './harness.ts'

/** One assistant message's committed id and visible text, as a fork point. */
interface AssistantPoint {
  id: string
  text: string
  seq: number
}

describe('session/fork', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** The assistant messages a source session committed, in log order. */
  async function assistantPoints(sessionId: string): Promise<AssistantPoint[]> {
    const events = await readSessionLog(harness!.ctx, sessionId)
    return events.flatMap(event => (event.type === 'assistant/message'
      ? [{
        id: `${String(event.data.turn)}:${String(event.data.step)}`,
        text: event.data.message.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => block.text)
          .join(''),
        seq: event.seq,
      }]
      : []))
  }

  /** Every committed event type in one stored log, for structural assertions. */
  async function logTypes(sessionId: string): Promise<string[]> {
    return (await readSessionLog(harness!.ctx, sessionId)).map(event => event.type)
  }

  /**
   * Drive a session through one prompt so its log holds real committed
   * assistant messages, then return that session id.
   */
  async function seededSession(reply = 'first answer'): Promise<string> {
    harness = await makeBridgeHarness({ script: [textResponse(reply)] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'question' }] })
    return session.sessionId
  }

  /** The wire form of a `messageFingerprint`. */
  function fingerprint(text: string): string {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
  }

  it('copies the whole committed log when the request carries no fork point', async () => {
    const sourceId = await seededSession()
    const before = await logTypes(sourceId)

    const forked = await harness!.client.forkSession({ sessionId: sourceId, cwd: process.cwd(), mcpServers: [] })

    expect(forked.sessionId).not.toBe(sourceId)
    // The child's inherited prefix is the source's whole log, terminated by the
    // platform's `session/end-seed` marker — the boundary `inheritedEventCount`
    // counts up to. A settled source needs no synthetic closers after it.
    expect(await logTypes(forked.sessionId)).toEqual([...before, 'session/end-seed'])
    // The source is untouched: fork is read-only against it.
    expect(await logTypes(sourceId)).toEqual(before)
  })

  it('keeps the selected assistant message and drops everything after it', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('first answer'), textResponse('second answer')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: source.sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await harness.client.prompt({ sessionId: source.sessionId, prompt: [{ type: 'text', text: 'two' }] })

    const points = await assistantPoints(source.sessionId)
    expect(points.map(point => point.text)).toEqual(['first answer', 'second answer'])
    const full = await logTypes(source.sessionId)

    const forked = await harness.client.forkSession({
      sessionId: source.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { jetbrains: { air: { fork: { version: 1, inclusive: true, messageId: points[0].id } } } },
    })

    const childPoints = await assistantPoints(forked.sessionId)
    expect(childPoints.map(point => point.text)).toEqual(['first answer'])
    // Exactly the prefix through the selected message, the seed marker, and the
    // synthetic step/turn closers `buildForkSeed` adds for the still-open tail —
    // not the source's second turn.
    const through = full.indexOf('assistant/message') + 1
    expect(await logTypes(forked.sessionId))
      .toEqual([...full.slice(0, through), 'session/end-seed', 'step/end', 'turn/end'])
    // And the source still holds both replies.
    expect((await assistantPoints(source.sessionId)).map(point => point.text)).toEqual(['first answer', 'second answer'])
  })

  it('accepts a streamed segment id and resolves it to the whole message', async () => {
    const sourceId = await seededSession()
    const [point] = await assistantPoints(sourceId)

    const forked = await harness!.client.forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: `${point.id}:segment:3` } } } },
    })

    expect((await assistantPoints(forked.sessionId)).map(entry => entry.text)).toEqual(['first answer'])
  })

  it('selects by fingerprint when the id no longer matches', async () => {
    const sourceId = await seededSession()
    const [point] = await assistantPoints(sourceId)

    const forked = await harness!.client.forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        jetbrains: {
          air: {
            fork: { version: 1, messageId: '0:9', messageFingerprint: fingerprint(point.text) },
          },
        },
      },
    })

    expect((await assistantPoints(forked.sessionId)).map(entry => entry.text)).toEqual(['first answer'])
  })

  it('rejects a mismatched fingerprint instead of falling back to a whole-session copy', async () => {
    const sourceId = await seededSession()
    const [point] = await assistantPoints(sourceId)

    await expect(harness!.client.forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        jetbrains: {
          air: {
            fork: { version: 1, messageId: point.id, messageFingerprint: fingerprint('a different reply') },
          },
        },
      },
    })).rejects.toThrow(/not found/)
  })

  it.each([
    ['an unsupported version', { version: 2, messageId: '1:1' }, /Unsupported jetbrains\.air\.fork version/],
    ['a blank messageId', { version: 1, messageId: '   ' }, /messageId must be a non-empty string/],
    ['a malformed fingerprint', { version: 1, messageId: '1:1', messageFingerprint: 'sha256:zz' }, /must match sha256/],
    ['a zero occurrence', { version: 1, messageId: '1:1', messageOccurrence: 0 }, /positive safe integer/],
  ])('rejects %s', async (_label, fork, expected) => {
    const sourceId = await seededSession()
    await expect(harness!.client.forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { jetbrains: { air: { fork } } },
    })).rejects.toThrow(expected)
  })

  it('rejects a fork point the log does not contain', async () => {
    const sourceId = await seededSession()
    await expect(harness!.client.forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: '7:7' } } } },
    })).rejects.toThrow(/was not found/)
  })

  it('rejects an unknown session, a mismatched cwd, and additional roots', async () => {
    const sourceId = await seededSession()
    await expect(harness!.client.forkSession({
      sessionId: 'no-such-session',
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/unknown session/)
    await expect(harness!.client.forkSession({
      sessionId: sourceId,
      cwd: '/somewhere/else',
      mcpServers: [],
    })).rejects.toThrow(/cwd does not match/)
    await expect(harness!.client.forkSession({
      sessionId: sourceId,
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: ['/extra'],
    })).rejects.toThrow(/additionalDirectories is not supported/)
  })

  it('reloads the forked prefix through session/load on the child', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('first answer'), textResponse('second answer')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: source.sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await harness.client.prompt({ sessionId: source.sessionId, prompt: [{ type: 'text', text: 'two' }] })
    const points = await assistantPoints(source.sessionId)

    const forked = await harness.client.forkSession({
      sessionId: source.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: points[0].id } } } },
    })
    await harness.client.closeSession({ sessionId: forked.sessionId })
    harness.sessionUpdates.length = 0
    await harness.client.loadSession({ sessionId: forked.sessionId, cwd: process.cwd(), mcpServers: [] })

    const replayed = harness.sessionUpdates
      .filter(entry => entry.sessionId === forked.sessionId)
      .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
      .map(entry => entry.update.sessionUpdate === 'agent_message_chunk' && entry.update.content.type === 'text'
        ? entry.update.content.text
        : '')
    expect(replayed).toEqual(['first answer'])
  })

  it('keeps a forked child listable, loadable, and promptable as a first-class root', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('first answer'), textResponse('second answer'), textResponse('after fork')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const source = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: source.sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await harness.client.prompt({ sessionId: source.sessionId, prompt: [{ type: 'text', text: 'two' }] })
    const points = await assistantPoints(source.sessionId)

    const forked = await harness.client.forkSession({
      sessionId: source.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: points[0].id } } } },
    })

    // Fork lineage sets `parentSession` but not `origin: 'subagent'`. Close the
    // child so it is no longer an active session, then prove it survives the
    // delegated-child gates a spawn child would be excluded by.
    await harness.client.closeSession({ sessionId: forked.sessionId })
    const listed = await harness.client.listSessions({ cwd: process.cwd() })
    expect(listed.sessions.map(entry => entry.sessionId)).toContain(forked.sessionId)

    // And the branch really is usable: it reloads like any other root session,
    // and the next prompt continues from the fork point.
    await harness.client.loadSession({ sessionId: forked.sessionId, cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: forked.sessionId, prompt: [{ type: 'text', text: 'branch' }] })
    expect((await assistantPoints(forked.sessionId)).map(entry => entry.text))
      .toEqual(['first answer', 'after fork'])
  })

  it('advertises the fork capability and the extension contract at initialize', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(response.agentCapabilities?.sessionCapabilities?.fork).toEqual({})
    expect(response.agentCapabilities?._meta).toMatchObject({
      jetbrains: { air: { fork: { version: 1, inclusive: true } } },
    })
  })
})
