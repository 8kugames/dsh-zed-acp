/**
 * Slash commands over ACP `session/prompt`.
 *
 * `available_commands_update` already advertises the host command registry's
 * roster to every client, but a standard ACP client submits a chosen command as
 * an ordinary `session/prompt` line — there is no standard ACP method for
 * running one. Sending that line to the model makes a host-plane operation
 * depend on the model choosing to call a tool for it, which is two failure
 * modes this bridge can remove outright:
 *
 * - a tool call is gated by whatever review/approval policy the deployment
 *   mounts, so a command can be refused before its body runs;
 * - the tool call consumes the model route, so it fails outright whenever that
 *   route is rate-limited, throttled, or unreachable.
 *
 * `/goal pause` is the case that matters: it is the only in-band way to stop an
 * autonomous goal run, and routing it through the model made "stop the storm"
 * depend on the very channel the storm was burning.
 *
 * This module recognizes a command line and reports the handler's result; the
 * bridge's session owns the dispatch, the output ordering, and the stop reason.
 * @module @8kugames/dsh-zed-acp/commands
 */

import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'

/**
 * The registry's own line grammar, mirrored.
 *
 * The registry re-parses the line it is handed, so this pattern only decides
 * whether to *offer* the prompt as a command; it never decides what the command
 * means. Mirroring it keeps an unrecognized shape (a leading capital, a
 * `/`glued to its argument, a multi-block prompt) on the prose path it already
 * takes today instead of swallowing it.
 */
const COMMAND_LINE = /^\/[a-z][a-z0-9_-]*(?=$|[\t\n\r ])/u

/**
 * Read one prompt as a candidate slash-command line.
 *
 * Only a prompt that is a single text block qualifies. A multi-block prompt
 * carries attachments or mixed content, and the registry's attachment admission
 * is a separate contract this bridge does not reimplement here; such a prompt
 * stays prose and reaches the model exactly as before.
 * @param prompt - the client's standard prompt content blocks.
 * @returns the trimmed command line, or `undefined` for ordinary prose.
 */
export function acpCommandLine(prompt: readonly ContentBlock[]): string | undefined {
  if (prompt.length !== 1) return undefined
  const block = prompt[0]
  if (block?.type !== 'text') return undefined
  const line = block.text.trim()
  return COMMAND_LINE.test(line) ? line : undefined
}

/**
 * Project one settled command result as the assistant text the client shows.
 *
 * The handler's text is already a complete, user-facing sentence, so it is
 * carried verbatim. A success with no text produces no chunk: the registry
 * models "said nothing" as a real outcome, and inventing a placeholder would
 * put a line in the client's transcript that no handler wrote.
 *
 * The execution's pairing id becomes the chunk's `messageId`, so a client
 * groups the whole result under one message and can correlate it with the
 * `command/run` / `command/done` records the registry appended to the log.
 * @param execution - one settled command execution.
 * @returns the update, or `undefined` when the result carries no text.
 */
export function commandResultUpdate(execution: CommandExecution): SessionUpdate | undefined {
  const text = execution.result.text
  if (text === undefined) return undefined
  return {
    sessionUpdate: 'agent_message_chunk',
    messageId: execution.commandId,
    content: { type: 'text', text },
  }
}