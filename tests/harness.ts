/** In-memory ACP transport fixture over the real agent factory and loop. */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  type Agent as AcpAgent,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SendRequestOptions,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { type GenerateOptions, LlmAdapter, ReasoningEffortId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {} from '@deepseek-ai/dsh-session-title'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import * as AcpPlugin from '../src/index.ts'
import type { AcpConfig } from '../src/index.ts'
import { ACP_STEERING_METHOD, type AcpSteeringOutcome, type AcpSteeringRequest } from '../src/steering.ts'

/**
 * One scripted response: a plain chunk list, the literal `'hang'` for a call
 * that never returns, or `{ chunks, holdMs }` to keep a call open for a bounded
 * time — the window a steering test needs to act while a turn is still live but
 * will still reach a next step boundary.
 */
export type ScriptedResponse = StreamChunk[] | 'hang' | { chunks: StreamChunk[]; holdMs: number }

/** Scripted adapter for protocol tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: ScriptedResponse[],
    private readonly imageCapable: boolean,
    private readonly provider = 'mock',
  ) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== this.provider) throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: this.provider, name: this.provider === 'mock' ? 'Mock' : `Mock ${this.provider}` }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === this.provider ? [
      {
        provider: this.provider,
        id: 'mock',
        name: 'Mock Reasoner',
        description: 'Mock model with selectable reasoning.',
        inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
      },
      {
        provider: this.provider,
        id: 'plain',
        name: 'Mock Plain',
        inputModalities: ['text'] as const,
      },
    ] : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.imageCapable && model === 'mock' ? ['text', 'image'] : ['text'],
      context: { contextWindow: 1_024 },
      ...model === 'mock' ? {
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {},
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang' || typeof entry === 'object' && !Array.isArray(entry)) {
      const chunks = entry === 'hang' ? 'hang' : entry.chunks
      const holdMs = entry === 'hang' ? undefined : entry.holdMs
      if (chunks === 'hang') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error('aborted'))
            return
          }
          options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
        return
      }
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw new Error('aborted')
        yield chunk
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, holdMs ?? 0)
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/**
 * Minimal roster stand-in: one fixed two-preset roster with the mount, select,
 * and recorded-composition reads the bridge consumes. Single-current, because
 * the bridge wiring tests drive one session at a time.
 */
export class StubAgentPresetRegistry {
  static readonly USABLE = ['standard', 'minimal']

  current: string | undefined = 'standard'
  /** The id `resolve()` falls back to; the real roster reads this from config. */
  default = 'standard'
  readonly mounted: (string | undefined)[] = []
  readonly selected: string[] = []
  /** When set, the next `select` rejects with this failure. */
  selectFailure: RemoteError | undefined
  /** Per-agent plan-mode state, standing in for the preset realm's controller. */
  readonly realmPlanModes = new Map<unknown, StubRealmPlanMode>()

  private row(id: string, extra: Partial<AgentPresetRow> = {}): AgentPresetRow {
    return { id, isDefault: id === 'standard', ...extra }
  }

  async resolve(id?: string): Promise<AgentPresetRow> {
    if (id !== undefined && !StubAgentPresetRegistry.USABLE.includes(id)) {
      throw new RemoteError('agent-preset/not-found', `preset "${id}" not found`, { agentPreset: id, available: StubAgentPresetRegistry.USABLE })
    }
    return this.row(id ?? this.default)
  }

  async mount(_agentCtx: unknown, id?: string): Promise<AgentPresetRow> {
    const preset = await this.resolve(id)
    this.mounted.push(preset.id)
    this.current = preset.id
    return preset
  }

  composedPreset(): string | undefined {
    return this.current
  }

  /**
   * The per-agent realm read the real roster serves from the preset's
   * entry-local isolate: the mounted composition's own plan-mode instance,
   * invisible to the agent's scope context.
   */
  serviceFor(agent: unknown, name: string): StubRealmPlanMode | undefined {
    if (name !== 'planMode') return undefined
    let state = this.realmPlanModes.get(agent)
    if (state === undefined) {
      state = new StubRealmPlanMode()
      this.realmPlanModes.set(agent, state)
    }
    return state
  }

  async list(): Promise<AgentPresetRow[]> {
    return [
      this.row('standard', { name: 'Standard' }),
      this.row('minimal', { name: 'Minimal', description: 'Two tools' }),
      this.row('broken', { broken: 'composition failed' }),
    ]
  }

  async select(_agent: unknown, id: string): Promise<string> {
    if (this.selectFailure !== undefined) throw this.selectFailure
    if (!StubAgentPresetRegistry.USABLE.includes(id)) {
      throw new RemoteError('agent-preset/not-found', `preset "${id}" not found`, { agentPreset: id, available: StubAgentPresetRegistry.USABLE })
    }
    this.selected.push(id)
    this.current = id
    return id
  }
}

/**
 * Minimal plan-mode stand-in for the preset realm: the same get/set surface
 * the bridge consumes, tracked per agent by {@link StubAgentPresetRegistry.serviceFor}.
 */
export class StubRealmPlanMode {
  active = false
  readonly setCalls: boolean[] = []

  get(): { active: boolean } {
    return { active: this.active }
  }

  set(_agent: unknown, active: boolean): void {
    this.active = active
    this.setCalls.push(active)
  }
}

/**
 * Minimal permission-preset stand-in: the shipped three-preset table with a
 * per-session current value, mirroring the composed workspace-write default.
 */
export class StubPermissionPresets {
  static readonly TABLE = ['read-only', 'workspace-write', 'danger-full-access']

  private readonly currentBySession = new Map<unknown, string>()

  current(session: unknown): string {
    return this.currentBySession.get(session) ?? 'workspace-write'
  }

  get names(): readonly string[] {
    return StubPermissionPresets.TABLE
  }

  optionOf(name: string): { value: string; name: string; description?: string } {
    const descriptions: Record<string, string> = {
      'read-only': 'Read-only inspection.',
      'workspace-write': 'Write inside the workspace.',
      'danger-full-access': 'Full access without approval prompts.',
    }
    const known = StubPermissionPresets.TABLE.includes(name)
    return {
      value: name,
      name,
      ...descriptions[name] === undefined ? { description: 'Current settings match no preset.' } : { description: descriptions[name] },
      ...known ? {} : { name: 'Custom' },
    }
  }

  set(session: unknown, name: string): void {
    if (!StubPermissionPresets.TABLE.includes(name)) {
      throw new Error(`permission: unknown preset "${name}" (known: ${StubPermissionPresets.TABLE.join(', ')})`)
    }
    this.currentBySession.set(session, name)
  }
}

/**
 * Minimal skill-registry stand-in: the merged, name-sorted summary list plus
 * the invocation-policy half the command roster reads. `failure` reproduces a
 * provider that cannot be collected, which must not take the roster down.
 */
export class StubSkillRegistry {
  /** Summaries the merged catalog reports, in registry order. */
  summaries: { name: string; description: string; invocation: { userInvocable: boolean; modelInvocable: boolean } }[] = []
  /** When set, `list` rejects with this failure instead of answering. */
  failure: Error | undefined
  /** The cwd values `list` was called with, for scope assertions. */
  readonly cwds: (string | undefined)[] = []

  async list(options?: { cwd?: string; signal?: AbortSignal }): Promise<typeof this.summaries> {
    this.cwds.push(options?.cwd)
    if (this.failure !== undefined) throw this.failure
    return this.summaries
  }
}

/** The stub cast the bridge consumes; service typing stays on the real class. */
export interface BridgeHarnessPresets {
  /** The stub's membership state, for assertions. */
  readonly stub: StubAgentPresetRegistry
}

/**
 * Minimal command-registry stand-in: the roster `available_commands_update`
 * publishes plus the executor `session/prompt` dispatches into. Mirrors the
 * real grammar — an unregistered name declines, so the caller keeps the line as
 * prose — and records every executed line so a test can assert the handler ran
 * without the model ever seeing the prompt.
 */
export class StubCommandRegistry {
  /** Registered command names, in the order the roster reports them. */
  readonly names: string[] = []
  /** Every line a resolved command executed, in order. */
  readonly executed: string[] = []
  /** When set, `execute` rejects with this failure instead of settling. */
  failure: Error | undefined
  /** The text the executor settles with, per registered name. */
  readonly results = new Map<string, { kind: 'success'; text?: string } | { kind: 'error'; text: string }>()

  /** Register one command name the executor will resolve. */
  register(name: string, result: { kind: 'success'; text?: string } | { kind: 'error'; text: string }): void {
    this.names.push(name)
    this.results.set(name, result)
  }

  list(): { name: string; description: string }[] {
    return this.names.map(name => ({ name, description: `stub command ${name}` }))
  }

  async execute(_agent: unknown, line: string, _attachments: readonly unknown[], _signal: AbortSignal): Promise<{
    commandId: string
    result: { kind: 'success'; text?: string } | { kind: 'error'; text: string }
  } | undefined> {
    if (this.failure !== undefined) throw this.failure
    const name = /^\/([a-z][a-z0-9_-]*)/u.exec(line)?.[1]
    if (name === undefined || !this.results.has(name)) return undefined
    this.executed.push(line)
    return { commandId: `cmd-${this.executed.length}`, result: this.results.get(name)! }
  }
}

/** In-memory durable store for ACP wire-order and lifecycle tests. */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []
  readonly objects = new Map<string, StoredImageAttachment>()
  beforeValidate: (() => Promise<void>) | undefined
  beforeRead: (() => Promise<void>) | undefined

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.beforeValidate?.()
    if (input.data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.objects.set(ref.attachmentId, { ref, data: Uint8Array.from(input.data) })
    return Promise.resolve(ref)
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    await this.beforeRead?.()
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    return { ref: stored.ref, data: Uint8Array.from(stored.data) }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response ending at the output-token ceiling. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

export type CapturedUpdate = SessionNotification['update']

/** Stable-v1 client methods exercised by the bridge tests. */
interface BridgeClient {
  initialize: NonNullable<AcpAgent['initialize']>
  authenticate: NonNullable<AcpAgent['authenticate']>
  newSession: NonNullable<AcpAgent['newSession']>
  listSessions: NonNullable<AcpAgent['listSessions']>
  loadSession: NonNullable<AcpAgent['loadSession']>
  resumeSession: NonNullable<AcpAgent['resumeSession']>
  closeSession: NonNullable<AcpAgent['closeSession']>
  setSessionConfigOption: NonNullable<AcpAgent['setSessionConfigOption']>
  setSessionMode: NonNullable<AcpAgent['setSessionMode']>
  forkSession: (params: ForkSessionRequest) => Promise<ForkSessionResponse>
  prompt: (params: PromptRequest, options?: SendRequestOptions) => Promise<PromptResponse>
  cancel: NonNullable<AcpAgent['cancel']>
  /** The custom `_session/steering` extension method. */
  steer: (params: AcpSteeringRequest) => Promise<AcpSteeringOutcome>
}

export interface BridgeHarness {
  ctx: Context
  client: BridgeClient
  adapter: MockAdapter
  attachments: MemoryAttachmentStore | undefined
  updates: CapturedUpdate[]
  sessionUpdates: { sessionId: string; update: CapturedUpdate }[]
  /** The mounted stub roster; undefined unless the harness option mounted one. */
  presets: StubAgentPresetRegistry | undefined
  /** The mounted stub permission service; undefined unless the option mounted one. */
  permissions: StubPermissionPresets | undefined
  /** The mounted stub skill registry; undefined unless the option mounted one. */
  skills: StubSkillRegistry | undefined
  /** The mounted stub command registry; undefined unless the option mounted one. */
  commands: StubCommandRegistry | undefined
  permissionRequests: RequestPermissionRequest[]
  elicitationRequests: CreateElicitationRequest[]
  persistenceRoot: string
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onElicitation: (request: CreateElicitationRequest) => CreateElicitationResponse
  onSessionUpdateError: (() => void) | undefined
  registerCatalogProvider: (provider: string) => () => void
  replacePrimaryProviders: (providers: string[]) => void
  closeClientTransport: () => Promise<void>
  abortClientTransport: () => Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  /** The AgentLoop fiber, so a test can reload the loop out from under the bridge. */
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
}

type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

/**
 * Read one stored session's complete committed log.
 *
 * A live session buffers its committed events until the durability barrier, so
 * a read handle sees nothing until the session is flushed — the same reason
 * `AcpSession.fork` flushes a live source before reading it. Tests that assert
 * on durable state must go through this helper or flush themselves.
 * @param ctx - harness context carrying the persistence service.
 * @param sessionId - the stored session to read.
 * @returns the session's committed events in seq order.
 */
export async function readSessionLog(ctx: Context, sessionId: string): Promise<readonly SessionEvent[]> {
  const id = SessionId(sessionId)
  const live = ctx.sessions.get(id)
  if (live !== undefined) await ctx.sessions.flush(live)
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read(0, undefined)).events
  } finally {
    await handle.close()
  }
}

/** Build the bridge and a connected SDK client over cross-wired byte streams. */
export async function makeBridgeHarness(options: {
  script?: ScriptedResponse[]
  config?: AcpConfigOverrides
  persona?: string
  imageCapable?: boolean
  attachments?: boolean
  persistenceRoot?: string
  /** Mount the plan-mode service, as the shipped dsh-base bundle does. */
  planMode?: boolean
  /** Mount the user-questions service, as the shipped dsh-base bundle does. */
  userQuestions?: boolean
  /** Mount the stub preset roster, as the shipped acp bundle does. */
  presets?: boolean
  /** Mount the stub permission-preset service, as the shipped dsh-base bundle does. */
  permissions?: boolean
  /** Provide the agent-default-model service, as the shipped dsh-base bundle does. */
  defaultModel?: { provider: string; model: string }
  /** Mount the stub skill registry, as a deployment mounting dsh-skill does. */
  skills?: boolean
  /** Mount the stub command registry, as the shipped dsh-base bundle does. */
  commands?: boolean
} = {}): Promise<BridgeHarness> {
  const adapter = new MockAdapter(options.script ?? [], options.imageCapable === true)
  const ctx = new Context()
  const ownsPersistenceRoot = options.persistenceRoot === undefined
  const persistenceRoot = options.persistenceRoot ?? await mkdtemp(join(tmpdir(), 'dsh-acp-test-'))
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: options.persona ?? '' } })
  // mountAgentLoopTestDependencies mounts the SessionProjectionRegistry (the
  // loop and the composed approval/permission services require it) together
  // with the LLM runtime, session store, system prompt, tools, and agents.
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(TokenMeter)
  if (options.attachments !== false) await ctx.plugin(MemoryAttachmentStore)
  if (options.planMode === true) {
    await ctx.plugin(PlanModeController, { section: 'Test plan guidance: stay in plan mode.' })
  }
  if (options.userQuestions === true) await ctx.plugin(UserQuestionService)
  const stubPresets = options.presets === true ? new StubAgentPresetRegistry() : undefined
  if (stubPresets !== undefined) {
    ctx.provide('agentPresets', stubPresets as never)
    // The real roster registers this projection on activation; the stub cannot.
    ctx.sessionProjections.register(agentPresetProjectionDefinition)
  }
  const stubPermissions = options.permissions === true ? new StubPermissionPresets() : undefined
  if (stubPermissions !== undefined) ctx.provide('permissionPresets', stubPermissions as unknown as PermissionPresetService)
  const stubSkills = options.skills === true ? new StubSkillRegistry() : undefined
  if (stubSkills !== undefined) ctx.provide('skills', stubSkills as never)
  const stubCommands = options.commands === true ? new StubCommandRegistry() : undefined
  if (stubCommands !== undefined) ctx.provide('commands', stubCommands as never)
  if (options.defaultModel !== undefined) {
    // The real service reads volatile per-profile settings; the stub detaches one fixed selection.
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ ...options.defaultModel }) } as never)
  }
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const primaryAdapter = ctx.llm.registerAdapter(['mock'], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const sessionUpdates: { sessionId: string; update: CapturedUpdate }[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const elicitationRequests: CreateElicitationRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    attachments: ctx.get('attachments') as MemoryAttachmentStore | undefined,
    updates,
    sessionUpdates,
    permissionRequests,
    elicitationRequests,
    presets: stubPresets,
    permissions: stubPermissions,
    skills: stubSkills,
    commands: stubCommands,
    persistenceRoot,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    onElicitation: () => ({ action: 'cancel' }),
    onSessionUpdateError: undefined,
    registerCatalogProvider: provider => ctx.llm.registerAdapter([provider], new MockAdapter([], false, provider)),
    replacePrimaryProviders: (providers) => { primaryAdapter.replace(providers) },
    client: undefined as unknown as BridgeClient,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    closeClientTransport: async () => { await clientToAgentWriter.close() },
    abortClientTransport: async () => { await clientToAgentWriter.abort(new Error('client transport failed')) },
    dispose: async () => {
      await ctx.fiber.dispose()
      if (ownsPersistenceRoot) await rm(persistenceRoot, { recursive: true, force: true })
    },
  }

  const clientApp = createAcpClientApp({ name: 'dsh-acp-test-client' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
      if (harness.onSessionUpdateError !== undefined) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params)
      return Promise.resolve(harness.onPermission(params))
    })
    .onRequest(methods.client.elicitation.create, ({ params }) => {
      elicitationRequests.push(params)
      return Promise.resolve(harness.onElicitation(params))
    })

  const config = { stream: agentStream, ...options.config } as AcpConfig
  if (!(options.config && 'provider' in options.config)) config.provider = 'mock'
  if (!(options.config && 'model' in options.config)) config.model = 'mock'
  // Preference persistence defaults into the per-harness tmpdir so bridge
  // tests never touch the developer's real ~/.dsh preference file — including
  // an explicitly-undefined override, which must not fall through to the
  // production default path.
  if (options.config?.modelPreferencePath === undefined) {
    config.modelPreferencePath = join(persistenceRoot, 'reasoning-efforts.json')
  }
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
  })
  const clientConnection = clientApp.connect(clientStream)
  const client = clientConnection.agent
  harness.client = {
    initialize: params => client.request(methods.agent.initialize, params),
    authenticate: params => client.request(methods.agent.authenticate, params),
    newSession: params => client.request(methods.agent.session.new, params),
    listSessions: params => client.request(methods.agent.session.list, params),
    loadSession: params => client.request(methods.agent.session.load, params),
    resumeSession: params => client.request(methods.agent.session.resume, params),
    closeSession: params => client.request(methods.agent.session.close, params),
    setSessionConfigOption: params => client.request(methods.agent.session.setConfigOption, params),
    setSessionMode: params => client.request(methods.agent.session.setMode, params),
    forkSession: params => client.request(methods.agent.session.fork, params),
    prompt: (params, options) => client.request(methods.agent.session.prompt, params, options),
    cancel: params => client.notify(methods.agent.session.cancel, params),
    steer: params => client.request<AcpSteeringOutcome, AcpSteeringRequest>(ACP_STEERING_METHOD, params),
  }
  return harness
}
