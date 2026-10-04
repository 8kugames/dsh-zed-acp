/**
 * `_session/steering`: inject a follow-up into a turn that is already running.
 *
 * This is a namespaced ACP extension, not a standard method, so it follows the
 * extensibility rules: advertise support in `initialize` `_meta`, name the
 * custom request with a leading underscore, and send nothing on the standard
 * path that an ordinary client depends on. A client that never calls
 * `_session/steering` is unaffected — `session/prompt` and `session/cancel`
 * carry the whole standard contract.
 *
 * The outcome vocabulary is deliberately two-valued:
 *
 * - `injected` — the message joined the running turn and the client keeps
 *   whatever `session/prompt` request it already has open. The bridge never
 *   opens a prompt request of its own, so the turn's stop reason and output
 *   stream still belong to the request the client made.
 * - `promptRequired` with `reason: 'noRunningTurn'` — nothing was running to
 *   join. The client sends an ordinary `session/prompt` instead.
 *
 * ponytail: `idleBehavior` is accepted and validated for forward
 * compatibility but only `promptRequired` is honored, because promoting an
 * idle session into a turn would mean starting work no ACP request is waiting
 * on — with no owner for its stop reason, cost accounting, or output stream. A
 * future `idleBehavior: 'autoPrompt'` would need that owner first.
 * @module @8kugames/dsh-zed-acp/steering
 */

import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk'

/** The custom JSON-RPC method name, underscore-prefixed per the extension rules. */
export const ACP_STEERING_METHOD = '_session/steering'

/** `{ steering: { supported: true } }`, to place in `agentCapabilities._meta`. */
export function acpSteeringCapabilityMeta(): { steering: { supported: true } } {
  return { steering: { supported: true } }
}

/** One validated steering request. */
export interface AcpSteeringRequest {
  /** The session whose running turn receives the message. */
  readonly sessionId: string
  /** Prompt content, admitted through the same route rules as `session/prompt`. */
  readonly prompt: readonly ContentBlock[]
}

/** The two outcomes a steering request can report. */
export type AcpSteeringOutcome =
  | { outcome: 'injected' }
  | { outcome: 'promptRequired'; reason: 'noRunningTurn' }

/** Report that the request joined a running turn. */
export function steeringInjected(): AcpSteeringOutcome {
  return { outcome: 'injected' }
}

/** Report that nothing was running, so the client must open its own prompt. */
export function steeringPromptRequired(): AcpSteeringOutcome {
  return { outcome: 'promptRequired', reason: 'noRunningTurn' }
}

function invalid(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/**
 * Parse and narrow one `_session/steering` request.
 *
 * Only the envelope is validated here — `sessionId` and a non-empty `prompt`
 * array. Block-level admission (image capability, route support, attachment
 * limits) belongs to the same `admitAcpPrompt` path `session/prompt` uses, so a
 * steered message can never be admitted on weaker terms than a prompted one.
 * @param params - raw JSON-RPC params.
 * @returns the validated request.
 */
export function parseSteeringRequest(params: unknown): AcpSteeringRequest {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalid('steering params must be an object')
  }
  const record = params as Record<string, unknown>
  const sessionId = record['sessionId']
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw invalid('steering sessionId must be a non-empty string')
  }
  const prompt = record['prompt']
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw invalid('steering prompt must be a non-empty content-block array')
  }
  return { sessionId, prompt: prompt as readonly ContentBlock[] }
}

/**
 * The SDK's custom-method registration hook: a bare parse function is a valid
 * `ParamsParser`. Exposed so the transport wiring and the contract stay in one
 * place.
 * @param params - raw JSON-RPC params.
 * @returns the validated request.
 */
export const steeringParamsParser = parseSteeringRequest
