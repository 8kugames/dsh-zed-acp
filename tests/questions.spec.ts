import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP user-questions bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function questionHarness(): Promise<string> {
    harness = await makeBridgeHarness({ planMode: true, userQuestions: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    return sessionId
  }

  function planReviewQuestion(): AskUserQuestionItem {
    return {
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# The plan',
      options: [
        { label: 'Approve', description: 'Leave plan mode.' },
        { label: 'Keep planning', description: 'Stay in plan mode.' },
      ],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }
  }

  it('maps a plan review onto the permission channel and answers with the label', async () => {
    const sessionId = await questionHarness()
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = (request) => {
      expect(request.toolCall).toMatchObject({
        toolCallId: 'acp-question:plan-review',
        title: 'Plan review',
        content: [{ type: 'content', content: { type: 'text', text: 'Approve this plan and leave plan mode?\n\n# The plan' } }],
        rawInput: planReviewQuestion(),
      })
      expect(request.options).toEqual([
        { optionId: 'Approve', name: 'Approve', kind: 'allow_once' },
        { optionId: 'Keep planning', name: 'Keep planning', kind: 'reject_once' },
      ])
      return { outcome: { outcome: 'selected', optionId: 'Approve' } }
    }

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [planReviewQuestion()],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    expect(harness!.permissionRequests[0]?.sessionId).toBe(sessionId)
  })

  it('asks each question of a multi-question request in order', async () => {
    const sessionId = await questionHarness()
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = () => ({
      outcome: { outcome: 'selected', optionId: harness!.permissionRequests.length === 1 ? 'Alpha' : 'Beta' },
    })

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [
        { id: 'one', question: 'First?', options: [{ label: 'Alpha' }, { label: 'Other alpha' }] },
        { id: 'two', question: 'Second?', options: [{ label: 'Beta' }, { label: 'Other beta' }] },
      ],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'one', selected: ['Alpha'] }, { id: 'two', selected: ['Beta'] }] })
    expect(harness!.permissionRequests).toHaveLength(2)
  })

  it('raises the cancellation code the plan-review path expects', async () => {
    const sessionId = await questionHarness()
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = () => ({ outcome: { outcome: 'cancelled' } })

    await expect(harness!.ctx.userQuestions.ask({
      questions: [planReviewQuestion()],
      agent,
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
  })

  it('delegates free-text and multi-select questions to the waterfall', async () => {
    const sessionId = await questionHarness()
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!

    await expect(harness!.ctx.userQuestions.ask({
      questions: [{ id: 'text', question: 'Describe the change' }],
      agent,
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
    expect(harness!.permissionRequests).toHaveLength(0)

    await expect(harness!.ctx.userQuestions.ask({
      questions: [{
        id: 'multi',
        question: 'Pick many',
        options: [{ label: 'One' }, { label: 'Two' }],
        multiSelect: true,
      }],
      agent,
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
    expect(harness!.permissionRequests).toHaveLength(0)
  })

  it('delegates agent-less requests the bridge cannot attribute to a session', async () => {
    await questionHarness()

    await expect(harness!.ctx.userQuestions.ask({
      questions: [planReviewQuestion()],
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
    expect(harness!.permissionRequests).toHaveLength(0)
  })
})
