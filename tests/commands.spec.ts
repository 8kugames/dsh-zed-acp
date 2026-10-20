/**
 * Slash commands over `session/prompt`: a resolved command runs on the host
 * plane, so it settles without a model turn and cannot be refused by a tool
 * gate or a rate-limited model route.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, readSessionLog, textResponse, type BridgeHarness } from './harness.ts'
import type { ScriptedResponse } from './harness.ts'

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

/** Assistant text this bridge delivered as a session update, in order. */
function deliveredAgentText(harness: BridgeHarness): string[] {
  const texts: string[] = []
  for (const { update } of harness.sessionUpdates) {
    if (update.sessionUpdate !== 'agent_message_chunk') continue
    if (update.content.type === 'text') texts.push(update.content.text)
  }
  return texts
}

describe('slash commands over session/prompt', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** A harness with a registry that resolves `goal` and reports it as paused. */
  async function withGoalCommand(script: ScriptedResponse[] = []): Promise<BridgeHarness> {
    const built = await makeBridgeHarness({ script, commands: true })
    built.commands!.register('goal', { kind: 'success', text: 'Goal paused' })
    harness = built
    return built
  }

  it('runs a resolved command without sending the line to the model', async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    // No scripted response: a prompt that reached the model would exhaust the
    // adapter, so a settled prompt is itself the proof the line never did.
    const response = await built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })

    expect(response.stopReason).toBe('end_turn')
    expect(built.commands!.executed).toEqual(['/goal pause'])
    const events = await readSessionLog(built.ctx, sessionId)
    expect(userPromptTexts(events)).toEqual([])
    expect(deliveredAgentText(built)).toContain('Goal paused')
  })

  it('leaves an unregistered slash line on the model path', async () => {
    const built = await withGoalCommand([textResponse('prose reply')])
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    const response = await built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/unknown thing' }] })

    expect(response.stopReason).toBe('end_turn')
    expect(built.commands!.executed).toEqual([])
    const events = await readSessionLog(built.ctx, sessionId)
    expect(userPromptTexts(events)).toEqual(['/unknown thing'])
  })

  it('sends ordinary prose to the model unchanged', async () => {
    const built = await withGoalCommand([textResponse('prose reply')])
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    await built.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'close the goal please' }] })

    expect(built.commands!.executed).toEqual([])
    const events = await readSessionLog(built.ctx, sessionId)
    expect(userPromptTexts(events)).toEqual(['close the goal please'])
  })

  it('keeps a multi-block prompt on the model path', async () => {
    const built = await withGoalCommand([textResponse('prose reply')])
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    await built.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/goal pause' }, { type: 'text', text: 'and commit' }],
    })

    expect(built.commands!.executed).toEqual([])
  })

  it('reports a handler failure and ends the turn instead of retrying as prose', async () => {
    const built = await withGoalCommand()
    built.commands!.failure = new Error('domain exploded')
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    const response = await built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })

    expect(response.stopReason).toBe('end_turn')
    expect(deliveredAgentText(built).join('\n')).toContain('domain exploded')
    const events = await readSessionLog(built.ctx, sessionId)
    expect(userPromptTexts(events)).toEqual([])
  })

  it('omits a chunk for a result that carries no text', async () => {
    const built = await withGoalCommand()
    built.commands!.register('silent', { kind: 'success' })
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    const response = await built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/silent' }] })

    expect(response.stopReason).toBe('end_turn')
    expect(built.commands!.executed).toEqual(['/silent'])
    expect(deliveredAgentText(built)).not.toContain('')
  })

  it('rejects a concurrent prompt while a command is mid-dispatch', async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executing = built.commands!.execute
    built.commands!.execute = async (...args) => {
      await gate
      return executing.call(built.commands!, ...args)
    }

    const first = built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })
    // Let the dispatch claim the slot before the second prompt is admitted.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(built.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] }))
      .rejects.toThrow(/already in flight/)
    release!()
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('aborts a running command on session/cancel and settles the prompt as cancelled', async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const executing = built.commands!.execute
    let signal: AbortSignal | undefined
    built.commands!.execute = async (...args) => {
      signal = args[3]
      entered!()
      await gate
      return executing.call(built.commands!, ...args)
    }

    const prompt = built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })
    await started
    await built.client.cancel({ sessionId })
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    release!()

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(deliveredAgentText(built)).not.toContain('Goal paused')
  })

  it("replays a settled command's text on session/load", async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    const agent = built.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('command/run', {
      commandId: CommandId('cmd-replay'),
      name: 'goal',
      source: { kind: 'user' },
    })
    agent.session.append('command/done', {
      commandId: CommandId('cmd-replay'),
      kind: 'success',
      text: 'Goal paused',
    })
    await built.client.closeSession({ sessionId })
    const before = built.sessionUpdates.length

    await built.client.loadSession({ sessionId, cwd: built.persistenceRoot, mcpServers: [] })

    const replayed = built.sessionUpdates.slice(before)
      .filter(({ update }) => update.sessionUpdate === 'agent_message_chunk')
    expect(replayed.some(({ update }) =>
      'messageId' in update && update.messageId === 'cmd-replay'
      && update.content.type === 'text' && update.content.text === 'Goal paused')).toBe(true)
  })

  it('answers busy rather than promptRequired while a command is running', async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const executing = built.commands!.execute
    built.commands!.execute = async (...args) => {
      entered!()
      await gate
      return executing.call(built.commands!, ...args)
    }

    const prompt = built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })
    await started
    // A new prompt would be rejected by the command slot, so steering must not
    // tell the client to send one.
    await expect(built.client.steer({
      sessionId,
      prompt: [{ type: 'text', text: 'follow-up' }],
    })).resolves.toEqual({ outcome: 'busy' })

    await built.client.cancel({ sessionId })
    release!()
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('waits for a running command and aborts it before closing', async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const executing = built.commands!.execute
    let signal: AbortSignal | undefined
    built.commands!.execute = async (...args) => {
      signal = args[3]
      entered!()
      await gate
      return executing.call(built.commands!, ...args)
    }

    const prompt = built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })
    await started
    let closed = false
    const closing = Promise.resolve(built.client.closeSession({ sessionId }))
      .then((response) => { closed = true; return response })
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Close must hold the session open while the handler still runs.
    expect(closed).toBe(false)

    release!()
    await expect(closing).resolves.toEqual({})
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(deliveredAgentText(built)).not.toContain('Goal paused')
  })

  it('rejects a command prompt after the agent was disposed', async () => {
    const built = await withGoalCommand()
    const { sessionId } = await built.client.newSession({ cwd: built.persistenceRoot, mcpServers: [] })
    await built.loopFiber.dispose()

    await expect(built.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/goal pause' }] }))
      .rejects.toThrow(/prompt was not queued/)
    expect(built.commands!.executed).toEqual([])
  })
})
