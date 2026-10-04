/**
 * Zed-oriented Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes persistent harness sessions to interactive ACP clients
 * such as Zed. It carries standard configuration, agent-preset, permission, and
 * default/plan session-mode selects, MCP mounts, prompt content, committed
 * semantic updates with tool kinds and file diffs, credential authentication,
 * one-shot permission decisions, and option-only user questions; presentation
 * features that need a richer client stay with the harness's UI modules.
 *
 * Install as a dsh plugin (`dsh plugin --profile zed add @8kugames/dsh-zed-acp`)
 * and run `dsh --profile zed`; the bundle patch disables the shipped
 * automation-only `acp` transport when this plugin joins that profile.
 * @module @8kugames/dsh-zed-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Side-effect type imports: declaration-merge the approval waterfall answered
// below, the user-questions waterfall the questions bridge answers, the
// optional default-model selection the initial route resolves through, and the
// optional projection cache the session-list title read resolves through.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { authenticate as authenticateCredential, acpAuthMethods, resolveApiKeyRef } from './auth.ts'
import { AcpContentError, mountsAcpImageAttachments, supportsAcpImagePrompts } from './content.ts'
import { AcpMcpConfigError } from './mcp.ts'
import { AcpModelConfigError, createReasoningPreferenceStore, defaultReasoningPreferencePath } from './model-control.ts'
import { AcpPermissionConfigError } from './permission-control.ts'
import { AcpPresetConfigError } from './preset-control.ts'
import { AcpSessionModeConfigError } from './session-mode-control.ts'
import { acpInclusiveForkCapabilityMeta, parseForkRequest } from './fork.ts'
import { bridgeAcpQuestions } from './questions.ts'
import {
  ACP_STEERING_METHOD,
  acpSteeringCapabilityMeta,
  parseSteeringRequest,
  type AcpSteeringOutcome,
  type AcpSteeringRequest,
} from './steering.ts'
import { AcpSession } from './session.ts'
import { buildPriceTable } from './stats.ts'
import { ACP_AGENT_VERSION } from './version.ts'

const DEFAULT_SESSION_LIST_PAGE_SIZE = 100

export const name = 'zed-acp'
/** Core services required by the standard automation controls. */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /**
   * Credential reference `authenticate` validates; must name the same
   * environment variable the composed LLM provider resolves its key from
   * (the DeepSeek provider's default).
   */
  apiKeyEnv?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /**
   * File path persisted reasoning-effort choices are read from and written
   * through to. Defaults to `~/.dsh/zed-acp-reasoning-efforts.json`; a relative
   * path resolves against the bridge process working directory, so deployments
   * overriding it should pin an absolute path to keep tests and parallel
   * installs off the shared user file.
   */
  modelPreferencePath?: string
  /**
   * Whether to advertise inline image prompts when the attachment store is
   * mounted. `'auto'` (the default) requires the route a fresh session starts
   * on — the pinned provider/model, else the composition's default model — to
   * declare image input; `true` is the deployment's explicit promise, for
   * adapters whose catalog omits `inputModalities`, and still refuses such a
   * route at admission time; `false` never advertises them.
   */
  imageInputs?: 'auto' | boolean
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  apiKeyEnv: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
  modelPreferencePath: Schema.string(),
  imageInputs: Schema.union([Schema.const('auto'), Schema.boolean()]).default('auto'),
})

/**
 * Decide the `promptCapabilities.image` this connection advertises. The
 * `promptCapabilities` block is the agent's promise to the client, so a
 * deployment may state it explicitly; the per-prompt route check stays the
 * safety net for routes that really cannot accept an image.
 * @param ctx - bridge context carrying the optional attachment and LLM services.
 * @param config - deployment configuration for this connection.
 * @returns whether inline image prompts are advertised.
 */
async function resolveImagePromptCapability(ctx: Context, config: AcpConfig): Promise<boolean> {
  const override = config.imageInputs ?? 'auto'
  if (override === 'auto') {
    // Probe the exact route a fresh session starts on, so the advertised
    // capability matches what the first prompt will actually run on.
    const selection = initialSelection(ctx, config)
    return supportsAcpImagePrompts(ctx, selection?.provider, selection?.model)
  }
  if (override === false) return false
  return mountsAcpImageAttachments(ctx)
}

/**
 * Mount the Zed-oriented ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const persistence = ctx.sessionPersistence
  const logger = ctx.logger
  const sessionListPageSize = resolveSessionListPageSize(config.sessionListPageSize)
  // A malformed reference fails at load, before any client can authenticate.
  const apiKeyRef = resolveApiKeyRef(config.apiKeyEnv)
  const sessions = new Map<SessionId, AcpSession>()
  const activating = new Set<SessionId>()
  const prices = buildPriceTable(process.env.DSH_ACP_PRICES, (message) => { logger.warn(message) })
  const preferenceStore = createReasoningPreferenceStore(config.modelPreferencePath ?? defaultReasoningPreferencePath())
  let closed = false
  let imagePromptEnabled = false
  // Zed's display-terminal extension: the client advertises it in the
  // capability _meta (the codex-acp contract); non-advertising clients keep
  // the plain tool-result content projection.
  let clientTerminalOutput = false

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Parameters<AcpSession['owns']>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): AcpSession => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send one ordered protocol update while containing transport-only failure. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.notify(methods.client.session.update, notification)
    /* v8 ignore start -- the ACP SDK contains notification-handler failures; only a transport write failure reaches this guard. */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }

  // Continuable-subagent visibility: descendant agents (header lineage) route
  // to their root ACP session, which holds its prompt open while they work and
  // projects each activity period as a synthetic card. The lineage map covers
  // grandchildren transitively: a child's own children resolve through the
  // child's entry, mirroring the recursive descendant drain. Declared before
  // the `session/event` handler below, which falls back to it for descendant
  // sessions (their committed events feed the live progress cards).
  const descendantRoots = new Map<SessionId, AcpSession>()
  const recordOwningSession = (sessionId: SessionId): AcpSession | undefined =>
    descendantRoots.get(sessionId) ?? sessions.get(sessionId)

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record !== undefined) {
      if (record.ownsSession(session)) record.onSessionEvent(session, event)
      return
    }
    descendantRoots.get(session.header.id)?.onDescendantSessionEvent(session, event)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn)
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    ownedRecord(agent)?.onAgentError(turn, error)
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // Slash-command rosters can change while sessions are live; every owned
  // session republishes its effective view of the registry.
  ctx.on('commands/change', () => {
    for (const record of sessions.values()) record.publishAvailableCommands()
  })

  ctx.on('agent/created', ({ agent }) => {
    const parent = agent.session.header.parentSession
    if (parent === undefined || !isDelegatedChild(agent.session.header)) return
    const record = recordOwningSession(parent)
    if (record === undefined) return
    descendantRoots.set(agent.session.id, record)
    record.onDescendantBorn(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    descendantRoots.get(agent.session.id)?.onDescendantStatus(agent, status)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const record = descendantRoots.get(agent.session.id)
    descendantRoots.delete(agent.session.id)
    record?.onDescendantGone(agent)
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    return record.drainUpdates().then(() => {
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      return conn.request(methods.client.session.requestPermission, params)
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  // Structured questions (plan review, ask_user_question) ride the same
  // permission channel; unrepresentable questions delegate to the waterfall.
  ctx.on('user-questions/request', (request, next) => {
    const record = request.agent === undefined ? undefined : ownedRecord(request.agent)
    if (record === undefined) return next()
    return bridgeAcpQuestions({
      sessionId: record.agent.session.id,
      drainUpdates: () => record.drainUpdates(),
      requestPermission: (params, signal) =>
        conn.request(methods.client.session.requestPermission, params,
          signal === undefined ? undefined : { cancellationSignal: signal }),
      warn: (message) => { logger.warn(message) },
    }, request, next)
  })

  const implementation = {
    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else
      // the latest supported" both resolve to this server's one version.
      imagePromptEnabled = await resolveImagePromptCapability(ctx, config)
      clientTerminalOutput = params.clientCapabilities?._meta?.terminal_output === true
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'dsh-zed-acp', version: ACP_AGENT_VERSION },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          loadSession: true,
          sessionCapabilities: { close: {}, list: {}, resume: {}, fork: {} },
          // Namespaced, versioned extension capabilities. A client that reads
          // no `_meta` still gets the complete standard path: plain
          // whole-session `session/fork`, no steering method.
          _meta: acpAgentCapabilityMeta(),
        },
        authMethods: acpAuthMethods(),
      }
    },

    async authenticate(params: AuthenticateRequest): Promise<void> {
      await authenticateCredential(ctx, apiKeyRef, params.methodId)
    },

    async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(randomUUID())
      let record: AcpSession
      try {
        record = await AcpSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          agentOptions: agentOptions(config),
          fallbackSelection: initialSelection(ctx, config),
          preferenceStore,
          signal,
          notify,
          prices,
          terminal: { enabled: clientTerminalOutput, cwd: params.cwd },
        })
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        throw error
      }
      /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
      if (closed) {
        await record.close('connection closed during session/new')
        throw internalError('connection closed during session/new')
      }
      sessions.set(sessionId, record)
      try {
        const configOptions = await record.configOptions(signal)
        const modes = record.modesState()
        assertOpen()
        // The attached log writer's flush materializes an empty session durably.
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        // Deferred to a macrotask so the session/new response is queued onto
        // the stdio stream first; a strict client that drops updates for
        // sessions it has not yet seen registered still receives the roster.
        setImmediate(() => {
          if (sessions.get(sessionId) === record) record.publishAvailableCommands()
        })
        return { sessionId, ...(modes === undefined ? {} : { modes }), configOptions }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/new activation failed')
        throw error
      }
    },

    async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(params.sessionId)
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      activating.add(sessionId)
      return (async (): Promise<ResumeSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        if (persisted === undefined || isDelegatedChild(persisted)) {
          throw invalidParams(`session is not resumable: ${sessionId}`)
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        let record: AcpSession
        try {
          record = await AcpSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            agentOptions: agentOptions(config),
            fallbackSelection: initialSelection(ctx, config),
            preferenceStore,
            signal,
            notify,
            prices,
            terminal: { enabled: clientTerminalOutput, cwd: params.cwd },
          })
        } catch (error: unknown) {
          if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
          throw error
        }
        /* v8 ignore start -- the persisted header was checked before resume; the factory restores that exact header. */
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/resume cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        /* v8 ignore stop */
        /* v8 ignore next 4 -- a real stdio close can race an in-flight resume. */
        if (closed) {
          await record.close('connection closed during session/resume')
          throw internalError('connection closed during session/resume')
        }
        sessions.set(sessionId, record)
        try {
          const configOptions = await record.configOptions(signal)
          const modes = record.modesState()
          // Same response-first deferral as session/new: the roster follows the
          // session/resume response onto the wire.
          setImmediate(() => {
            if (sessions.get(sessionId) === record) record.publishAvailableCommands()
          })
          return { ...(modes === undefined ? {} : { modes }), configOptions }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await record.close('session/resume option discovery failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async loadSession(params: LoadSessionRequest, signal: AbortSignal): Promise<LoadSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(params.sessionId)
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      activating.add(sessionId)
      return (async (): Promise<LoadSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        if (persisted === undefined || isDelegatedChild(persisted)) {
          throw invalidParams(`session is not loadable: ${sessionId}`)
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        let record: AcpSession
        try {
          record = await AcpSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            agentOptions: agentOptions(config),
            fallbackSelection: initialSelection(ctx, config),
            preferenceStore,
            signal,
            notify,
            prices,
            terminal: { enabled: clientTerminalOutput, cwd: params.cwd },
          })
        } catch (error: unknown) {
          if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
          throw error
        }
        /* v8 ignore start -- the persisted header was checked before resume; the factory restores that exact header. */
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/load cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        /* v8 ignore stop */
        try {
          // The full history rides session/update notifications ahead of this
          // handler's response, the order the ACP spec's loading path requires.
          await record.replayStoredHistory(signal)
          /* v8 ignore next 4 -- a real stdio close can race an in-flight load. */
          if (closed) {
            await record.close('connection closed during session/load')
            throw internalError('connection closed during session/load')
          }
          sessions.set(sessionId, record)
          const configOptions = await record.configOptions(signal)
          const modes = record.modesState()
          // Same response-first deferral as session/new: the roster follows the
          // session/load response onto the wire.
          setImmediate(() => {
            if (sessions.get(sessionId) === record) record.publishAvailableCommands()
          })
          return { ...(modes === undefined ? {} : { modes }), configOptions }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await record.close('session/load activation failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async forkSession(params: ForkSessionRequest, signal: AbortSignal): Promise<ForkSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      // Parsed before any allocation: a malformed extension block must not
      // leave a half-built session behind, and a client that guessed wrong gets
      // told so instead of silently receiving the whole conversation.
      const fork = parseForkRequest(params._meta)
      const sourceId = brandString<SessionId>(params.sessionId)
      const persisted = (await persistence.stat(sourceId, { signal }))?.header
      if (persisted === undefined) throw invalidParams(`unknown session: ${sourceId}`)
      if (isDelegatedChild(persisted)) throw invalidParams(`session is not forkable: ${sourceId}`)
      if (!await sameDirectory(persisted.cwd, params.cwd)) {
        throw invalidParams(`session cwd does not match: ${params.cwd}`)
      }
      const sessionId = brandString<SessionId>(randomUUID())
      let record: AcpSession
      try {
        record = await AcpSession.fork(ctx, {
          sessionId,
          sourceSessionId: sourceId,
          fork,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          agentOptions: agentOptions(config),
          fallbackSelection: initialSelection(ctx, config),
          preferenceStore,
          signal,
          notify,
          prices,
          terminal: { enabled: clientTerminalOutput, cwd: params.cwd },
        })
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        if (error instanceof RequestError) throw error
        throw internalError(`session/fork failed: ${errorChain(error)}`)
      }
      /* v8 ignore next 4 -- a real stdio close can race an in-flight fork. */
      if (closed) {
        await record.close('connection closed during session/fork')
        throw internalError('connection closed during session/fork')
      }
      sessions.set(sessionId, record)
      try {
        const configOptions = await record.configOptions(signal)
        const modes = record.modesState()
        assertOpen()
        // The child is a seeded session: the factory's own creation is its first
        // durable write, and the same flush that materializes an empty
        // `session/new` materializes the inherited prefix.
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        setImmediate(() => {
          if (sessions.get(sessionId) === record) record.publishAvailableCommands()
        })
        return {
          sessionId,
          ...modes === undefined ? {} : { modes },
          configOptions,
        }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/fork activation failed')
        throw error
      }
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      assertOpen()
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      const listed = await persistence.list({ signal })
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          sessions.has(header.id)
            || activating.has(header.id)
            || ctx.sessions.get(header.id) !== undefined
            || isDelegatedChild(header)
            || header.cwd === undefined
            || !isAbsolute(header.cwd)
        ) return undefined
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt, title: listedTitle(ctx, header) }
      }))
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      const page = remaining.slice(0, sessionListPageSize)
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd, title }) => ({
          sessionId,
          cwd,
          ...title === undefined ? {} : { title },
        })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        if (
          error instanceof AcpModelConfigError
          || error instanceof AcpPresetConfigError
          || error instanceof AcpPermissionConfigError
          || error instanceof AcpSessionModeConfigError
        ) {
          throw invalidParams(error.message)
        }
        throw error
      }
    },

    setSessionMode(params: SetSessionModeRequest): SetSessionModeResponse {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        record.setMode(params.modeId)
        return {}
      } catch (error: unknown) {
        if (error instanceof RequestError) throw error
        throw internalError(`mode selection failed: ${errorChain(error)}`)
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen()
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      try {
        await record.close('ACP session closed')
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
        // A failed drain leaves live descendants whose lineage entries would
        // otherwise outlive this record and route later events into it.
        for (const [descendantId, root] of descendantRoots) {
          if (root === record) descendantRoots.delete(descendantId)
        }
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    async steer(params: AcpSteeringRequest, signal: AbortSignal): Promise<AcpSteeringOutcome> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return await record.steer(params.prompt, imagePromptEnabled, signal)
      } catch (error: unknown) {
        if (error instanceof AcpContentError) {
          throw error.kind === 'invalid'
            ? invalidParams(error.message)
            : internalError(error.message)
        }
        if (error instanceof RequestError) throw error
        throw internalError(`steering failed: ${errorChain(error)}`)
      }
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  // The SDK dispatches every incoming message through the handler chain in
  // registration order, so each registered method adds one dispatch hop to
  // every message behind it. Cancellation is the latency-critical direction
  // and must not drift as methods are added: register it first.
  const app = createAcpAgentApp({ name: 'dsh-zed-acp' })
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.setMode, ({ params }) => implementation.setSessionMode(params))
    .onRequest(methods.agent.session.fork, ({ params, signal }) => implementation.forkSession(params, signal))
    .onRequest(ACP_STEERING_METHOD, parseSteeringRequest, ({ params, signal }) => implementation.steer(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onRequest(methods.agent.session.load, ({ params, signal }) => implementation.loadSession(params, signal))
  const connection = app.connect(stream)
  const conn: AgentContext = connection.client

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    // AcpSession.close cancels synchronously before its first await, so every owned
    // prompt stops before any descendant or persistence drain can block.
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      descendantRoots.clear()
      for (const record of records) {
        /* v8 ignore next -- closed blocks concurrent handlers; each captured record remains mapped until this loop. */
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'zed-acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/**
 * The route a fresh session starts on: the deployment's explicit provider/model
 * pin when both fields are present, else the composition's default-model
 * selection. `undefined` when neither composes; the agent loop then supplies
 * no route up front.
 * @param ctx - bridge context carrying the optional agent-default-model service.
 * @param config - ACP provider/model configuration.
 * @returns the initial session selection, or `undefined` when neither composes.
 */
function initialSelection(ctx: Context, config: AcpConfig): ModelSelection | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  return ctx.get('agentDefaultModel')?.currentSelection()
}

/**
 * Read one listed session's persisted title from the projection cache.
 * Cache rows are durable derived data, so the value is narrowed at this
 * boundary; a deployment without the cache, an uncached session, or a null
 * title reports no field rather than a placeholder. A predecessor checkpoint
 * (a resumed session's previous lifecycle) still contributes its last title.
 * @param ctx - bridge context resolving the optional projection cache.
 * @param header - persisted session header being listed.
 * @returns the non-empty title, or `undefined` when none is cached.
 */
function listedTitle(ctx: Context, header: SessionHeader): string | undefined {
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) return undefined
  const title = (cache.cachedSnapshot(header, ['title']) ?? cache.cachedPredecessorTitle(header))?.values.title
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** Resolve and validate the deployment-owned session page limit. */
function resolveSessionListPageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SESSION_LIST_PAGE_SIZE
  /* v8 ignore start -- Cordis applies the positive-integer Config schema; this protects direct apply callers. */
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('acp: sessionListPageSize must be a positive safe integer')
  }
  /* v8 ignore stop */
  return resolved
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    throw new Error('session/list cursor is invalid')
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** Test whether an entry follows the cursor in newest-first list order. */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * The namespaced, versioned extension capabilities this connection advertises
 * in `agentCapabilities._meta`.
 *
 * Every entry here is discoverability only: the standard path stays complete
 * without it. `sessionCapabilities.fork` above is what actually gates
 * `session/fork`; a client that never reads this block still forks a whole
 * session. `steering.supported` advertises the custom `_session/steering`
 * method, and `jetbrains.air.fork` the inclusive message-point extension on top
 * of it.
 * @returns the `_meta` capability block for `initialize`.
 */
function acpAgentCapabilityMeta(): Record<string, unknown> {
  return { ...acpSteeringCapabilityMeta(), ...acpInclusiveForkCapabilityMeta() }
}

/**
 * Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] | null }): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/**
 * Whether a stored header belongs to a delegated subagent, which a top-level
 * ACP surface never lists, loads, or forks.
 *
 * `parentSession` alone is *not* the test. It is the platform's fork-lineage
 * field, so a `session/fork` child carries the same header lineage a spawn
 * child does; only the spawn tool additionally stamps `origin: 'subagent'`.
 * Keying the gates on the origin stamp is what keeps a forked session a
 * first-class root — listable, loadable, resumable, and promptable — instead of
 * stranding every fork as a write-only record.
 * @param header - the persisted or live session header being classified.
 * @returns true when the header is a delegated descendant.
 */
function isDelegatedChild(header: SessionHeader): boolean {
  return header.origin === 'subagent'
}

/** Compare existing directories by physical identity and missing paths lexically. */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right)
  }
}
