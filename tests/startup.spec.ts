/** Coverage for the zed profile's CLI startup plugin (src/startup.ts). */

import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ZED_ACP_STARTUP_SERVICE, apply } from '../src/startup.ts'

interface StartupHarness {
  ctx: Context
  /** Exit codes requested through the launcher's bounded exit. */
  exits: number[]
  /** Flush every registered readiness listener. */
  ready: () => void
  /** The fake stdin the EOF binding listens on. */
  stdin: PassThrough
  /** Everything written to the substituted stdout. */
  out: string[]
  /** Everything written to the substituted stderr. */
  err: string[]
}

const realInternals = { ...internals }

/**
 * Boot the startup plugin against a real cordis context with the launcher's
 * cmdline facts and substituted process streams, exactly the surface the
 * production `dsh --profile zed` host provides.
 */
function bootStartup(args: readonly string[]): StartupHarness {
  const exits: number[] = []
  const readyListeners: (() => void)[] = []
  const stdin = new PassThrough()
  const out: string[] = []
  const err: string[] = []
  internals.stdin = stdin as unknown as typeof internals.stdin
  internals.stdout = { write: (text: string) => { out.push(text); return true } } as unknown as typeof internals.stdout
  internals.stderr = { write: (text: string) => { err.push(text); return true } } as unknown as typeof internals.stderr
  const ctx = new Context()
  provideCmdline(ctx, {
    args,
    exit: code => { exits.push(code) },
    ready: {
      onReady: listener => {
        readyListeners.push(listener)
        return () => {}
      },
    },
  })
  apply(ctx)
  return {
    ctx,
    exits,
    ready: () => { for (const listener of readyListeners.splice(0)) listener() },
    stdin,
    out,
    err,
  }
}

describe('zed-acp startup plugin', () => {
  afterEach(async () => {
    Object.assign(internals, realInternals)
  })

  it('publishes the startup service on a bare invocation', () => {
    const boot = bootStartup([])
    expect(boot.ctx.get(ZED_ACP_STARTUP_SERVICE)).toEqual({ accepted: true })
    expect(boot.exits).toEqual([])
    return boot.ctx.fiber.dispose()
  })

  it('binds stdin EOF to a bounded exit only after startup commits', async () => {
    const boot = bootStartup([])
    // A PassThrough never reaches `end` without a consumer; resume the flow so
    // the EOF listener fires exactly as it would on a drained stdio pipe. The
    // event itself is asynchronous, so wait for it before committing readiness.
    const ended = new Promise<void>(resolve => { boot.stdin.once('end', resolve) })
    boot.stdin.resume()
    // EOF before readiness parks the exit on the readiness signal…
    boot.stdin.end()
    await ended
    expect(boot.exits).toEqual([])
    // …and committing readiness releases it exactly once.
    boot.ready()
    boot.ready()
    expect(boot.exits).toEqual([0])
    await boot.ctx.fiber.dispose()
  })

  it('stops hearing EOF after the context is disposed', async () => {
    const boot = bootStartup([])
    await boot.ctx.fiber.dispose()
    boot.stdin.end()
    boot.ready()
    expect(boot.exits).toEqual([])
  })

  it('prints help and exits without publishing the service', () => {
    const boot = bootStartup(['--help'])
    expect(boot.out.join('')).toContain('dsh --profile zed')
    expect(boot.exits).toEqual([0])
    expect(boot.ctx.get(ZED_ACP_STARTUP_SERVICE)).toBeUndefined()
    return boot.ctx.fiber.dispose()
  })

  it('rejects an unknown flag with a usage error and no service', () => {
    const boot = bootStartup(['--bogus'])
    expect(boot.exits).toHaveLength(1)
    expect(boot.exits[0]).toBeGreaterThan(0)
    expect(boot.err.join('')).toContain('unknown')
    expect(boot.ctx.get(ZED_ACP_STARTUP_SERVICE)).toBeUndefined()
    return boot.ctx.fiber.dispose()
  })
})
