import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import {
  DESCENDANT_ACTIVITY_TITLE,
  DESCENDANT_STALL_WARN_MS,
  assistantUpdates,
  availableCommandsUpdate,
  currentModeUpdate,
  descendantActivityOpen,
  descendantActivityProgress,
  descendantActivitySettle,
  descendantActivityTitle,
  descendantProgressText,
  sessionTitleUpdate,
  todoPlanUpdate,
  toolCallUpdate,
  toolResultUpdate,
  turnEndToFate,
} from '../src/updates.ts'

/** Minimal committed assistant event for pure update projection tests. */
function assistantEvent(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  usage?: SessionEvent<'assistant/message'>['data']['usage'],
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: MessageId('message-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content,
      },
      ...usage === undefined ? {} : { usage },
    },
  }
}

describe('descendant activity card projection', () => {
  it('opens generic, patches the learned title, and keeps live patches status-less', () => {
    expect(descendantActivityOpen('dsh-subagent-a-1', undefined).title).toBe(DESCENDANT_ACTIVITY_TITLE)
    expect(descendantActivityOpen('dsh-subagent-a-1', 'Audit the parser').title).toBe('Audit the parser')
    const title = descendantActivityTitle('dsh-subagent-a-1', 'Audit the parser')
    expect(title.title).toBe('Audit the parser')
    expect(title.status).toBeUndefined()
    const progress = descendantActivityProgress('dsh-subagent-a-1', 'body')
    expect(progress.status).toBeUndefined()
    expect(progress.content).toEqual([{ type: 'content', content: { type: 'text', text: 'body' } }])
  })

  it('settles with fate and summary, defaulting to a bare completed', () => {
    expect(descendantActivitySettle('dsh-subagent-a-1')).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'dsh-subagent-a-1',
      status: 'completed',
    })
    const failed = descendantActivitySettle('dsh-subagent-a-1', 'failed', 'boom')
    expect(failed.status).toBe('failed')
    const block = failed.content?.[0]
    expect(block).toMatchObject({ type: 'content', content: { type: 'text', text: 'boom' } })
  })

  it('renders activity, usage, and the stall warning only past the threshold', () => {
    const active = descendantProgressText({
      activity: 'npm test',
      elapsedMs: 134_000,
      silentMs: 1_000,
      inputTokens: 1_100,
      outputTokens: 50,
    })
    expect(active).toContain('`npm test`')
    expect(active).toContain('elapsed 2m 14s')
    expect(active).toContain('in 1.1k')
    expect(active).toContain('out 50')
    expect(active).not.toContain('stalled')
    const stalled = descendantProgressText({
      activity: undefined,
      elapsedMs: 0,
      silentMs: DESCENDANT_STALL_WARN_MS + 1,
      inputTokens: undefined,
      outputTokens: undefined,
    })
    expect(stalled).toContain('_working…_')
    expect(stalled).toContain('stalled')
    expect(stalled).not.toContain('in ')
  })

  it('keeps the activity code span intact when the activity itself contains backticks', () => {
    const rendered = descendantProgressText({
      activity: 'echo `date`',
      elapsedMs: 1_000,
      silentMs: 0,
      inputTokens: undefined,
      outputTokens: undefined,
    })
    expect(rendered.startsWith('`` ')).toBe(true)
    expect(rendered).toContain('echo `date`')
  })

  it('maps turn-end kinds to delegated fate', () => {
    for (const kind of ['completed', 'max-tokens', 'forked']) expect(turnEndToFate(kind)).toBe('completed')
    for (const kind of ['interrupted', 'aborted', 'blocked', 'error']) expect(turnEndToFate(kind)).toBe('failed')
  })
})

describe('standard ACP update projection', () => {
  /** Minimal committed tool-call event for pure update projection tests. */
  function callEvent(name: string, callArguments: string): SessionEvent<'tool/call'> {
    return {
      type: 'tool/call',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name, arguments: callArguments },
    }
  }

  /** Minimal committed tool-result event for completion-projection tests. */
  function resultEvent(
    toolCallId: string,
    content: SessionEvent<'tool/result'>['data']['message']['content'],
    isError = false,
  ): SessionEvent<'tool/result'> {
    return {
      type: 'tool/result',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('tool-message'),
          role: 'tool',
          toolCallId: ToolCallId(toolCallId),
          isError,
          source: { kind: 'tool', callId: ToolCallId(toolCallId) },
          content,
        },
      },
    }
  }

  it('omits empty reasoning, unsupported assistant blocks, and absent usage', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: ToolCallId('call-hidden'), name: 'hidden', arguments: '{}' },
    ])

    await expect(assistantUpdates(ctx, session, event)).resolves.toEqual([])
  })

  it('requires both measured usage and context capacity', async () => {
    const meter = { measure: vi.fn(() => ({ totalTokens: 7 })) }
    const withMeter = { get: (name: string) => name === 'tokenMeter' ? meter : undefined } as unknown as Context
    const withoutMeter = { get: () => undefined } as unknown as Context
    const withCapacity = { requestContext: () => ({ contextWindow: 100 }) } as unknown as Session
    const withoutCapacity = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([{ type: 'text', text: 'done' }], { inputTokens: 1, outputTokens: 1 })

    expect((await assistantUpdates(withMeter, withoutCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect((await assistantUpdates(withoutMeter, withCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect(meter.measure).not.toHaveBeenCalled()
  })

  it('preserves malformed tool input and projects a failed result without hidden content', async () => {
    const call = toolCallUpdate({
      type: 'tool/call',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 1, step: 1, callId: ToolCallId('call-bad'), name: 'broken', arguments: '{' },
    })
    const result = await toolResultUpdate({ get: () => undefined } as unknown as Context, {
      type: 'tool/result',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('tool-message'),
          role: 'tool',
          toolCallId: ToolCallId('call-bad'),
          isError: true,
          source: { kind: 'tool', callId: ToolCallId('call-bad') },
          content: [{ type: 'reasoning', text: 'hidden' }],
        },
      },
    })

    expect(call).toMatchObject({ rawInput: '{' })
    expect(result).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-bad',
      status: 'failed',
      content: [],
    }])
  })

  it('titles a terminal call with its one-line command and falls back to the tool name otherwise', () => {
    expect(toolCallUpdate(callEvent('bash', JSON.stringify({ command: 'git status --short' })))).toMatchObject({
      title: 'git status --short',
      kind: 'execute',
      rawInput: { command: 'git status --short' },
    })

    const multiline = 'echo one\n  echo two'
    expect(toolCallUpdate(callEvent('pwsh', JSON.stringify({ command: multiline }))))
      .toMatchObject({ title: 'echo one echo two' })

    const long = `printf ${'x'.repeat(300)}`
    const titled = toolCallUpdate(callEvent('bash', JSON.stringify({ command: long })))
    const longTitle = titled.sessionUpdate === 'tool_call' && typeof titled.title === 'string' ? titled.title : ''
    expect(longTitle.length).toBeLessThanOrEqual(200)
    expect(longTitle.endsWith('…')).toBe(true)

    expect(toolCallUpdate(callEvent('read', JSON.stringify({ path: 'a.ts' })))).toMatchObject({ title: 'read' })
    expect(toolCallUpdate(callEvent('broken', '{'))).toMatchObject({ title: 'broken' })
  })

  it('titles known calls from their salient argument vocabulary and kinds background jobs', () => {
    expect(toolCallUpdate(callEvent('grep', JSON.stringify({ pattern: 'seed', path: 'src' }))))
      .toMatchObject({ title: 'seed', kind: 'search' })
    expect(toolCallUpdate(callEvent('web_fetch', JSON.stringify({ url: 'https://zed.dev' }))))
      .toMatchObject({ title: 'https://zed.dev', kind: 'fetch' })
    expect(toolCallUpdate(callEvent('web_search', JSON.stringify({ queries: ['acp tool calls', 'zed'] }))))
      .toMatchObject({ title: 'acp tool calls, zed', kind: 'fetch' })
    expect(toolCallUpdate(callEvent('read', JSON.stringify({ file_path: 'src/session.ts', offset: 5 }))))
      .toMatchObject({ title: 'src/session.ts', kind: 'read' })
    expect(toolCallUpdate(callEvent('edit', JSON.stringify({ file_path: 'src/session.ts', old_string: 'a', new_string: 'b' }))))
      .toMatchObject({ title: 'src/session.ts', kind: 'edit' })
    expect(toolCallUpdate(callEvent('subagent', JSON.stringify({ description: 'Audit the projection', prompt: '...' }))))
      .toMatchObject({ title: 'Audit the projection', kind: 'other' })
    expect(toolCallUpdate(callEvent('job_kill', JSON.stringify({ job_id: 'job-7' }))))
      .toMatchObject({ title: 'job_kill', kind: 'execute' })
    expect(toolCallUpdate(callEvent('job_output', JSON.stringify({ job_id: 'job-7' }))))
      .toMatchObject({ title: 'job_output', kind: 'read' })
  })
  it('titles the reserved run_code PTC transport from its code body, not its description', () => {
    // The run_code schema is { code: <async-fn body>, description: <summary> };
    // the description is a prose label the model writes for the user, while
    // code is the executed body the tool kinds=execute category ("Run Command"
    // in Zed) should surface in the title strip. Listing code ahead of
    // description in SALIENT_TITLE_FIELDS keeps the rendered title aligned
    // with what the kind icon says the call is doing.
    const body = 'const { execSync } = await import("node:child_process");\n'
      + 'return execSync("git status --short", { encoding: "utf-8" })'
    expect(toolCallUpdate(callEvent('run_code', JSON.stringify({
      code: body,
      description: 'Audit the projection',
    })))).toMatchObject({
      title: body.replace(/\s+/g, ' ').trim(),
      kind: 'execute',
    })

    // Fallback contract still holds: when no salient field exists the tool
    // name becomes the title, so a run_code call without description stays
    // unambiguous in the strip.
    expect(toolCallUpdate(callEvent('run_code', JSON.stringify({ code: body }))))
      .toMatchObject({ title: body.replace(/\s+/g, ' ').trim(), kind: 'execute' })
  })

  it('attaches follow-along locations from file-shaped arguments', () => {
    expect(toolCallUpdate(callEvent('read', JSON.stringify({ file_path: 'src/session.ts', offset: 5 }))))
      .toMatchObject({ locations: [{ path: 'src/session.ts' }] })
    // First probe key wins when several are present.
    expect(toolCallUpdate(callEvent('edit', JSON.stringify({ path: 'a.ts', file_path: 'b.ts' }))))
      .toMatchObject({ locations: [{ path: 'a.ts' }] })
    // A url is not a location; calls without a file argument carry none.
    expect(toolCallUpdate(callEvent('web_fetch', JSON.stringify({ url: 'https://zed.dev' }))))
      .not.toHaveProperty('locations')
    expect(toolCallUpdate(callEvent('bash', JSON.stringify({ command: 'ls' }))))
      .not.toHaveProperty('locations')
  })

  it('replays locations on the completing update of a plain content result', async () => {
    const result = await toolResultUpdate(
      { get: () => undefined } as unknown as Context,
      resultEvent('call-read', [{ type: 'text', text: 'body' }]),
      { terminal: false, locations: [{ path: 'src/updates.ts' }] },
    )
    expect(result).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'body' } }],
      locations: [{ path: 'src/updates.ts' }],
    }])
  })

  it('embeds a display terminal on execute calls only when the client advertised it', () => {
    const terminal = { enabled: true, cwd: '/work/repo' }
    const embedded = toolCallUpdate(callEvent('bash', JSON.stringify({ command: 'ls' })), terminal)
    expect(embedded).toMatchObject({
      content: [{ type: 'terminal', terminalId: 'call-1' }],
      _meta: { terminal_info: { terminal_id: 'call-1', cwd: '/work/repo' } },
    })
    // Non-execute kinds never take the terminal even with the capability.
    const read = toolCallUpdate(callEvent('read', JSON.stringify({ file_path: 'a.ts' })), terminal)
    expect(read).not.toHaveProperty('content')
    expect(read).not.toHaveProperty('_meta')
    // Without the capability nothing changes for any kind.
    const plain = toolCallUpdate(callEvent('bash', JSON.stringify({ command: 'ls' })), { enabled: false, cwd: '/work' })
    expect(plain).not.toHaveProperty('content')
    expect(plain).not.toHaveProperty('_meta')
  })

  it('omits cwd from terminal_info when the session has none', () => {
    const embedded = toolCallUpdate(
      callEvent('bash', JSON.stringify({ command: 'ls' })),
      { enabled: true, cwd: undefined },
    )
    expect(embedded).toMatchObject({ _meta: { terminal_info: { terminal_id: 'call-1' } } })
    expect(embedded._meta).not.toHaveProperty('cwd')
  })

  it('settles a terminal call by streaming output then exiting with a synthesized code', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const call = { terminal: true, locations: undefined }
    const settled = await toolResultUpdate(ctx, resultEvent('call-1', [{ type: 'text', text: 'total 0' }]), call)
    expect(settled).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        _meta: { terminal_output: { terminal_id: 'call-1', data: 'total 0' } },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { output: 'total 0', isError: false },
        _meta: { terminal_exit: { terminal_id: 'call-1', exit_code: 0, signal: null } },
      },
    ])

    // Empty output settles without a data payload; failure exits 1 and flags error.
    const failed = await toolResultUpdate(
      ctx,
      resultEvent('call-1', [], true),
      { terminal: true, locations: undefined },
    )
    expect(failed).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      rawOutput: { output: '', isError: true },
      _meta: { terminal_exit: { terminal_id: 'call-1', exit_code: 1, signal: null } },
    }])
  })

  it('projects the whole todo snapshot as the plan with medium priority', () => {
    const event: SessionEvent<'todo/write'> = {
      type: 'todo/write',
      seq: SessionSeq(0),
      time: 0,
      data: {
        todos: [
          { content: 'Survey the seam ledger', status: 'completed' },
          { content: 'Project the new updates', status: 'in_progress' },
          { content: 'Run the review', status: 'pending' },
          // Malformed entries are dropped rather than surfaced empty.
          { content: '', status: 'pending' },
          { status: 'pending' } as unknown as TodoItem,
        ],
      },
    }
    expect(todoPlanUpdate(event)).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Survey the seam ledger', priority: 'medium', status: 'completed' },
        { content: 'Project the new updates', priority: 'medium', status: 'in_progress' },
        { content: 'Run the review', priority: 'medium', status: 'pending' },
      ],
    })

    // An unrecognized status degrades to pending instead of fabricating a lifecycle.
    const drifted: SessionEvent<'todo/write'> = {
      type: 'todo/write',
      seq: SessionSeq(1),
      time: 0,
      data: { todos: [{ content: 'Drifted entry', status: 'blocked' as unknown as 'pending' }] },
    }
    expect(todoPlanUpdate(drifted)).toMatchObject({ entries: [{ status: 'pending' }] })
  })

  it('projects a committed title as the session-info update', () => {
    const event: SessionEvent<'session/title'> = {
      type: 'session/title',
      seq: SessionSeq(0),
      time: 0,
      data: { title: 'Fix the flaky bridge test', messageSeqs: [], source: { kind: 'fallback' } },
    }
    expect(sessionTitleUpdate(event)).toEqual({ sessionUpdate: 'session_info_update', title: 'Fix the flaky bridge test' })
  })

  it('lists effective commands one-to-one and dedupes shadowed names', async () => {
    const agent = {} as Agent
    const commands = {
      list: () => [
        { name: 'init', description: 'Scaffold a workspace' },
        { name: 'plan', description: 'Switch to plan mode', input: { hint: 'goal for the plan' } },
        // A scoped shadow carrying the same name keeps only the first listing.
        { name: 'init', description: 'Shadowed duplicate' },
      ],
    }
    const warn = (): void => { throw new Error('the command path must not warn') }
    expect(await availableCommandsUpdate(commands, undefined, agent, '/tmp/project', warn)).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'init', description: 'Scaffold a workspace' },
        { name: 'plan', description: 'Switch to plan mode', input: { hint: 'goal for the plan' } },
      ],
    })
    // Without a composed registry there is nothing to publish.
    expect(await availableCommandsUpdate(undefined, undefined, agent, '/tmp/project', warn)).toBeUndefined()
  })

  it('appends user-invocable skills after commands and yields names to the host registry', async () => {
    const agent = {} as Agent
    const commands = { list: () => [{ name: 'plan', description: 'Switch to plan mode' }] }
    const skills = {
      list: async () => [
        { name: 'pdf', description: 'Extract PDF text', invocation: { userInvocable: true, modelInvocable: false } },
        { name: 'internal', description: 'Model-only', invocation: { userInvocable: false, modelInvocable: true } },
        // A skill colliding with a real command never displaces the command.
        { name: 'plan', description: 'Skill shadow', invocation: { userInvocable: true, modelInvocable: true } },
      ],
    }
    const warn = (): void => { throw new Error('a healthy catalog must not warn') }
    expect(await availableCommandsUpdate(commands, skills, agent, '/tmp/project', warn)).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'plan', description: 'Switch to plan mode' },
        { name: 'pdf', description: 'Extract PDF text', input: { hint: 'instructions for the skill' } },
      ],
    })
  })

  it('keeps the command roster when the skill catalog read fails', async () => {
    const agent = {} as Agent
    const commands = { list: () => [{ name: 'init', description: 'Scaffold a workspace' }] }
    const warnings: string[] = []
    const update = await availableCommandsUpdate(
      commands,
      { list: async () => { throw new Error('provider unreachable') } },
      agent,
      '/tmp/project',
      (message) => { warnings.push(message) },
    )
    expect(update).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'init', description: 'Scaffold a workspace' }],
    })
    expect(warnings).toEqual(['acp: skill catalog read failed: provider unreachable'])
  })

  it('projects committed plan-mode switches onto the advertised mode ids', () => {
    const active: SessionEvent<'plan/mode'> = {
      type: 'plan/mode',
      seq: SessionSeq(0),
      time: 0,
      data: { active: true },
    }
    expect(currentModeUpdate(active)).toEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    const idle: SessionEvent<'plan/mode'> = { ...active, data: { active: false } }
    expect(currentModeUpdate(idle)).toEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'default' })
  })
})
