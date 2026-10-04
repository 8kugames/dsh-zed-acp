/**
 * User-invocable skills projected into the standard available-commands roster.
 *
 * A skill is a reusable, task-specific instruction body that `@deepseek-ai/dsh-skill`
 * merges from every mounted provider. Each entry carries a two-boolean
 * invocation policy: `modelInvocable` gates the model-facing catalog
 * (`dsh-tool-skill`) and `userInvocable` gates the user-facing command list,
 * so one discovery pass can serve both interfaces without conflating them.
 *
 * This module reads only the `userInvocable` half. A skill needs no dispatch
 * here: `/name` in a user message is the harness's own invocation gesture, so
 * typing it runs through the agent loop without the bridge intercepting
 * anything. What the bridge owes the client is discoverability — without this
 * projection a user-invocable skill is absent from the client's slash-command
 * menu even though it works.
 *
 * ponytail: listing reads summaries only, never a skill body — `SkillSummary`
 * carries no instruction text, and the registry's own load path stays the
 * single owner of body retrieval. Upgrade path: advertise a skill's `path`
 * as an ACP resource link once clients render them.
 * @module @8kugames/dsh-zed-acp/skills
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { errorChain } from '@deepseek-ai/dsh-llm'

/**
 * The one skill-summary field the roster reads. Narrowed from the registry's
 * `SkillSummary`, whose `source`/`provider` lineage and `path` pointer are
 * discovery details this projection has no use for.
 */
export interface SkillCatalogEntry {
  /** Exact kebab-case skill name, invoked as `/name`. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Resolved invocation controls; only the user half is read here. */
  readonly invocation: { readonly userInvocable: boolean }
}

/**
 * The minimal skill-registry surface the command roster reads. Narrowed from
 * `SkillRegistry` so a deployment can satisfy it without the bridge depending
 * on the registry package at runtime, mirroring how the command roster narrows
 * `CommandRuntime` to `list`.
 */
export interface SkillCatalog {
  /** List invocation-neutral summaries for a workspace. */
  list(options?: { cwd?: string; signal?: AbortSignal }): Promise<readonly SkillCatalogEntry[]>
}

/** The `input` hint every skill entry advertises, mirroring openma's roster. */
const SKILL_INPUT_HINT = 'instructions for the skill'

/**
 * Project the registry's user-invocable skills as standard ACP commands.
 *
 * Order follows the registry's own name-sorted catalog, and a same-name skill
 * never displaces a real command: the caller merges this list *after* the host
 * command registry, so the registry's contract (one winner per name after
 * scoped shadowing) keeps owning collisions. The keep-first dedupe below is the
 * defensive guard for a catalog that ever reports the same name twice.
 * @param skills - the skill registry, when the deployment composes one.
 * @param cwd - workspace root the catalog is collected for, when the session header records one.
 * @param warn - diagnostic sink for a failed catalog read.
 * @param signal - optional cancellation observed by the catalog read.
 * @returns one command per user-invocable skill, empty without a registry.
 */
export async function acpSkillCommands(
  skills: SkillCatalog | undefined,
  cwd: string | undefined,
  warn: (message: string) => void,
  signal?: AbortSignal,
): Promise<AvailableCommand[]> {
  if (skills === undefined) return []
  let summaries: readonly SkillCatalogEntry[]
  try {
    summaries = await skills.list({ ...cwd === undefined ? {} : { cwd }, ...signal === undefined ? {} : { signal } })
  } catch (error: unknown) {
    // A failing or partially-observable provider must not take the whole
    // command roster down: the registry keeps its last usable catalog, and the
    // host command entries still reach the client.
    warn(`acp: skill catalog read failed: ${errorChain(error)}`)
    return []
  }
  const seen = new Set<string>()
  const commands: AvailableCommand[] = []
  for (const skill of summaries) {
    if (skill.invocation.userInvocable !== true) continue
    const name = skill.name?.trim()
    if (typeof name !== 'string' || name.length === 0) continue
    if (seen.has(name)) continue
    seen.add(name)
    commands.push({
      name,
      description: skill.description,
      input: { hint: SKILL_INPUT_HINT },
    })
  }
  return commands
}
