/** User-invocable skills projected into the wire's slash-command roster. */

import { describe, it, expect, afterEach } from 'vitest'
import { PROTOCOL_VERSION, type AvailableCommand } from '@agentclientprotocol/sdk'
import { makeBridgeHarness } from './harness.ts'
import type { BridgeHarness, StubSkillRegistry } from './harness.ts'

describe('skill command roster', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /** The commands one `available_commands_update` carried for a session. */
  function rosterFor(sessionId: string): AvailableCommand[] {
    const roster = harness!.sessionUpdates
      .filter(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === 'available_commands_update')
      .at(-1)
    return roster?.update.sessionUpdate === 'available_commands_update' ? roster.update.availableCommands : []
  }

  /** Mount a harness whose skill registry answers with these summaries. */
  async function withSkills(
    summaries: StubSkillRegistry['summaries'],
  ): Promise<{ harness: BridgeHarness; registry: StubSkillRegistry }> {
    const built = await makeBridgeHarness({ skills: true })
    harness = built
    built.skills!.summaries = summaries
    return { harness: built, registry: built.skills! }
  }

  it('publishes user-invocable skills alongside the command registry', async () => {
    const { harness: h, registry } = await withSkills([
      { name: 'pdf-extract', description: 'Extract text from a PDF', invocation: { userInvocable: true, modelInvocable: false } },
      { name: 'model-only', description: 'Never offered to a human', invocation: { userInvocable: false, modelInvocable: true } },
    ])
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await new Promise(resolve => { setImmediate(resolve) })

    expect(rosterFor(session.sessionId)).toEqual([
      { name: 'pdf-extract', description: 'Extract text from a PDF', input: { hint: 'instructions for the skill' } },
    ])
    // The catalog was collected for this session's workspace, not the process.
    expect(registry.cwds.at(-1)).toBe(process.cwd())
  })

  it('republishes nothing extra when no skill is user-invocable', async () => {
    const { harness: h } = await withSkills([
      { name: 'model-only', description: 'Never offered to a human', invocation: { userInvocable: false, modelInvocable: true } },
    ])
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await new Promise(resolve => { setImmediate(resolve) })

    expect(rosterFor(session.sessionId)).toEqual([])
  })

  it('publishes an empty roster without a skill registry at all', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await new Promise(resolve => { setImmediate(resolve) })

    // No command registry and no skill registry compose here, so the bridge has
    // nothing to advertise and stays silent on this notification.
    expect(rosterFor(session.sessionId)).toEqual([])
    expect(harness.sessionUpdates.some(entry => entry.update.sessionUpdate === 'available_commands_update')).toBe(false)
  })

  it('contains a failing skill catalog without failing the session', async () => {
    // The command-survives-a-broken-provider case is unit-tested against a real
    // command registry in `updates.spec.ts`; over the wire what matters is that
    // an unreachable provider degrades the roster and nothing else.
    const { harness: h, registry } = await withSkills([
      { name: 'pdf-extract', description: 'Extract text from a PDF', invocation: { userInvocable: true, modelInvocable: true } },
    ])
    registry.failure = new Error('provider unreachable')
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await new Promise(resolve => { setImmediate(resolve) })

    expect(rosterFor(session.sessionId)).toEqual([])
    // The session is fully usable: the failure is a warn, not a broken session.
    await expect(h.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'still works' }],
    })).rejects.toThrow(/script exhausted/)
  })
})
