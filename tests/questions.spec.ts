import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type InitializeRequest } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP user-questions bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function questionHarness(clientCapabilities: InitializeRequest['clientCapabilities'] = {}): Promise<string> {
    harness = await makeBridgeHarness({ planMode: true, userQuestions: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities })
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

  it('appends an Other escape that collects free text through a form elicitation', async () => {
    const sessionId = await questionHarness({ elicitation: { form: {} } })
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = (request) => {
      expect(request.options).toEqual([
        { optionId: 'Alpha', name: 'Alpha', kind: 'allow_once' },
        { optionId: 'Beta', name: 'Beta', kind: 'allow_once' },
        { optionId: 'Other', name: 'Other', kind: 'allow_once' },
      ])
      return { outcome: { outcome: 'selected', optionId: 'Other' } }
    }
    harness!.onElicitation = (request) => {
      expect(request).toMatchObject({
        sessionId,
        toolCallId: 'acp-question:pick',
        mode: 'form',
        message: 'Which one?',
        requestedSchema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'string', title: 'Which one?' } },
        },
      })
      return { action: 'accept', content: { answer: '  none of these, do X instead  ' } }
    }

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [{ id: 'pick', question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'pick', selected: ['Other'], custom: '  none of these, do X instead  ' }] })
    expect(harness!.permissionRequests).toHaveLength(1)
    expect(harness!.elicitationRequests).toHaveLength(1)
  })

  it('returns to the menu when the user backs out of typing', async () => {
    const sessionId = await questionHarness({ elicitation: { form: {} } })
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = () => ({
      outcome: { outcome: 'selected', optionId: harness!.permissionRequests.length === 1 ? 'Other' : 'Alpha' },
    })
    harness!.onElicitation = () => ({ action: 'decline' })

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [{ id: 'pick', question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'pick', selected: ['Alpha'] }] })
    expect(harness!.permissionRequests).toHaveLength(2)
    expect(harness!.elicitationRequests).toHaveLength(1)
  })

  it('turns an option-less question into a free-text form when the client supports it', async () => {
    const sessionId = await questionHarness({ elicitation: { form: {} } })
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onElicitation = () => ({ action: 'accept', content: { answer: 'make the flip green' } })

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [{ id: 'text', question: 'Describe the change' }],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'text', selected: ['Other'], custom: 'make the flip green' }] })
    expect(harness!.permissionRequests).toHaveLength(0)
    expect(harness!.elicitationRequests).toHaveLength(1)
  })

  it('maps dismissing the free-text form of an option-less question to cancellation', async () => {
    const sessionId = await questionHarness({ elicitation: { form: {} } })
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onElicitation = () => ({ action: 'cancel' })

    await expect(harness!.ctx.userQuestions.ask({
      questions: [{ id: 'text', question: 'Describe the change' }],
      agent,
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    expect(harness!.permissionRequests).toHaveLength(0)
    expect(harness!.elicitationRequests).toHaveLength(1)
  })

  it('does not append a second Other but still routes that label to the form', async () => {
    const sessionId = await questionHarness({ elicitation: { form: {} } })
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = (request) => {
      expect(request.options).toHaveLength(2)
      return { outcome: { outcome: 'selected', optionId: 'Other' } }
    }
    harness!.onElicitation = () => ({ action: 'accept', content: { answer: 'custom path' } })

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [{ id: 'pick', question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Other' }] }],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'pick', selected: ['Other'], custom: 'custom path' }] })
    expect(harness!.permissionRequests).toHaveLength(1)
    expect(harness!.elicitationRequests).toHaveLength(1)
  })

  it('answers a model-provided Other as a plain label when the client cannot collect free text', async () => {
    const sessionId = await questionHarness()
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'Other' } })

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [{ id: 'pick', question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Other' }] }],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'pick', selected: ['Other'] }] })
    expect(harness!.permissionRequests).toHaveLength(1)
    expect(harness!.elicitationRequests).toHaveLength(0)
  })

  it('presents the plan-review escape as an allow option and carries its free text', async () => {
    const sessionId = await questionHarness({ elicitation: { form: {} } })
    const agent = harness!.ctx.agents.get(SessionId(sessionId))!
    harness!.onPermission = (request) => {
      expect(request.options).toEqual([
        { optionId: 'Approve', name: 'Approve', kind: 'allow_once' },
        { optionId: 'Keep planning', name: 'Keep planning', kind: 'reject_once' },
        { optionId: 'Other', name: 'Other', kind: 'allow_once' },
      ])
      return { outcome: { outcome: 'selected', optionId: 'Other' } }
    }
    harness!.onElicitation = () => ({ action: 'accept', content: { answer: 'approve once the retry loop is gone' } })

    const answer = await harness!.ctx.userQuestions.ask({
      questions: [planReviewQuestion()],
      agent,
    })
    expect(answer).toEqual({ answers: [{ id: 'plan-review', selected: ['Other'], custom: 'approve once the retry loop is gone' }] })
    expect(harness!.permissionRequests).toHaveLength(1)
    expect(harness!.elicitationRequests).toHaveLength(1)
  })
})
