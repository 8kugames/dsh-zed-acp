/**
 * Bridge from the user-questions answerer waterfall to the ACP permission
 * channel. A question is representable as a single-choice permission menu: the
 * bridge maps its options onto one-shot `session/request_permission` options
 * and answers with the chosen label, and carries the question body on the
 * rendered card's content blocks and rawInput so the client shows what is being
 * asked, not just the title. A plan-review intent maps the approve label to
 * `allow_once` and every other option to `reject_once`; without an intent every
 * option is `allow_once`, because the label, not the kind, carries the choice.
 *
 * When the client advertises form elicitation, every menu gains a synthesized
 * `Other` escape (unless the question already offers that label): picking it
 * opens an `elicitation/create` form that collects free text, answered as the
 * `Other` label plus the `custom` text, so a question whose listed options all
 * miss the user's intent never locks them in — a model-provided `Other` label
 * routes to the same form. A question with no options at all becomes a pure
 * free-text form instead of delegating. Without that capability the menu stays
 * option-only and option-less questions delegate to the waterfall, whose
 * no-answerer failure keeps them honest. Multi-select and duplicate-label
 * questions delegate in every case: a permission menu cannot express either.
 * @module @8kugames/dsh-zed-acp/questions
 */

import type { CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'

/** The synthesized escape option appended when the client can collect free text. */
const OTHER_OPTION: AskUserQuestionOption = { label: 'Other', description: 'Type your own answer instead' }

/** The single free-text field of the elicitation form. */
const FREE_TEXT_FIELD = 'answer'

/** Why one question cannot become a permission menu (or a free-text form). */
function unrepresentableReason(question: AskUserQuestionItem, freeTextInput: boolean): string | undefined {
  if (question.multiSelect === true) {
    return `question ${question.id} allows multiple selections, which a permission menu cannot express`
  }
  const options = question.options ?? []
  const labels = new Set(options.map(option => option.label))
  if (labels.size !== options.length) {
    return `question ${question.id} has duplicate option labels, which would not round-trip as option ids`
  }
  if (!freeTextInput && options.length === 0) {
    return `question ${question.id} offers no options, and the client cannot collect free text`
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

/** One question's settled choice: the picked label plus optional free text. */
interface QuestionChoice {
  label: string
  custom?: string
}

/** Inputs the ACP connection owns; the bridge stays a pure protocol mapping. */
export interface AcpQuestionBridge {
  /** The ACP session id every permission request carries. */
  sessionId: string
  /** Whether the client advertises form elicitation and the bridge may collect free text. */
  freeTextInput: boolean
  /** Await the ordered update queue, so the reviewed content renders before the dialog. */
  drainUpdates: () => Promise<void>
  /** One client permission round trip. */
  requestPermission: (params: RequestPermissionRequest, signal?: AbortSignal) => Promise<RequestPermissionResponse>
  /** One client form-elicitation round trip; consulted only when {@link AcpQuestionBridge.freeTextInput} holds. */
  elicitFreeText: (params: CreateElicitationRequest, signal?: AbortSignal) => Promise<CreateElicitationResponse>
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
  const reasons = request.questions
    .map(question => unrepresentableReason(question, bridge.freeTextInput))
    .filter(reason => reason !== undefined)
  if (reasons.length > 0) {
    bridge.warn(`acp: delegating an unrepresentable user-questions request: ${reasons.join('; ')}`)
    return next()
  }
  await bridge.drainUpdates()
  const answers: AskUserQuestionAnswerItem[] = []
  for (const question of request.questions) {
    const { label, custom } = await askOne(bridge, request, question)
    answers.push(custom === undefined ? { id: question.id, selected: [label] } : { id: question.id, selected: [label], custom })
  }
  return { answers }
}

/** Run one question's round trip and read back its chosen label and optional free text. */
async function askOne(
  bridge: AcpQuestionBridge,
  request: AskUserQuestionRequestEvent,
  question: AskUserQuestionItem,
): Promise<QuestionChoice> {
  const options = question.options ?? []
  if (options.length === 0) {
    // Free-text-only question: the form itself is the question, so backing out
    // of it is dismissing the question.
    const choice = await elicitChoice(bridge, request, question)
    if (choice === undefined) {
      throw new UserQuestionError('the user dismissed the question', 'ASK_CANCELLED')
    }
    return choice
  }
  const menu = bridge.freeTextInput && !options.some(option => option.label === OTHER_OPTION.label)
    ? [...options, OTHER_OPTION]
    : options
  for (;;) {
    const chosen = await offerMenu(bridge, request, question, menu)
    // On a client without form elicitation a model-provided `Other` is just a
    // label: answering it must stay the plain menu answer it always was.
    if (chosen !== OTHER_OPTION.label || !bridge.freeTextInput) return { label: chosen }
    // Backing out of typing returns to the listed options.
    const choice = await elicitChoice(bridge, request, question)
    if (choice !== undefined) return choice
  }
}

/** Show one question's permission menu and read back its chosen label. */
async function offerMenu(
  bridge: AcpQuestionBridge,
  request: AskUserQuestionRequestEvent,
  question: AskUserQuestionItem,
  options: AskUserQuestionOption[],
): Promise<string> {
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
      // The synthesized escape is never a rejection; a model-provided Other
      // (a distinct object) still follows the intent mapping.
      kind: option === OTHER_OPTION || approve === undefined || option.label === approve ? 'allow_once' : 'reject_once',
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

/**
 * Collect free text for one question through a form elicitation. Backing out
 * (declining, cancelling, or accepting empty) yields `undefined`; the caller
 * decides whether that returns to the menu or dismisses the question.
 */
async function elicitChoice(
  bridge: AcpQuestionBridge,
  request: AskUserQuestionRequestEvent,
  question: AskUserQuestionItem,
): Promise<QuestionChoice | undefined> {
  const params: CreateElicitationRequest = {
    sessionId: bridge.sessionId,
    toolCallId: questionToolCallId(question.id),
    mode: 'form',
    message: questionText(question),
    requestedSchema: {
      type: 'object',
      properties: {
        [FREE_TEXT_FIELD]: {
          type: 'string',
          title: question.header ?? question.question,
          description: OTHER_OPTION.description,
        },
      },
      required: [FREE_TEXT_FIELD],
    },
  }
  const response = await bridge.elicitFreeText(params, request.signal)
  // The response union folds custom future actions into an index-signature
  // member, so `content` needs this narrowing cast to read at all.
  const raw = response.action === 'accept'
    ? (response as { content?: { [key: string]: unknown } }).content?.[FREE_TEXT_FIELD]
    : undefined
  const text = typeof raw === 'string' ? raw : undefined
  if (text !== undefined && text.trim().length > 0) {
    return { label: OTHER_OPTION.label, custom: text }
  }
  return undefined
}
