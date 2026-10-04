/**
 * Inclusive `session/fork`: the ACP whole-session default plus the
 * `jetbrains.air.fork` v1 message-point extension.
 *
 * ACP's own `session/fork` carries no fork point — it copies the source's whole
 * committed log into a new session id and leaves the source untouched. The
 * extension is what makes "branch from that reply" expressible: the request
 * carries `_meta.jetbrains.air.fork` naming one assistant message, and the new
 * session keeps that message and everything before it, dropping every later
 * event.
 *
 * The wire contract is byte-identical to openma-ai's `ACP_INCLUSIVE_FORK_CAPABILITY`
 * so the same client works against either adapter.
 *
 * A note on what the extension deliberately does *not* do: an unresolvable
 * fork point is `invalidParams`, never a silent whole-session copy. A client
 * that guessed an id wrong and silently received the entire conversation would
 * branch from the wrong place with no way to notice.
 * @module @8kugames/dsh-zed-acp/fork
 */

import { createHash } from 'node:crypto'
import { RequestError } from '@agentclientprotocol/sdk'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

/** The one `jetbrains.air.fork` contract version this adapter speaks. */
export const ACP_INCLUSIVE_FORK_VERSION = 1 as const

/** The capability block advertised in `agentCapabilities._meta`. */
export interface AcpInclusiveForkCapability {
  readonly version: typeof ACP_INCLUSIVE_FORK_VERSION
  /** The selected message is kept, not excluded. */
  readonly inclusive: true
}

export const ACP_INCLUSIVE_FORK_CAPABILITY: AcpInclusiveForkCapability = Object.freeze({
  version: ACP_INCLUSIVE_FORK_VERSION,
  inclusive: true,
})

/** `{ jetbrains: { air: { fork } } }`, to place in `agentCapabilities._meta`. */
export function acpInclusiveForkCapabilityMeta(): {
  jetbrains: { air: { fork: AcpInclusiveForkCapability } }
} {
  return { jetbrains: { air: { fork: ACP_INCLUSIVE_FORK_CAPABILITY } } }
}

/** One resolved inclusive-fork request. */
export interface JetbrainsAirForkRequest {
  /** The selected assistant message's ACP id, `<turn>:<step>`. */
  readonly messageId: string
  /** `sha256:<64 lowercase hex>` over the message's visible text, when the client sent one. */
  readonly messageFingerprint?: string
  /** 1-based disambiguator when several messages share one fingerprint; defaults to 1. */
  readonly messageOccurrence: number
}

const UNSUPPORTED_VERSION = 'Unsupported jetbrains.air.fork version'
const MESSAGE_ID_REQUIRED = 'jetbrains.air.fork messageId must be a non-empty string'
const FINGERPRINT_INVALID = 'jetbrains.air.fork messageFingerprint must match sha256:<64 lowercase hex>'
const OCCURRENCE_INVALID = 'jetbrains.air.fork messageOccurrence must be a positive safe integer'
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/
const SEGMENT_SUFFIX = /:segment:\d+$/

function invalid(detail: string, data?: unknown): RequestError {
  return RequestError.invalidParams(data, detail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read `_meta.jetbrains.air.fork`. Absent meta keeps the ACP whole-session
 * default; a present but unusable value is `invalidParams` and must not fall
 * back to that default.
 * @param meta - the request's `_meta` payload.
 * @returns the resolved request, or `undefined` for a whole-session fork.
 */
export function parseForkRequest(meta: unknown): JetbrainsAirForkRequest | undefined {
  if (!isRecord(meta)) return undefined
  const jetbrains = meta['jetbrains']
  if (jetbrains === undefined || !isRecord(jetbrains)) return undefined
  const air = jetbrains['air']
  if (air === undefined || !isRecord(air) || !Object.hasOwn(air, 'fork')) return undefined
  const fork = air['fork']
  if (!isRecord(fork) || fork['version'] !== ACP_INCLUSIVE_FORK_VERSION) {
    throw invalid(UNSUPPORTED_VERSION)
  }

  const rawId = fork['messageId']
  if (typeof rawId !== 'string' || rawId.trim().length === 0) throw invalid(MESSAGE_ID_REQUIRED)
  const messageId = rawId.trim()

  let messageFingerprint: string | undefined
  if (Object.hasOwn(fork, 'messageFingerprint')) {
    const value = fork['messageFingerprint']
    if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) throw invalid(FINGERPRINT_INVALID)
    messageFingerprint = value
  }

  let messageOccurrence = 1
  if (Object.hasOwn(fork, 'messageOccurrence')) {
    const value = fork['messageOccurrence']
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw invalid(OCCURRENCE_INVALID)
    }
    messageOccurrence = value
  }

  return {
    messageId,
    messageOccurrence,
    ...messageFingerprint === undefined ? {} : { messageFingerprint },
  }
}

/** `sha256:` plus the SHA-256 of one assistant message's visible text. */
export function assistantMessageFingerprint(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * The text a client sees for one assistant message, and therefore the text its
 * fingerprint is computed over: `agent_message_chunk` content in order. Thoughts
 * and tool calls are not part of it; an image block contributes a fixed
 * placeholder so two messages differing only in image count hash differently.
 * ponytail: the placeholder is not a client contract — a client that
 * fingerprints its own rendered text must use this exact rule. A versioned
 * fingerprint scheme would be the upgrade path.
 * @param message - the raw committed assistant message.
 * @returns the visible text.
 */
export function visibleAssistantText(message: unknown): string {
  const texts: string[] = []
  const content = isRecord(message) ? message['content'] : undefined
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      const type = block['type']
      if (type === 'text' && typeof block['text'] === 'string') texts.push(block['text'])
      else if (type === 'image') texts.push('[image attachment]')
    }
  }
  return texts.join('')
}

/** The `<turn>:<step>` ACP id clients receive as a chunk's `messageId`. */
function assistantMessageId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const { turn, step } = data
  if ((typeof turn !== 'number' && typeof turn !== 'string') || (typeof step !== 'number' && typeof step !== 'string')) {
    return undefined
  }
  return `${String(turn)}:${String(step)}`
}

/** A selectable assistant message in the source log. */
interface AssistantHit {
  /** The message's own event seq — the inclusive fork boundary. */
  readonly seq: SessionSeq
  readonly messageId: string
  readonly fingerprint: string
}

/** Top-level persisted assistant messages, in log order. Child sessions are separate logs. */
function assistantHits(events: readonly SessionEvent[]): AssistantHit[] {
  const hits: AssistantHit[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const messageId = assistantMessageId(event.data)
    if (messageId === undefined) continue
    hits.push({
      seq: event.seq,
      messageId,
      fingerprint: assistantMessageFingerprint(visibleAssistantText(event.data.message)),
    })
  }
  return hits
}

/**
 * A client may name a message by the id of one of its streamed segments
 * (`<turn>:<step>:segment:<n>`); the whole message is selected by the prefix.
 */
function candidateIds(messageId: string): string[] {
  const ids = [messageId]
  if (!SEGMENT_SUFFIX.test(messageId)) return ids
  const stripped = messageId.replace(SEGMENT_SUFFIX, '')
  if (stripped.length > 0) ids.push(stripped)
  return ids
}

/**
 * Locate the inclusive fork boundary. An id hit whose fingerprint disagrees is
 * treated as a miss, so a client whose counter was reused cannot silently
 * branch from a different message; a client that sent only a fingerprint falls
 * back to matching on it alone, disambiguated by `messageOccurrence`.
 * @param events - the source session's complete persisted log.
 * @param request - the resolved inclusive-fork request.
 * @param sessionId - the source session id, for the failure message.
 * @returns the selected message's event seq.
 */
export function locateForkBoundary(
  events: readonly SessionEvent[],
  request: JetbrainsAirForkRequest,
  sessionId: string,
): SessionSeq {
  const hits = assistantHits(events)
  for (const candidate of candidateIds(request.messageId)) {
    const found = hits.find(hit => hit.messageId === candidate)
    if (found !== undefined && (request.messageFingerprint === undefined || found.fingerprint === request.messageFingerprint)) {
      return found.seq
    }
  }

  if (request.messageFingerprint !== undefined) {
    const matches = hits.filter(hit => hit.fingerprint === request.messageFingerprint)
    const chosen = matches.length === 1 ? matches[0] : matches[request.messageOccurrence - 1]
    if (chosen !== undefined) return chosen.seq
  }

  throw invalid(
    `Fork point message ${request.messageId} was not found in session ${sessionId}`,
    { messageId: request.messageId },
  )
}

function isToolCallBlock(block: unknown): boolean {
  return isRecord(block) && block['type'] === 'tool-call'
}

/**
 * Copy the log through the selected message, dropping the tool calls *on that
 * message only*. Their results are committed after it, so a copied call
 * without its result is an illegal transcript and would make the child's
 * `session/load` replay run past the fork point. Earlier calls and results stay.
 * The source array is never mutated.
 * @param events - the source session's complete persisted log.
 * @param boundary - the selected assistant message's event seq.
 * @returns the prefix through `boundary`, tool-call-free at the boundary.
 */
export function inclusiveHistoryPrefix(events: readonly SessionEvent[], boundary: SessionSeq): SessionEvent[] {
  const index = events.findIndex(event => event.seq === boundary)
  if (index < 0) return events.slice()
  const target = events[index]
  const prefix = events.slice(0, index + 1)
  if (target === undefined || target.type !== 'assistant/message') return prefix
  const message = target.data.message
  if (!Array.isArray(message.content) || !message.content.some(isToolCallBlock)) return prefix

  const cloned = structuredClone(target)
  if (cloned.type !== 'assistant/message') return prefix
  // Rebuild rather than mutate: committed events are frozen snapshots, and the
  // source array itself stays untouched either way.
  prefix[index] = {
    ...cloned,
    data: {
      ...cloned.data,
      message: {
        ...cloned.data.message,
        content: cloned.data.message.content.filter(block => !isToolCallBlock(block)),
      },
    },
  }
  return prefix
}
