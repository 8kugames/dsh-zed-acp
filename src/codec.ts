/**
 * Pure translation between the harness lifecycle and the automation-only ACP wire.
 * @module @8kugames/dsh-zed-acp/codec
 */

import { Transform } from 'node:stream'
import type { StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    /* v8 ignore next 2 -- TurnEndReason is merge-extensible; every live-turn member is
     * handled above, and seed-only variants (`forked`) never end an ACP prompt turn. */
    default:
      return 'end_turn'
  }
}

/**
 * Upper bound on one NDJSON line the production stdio transport accepts
 * before it drops the connection. Generous enough for any legitimate
 * image-bearing prompt (base64 inflates 4/3), strict enough that a runaway
 * peer cannot buffer unbounded bytes the way the SDK's line splitter alone
 * would.
 * ponytail: a fixed ceiling with no knob; deployments pasting images larger
 * than this need a config option — that is the upgrade path, not a guess here.
 */
export const MAX_WIRE_LINE_BYTES = 64 * 1024 * 1024

/**
 * Pass-through NDJSON framing guard: tracks the byte length of the line being
 * assembled and fails the stream once one line exceeds the ceiling. Data is
 * never buffered here, so the bound is on the peer's own line, not on this
 * process's memory.
 */
export class WireLineLimiter extends Transform {
  private lineBytes = 0

  /** @param maxLineBytes - per-line byte ceiling enforced by this guard. */
  constructor(
    private readonly maxLineBytes: number = MAX_WIRE_LINE_BYTES,
  ) {
    super()
  }

  override _transform(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null, data?: never) => void): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const lastNewline = data.lastIndexOf(0x0a)
    // Bytes after the last newline belong to the line still being assembled;
    // everything before it closed earlier (already-counted) lines.
    this.lineBytes = lastNewline === -1 ? this.lineBytes + data.length : data.length - lastNewline - 1
    if (this.lineBytes > this.maxLineBytes) {
      callback(new Error(`acp wire line exceeds ${this.maxLineBytes} bytes`))
      return
    }
    callback(null, data as never)
  }
}
