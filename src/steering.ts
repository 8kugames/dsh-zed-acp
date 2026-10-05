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
 * `_meta.steering.idleBehavior` is a real, validated field: `promptRequired` is
 * the only policy this bridge implements, so any other value is `invalidParams`
 * rather than being answered with a policy the client never asked for.
 * `ponytail:` the one implemented policy — promoting an idle session into a
 * turn would mean starting work no ACP request is waiting on, with no owner for
 * its stop reason, cost accounting, or output stream. A future
 * `idleBehavior: 'autoPrompt'` would need that owner first.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Render an unexpected idle policy for the error detail.
 *
 * The client chose this value, so echoing it back is how it learns which field
 * was refused — but it must not get to decide the size of the refusal: a
 * hostile or merely careless `_meta` could otherwise be echoed wholesale, and a
 * value the JSON encoder cannot handle must not throw inside the error path.
 * @param value - the refused `idleBehavior` value.
 * @returns a bounded rendering of it.
 */
function describeIdleBehavior(value: unknown): string {
  let rendered: string
  try {
    rendered = JSON.stringify(value) ?? String(value)
  } catch {
    rendered = String(value)
  }
  return rendered.length <= 120 ? rendered : `${rendered.slice(0, 117)}…`
}

/**
 * Enforce `_meta.steering.idleBehavior`.
 *
 * Omitting `_meta`, or omitting `idleBehavior` inside it, keeps the current
 * behavior — the request is answered as `promptRequired` implies, exactly as
 * the ACP extension rule "omitting idleBehavior uses the same behavior"
 * requires. A value that names a policy this bridge does not implement is
 * `invalidParams`: falling back to the implemented one would answer a contract
 * the client never signed.
 * @param meta - the request's `_meta` payload.
 * @throws {RequestError} `invalidParams` on an unimplemented idle policy.
 */
function assertIdleBehavior(meta: unknown): void {
  if (!isRecord(meta)) return
  const steering = meta['steering']
  if (!isRecord(steering)) return
  const idleBehavior = steering['idleBehavior']
  if (idleBehavior === undefined) return
  if (idleBehavior !== 'promptRequired') {
    throw invalid(
      `steering _meta.steering.idleBehavior: only "promptRequired" is implemented, got ${describeIdleBehavior(idleBehavior)}`,
    )
  }
}

/**
 * Parse and narrow one `_session/steering` request.
 *
 * The envelope (`sessionId` and a non-empty `prompt` array) and the
 * `_meta.steering` policy block are validated here. Block-level admission
 * (image capability, route support, attachment limits) belongs to the same
 * `admitAcpPrompt` path `session/prompt` uses, so a steered message can never
 * be admitted on weaker terms than a prompted one.
 * @param params - raw JSON-RPC params.
 * @returns the validated request.
 * @throws {RequestError} `invalidParams` on a malformed envelope or an
 * unimplemented idle policy.
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
  assertIdleBehavior(record['_meta'])
  return { sessionId, prompt: prompt as readonly ContentBlock[] }
}
