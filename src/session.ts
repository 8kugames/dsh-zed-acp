/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import {
  RequestError,
  type ContentBlock,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, AgentStatus, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import { createUserMessage, errorChain, type UserMessage } from '@deepseek-ai/dsh-llm'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import {
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionLogOffset,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { AcpContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { acpConfigOptions } from './config-options.ts'
import { inclusiveHistoryPrefix, locateForkBoundary, type JetbrainsAirForkRequest } from './fork.ts'
import { mountAcpMcpServers } from './mcp.ts'
import type { SkillCatalog } from './skills.ts'
import { steeringInjected, steeringPromptRequired, type AcpSteeringOutcome } from './steering.ts'
import { AcpModelControl, type ReasoningPreferenceStore } from './model-control.ts'
import { AcpPermissionControl, PERMISSION_CONFIG_ID } from './permission-control.ts'
import { AcpPresetControl, PRESET_CONFIG_ID } from './preset-control.ts'
import { AcpSessionModeControl, SESSION_MODE_CONFIG_ID, modeState } from './session-mode-control.ts'
import {
  TurnStatsCollector,
  emptySessionStats,
  foldTurnStats,
  formatStatsCard,
  mergeTurnStats,
  statsCardTitle,
  sumPromptTokens,
  type PriceTable,
  type SessionStats,
  type TurnStats,
} from './stats.ts'
import {
  DEFAULT_MODE_ID,
  DESCENDANT_RECONCILE_MS,
  PLAN_MODE_ID,
  availableCommandsUpdate,
  assistantUpdates,
  configOptionUpdate,
  contextUsage,
  contextUsageUpdate,
  currentModeUpdate,
  descendantActivityOpen,
  descendantActivityProgress,
  descendantActivitySettle,
  descendantActivityTitle,
  descendantHistoryFromEvents,
  descendantProgressText,
  oneLineText,
  sessionTitleUpdate,
  todoPlanUpdate,
  toolCallTitle,
  toolCallUpdate,
  toolResultUpdate,
  turnEndToFate,
  turnEndUsageUpdate,
  turnStatsCard,
  userMessageUpdates,
  type ProjectedToolCall,
  type TerminalPresentation,
} from './updates.ts'

/**
 * Bound on bridge-issued continuation turns for one ACP prompt. A turn that
 * ends while background descendants still work is woken again so the delegating
 * agent can read their results without holding its own turn open (see
 * {@link AcpSession.settleAfterQuiescence}). The bound stops a delegation chain
 * that spawns fresh descendants on every wake from holding the client's
 * `session/prompt` open forever — the same wedge the descendant gate's
 * reconciliation exists to prevent, one level up.
 */
export const DESCENDANT_WAKE_LIMIT = 8

/**
 * Model-facing text of one continuation turn. It states only what the bridge
 * observed — that the delegated background work settled — and leaves the next
 * move to the agent. The leading tag marks it as harness-produced rather than
 * human input, matching the dedicated source kind below.
 */
export const DESCENDANT_WAKE_TEXT =
  '[harness] Every background subagent you delegated has settled. Read their results and continue; if nothing is left to do, give your final answer.'

/**
 * This bridge's own user-message source kind, declared in its own module per the
 * merge-extensible `MessageSourceMap` contract. A continuation turn must not
 * carry `{ kind: 'user' }`: the reload replay treats that kind as the human
 * transcript, which would resurrect a harness-authored turn as user input.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'acp-descendant-continuation': { kind: 'acp-descendant-continuation' }
  }
}

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpSessionBuildOptions {
  cwd: string
  mcpServers: readonly McpServer[]
  agentOptions: AgentOptions
  fallbackSelection: ModelSelection | undefined
  /** Persisted reasoning-effort preference store; `undefined` disables persistence. */
  preferenceStore: ReasoningPreferenceStore | undefined
  signal: AbortSignal
  notify: (notification: SessionNotification) => Promise<void>
  /** Effective price table for turn/session cost reporting. */
  prices: PriceTable
  /** Client display-terminal presentation negotiated at initialize. */
  terminal: TerminalPresentation
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Forked ACP session construction inputs. */
export interface ForkAcpSessionOptions extends AcpSessionBuildOptions {
  /** The new child session id; never the source's. */
  sessionId: SessionId
  /** The source session whose committed log the child inherits. */
  sourceSessionId: SessionId
  /** The inclusive fork request, or `undefined` for the ACP whole-session copy. */
  fork: JetbrainsAirForkRequest | undefined
}

/** The continuable-subagent teardown used without depending on the subagent package. */
interface ContinuableDrain {
  /** Dispose continuable descendants below exact host-owned parents child-first. */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/**
 * One tracked descendant agent's activity state. `known` spans creation to the
 * first `agent/status` transition, so a continuable spawn counts as active
 * before its driver's first `running` — closing the race where the parent
 * settles between the spawn tool's return and the child's first status.
 */
type DescendantState = 'known' | 'running' | 'idle'

/**
 * One tracked descendant's observed facts, per activity period. The `agent`
 * handle carries the mirrored `status` ground truth reconciliation re-reads;
 * `title` survives across periods (the task text is session-scoped) while the
 * remaining fields reset when a new period opens.
 */
interface DescendantFacts {
  agent: Agent | undefined
  title: string | undefined
  activity: string | undefined
  inputTokens: number
  outputTokens: number
  periodStartMs: number
  lastEventMs: number
  periodFate: 'completed' | 'failed' | undefined
  summary: string | undefined
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancelRequested: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
  stats: TurnStats | undefined
  /** Bridge-issued continuation turns already spent by this prompt. */
  continuations: number
}

/** Open one descendant's tracking facts at birth or adoption. */
function freshDescendantFacts(agent: Agent): DescendantFacts {
  const now = Date.now()
  return {
    agent,
    title: undefined,
    activity: undefined,
    inputTokens: 0,
    outputTokens: 0,
    periodStartMs: now,
    lastEventMs: now,
    periodFate: undefined,
    summary: undefined,
  }
}

/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Standard internal failure with protocol-safe detail. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Restore the latest logged route before falling back to deployment config. */
function selectionFor(
  logged: {
    config: { provider: string; model: string; reasoningEffort?: ModelSelection['reasoningEffort'] }
    adapterDefaults?: { reasoningEffort?: boolean }
  } | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  return logged === undefined
    ? fallback
    : {
      provider: logged.config.provider,
      model: logged.config.model,
      ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
        ? {}
        : { reasoningEffort: logged.config.reasoningEffort },
    }
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, selected
 * route, one-prompt admission slot, ordered standard updates, and memoized
 * quiescent teardown.
 */
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private closing: Promise<void> | undefined
  private readonly pendingSelections = new Map<string, ModelSelection>()
  private statsCollector: TurnStatsCollector | undefined
  private sessionStats: SessionStats = emptySessionStats()
  /** Per-call presentation state (locations, display-terminal) carried from `tool/call` to `tool/result`. */
  private readonly projectedCalls = new Map<string, ProjectedToolCall>()
  /** Tracked descendant agents' activity states, keyed by agent id. */
  private readonly descendantStates = new Map<string, DescendantState>()
  /** Open synthetic activity card per tracked descendant agent id. */
  private readonly openDescendantCards = new Map<string, string>()
  /** Activity-period counter per tracked descendant agent id (idle → running again opens a new card). */
  private readonly descendantPeriods = new Map<string, number>()
  /** Observed facts per tracked descendant agent id, feeding progress cards and reconciliation. */
  private readonly descendantFacts = new Map<string, DescendantFacts>()
  /** Descendant session id → agent id, routing descendant `session/event`s to their tracked agent. */
  private readonly descendantBySession = new Map<SessionId, string>()
  /** Periodic reconciliation handle while any descendant is tracked; unref'd so it never holds the process. */
  private descendantTimer: ReturnType<typeof setInterval> | undefined
  /** Resolvers released when the tracked descendants reach zero active or the prompt is cancelled. */
  private descendantWaiters: (() => void)[] = []

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    modelControl: AcpModelControl,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
    private readonly presets: AgentPresetRegistry | undefined,
    permissions: PermissionPresetService | undefined,
    private readonly prices: PriceTable,
    private readonly terminal: TerminalPresentation,
  ) {
    this.agent = handle.agent
    this.modelControl = modelControl
    this.presetControl = presets === undefined
      ? undefined
      : new AcpPresetControl(presets, this.agent)
    this.permissionControl = permissions === undefined
      ? undefined
      : new AcpPermissionControl(permissions, this.agent.session)
    this.modeControl = new AcpSessionModeControl(this.agent, () => this.planMode())
    this.disposeAgent = () => handle.dispose()
  }

  private readonly disposeAgent: () => Promise<void>
  private readonly presetControl: AcpPresetControl | undefined
  private readonly permissionControl: AcpPermissionControl | undefined
  private readonly modeControl: AcpSessionModeControl

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - fresh session identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    const presets = ctx.get('agentPresets')
    const agentPreset = presets === undefined ? undefined : (await presets.resolve()).id
    const modelControl = new AcpModelControl(
      ctx.llm,
      options.fallbackSelection,
      (message) => { ctx.logger.warn(message) },
      options.preferenceStore,
    )
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      // The header records the composition this session starts under, so a
      // resume rejoins it rather than the roster's then-current default.
      meta: { cwd: options.cwd, ...(agentPreset === undefined ? {} : { agentPreset }) },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx)
        if (presets !== undefined) await presets.mount(agentCtx, agentPreset)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    return new AcpSession(ctx, handle, modelControl, options.notify, presets, ctx.get('permissionPresets'), options.prices, options.terminal)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - persisted identity, fallback route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    const presets = ctx.get('agentPresets')
    let modelControl: AcpModelControl | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx, agent) => {
        modelControl = new AcpModelControl(
          ctx.llm,
          selectionFor(agent.session.requestHeader(), options.fallbackSelection),
          (message) => { ctx.logger.warn(message) },
          options.preferenceStore,
        )
        modelControl.install(agentCtx)
        if (presets !== undefined) {
          // The session log states the composition this session ran under;
          // a session recorded before a roster existed joins the default.
          const projections = ctx.get('sessionProjections')
          const recorded = projections?.stateOf(agent.session, 'agentPreset') ?? undefined
          const preset = await presets.resolve(typeof recorded === 'string' ? recorded : undefined)
          await presets.mount(agentCtx, preset.id)
        }
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    /* v8 ignore start -- a fulfilled Agent resume necessarily ran setup to completion. */
    if (modelControl === undefined) {
      await handle.dispose()
      throw internalError('session/resume did not compose model selection')
    }
    /* v8 ignore stop */
    return new AcpSession(ctx, handle, modelControl, options.notify, presets, ctx.get('permissionPresets'), options.prices, options.terminal)
  }

  /**
   * Derive an independent child session from a source session's committed log.
   *
   * The source is never mutated and is not required to be live: its log is read
   * through a read-only persistence handle, exactly as `session/load` does, so
   * a client can branch from a session it has not opened. The child is a
   * platform-native fork seed — `meta.isSeeded` plus the exact inherited
   * prefix length, with `buildForkSeed` closing an open tail through synthetic
   * `forked` results and step/turn endings — so a branch never inherits a
   * half-open turn and the child's own `session/load` replay stops where the
   * fork did.
   *
   * The inherited prefix is conversation, not route state: a fork over a
   * session that was mid-`tool/call` inherits the call and its result as
   * committed history, while the child's selected route is re-resolved exactly
   * as `session/new` does. The fork response returns the child's full
   * `configOptions`, so a client sees and can change the route before prompting.
   * ponytail: that means forking a session pinned to a non-default model lands
   * on the composition default. Inheriting the source's route would need the
   * last pinned turn read back out of the inherited log, which is the upgrade
   * path rather than a silent guess here.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - child identity, source id, fork request, and notifier.
   * @returns the forked per-session module.
   */
  static async fork(ctx: Context, options: ForkAcpSessionOptions): Promise<AcpSession> {
    const source = options.sourceSessionId
    // A live source buffers its committed events until the durability barrier,
    // and a read handle never sees past that buffer. Without this flush a fork
    // of the conversation currently on screen — the common case — would read an
    // empty log and silently branch from nothing. A source that is not live in
    // this process is already durable, so this is a no-op for it.
    const live = ctx.sessions.get(source)
    if (live !== undefined) await ctx.sessions.flush(live)
    const handle = await ctx.sessionPersistence.open(source, 'read', { signal: options.signal })
    let events: readonly SessionEvent[]
    try {
      events = (await handle.read(0, undefined, { signal: options.signal })).events
    } finally {
      await handle.close()
    }
    // An absent boundary means the source's last committed event — the ACP
    // whole-session default — and an empty source forks an empty child.
    const boundary = options.fork === undefined
      ? events.at(-1)?.seq
      : locateForkBoundary(events, options.fork, source)
    const inherited = boundary === undefined
      ? []
      : buildForkSeed(
        options.fork === undefined ? [...events] : inclusiveHistoryPrefix(events, boundary),
        boundary,
      )
    const presets = ctx.get('agentPresets')
    const modelControl = new AcpModelControl(
      ctx.llm,
      options.fallbackSelection,
      (message) => { ctx.logger.warn(message) },
      options.preferenceStore,
    )
    const created = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: {
        cwd: options.cwd,
        // Fork lineage, not delegation: `origin` stays unset so the child is a
        // listable, loadable, promptable root.
        isSeeded: true,
        parentSession: source,
      },
      inheritedEventCount: brandNumber<SessionLogOffset>(boundary === undefined ? 0 : Number(boundary) + 1),
      seed: inherited,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx)
        if (presets !== undefined) {
          const agentPreset = await presets.resolve()
          await presets.mount(agentCtx, agentPreset.id)
        }
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    return new AcpSession(
      ctx,
      created,
      modelControl,
      options.notify,
      presets,
      ctx.get('permissionPresets'),
      options.prices,
      options.terminal,
    )
  }

  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /**
   * Return the complete standard configuration state: the preset select when
   * the deployment composes a roster, the permission select when it composes
   * the permission service, the Default/Plan mode select when this session's
   * composition provides a plan-mode service, then the model selections.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current configuration options.
   */
  async configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return acpConfigOptions({
      preset: this.presetControl,
      permission: this.permissionControl,
      mode: this.modeControl,
      model: this.modelControl,
    }, signal)
  }

  /**
   * Apply one standard configuration option to later ACP turns.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns the complete resulting option state.
   */
  async setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    if (this.presetControl !== undefined && configId === PRESET_CONFIG_ID) {
      await this.presetControl.set(value)
    } else if (this.permissionControl !== undefined && configId === PERMISSION_CONFIG_ID) {
      this.permissionControl.set(value)
    } else if (configId === SESSION_MODE_CONFIG_ID) {
      this.modeControl.set(value)
    } else {
      await this.modelControl.set(configId, value, signal)
    }
    return this.configOptions(signal)
  }

  /**
   * The plan-mode service of this session's own composition. A preset-joined
   * Agent resolves the roster's realm instance — its scope context cannot see
   * an entry-local realm — and a rosterless deployment falls back to the host
   * plane.
   * @returns the plan-mode service, or `undefined` when neither composes one.
   */
  private planMode(): PlanModeController | undefined {
    return this.presets?.serviceFor(this.agent, 'planMode') ?? this.agent.ctx.get('planMode')
  }

  /**
   * Return the session-mode state, or `undefined` when this session's
   * composition provides no plan-mode service.
   * @returns the current mode and the two fixed options.
   */
  modesState(): SessionModeState | undefined {
    const planMode = this.planMode()
    return planMode === undefined ? undefined : modeState(planMode, this.agent)
  }

  /**
   * Select a session mode. A selection during an open turn queues in the
   * plan-mode service until the next accepted pre-step; the committed change
   * reaches the client as a `current_mode_update` notification.
   * @param modeId - one of the advertised mode ids.
   */
  setMode(modeId: string): void {
    if (modeId !== DEFAULT_MODE_ID && modeId !== PLAN_MODE_ID) {
      throw invalidParams(`unknown mode: ${modeId}`)
    }
    this.assertActive()
    const planMode = this.planMode()
    if (planMode === undefined) throw invalidParams('session modes are not available in this deployment')
    planMode.set(this.agent, modeId === PLAN_MODE_ID)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.configOptions()
      .then((configOptions) => {
        if (this.closing !== undefined) return
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: configOptionUpdate(configOptions),
          }))
          /* v8 ignore start -- the bridge notifier contains transport failure. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      })
      /* v8 ignore start -- option discovery contains per-provider failure. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Publish the host registry's effective slash-command roster for this
   * session as an `available_commands_update`, serialized onto the ordered
   * output tail without blocking execution updates. User-invocable skills from
   * the skill registry ride the same update. A deployment that composes
   * neither registry publishes nothing.
   *
   * The tail position is captured synchronously, before the skill catalog read
   * starts, so a roster triggered concurrently with a live turn still lands
   * after every update queued when it was requested rather than jumping ahead
   * of them once the read resolves. The read itself runs in parallel with that
   * drain instead of waiting for it.
   */
  publishAvailableCommands(): void {
    if (this.closing !== undefined) return
    const previous = this.outputTail
    const read = availableCommandsUpdate(
      this.ctx.get('commands'),
      this.ctx.get('skills') as SkillCatalog | undefined,
      this.agent,
      this.agent.session.header.cwd,
      (message) => { this.ctx.logger.warn(message) },
    )
    this.outputTail = previous
      .then(() => read)
      .then((update) => update === undefined
        ? undefined
        : this.notify({ sessionId: this.agent.session.id, update }))
      /* v8 ignore start -- the bridge notifier contains transport failure. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: available-commands update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Admit, enqueue, and settle one prompt at whole-Agent quiescence.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.assertActive()
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancelRequested: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
      stats: undefined,
      continuations: 0,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
    if (requestSignal?.aborted === true) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.modelControl.snapshot()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        inflight.messageId = message.id
        inflight.messageQueued = true
        if (promptSelection !== undefined) this.pendingSelections.set(message.id, promptSelection)
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          this.pendingSelections.delete(message.id)
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.cancelRequested) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /**
   * Inject one steered follow-up into this session's running turn.
   *
   * The message goes to the nearest *step* boundary of the turn already in
   * flight, so the running turn keeps its identity and the client's open
   * `session/prompt` request keeps ownership of the output stream and stop
   * reason. Content admission is the same `admitAcpPrompt` path a prompted
   * message takes, so steering cannot smuggle in a block the route or the
   * connection's image capability would have refused.
   *
   * When nothing is running to join, this reports `promptRequired` rather than
   * starting a turn: the agent's own `steer` would happily begin one, but no
   * ACP request would be waiting on it, so its stop reason, cost accounting,
   * and output stream would have no owner.
   * @param prompt - ACP content blocks to inject.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param signal - JSON-RPC request cancellation signal.
   * @returns `injected`, or `promptRequired` when no turn is running.
   */
  async steer(
    prompt: readonly ContentBlock[],
    imageEnabled: boolean,
    signal: AbortSignal,
  ): Promise<AcpSteeringOutcome> {
    this.assertActive()
    if (!this.steerable()) return steeringPromptRequired()
    const content = await admitAcpPrompt(this.ctx, this.modelControl.snapshot(), prompt, imageEnabled, signal)
    // Re-check: admission awaits attachment storage, and the turn the message
    // was aimed at may have settled while it ran.
    if (!this.steerable()) return steeringPromptRequired()
    this.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
    return steeringInjected()
  }

  /**
   * Whether a running turn exists to receive a steered message: the in-flight
   * prompt holds a claimed turn that has neither ended nor been cancelled.
   *
   * `settlementStarted` is deliberately *not* the test — it is set the moment
   * the prompt is queued, because settlement runs for the whole life of a turn
   * awaiting quiescence. The precise "this turn is over" fact is `endReason`,
   * recorded when the turn's own `turn/end` commits.
   */
  private steerable(): boolean {
    const inflight = this.inflight
    if (inflight === undefined) return false
    if (inflight.turn === undefined) return false
    return !inflight.cancelRequested && inflight.endReason === undefined
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }

  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    this.trackStats(event)
    try {
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
        const update = toolCallUpdate(event, this.terminal)
        this.projectedCalls.set(event.data.callId, {
          // Derived from the update the client actually received, so the
          // completion path can never drift from the embedded presentation.
          terminal: update.content?.some(content => content.type === 'terminal') === true,
          locations: update.locations,
        })
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'plan/mode') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: currentModeUpdate(event),
          }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: mode update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'todo/write') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: todoPlanUpdate(event) }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: plan update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'session/title') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: sessionTitleUpdate(event) }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: session-title update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'user/message' && event.surfaceOp !== 'append') {
        // A replacing user/message is a compaction checkpoint: the surface
        // shrinks with no assistant message to carry fresh usage, so without
        // this projection the client's context meter would keep the last
        // request's pre-compaction reading until the next model reply.
        const update = contextUsageUpdate(this.ctx, session)
        if (update !== undefined) {
          const previous = this.outputTail
          this.outputTail = previous
            .then(() => this.notify({
              sessionId: this.agent.session.id,
              update,
            }))
            /* v8 ignore start -- the bridge notifier contains transport failure. */
            .catch((error: unknown) => {
              this.ctx.logger.warn(`acp: compaction usage update delivery failed: ${errorChain(error)}`)
            })
          /* v8 ignore stop */
        }
      } else if (event.type === 'tool/result') {
        const call = this.projectedCalls.get(event.data.message.toolCallId)
        this.projectedCalls.delete(event.data.message.toolCallId)
        const previous = this.outputTail
        this.outputTail = previous
          .then(async () => {
            for (const update of await toolResultUpdate(this.ctx, event, call)) {
              await this.notify({ sessionId: this.agent.session.id, update })
            }
          })
          /* v8 ignore start -- supplemental-content conversion failure is contained and cannot fail Agent work. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
      if (event.type === 'turn/end') this.modelControl.releaseTurn(event.data.turn)
    }
  }

  /**
   * Replay a persisted session's client-visible history onto this connection.
   *
   * The stored log is read through a read-only persistence handle — never
   * taking write ownership from the restored Agent — and projected with the
   * same event-to-update routing the live firehose uses, so a reloaded client
   * reconstructs the conversation it would have watched live. The transcript
   * source is append-origin surface events, per the platform's contract that
   * the model-visible surface shadows replaced ranges while append-origin
   * events stay the durable human transcript: a compaction summary node is a
   * model-only replacement copy, so replaying `user/message` events only for
   * direct human prompts both restores the pre-compaction conversation the
   * client saw live and skips the summary it never saw. Every notification is
   * delivered before this resolves, so a `session/load` response follows its
   * history onto the wire.
   * @param signal - replay cancellation observed by the storage read.
   */
  async replayStoredHistory(signal: AbortSignal): Promise<void> {
    const sessionId = this.agent.session.id
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read', { signal })
    let events: readonly SessionEvent[]
    try {
      events = (await handle.read(0, undefined, { signal })).events
    } finally {
      await handle.close()
    }
    for (const event of events) {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') continue
        const previous = this.outputTail
        this.outputTail = previous.then(async () => {
          for (const update of await userMessageUpdates(this.ctx, event)) {
            await this.notify({ sessionId, update })
          }
        }).catch((error: unknown) => {
          this.ctx.logger.warn(`acp: user-message replay delivery failed: ${errorChain(error)}`)
        })
        continue
      }
      this.onSessionEvent(this.agent.session, event)
    }
    // Reload projection for continuable descendants: the persisted child
    // sessions carry the background work's durable fate (a crash-orphaned turn
    // receives its `interrupted` closer on resume), which the parent log never
    // records. One settled fate card per descendant in the `origin: 'subagent'
    // forest rides the replay tail — collected transitively to match the live
    // routing's grandchild coverage — so a reloaded client cannot mistake
    // interrupted work for the early-settled spawn call's "completed". Two
    // contract assumptions live outside this repo's dependency tree: the spawn
    // tool stamps both `parentSession` and `origin: 'subagent'` on children
    // (the same headers the live routing and load gates already read), and
    // fork lineage without the subagent origin stamp is not delegated work.
    const headers = (await this.ctx.sessionPersistence.list({ signal })).map(({ header }) => header)
    const subagentChildren = new Map<SessionId, SessionHeader[]>()
    for (const header of headers) {
      if (header.parentSession === undefined || header.origin !== 'subagent') continue
      const bucket = subagentChildren.get(header.parentSession)
      if (bucket === undefined) subagentChildren.set(header.parentSession, [header])
      else bucket.push(header)
    }
    const children: SessionHeader[] = []
    const visited = new Set<SessionId>([sessionId])
    let frontier: SessionId[] = [sessionId]
    while (frontier.length > 0) {
      const next: SessionId[] = []
      for (const parent of frontier) {
        for (const header of subagentChildren.get(parent) ?? []) {
          // Immutable headers cannot form real cycles; the visited guard only
          // bounds the walk against corrupt lineage data.
          if (visited.has(header.id)) continue
          visited.add(header.id)
          children.push(header)
          next.push(header.id)
        }
      }
      frontier = next
    }
    children.sort((left, right) => left.createdAt - right.createdAt)
    for (const header of children) {
      if (signal.aborted) break
      try {
        const childHandle = await this.ctx.sessionPersistence.open(header.id, 'read', { signal })
        let childEvents: readonly SessionEvent[]
        try {
          childEvents = (await childHandle.read(0, undefined, { signal })).events
        } finally {
          await childHandle.close()
        }
        const cards = descendantHistoryFromEvents(header.id, childEvents)
        if (cards === undefined) continue
        const previous = this.outputTail
        this.outputTail = previous.then(async () => {
          for (const update of cards) {
            await this.notify({ sessionId, update })
          }
        }).catch((error: unknown) => {
          this.ctx.logger.warn(`acp: descendant history delivery failed: ${errorChain(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: descendant history read failed for ${header.id}: ${errorChain(error)}`)
      }
    }
    await this.outputTail
  }

  /**
   * Correlate an accepted user message with its Agent turn and pinned route.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
    const selection = this.pendingSelections.get(message.id)
    this.pendingSelections.delete(message.id)
    if (selection !== undefined) this.modelControl.pinTurn(turn, selection)
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param turn - failed turn number.
   * @param error - original same-process failure.
   */
  onAgentError(turn: number, error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // AgentLoop balances an in-turn failure with durable turn/end; settlement
    // reads that exact error reason. This slot records interval failures outside it.
    if (inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }

  /**
   * Track one descendant agent's birth as an active activity period. Birth is
   * observed from `agent/created`, which the spawn tool's execution emits
   * before the parent turn can settle, so the period opens inside the prompt's
   * settlement window rather than racing it.
   * @param agent - the newly created descendant Agent.
   */
  onDescendantBorn(agent: Agent): void {
    if (this.closing !== undefined) return
    if (this.descendantStates.has(agent.id)) return
    this.descendantStates.set(agent.id, 'known')
    this.descendantBySession.set(agent.session.id, agent.id)
    this.descendantFacts.set(agent.id, freshDescendantFacts(agent))
    this.openDescendantCard(agent.id)
    this.reconcileDescendants()
  }

  /**
   * Follow one tracked descendant's `agent/status` transition: `running`
   * (re)opens an activity card, `idle` settles the open one. A status for an
   * untracked descendant is adopted (with its facts, so reconciliation can
   * re-read the handle) rather than dropped, so stray remaining activity still
   * surfaces — and cannot wedge the gate, because the periodic reconcile
   * settles any adoption the ground truth has already left behind.
   * @param agent - the transitioning descendant Agent.
   * @param status - the status just entered.
   */
  onDescendantStatus(agent: Agent, status: AgentStatus): void {
    if (this.closing !== undefined) return
    const previous = this.descendantStates.get(agent.id)
    if (previous === status) return
    this.descendantStates.set(agent.id, status)
    if (!this.descendantFacts.has(agent.id)) {
      this.descendantFacts.set(agent.id, freshDescendantFacts(agent))
      this.descendantBySession.set(agent.session.id, agent.id)
    }
    if (status === 'idle') {
      this.settleDescendantCard(agent.id)
    } else {
      this.openDescendantCard(agent.id)
      this.refreshDescendantCard(agent.id)
    }
    this.reconcileDescendants()
    if (this.activeDescendantCount() === 0) this.releaseDescendantWaiters()
  }

  /**
   * Track one tracked descendant's committed session events into its open
   * activity card: the first user message becomes the card title, tool calls
   * and assistant lines become the live activity readout, usage accumulates,
   * and the period's last `turn/end` decides its settle fate.
   * @param session - the descendant's own session.
   * @param event - one committed event from that session.
   */
  onDescendantSessionEvent(session: Session, event: SessionEvent): void {
    if (this.closing !== undefined) return
    const agentId = this.descendantBySession.get(session.header.id)
    if (agentId === undefined) return
    const facts = this.descendantFacts.get(agentId)
    if (facts === undefined) return
    facts.lastEventMs = Date.now()
    if (event.type === 'user/message') {
      if (facts.title === undefined) {
        const title = oneLineText(event.data.content)
        if (title !== undefined) {
          facts.title = title
          this.patchDescendantCardTitle(agentId, title)
        }
      }
      this.reconcileDescendants()
      return
    }
    if (event.type === 'tool/call') {
      facts.activity = toolCallTitle(event.data.name, event.data.arguments)
      this.refreshDescendantCard(agentId)
      this.reconcileDescendants()
      return
    }
    if (event.type === 'assistant/message') {
      const line = oneLineText(event.data.message.content)
      if (line !== undefined) {
        facts.summary = line
        facts.activity = line
      }
      const usage = event.data.usage
      if (usage !== undefined) {
        facts.inputTokens += sumPromptTokens(usage)
        facts.outputTokens += usage.outputTokens
      }
      this.refreshDescendantCard(agentId)
      this.reconcileDescendants()
      return
    }
    if (event.type === 'turn/end') {
      facts.periodFate = turnEndToFate(event.data.reason.kind)
      this.refreshDescendantCard(agentId)
      this.reconcileDescendants()
    }
  }

  /**
   * Retire one tracked descendant at disposal: settle its open card and forget
   * the agent. Disposal is not an observable `agent/status`, so it must clear
   * activity directly or a drained-but-running child would wedge the gate.
   * @param agent - the disposed descendant Agent.
   */
  onDescendantGone(agent: Agent): void {
    this.settleDescendantCard(agent.id)
    this.descendantStates.delete(agent.id)
    this.descendantFacts.delete(agent.id)
    this.descendantBySession.delete(agent.session.id)
    // Facts/period counter notes: the counter stays monotonic across disposal
    // (a same-id recreation or late status must never reuse a settled card id)
    // and the timer disarms once nothing is actively held — an idle-but-alive
    // descendant must not keep the reconcile tick spinning.
    if (this.activeDescendantCount() === 0) {
      this.stopDescendantTimer()
      this.releaseDescendantWaiters()
    }
  }

  /** Await every update queued before this call. */
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * Feed the live prompt's turn statistics while its events commit. A
   * `turn/start` under an in-flight prompt opens a fresh collector; its
   * matching `turn/end` finalizes it into the prompt slot and the
   * session-lifetime totals.
   * @param event - committed durable event.
   */
  private trackStats(event: SessionEvent): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    if (event.type === 'turn/start') {
      this.statsCollector = new TurnStatsCollector(
        event.data.turn,
        () => this.modelControl.snapshot()?.model,
        this.prices,
      )
      return
    }
    const collector = this.statsCollector
    if (collector === undefined) return
    if (event.type === 'turn/end') {
      if (event.data.turn !== collector.turn) return
      this.statsCollector = undefined
      const stats = collector.result()
      if (stats === undefined) return
      // A prompt can span several turns (a continuation issued after background
      // descendants settle), so the one card this prompt finally emits must
      // carry the whole request: fold each turn into the prompt's aggregate
      // while the session keeps its own per-turn fold.
      inflight.stats = inflight.stats === undefined ? stats : mergeTurnStats(inflight.stats, stats)
      this.sessionStats = foldTurnStats(this.sessionStats, stats)
      return
    }
    collector.record(event)
  }

  /**
   * Deliver the finalized turn statistics: one collapsed turn-stats tool card
   * (markdown text in the client's tool timeline, not the chat stream), then
   * one final `usage_update` carrying cumulative cost and the machine-readable
   * `dsh` `_meta` extension. Both queue onto the ordered output tail; turns
   * that were cancelled or failed settle without either.
   * @param inflight - the settling prompt slot.
   */
  private async emitTurnStats(inflight: InflightPrompt): Promise<void> {
    const stats = inflight.stats
    if (stats === undefined || inflight.cancelRequested) return
    if (inflight.outputError !== undefined || inflight.agentError !== undefined) return
    const end = inflight.endReason
    if (end === undefined || end.kind === 'error') return
    const modelId = this.modelControl.snapshot()?.model
    const updates: SessionUpdate[] = turnStatsCard(
      `dsh-stats-${stats.turn}`,
      statsCardTitle(modelId, {
        inputTokens: sumPromptTokens(stats.usage),
        outputTokens: stats.usage.outputTokens,
        cost: stats.cost,
        // The unpriced placeholder follows the currency the session is known to
        // be billed in; with no priced turn to learn one from, the deployment's
        // configured default stands in (CNY when it names none).
        fallbackCurrency: this.sessionStats.cost?.currency ?? this.prices.defaultCurrency,
        defaultCurrency: this.prices.defaultCurrency,
      }),
      formatStatsCard(stats, this.sessionStats, modelId, this.prices.defaultCurrency),
    )
    const usage = contextUsage(this.ctx, this.agent.session)
    if (usage !== undefined) {
      updates.push(turnEndUsageUpdate(usage, this.sessionStats, stats))
    }
    const previous = this.outputTail
    const delivery = previous.then(async () => {
      for (const update of updates) {
        await this.notify({ sessionId: this.agent.session.id, update })
      }
    })
    this.outputTail = delivery.catch((error: unknown) => {
      this.ctx.logger.warn(`acp: turn-stats delivery failed: ${errorChain(error)}`)
    })
    await this.outputTail
  }

  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      const subagents = this.ctx.get('subagents') as ContinuableDrain | undefined
      try {
        await subagents?.drainContinuableDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: continuable subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('continuable subagent teardown failed', { cause: error }))
      }
      // The drain disposes tracked descendants, whose `agent/disposed` events
      // settle their open cards; anything left (for example when no subagents
      // service is composed) is settled here so no card spins against a closed
      // session.
      for (const agentId of [...this.openDescendantCards.keys()]) this.settleDescendantCard(agentId)
      this.descendantStates.clear()
      this.descendantPeriods.clear()
      this.descendantFacts.clear()
      this.descendantBySession.clear()
      this.stopDescendantTimer()
      this.releaseDescendantWaiters()
      try {
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      this.pendingSelections.clear()
      this.projectedCalls.clear()
      if (failures.length === 1) throw failures[0]
      /* v8 ignore start -- independent teardown failures can aggregate only under multiple simultaneous provider faults. */
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
      /* v8 ignore stop */
    })()
    return this.closing
  }

  /** Number of tracked descendants whose activity period is still open (`known` or `running`). */
  private activeDescendantCount(): number {
    let count = 0
    for (const state of this.descendantStates.values()) {
      if (state !== 'idle') count += 1
    }
    return count
  }

  /**
   * Resolve once no tracked descendant remains active. The promise is released
   * either by the last activity period closing or by `cancelPrompt`, and the
   * settlement loop re-checks the count itself, so a descendant that restarts
   * before the re-check simply re-arms the wait.
   */
  private whenDescendantsSettled(): Promise<void> {
    if (this.activeDescendantCount() === 0) return Promise.resolve()
    return new Promise(resolve => { this.descendantWaiters.push(resolve) })
  }

  /** Release every descendant-gate waiter (activity emptied or prompt cancelled). */
  private releaseDescendantWaiters(): void {
    const waiters = this.descendantWaiters
    this.descendantWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * Re-enter the agent once the background descendants it delegated have
   * settled, under the prompt that is still open.
   *
   * A turn that ends while descendants still work leaves the agent idle with no
   * way back in: the gate keeps the *client* waiting, but nothing re-enters the
   * agent, so an agent that needs its delegation results has no choice but to
   * hold its own turn open with a blocking shell call. This wake-up removes that
   * need. `endReason` is cleared because the final stop reason must come from the
   * last turn, and `messageId` is replaced so the newly claimed turn correlates
   * back to this same prompt — which is exactly what makes the prompt the owner
   * of the continuation's stop reason, cost, and output stream.
   * @param inflight - the settling prompt that owns the continuation.
   */
  private wakeForSettledDescendants(inflight: InflightPrompt): void {
    const message = createUserMessage({
      content: [{ type: 'text', text: DESCENDANT_WAKE_TEXT }],
      source: { kind: 'acp-descendant-continuation' },
    })
    inflight.endReason = undefined
    inflight.messageId = message.id
    inflight.continuations += 1
    this.agent.followup(message)
  }

  /**
   * Open this agent's current activity card, one synthetic `tool_call` per
   * activity period riding the ordered update tail. Period-scoped facts reset
   * here; the learned title survives, so a re-woken descendant's new card opens
   * already named.
   */
  private openDescendantCard(agentId: string): void {
    if (this.openDescendantCards.has(agentId)) return
    this.ensureDescendantTimer()
    const period = (this.descendantPeriods.get(agentId) ?? 0) + 1
    this.descendantPeriods.set(agentId, period)
    const toolCallId = `dsh-subagent-${agentId}-${period}`
    this.openDescendantCards.set(agentId, toolCallId)
    const facts = this.descendantFacts.get(agentId)
    if (facts !== undefined) {
      const now = Date.now()
      facts.activity = undefined
      facts.inputTokens = 0
      facts.outputTokens = 0
      facts.periodStartMs = now
      facts.lastEventMs = now
      facts.periodFate = undefined
      facts.summary = undefined
    }
    const previous = this.outputTail
    this.outputTail = previous
      .then(() => this.notify({
        sessionId: this.agent.session.id,
        update: descendantActivityOpen(toolCallId, facts?.title),
      }))
      /* v8 ignore start -- the bridge notifier contains transport rejection. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: descendant-activity card delivery failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /** Settle this agent's open activity card with its observed fate and summary. */
  private settleDescendantCard(agentId: string): void {
    const toolCallId = this.openDescendantCards.get(agentId)
    if (toolCallId === undefined) return
    this.openDescendantCards.delete(agentId)
    const facts = this.descendantFacts.get(agentId)
    const previous = this.outputTail
    this.outputTail = previous
      .then(() => this.notify({
        sessionId: this.agent.session.id,
        update: descendantActivitySettle(toolCallId, facts?.periodFate ?? 'completed', facts?.summary),
      }))
      /* v8 ignore start -- the bridge notifier contains transport rejection. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: descendant-activity settle delivery failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /** Replace one open card's body with the latest progress snapshot. */
  private refreshDescendantCard(agentId: string): void {
    const toolCallId = this.openDescendantCards.get(agentId)
    if (toolCallId === undefined) return
    const facts = this.descendantFacts.get(agentId)
    if (facts === undefined) return
    const now = Date.now()
    const sawUsage = facts.inputTokens > 0 || facts.outputTokens > 0
    const text = descendantProgressText({
      activity: facts.activity,
      elapsedMs: now - facts.periodStartMs,
      silentMs: now - facts.lastEventMs,
      inputTokens: sawUsage ? facts.inputTokens : undefined,
      outputTokens: sawUsage ? facts.outputTokens : undefined,
    })
    const previous = this.outputTail
    this.outputTail = previous
      .then(() => this.notify({
        sessionId: this.agent.session.id,
        update: descendantActivityProgress(toolCallId, text),
      }))
      /* v8 ignore start -- the bridge notifier contains transport rejection. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: descendant-activity progress delivery failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /** Patch one open card's title after the descendant's task text commits. */
  private patchDescendantCardTitle(agentId: string, title: string): void {
    const toolCallId = this.openDescendantCards.get(agentId)
    if (toolCallId === undefined) return
    const previous = this.outputTail
    this.outputTail = previous
      .then(() => this.notify({
        sessionId: this.agent.session.id,
        update: descendantActivityTitle(toolCallId, title),
      }))
      /* v8 ignore start -- the bridge notifier contains transport rejection. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: descendant-activity title delivery failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Reconcile tracked states against the agents' mirrored `status` ground
   * truth and refresh open cards' elapsed/stall readout. Runs on every
   * descendant input and on the {@link DESCENDANT_RECONCILE_MS} interval, so a
   * wedged `known`/`running` entry whose agent already went idle — a missed
   * terminal event, or a stray post-disposal adoption — settles here instead of
   * holding the descendant gate forever. A descendant whose ground truth is
   * genuinely still `running` stays held: the agreed semantics keep background
   * work from masquerading as a finished turn, and cancellation remains the
   * only forced exit. The timer stops once nothing is tracked.
   * ponytail: a driver that died without disposal while its mirrored `status`
   * stays frozen at `running` is indistinguishable from a genuinely hung tool
   * call through the public event surface; both surface as a stalled card and
   * yield to cancellation.
   */
  private reconcileDescendants(): void {
    for (const [agentId, state] of this.descendantStates) {
      if (state === 'idle') continue
      const agent = this.descendantFacts.get(agentId)?.agent
      if (agent === undefined || agent.status !== 'idle') continue
      this.descendantStates.set(agentId, 'idle')
      this.ctx.logger.warn(`acp: descendant ${agentId} observed ${state} but agent reports idle; reconciled`)
      this.settleDescendantCard(agentId)
    }
    if (this.activeDescendantCount() === 0) {
      this.stopDescendantTimer()
      this.releaseDescendantWaiters()
    }
  }

  /** Arm the periodic reconciliation timer while descendants are tracked; the
   * tick adds an open-card readout refresh on top of the state pass. */
  private ensureDescendantTimer(): void {
    if (this.descendantTimer !== undefined) return
    this.descendantTimer = setInterval(() => {
      this.reconcileDescendants()
      for (const agentId of this.openDescendantCards.keys()) this.refreshDescendantCard(agentId)
    }, DESCENDANT_RECONCILE_MS)
    this.descendantTimer.unref?.()
  }

  /** Disarm the periodic reconciliation timer. */
  private stopDescendantTimer(): void {
    if (this.descendantTimer === undefined) return
    clearInterval(this.descendantTimer)
    this.descendantTimer = undefined
  }

  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    inflight.cancelRequested = true
    inflight.admissionController.abort(new Error(detail))
    this.releaseDescendantWaiters()
    this.settleAfterQuiescence(inflight)
    if (inflight.messageQueued) this.agent.cancel({ kind: 'user' })
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        // Hold the turn while continuable descendants still work: the prompt
        // answers only after every spawned activity period goes idle, so the
        // client cannot mistake background work for a finished turn. Cancellation
        // skips the wait (agreed semantics: stop settles promptly, the open
        // activity cards keep the remainder visible).
        //
        // A turn that ends while descendants are still working is precisely the
        // window an agent otherwise covers by holding its own turn open with a
        // blocking shell call: the gate keeps the client waiting, but nothing
        // re-enters the agent, so its delegation results would be lost. Waking it
        // here — under the prompt that is already open, which therefore owns the
        // continuation's stop reason, cost, and output stream — removes that
        // need. The loop repeats only while each new turn again ends with
        // descendants running, and stops at DESCENDANT_WAKE_LIMIT.
        for (;;) {
          await this.agent.whenIdle()
          const held = !inflight.cancelRequested && this.activeDescendantCount() > 0
          while (!inflight.cancelRequested && this.activeDescendantCount() > 0) {
            await this.whenDescendantsSettled()
          }
          if (inflight.cancelRequested || !held) break
          if (inflight.continuations >= DESCENDANT_WAKE_LIMIT) break
          this.wakeForSettledDescendants(inflight)
        }
        await this.outputTail
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      await this.emitTurnStats(inflight)
      this.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}
