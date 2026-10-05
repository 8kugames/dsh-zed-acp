import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { WireLineLimiter, turnEndToStopReason } from '../src/codec.ts'

describe('ACP codec', () => {
  it.each([
    [{ kind: 'completed' }, 'end_turn'],
    [{ kind: 'max-tokens' }, 'max_tokens'],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'end_turn'],
    [{ kind: 'interrupted' }, 'cancelled'],
    [{ kind: 'blocked' }, 'end_turn'],
    [{ kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } }, 'end_turn'],
  ] satisfies Array<[TurnEndReason, string]>)('maps %o to %s', (reason, expected) => {
    expect(turnEndToStopReason(reason)).toBe(expected)
  })
})

/** Collect a limiter's output and outcome: everything it passed through, plus every failure it raised. */
function drain(limiter: WireLineLimiter, writes: readonly (Buffer | string)[]): {
  output: Buffer[]
  failures: Error[]
  settled: Promise<void>
} {
  const output: Buffer[] = []
  const failures: Error[] = []
  limiter.on('data', chunk => { output.push(chunk as Buffer) })
  limiter.on('error', error => { failures.push(error) })
  const settled = new Promise<void>(resolve => {
    limiter.on('close', () => resolve())
  })
  for (const write of writes) limiter.write(write)
  limiter.end()
  return { output, failures, settled }
}

describe('WireLineLimiter', () => {
  it('passes ordinary framed lines through unchanged', async () => {
    const limiter = new WireLineLimiter(32)
    const { output, failures, settled } = drain(limiter, ['{"a":1}\n', Buffer.from('{"b":2}\n')])
    await settled
    expect(failures).toEqual([])
    expect(Buffer.concat(output).toString()).toBe('{"a":1}\n{"b":2}\n')
  })

  it('fails the stream when one line exceeds the ceiling', async () => {
    const limiter = new WireLineLimiter(8)
    const { failures, settled } = drain(limiter, [Buffer.alloc(9, 0x61)])
    await settled
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toContain('exceeds 8 bytes')
  })

  it('accepts a line exactly at the ceiling and resets after each newline', async () => {
    const limiter = new WireLineLimiter(8)
    // Two consecutive lines of exactly 8 bytes each: neither crosses the cap,
    // and the second proves the counter reset at the first newline.
    const { output, failures, settled } = drain(limiter, [Buffer.from('a'.repeat(8) + '\n'), Buffer.from('b'.repeat(8) + '\n')])
    await settled
    expect(failures).toEqual([])
    expect(output).toHaveLength(2)
  })

  it('accumulates one line split across many writes before failing it', async () => {
    const limiter = new WireLineLimiter(8)
    // 'aaa' + 'bbb' + 'ccc' is one 9-byte line delivered in three writes.
    const { failures, settled } = drain(limiter, ['aaa', 'bbb', 'ccc'])
    await settled
    expect(failures[0]?.message).toContain('exceeds 8 bytes')
  })
})
