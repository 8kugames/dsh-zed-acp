/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { formatTokenCount, statsMeta, type SessionStats, type TurnStats } from './stats.ts'
import type {
  AvailableCommand,
  PlanEntry,
  SessionConfigOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'
import { acpSkillCommands, type SkillCatalog } from './skills.ts'

/** The advertised default mode id. */
export const DEFAULT_MODE_ID = 'default'

/** The advertised plan-mode id, backed by the plan-mode service. */
export const PLAN_MODE_ID = 'plan'

/**
 * Client display-terminal presentation resolved once per connection: whether
 * the client advertised Zed's display-terminal extension
 * (`clientCapabilities._meta.terminal_output === true`) at initialize, plus
 * the session working directory embedded on the terminals it renders.
 */
export interface TerminalPresentation {
  /** Whether the client renders `_meta.terminal_output` display terminals. */
  readonly enabled: boolean
  /** Session working directory advertised on embedded display terminals. */
  readonly cwd: string | undefined
}

/**
 * Per-call presentation state carried from a committed `tool/call` to its
 * `tool/result`: whether the call's `tool_call` update embedded a display
 * terminal, and the file locations recovered from its arguments.
 */
export interface ProjectedToolCall {
  /** Whether the call's `tool_call` update embedded a display terminal. */
  readonly terminal: boolean
  /** File locations replayed on the completing `tool_call_update`. */
  readonly locations: ToolCallLocation[] | undefined
}

/**
 * Shipped tool names with an unambiguous standard kind. A name absent here
 * reports `other`; MCP and deployment-specific tools keep that default.
 */
const TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map([
  ['edit', 'edit'],
  ['write', 'edit'],
  ['str_replace_editor', 'edit'],
  ['read', 'read'],
  ['read_image', 'read'],
  ['glob', 'search'],
  ['grep', 'search'],
  ['bash', 'execute'],
  ['pwsh', 'execute'],
  ['run_code', 'execute'],
  ['terminal_send', 'execute'],
  ['job_output', 'read'],
  ['job_list', 'read'],
  ['job_kill', 'execute'],
  ['web_search', 'fetch'],
  ['web_fetch', 'fetch'],
  ['exit_plan_mode', 'switch_mode'],
])

/**
 * Resolve the standard tool kind for one committed tool-call name.
 * @param name - committed DSH tool-call name.
 * @returns the mapped standard kind, or `other` for unmapped names.
 */
export function toolKindFor(name: string): ToolKind {
  return TOOL_KINDS.get(name) ?? 'other'
}

/** Title cap so a huge pasted script never rides the ACP wire as a display label. */
const MAX_COMMAND_TITLE = 200

/**
 * Salient string argument fields, probed in order. Each mirrors a shipped
 * tool's own `presentCall` intent (`bash`.command, the reserved `run_code`
 * PTC transport's `code` body, `glob`/`grep`.pattern, `web_fetch`.url,
 * `read`/`write`/`edit`.file_path, `subagent`.description); the
 * `web_search` `queries` string array is probed separately below. `code` is
 * listed before the prose-shape fields so a tool whose call carries both
 * `code` and `description` (the `run_code` contract) renders the executed
 * body rather than the human-facing summary in the title strip.
 */
const SALIENT_TITLE_FIELDS = ['command', 'code', 'pattern', 'url', 'file_path', 'description'] as const

/**
 * Derive one tool call's human-readable ACP title from its committed fact.
 * ponytail: titles follow the tools' declared `presentCall` intent only where it
 * is recoverable from the committed event — the salient string argument fields
 * above (plus `queries` arrays), collapsed to one line and capped, without the
 * presenters' verb prefixes (the ACP `kind` icon carries the category). Any
 * other shape falls back to the tool name; full presentation parity (verb
 * titles, locations, structured result cards) would need registry access the
 * pure event projection deliberately lacks.
 * @param name - committed DSH tool-call name.
 * @param rawArguments - raw `arguments` JSON string exactly as the model produced it.
 * @returns the salient argument text when recognizable, otherwise the tool name.
 */
export function toolCallTitle(name: string, rawArguments: string): string {
  const parsed = parseToolArguments(rawArguments)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return name
  const args = parsed as Record<string, unknown>
  const salient: string[] = []
  if (Array.isArray(args.queries)) {
    const joined = args.queries
      .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
      .join(', ')
    if (joined.length > 0) salient.push(joined)
  }
  for (const field of SALIENT_TITLE_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value.trim().length > 0) salient.push(value)
  }
  if (salient.length === 0) return name
  const oneLine = salient[0].replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_COMMAND_TITLE ? `${oneLine.slice(0, MAX_COMMAND_TITLE - 1)}…` : oneLine
}

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Convert one committed human prompt into block-ordered user-message chunks.
 * The caller filters synthetic `user/message` injections (file-change notices,
 * skill content) that were never client-visible; only blocks the client could
 * have echoed live are replayable.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed user message event.
 * @returns ordered standard user-message chunk updates.
 */
export async function userMessageUpdates(
  ctx: Context,
  event: SessionEvent<'user/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.content) {
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'user_message_chunk',
        messageId: event.data.id,
        content,
      })
    }
  }
  return updates
}

/**
 * Derive one tool call's follow-along location from its committed arguments.
 * Each shipped file tool names its target `file_path`; the remaining probe
 * keys cover registry and MCP tools that use the common alternatives. The
 * first match wins and only file-shaped fields are probed — a `url` is not a
 * location.
 * @param rawArguments - raw `arguments` JSON string exactly as the model produced it.
 * @returns the single resolved location, or `undefined` when none is recognizable.
 */
function toolCallLocations(rawArguments: string): ToolCallLocation[] | undefined {
  const parsed = parseToolArguments(rawArguments)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  for (const field of ['path', 'file_path', 'filePath', 'file'] as const) {
    const path = args[field]
    if (typeof path === 'string' && path.trim().length > 0) return [{ path }]
  }
  return undefined
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 *
 * Follow-along `locations` ride every call that names a file argument. When
 * the client advertised the display-terminal extension and the tool's kind is
 * `execute`, the call instead embeds a presentation terminal — the standard
 * `terminal` content block identifying the display, plus the `_meta`
 * `terminal_info` Zed's renderer reads; execution itself stays in DSH.
 * @param event - committed DSH tool-call event.
 * @param terminal - connection-level display-terminal presentation, when negotiated.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(
  event: SessionEvent<'tool/call'>,
  terminal?: TerminalPresentation,
): Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> {
  const kind = toolKindFor(event.data.name)
  const locations = toolCallLocations(event.data.arguments)
  const displayTerminal = terminal?.enabled === true && kind === 'execute'
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: toolCallTitle(event.data.name, event.data.arguments),
    kind,
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
    ...(locations === undefined ? {} : { locations }),
    ...(displayTerminal
      ? {
        content: [{ type: 'terminal' as const, terminalId: event.data.callId }],
        _meta: {
          terminal_info: {
            terminal_id: event.data.callId,
            ...(terminal?.cwd === undefined ? {} : { cwd: terminal.cwd }),
          },
        },
      }
      : {}),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 *
 * A successful result whose tool attached the shared file-diff `meta` payload
 * (the `write`/`edit` tools) projects it as standard `diff` content before the
 * committed text blocks, so ACP clients render the applied change natively.
 *
 * A call that embedded a display terminal settles on the terminal instead:
 * the captured output streams onto it as one `_meta` `terminal_output` payload,
 * then the paired `terminal_exit` update closes it with the exit status while
 * the raw output stays machine-accessible as `rawOutput` — content stays empty
 * because the terminal is the presentation. Calls without a display terminal
 * (or clients that never advertised it) keep the plain content projection.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @param call - per-call presentation state from the call's own update, when one was projected.
 * @returns the ordered completing tool-call updates.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
  call?: ProjectedToolCall,
): Promise<SessionUpdate[]> {
  const message = event.data.message
  const failed = message.isError === true
  if (call?.terminal === true) {
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    const updates: SessionUpdate[] = []
    if (text.length > 0) {
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: message.toolCallId,
        _meta: { terminal_output: { terminal_id: message.toolCallId, data: text } },
      })
    }
    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: message.toolCallId,
      status: failed ? 'failed' : 'completed',
      rawOutput: { output: text, isError: failed },
      ...(call.locations === undefined ? {} : { locations: call.locations }),
      _meta: { terminal_exit: { terminal_id: message.toolCallId, exit_code: failed ? 1 : 0, signal: null } },
    })
    return updates
  }
  const content: ToolCallContent[] = []
  if (message.isError !== true) {
    for (const diff of fileDiffsFromMeta(event.data.meta) ?? []) {
      content.push({ type: 'diff', path: diff.path, oldText: diff.oldText, newText: diff.newText })
    }
  }
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return [{
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: failed ? 'failed' : 'completed',
    content,
    ...(call?.locations === undefined ? {} : { locations: call.locations }),
  }]
}

/**
 * Narrow a durable tool-result `meta` payload to non-empty shared file diffs.
 * The payload is opaque at the durable boundary; malformed or absent data
 * yields `undefined` so the update keeps its text-only projection.
 * @param meta - opaque committed result metadata.
 * @returns validated applied file diffs, or `undefined` for absent or malformed data.
 */
function fileDiffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const narrowed: FileDiff[] = []
  for (const diff of diffs) {
    if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return undefined
    const { path, oldText, newText } = diff as Record<string, unknown>
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') {
      return undefined
    }
    narrowed.push({ path, oldText, newText })
  }
  return narrowed
}

/** Report the session's current context occupancy when both facts are available. */
export function contextUsage(
  ctx: Context,
  session: Session,
): { used: number; size: number } | undefined {
  const meter = ctx.get('tokenMeter')
  const size = session.requestContext()?.contextWindow
  if (meter === undefined || size === undefined) return undefined
  return { used: meter.measure(session).totalTokens, size }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  return contextUsageUpdate(ctx, session)
}

/**
 * One refresh-shaped `usage_update` carrying the meter's current context
 * occupancy: used and size only, the same shape a mid-turn assistant message
 * rides. The single construction site for every non-terminal usage refresh
 * (assistant-message delivery and compaction checkpoints alike).
 * @param ctx - bridge context carrying the token-meter service.
 * @param session - durable session whose occupancy is measured.
 * @returns the update, or undefined without both facts.
 */
export function contextUsageUpdate(ctx: Context, session: Session): SessionUpdate | undefined {
  const usage = contextUsage(ctx, session)
  if (usage === undefined) return undefined
  return { sessionUpdate: 'usage_update', used: usage.used, size: usage.size }
}

/**
 * The turn-end `usage_update`: fresh occupancy plus the session's cumulative
 * cost and the machine-readable `dsh` `_meta` extension. The single
 * construction site for the terminal usage projection.
 * @param usage - current context occupancy facts.
 * @param session - session-lifetime totals for the cumulative cost.
 * @param turn - the settling turn's statistics for the `_meta` payload.
 * @returns the completed update.
 */
export function turnEndUsageUpdate(
  usage: { used: number; size: number },
  session: SessionStats,
  turn: TurnStats,
): SessionUpdate {
  return {
    sessionUpdate: 'usage_update',
    used: usage.used,
    size: usage.size,
    ...(session.cost === undefined ? {} : {
      cost: { amount: session.cost.amount, currency: session.cost.currency },
    }),
    _meta: statsMeta(turn, session),
  }
}

/**
 * Wrap one assembled option state as the standard config-option update. The
 * single construction site for `config_option_update`.
 * @param configOptions - the complete assembled option state.
 * @returns the update.
 */
export function configOptionUpdate(configOptions: SessionConfigOption[]): SessionUpdate {
  return { sessionUpdate: 'config_option_update', configOptions }
}

/**
 * Project the finalized turn statistics as one collapsed read-kind tool card:
 * a synthetic `tool_call` immediately settled by its completing
 * `tool_call_update` carrying the card's markdown text. Unlike an agent
 * message, clients render this in their tool timeline instead of the chat
 * stream, so the card stays visible without polluting the conversation, and
 * it never enters the durable DSH session.
 * @param toolCallId - bridge-owned synthetic id, unique per turn.
 * @param title - card row title (clients show it while collapsed).
 * @param text - the card's markdown text.
 * @returns the ordered card lifecycle updates.
 */
export function turnStatsCard(
  toolCallId: string,
  title: string,
  text: string,
): [
  Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
] {
  return [
    {
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind: 'read',
      status: 'in_progress',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
    },
  ]
}

/** Fixed card title for one live continuable-subagent activity period. */
export const DESCENDANT_ACTIVITY_TITLE = 'Background subagent'

/** How long one activity period may stay event-silent before the progress card says so. */
export const DESCENDANT_STALL_WARN_MS = 120_000

/** Reconciliation cadence while any descendant is tracked: re-reads the agents'
 * mirrored `status` and refreshes elapsed/stall lines on open cards. */
export const DESCENDANT_RECONCILE_MS = 15_000

/** Map one durable `turn/end` reason to delegated-task fate, shared by the live
 * settle path and the reload fate projector so the two can never disagree. */
export function turnEndToFate(kind: string): 'completed' | 'failed' {
  return kind === 'completed' || kind === 'max-tokens' || kind === 'forked' ? 'completed' : 'failed'
}

/** Facts one open activity card renders between its opening and its settle. */
export interface DescendantProgress {
  /** Latest tool-call title or assistant one-liner, when anything ran yet. */
  activity: string | undefined
  /** Wall time since this activity period opened. */
  elapsedMs: number
  /** Wall time since the descendant's last committed event. */
  silentMs: number
  /** Prompt tokens accumulated by the descendant, once any call reported usage. */
  inputTokens: number | undefined
  outputTokens: number | undefined
}

/** Compact elapsed-time rendering for progress lines: `42s`, `2m 14s`, `1h 05m`. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Wrap one activity line as a markdown code span that survives embedded
 * backticks: the delimiter is one longer than the text's longest backtick run,
 * with padding spaces, per CommonMark. Without this, a command like
 * `` echo `date` `` would close the span early and smear the remainder into
 * the rendered card body.
 */
function codeSpan(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  if (longest === 0) return `\`${text}\``
  const delim = '`'.repeat(longest + 1)
  return `${delim} ${text} ${delim}`
}

/**
 * Render one activity period's live progress snapshot as the card body text.
 * The card title carries the task; this body replaces wholesale on every
 * update (`tool_call_update` patch semantics), so it stays a two-to-three-line
 * "latest fact" readout rather than an append-only log.
 */
export function descendantProgressText(progress: DescendantProgress): string {
  const lines: string[] = []
  lines.push(progress.activity === undefined ? '_working…_' : codeSpan(progress.activity))
  const meta = [`elapsed ${formatElapsed(progress.elapsedMs)}`]
  if (progress.inputTokens !== undefined && progress.outputTokens !== undefined) {
    meta.push(`in ${formatTokenCount(progress.inputTokens)}`, `out ${formatTokenCount(progress.outputTokens)}`)
  }
  lines.push(meta.join(' · '))
  if (progress.silentMs >= DESCENDANT_STALL_WARN_MS) {
    lines.push('', `**stalled** — no events for ${formatElapsed(progress.silentMs)}`)
  }
  return lines.join('\n')
}

/**
 * Open one continuable-subagent activity period as a synthetic tool card on the
 * parent session: `in_progress` from the descendant agent's creation until
 * that activity period ends (idle or disposed). Like the turn-statistics card
 * it never enters the durable DSH session, so a reloaded client does not
 * replay it; the deferred reload projector for descendant history reuses this
 * constructor against persisted descendant logs. The title starts generic and
 * is patched to the descendant's own first user message once that commits.
 * ponytail: before the first `user/message` the task text is unknown — the
 * spawn correlation is temporal-adjacency guessing under parallel spawns.
 * @param toolCallId - bridge-owned synthetic id, unique per activity period.
 * @param title - learned task title when the descendant already surfaced one.
 * @returns the opening `tool_call` update.
 */
export function descendantActivityOpen(
  toolCallId: string,
  title: string | undefined,
): Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: title === undefined || title.length === 0 ? DESCENDANT_ACTIVITY_TITLE : title,
    kind: 'other',
    status: 'in_progress',
  }
}

/**
 * Patch one open card's title (patch semantics: a lone `title` field changes
 * nothing else), used when the descendant's first user message commits after
 * the activity period already opened.
 * @param toolCallId - the open card's bridge-owned synthetic id.
 * @param title - the learned task title.
 * @returns the title-only `tool_call_update`.
 */
export function descendantActivityTitle(
  toolCallId: string,
  title: string,
): Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> {
  return { sessionUpdate: 'tool_call_update', toolCallId, title }
}

/**
 * Replace one open card's body with the latest progress snapshot. `status` is
 * deliberately omitted (patch semantics), so the card stays `in_progress` and
 * only its content moves.
 * @param toolCallId - the open card's bridge-owned synthetic id.
 * @param text - the rendered snapshot, from {@link descendantProgressText}.
 * @returns the content-only `tool_call_update`.
 */
export function descendantActivityProgress(
  toolCallId: string,
  text: string,
): Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    content: [{ type: 'content', content: { type: 'text', text } }],
  }
}

/**
 * Settle one open descendant-activity card with delegated-task fidelity: the
 * outcome follows the descendant's own last `turn/end` (unknown fate keeps the
 * historical `completed` default), and the summary is its last assistant line.
 * @param toolCallId - the same bridge-owned synthetic id.
 * @param outcome - the period's fate, defaulting to `completed`.
 * @param summary - the descendant's last assistant one-liner, when it produced one.
 * @returns the settling `tool_call_update`.
 */
export function descendantActivitySettle(
  toolCallId: string,
  outcome: 'completed' | 'failed' = 'completed',
  summary: string | undefined = undefined,
): Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: outcome,
    ...(summary === undefined || summary.length === 0 ? {} : {
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: summary } }],
    }),
  }
}

/**
 * Derive one reload-time fate card from a persisted descendant session's
 * event log: the task title from its first user message, the fate from its
 * last `turn/end`, and an optional summary from its last assistant message.
 * Like the other synthetic cards this never enters the durable DSH session;
 * it is projected only onto the reloaded client view.
 *
 * Fate mapping follows delegated-task semantics rather than prompt-stop
 * semantics: `completed`, `max-tokens` (task turn ran to its ceiling), and
 * `forked` (boundary closure) settle `completed`; `interrupted` (the durable
 * closer a crash-orphaned turn receives on resume), `aborted` (a cancellation
 * request stopped the live turn — the task did not run to completion),
 * `blocked`, and `error` settle `failed`. A log with events but no `turn/end`
 * reads as `failed` defensively.
 * ponytail: the summary is the raw assistant tail without any transformation;
 * a structured outcome card would need the descendant tool surface, which the
 * child log's projection here deliberately does not interpret.
 * @param sessionId - the descendant session id, for the synthetic card id.
 * @param events - the descendant session's complete persisted event log.
 * @returns the ordered card lifecycle pair, or `undefined` when the log shows
 * no work at all (no events worth surfacing).
 */
export function descendantHistoryFromEvents(
  sessionId: string,
  events: readonly SessionEvent[],
): [
  Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
] | undefined {
  let title: string | undefined
  let summary: string | undefined
  let fate: 'completed' | 'failed' | undefined
  for (const event of events) {
    if (event.type === 'user/message' && title === undefined) {
      title = oneLineText(event.data.content) ?? title
    } else if (event.type === 'assistant/message') {
      summary = oneLineText(event.data.message.content) ?? summary
    } else if (event.type === 'turn/end') {
      fate = turnEndToFate(event.data.reason.kind)
    }
  }
  if (fate === undefined && title === undefined && summary === undefined) return undefined
  const toolCallId = `dsh-subagent-${sessionId}`
  return [
    {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: title === undefined || title.length === 0 ? DESCENDANT_ACTIVITY_TITLE : title,
      kind: 'other',
      status: 'in_progress',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: fate ?? 'failed',
      ...(summary === undefined || summary.length === 0 ? {} : {
        content: [{ type: 'content' as const, content: { type: 'text' as const, text: summary } }],
      }),
    },
  ]
}

/** Collapse one message's text blocks into a single capped line. */
export function oneLineText(blocks: readonly { type: string }[]): string | undefined {
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return undefined
  return text.length > MAX_COMMAND_TITLE ? `${text.slice(0, MAX_COMMAND_TITLE - 1)}…` : text
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}

/**
 * Project a committed plan-mode switch as the standard current-mode update.
 * @param event - committed DSH plan-mode event.
 * @returns the `current_mode_update` naming the activated advertised mode.
 */
export function currentModeUpdate(event: SessionEvent<'plan/mode'>): SessionUpdate {
  return {
    sessionUpdate: 'current_mode_update',
    currentModeId: event.data.active ? PLAN_MODE_ID : DEFAULT_MODE_ID,
  }
}

/**
 * Project a committed whole-list todo snapshot as the standard ACP plan. DSH's
 * `TodoItem` carries no priority, so every entry reports `medium`; an entry
 * without usable content is dropped rather than surfaced as an empty task,
 * and an unrecognized status falls back to `pending`.
 * @param event - committed DSH `todo/write` snapshot.
 * @returns the `plan` update replacing the client's whole plan list.
 */
export function todoPlanUpdate(event: SessionEvent<'todo/write'>): SessionUpdate {
  const entries = event.data.todos
    .filter((todo): todo is TodoItem & { content: string } =>
      typeof todo?.content === 'string' && todo.content.trim().length > 0)
    .map((todo): PlanEntry => ({
      content: todo.content,
      priority: 'medium',
      status: todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending',
    }))
  return { sessionUpdate: 'plan', entries }
}

/**
 * Project a committed session-title snapshot as the standard session-info
 * update so titling clients surface the harness's own generated titles.
 * @param event - committed DSH `session/title` event.
 * @returns the `session_info_update` carrying the latest title.
 */
export function sessionTitleUpdate(event: SessionEvent<'session/title'>): SessionUpdate {
  return { sessionUpdate: 'session_info_update', title: event.data.title }
}

/**
 * Project the host command registry's effective descriptors for one agent as
 * the standard available-commands update. DSH's unstructured `input` hint maps
 * one-to-one onto ACP's `AvailableCommandInput`. Same-name entries cannot
 * occur under the registry's own contract (`list` returns name-sorted
 * descriptors after scoped shadowing), so the keep-first dedupe below is a
 * defensive guard, not a shadowing rule; if `list` ever emits duplicates, the
 * first listing wins under its current shadow-resolved order.
 *
 * User-invocable skills ride the same update, appended after the command
 * entries so a real command always owns its name. A deployment that composes
 * no command registry but does mount a skill registry still publishes; only
 * two absent-or-empty catalogs yield `undefined`.
 * @param commands - host command registry, when the deployment composes one.
 * @param skills - skill registry, when the deployment composes one.
 * @param agent - exact receiving agent and scoped-layer key.
 * @param cwd - workspace root the skill catalog is collected for, when the session header records one.
 * @param warn - diagnostic sink for a failed skill catalog read.
 * @param signal - optional catalog cancellation.
 * @returns the `available_commands_update`, or `undefined` with nothing to advertise.
 */
export async function availableCommandsUpdate(
  commands: Pick<CommandRuntime, 'list'> | undefined,
  skills: SkillCatalog | undefined,
  agent: Agent,
  cwd: string | undefined,
  warn: (message: string) => void,
  signal?: AbortSignal,
): Promise<SessionUpdate | undefined> {
  const seen = new Set<string>()
  const availableCommands: AvailableCommand[] = []
  for (const descriptor of commands?.list(agent) ?? []) {
    if (seen.has(descriptor.name)) continue
    seen.add(descriptor.name)
    availableCommands.push({
      name: descriptor.name,
      description: descriptor.description,
      ...(descriptor.input === undefined ? {} : { input: { hint: descriptor.input.hint } }),
    })
  }
  for (const skill of await acpSkillCommands(skills, cwd, warn, signal)) {
    // A command of the same name already claimed this slot; the host registry
    // stays authoritative for its own namespace.
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    availableCommands.push(skill)
  }
  if (commands === undefined && skills === undefined) return undefined
  return { sessionUpdate: 'available_commands_update', availableCommands }
}
