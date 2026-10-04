/**
 * Bridge from the user-questions answerer waterfall to the ACP permission
 * channel. ACP v1 has no free-text input request, so a question is
 * representable only as a single-choice menu: the bridge maps its options onto
 * one-shot `session/request_permission` options and answers with the chosen
 * label, and carries the question body on the rendered card's content blocks
 * and rawInput so the client shows what is being asked, not just the title. A plan-review intent maps the approve label to `allow_once` and every
 * other option to `reject_once`; without an intent every option is `allow_once`,
 * because the label, not the kind, carries the choice. Everything else —
 * multi-select, free text, unnamed options — delegates back to the waterfall,
 * whose no-answerer failure keeps unrepresentable questions honest.
 * @module @8kugames/dsh-zed-acp/questions
 */

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'

/** Why one question cannot become a permission menu. */
function unrepresentableReason(question: AskUserQuestionItem): string | undefined {
  if (question.options === undefined || question.options.length === 0) {
    return `question ${question.id} offers no options, and ACP cannot carry free-text answers`
  }
  if (question.multiSelect === true) {
    return `question ${question.id} allows multiple selections, which a permission menu cannot express`
  }
  const labels = new Set(question.options.map(option => option.label))
  if (labels.size !== question.options.length) {
    return `question ${question.id} has duplicate option labels, which would not round-trip as option ids`
  }
  return undefined
}

/** The synthesized tool-call identity the permission dialog renders for one question. */
function questionToolCallId(questionId: string): string {
  return `acp-question:${questionId}`
}

/** The card body text: the question, followed by its supporting detail when present. */
function questionText(question: AskUserQuestionItem): string {
  return question.detail === undefined ? question.question : `${question.question}\n\n${question.detail}`
}

/** Inputs the ACP connection owns; the bridge stays a pure protocol mapping. */
export interface AcpQuestionBridge {
  /** The ACP session id every permission request carries. */
  sessionId: string
  /** Await the ordered update queue, so the reviewed content renders before the dialog. */
  drainUpdates: () => Promise<void>
  /** One client permission round trip. */
  requestPermission: (params: RequestPermissionRequest, signal?: AbortSignal) => Promise<RequestPermissionResponse>
  /** Contained diagnostics for delegated (unrepresentable) requests. */
  warn: (message: string) => void
}

/**
 * Answer one owned user-questions request through the permission channel, or
 * delegate when any question is unrepresentable.
 * @param bridge - ACP connection inputs.
 * @param request - the pending user-questions request.
 * @param next - the waterfall delegate; called for unrepresentable requests.
 * @returns the answers in the request's question order.
 * @throws {UserQuestionError} `ASK_CANCELLED` when the user dismissed the
 *   dialog, or when the client answered with an unknown option id.
 */
export async function bridgeAcpQuestions(
  bridge: AcpQuestionBridge,
  request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>,
): Promise<AskUserQuestionAnswer> {
  const reasons = request.questions.map(unrepresentableReason).filter(reason => reason !== undefined)
  if (reasons.length > 0) {
    bridge.warn(`acp: delegating an unrepresentable user-questions request: ${reasons.join('; ')}`)
    return next()
  }
  await bridge.drainUpdates()
  const answers: AskUserQuestionAnswerItem[] = []
  for (const question of request.questions) {
    answers.push({ id: question.id, selected: [await askOne(bridge, request, question)] })
  }
  return { answers }
}

/** Run one question's permission round trip and read back its chosen label. */
async function askOne(
  bridge: AcpQuestionBridge,
  request: AskUserQuestionRequestEvent,
  question: AskUserQuestionItem,
): Promise<string> {
  const options = question.options ?? []
  const approve = question.intent?.approve
  const params: RequestPermissionRequest = {
    sessionId: bridge.sessionId,
    toolCall: {
      toolCallId: questionToolCallId(question.id),
      title: question.header ?? question.question,
      content: [{ type: 'content', content: { type: 'text', text: questionText(question) } }],
      rawInput: question,
    },
    options: options.map(option => ({
      optionId: option.label,
      name: option.label,
      kind: approve === undefined || option.label === approve ? 'allow_once' : 'reject_once',
    })),
  }
  // An aborted turn rejects this request; the answering service maps that
  // rejection onto its own `ASK_ABORTED` code, so rejections propagate as-is.
  const { outcome } = await bridge.requestPermission(params, request.signal)
  if (outcome.outcome === 'cancelled') {
    throw new UserQuestionError('the user dismissed the question', 'ASK_CANCELLED')
  }
  const chosen = options.find(option => option.label === outcome.optionId)
  if (chosen === undefined) {
    throw new UserQuestionError(
      `the client returned an unknown option id for question ${question.id}`,
      'ASK_FAILED',
    )
  }
  return chosen.label
}
