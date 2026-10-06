# @8kugames/dsh-zed-acp

English | [中文](docs/README.zh.md)

A Zed-oriented [Agent Client Protocol](https://agentclientprotocol.com/) server for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as a
freely installable dsh plugin. It turns `dsh` into an external agent that
[Zed](https://zed.dev) (or any ACP client) can drive: streamed answers and
reasoning, tool calls with real diffs, plan mode, agent presets, permission
presets, session history, and MCP servers.

Built and tested against dsh `0.2.0-rc.2`. The plugin composes over the
installed harness — it ships no runtime of its own and never pins your key in
editor config.

## Install

Prerequisites: [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) pinned to the version the plugin targets (`npm i -g @deepseek-ai/dsh@0.2.0-rc.2` — the npm `latest` tag may trail it), Node `^22.19 || >=24`, and Zed.

Install from the npm registry:

```sh
dsh plugin --profile zed add @8kugames/dsh-zed-acp
```

Re-run the same `add` command to update an existing install — a profile restart alone does not pick up files the previously installed version did not ship (the preset declarations under `presets/` are one such addition).

To track a branch instead of a release (for example while a change awaits publication), install from the repository ref:

```sh
dsh plugin --profile zed add "github:8kugames/dsh-zed-acp#zed-acp"
```

The per-feature walkthrough (modes, presets, permissions, sessions, troubleshooting) lives in [docs/zed-acp.md](docs/zed-acp.md).

### Install from a local clone

The `prepare` npm hook builds `dist/` during `npm install`, so a clone needs no separate build step. After `git clone https://github.com/8kugames/dsh-zed-acp.git`, install the clone through a pnpm symlink (a `link:` install reflects local edits on the next agent restart; `file:` copies and caches same-version tarballs instead):

```sh
dsh plugin --profile zed add -w "link:/absolute/path/to/dsh-zed-acp"
```

For development on the clone itself — tests, typecheck, rebuilds — run `npm install` once, then the usual `npm run typecheck` / `npm test` / `npm run build`.

Then point Zed at the profile (Zed → Settings → AI → External Agents, or
`settings.json`):

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "zed"],
      "env": {
        "DEEPSEEK_API_KEY": "<your key>",
      },
    },
  },
}
```

The first launch initializes `~/.dsh/profiles/zed`. Alternatively add the
plugin to the shipped automation profile — `dsh plugin --profile acp add
@8kugames/dsh-zed-acp` — the bundle patch disables the shipped
automation-only ACP transport so exactly one server owns stdio.

## What it adds over the shipped `dsh --profile acp`

|                      | shipped `acp` profile                          | this plugin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions             | `new` / `list` / `resume` / `close`            | same, plus per-session **titles** in `session/list`, live `session_info_update` from the harness's own title events, and **full-history reload** via `session/load` (stored-log replay through the same projection as live streaming)                                                                                                                                                                                                                                                                              |
| Background subagents | invisible; the turn ends when the parent idles | the prompt stays open while continuable subagents work, each activity projects a synthetic tool card with a live progress body (current activity, tokens, elapsed, stall warning) titled by the descendant's own task text, settling with the child's real fate (completed/failed) and last line, backed by a reconciliation pass that re-reads the agents' mirrored status so a missed terminal event can no longer wedge the turn; `session/load` replays their persisted fate from the child sessions' own logs; a turn that ends while descendants still work is woken again with a continuation under the same open prompt once they settle, so a delegating agent can read their results instead of holding its own turn open |
| Auth                 | accepted, unchecked                            | `deepseek-api-key` method; `authenticate` validates the credential and explains what is missing                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Modes                | —                                              | `default` / `plan` via `session/set_mode` with `current_mode_update`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Config options       | `model`, `reasoning_effort`                    | plus **`preset`** (agent presets) and **`permission`** (sandbox/approval presets, localized labels)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Questions            | —                                              | single-choice `ask_user_question` (plan review) rides `session/request_permission`; a client advertising form elicitation also gets a synthesized **Other** escape that collects free text via `elicitation/create`, and option-less questions become free-text forms                                                                                                                                                                                                                                              |
| Plan                 | —                                              | the agent's `todo` snapshots project as ACP `plan` updates, so the client renders its native plan panel                                                                                                                                                                                                                                                                                                                                                                                                            |
| Slash commands       | —                                              | `available_commands_update` lists the host command registry's effective roster per session, and a `session/prompt` line the registry resolves **runs on the host plane** — no model turn, no tool gate, so `/goal pause` still works while the model route is rate-limited                                                                                                                                                                                                                                              |
| Tool calls           | generic `other` kind                           | standard kinds (`edit`/`read`/`search`/`execute`/`fetch`/`switch_mode`), follow-along **`locations`**, and native **file diffs** from `write`/`edit` results                                                                                                                                                                                                                                                                                                                                                       |
| Terminals            | —                                              | command tool calls embed a **display terminal** (Zed's `terminal_output` extension) when the client advertises it; everyone else keeps the plain text projection                                                                                                                                                                                                                                                                                                                                                   |
| Presets              | host-plane tools                               | the web-style split: model-facing rows move into each preset's composition (`standard`/`ptc`/`minimal`/`cordis`)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Fork                 | —                                              | `session/fork` over the platform's native seed lineage, plus the `jetbrains.air.fork` v1 extension that keeps the selected assistant message and drops everything after it                                                                                                                                                                                                                                                                                                                                         |
| Steering             | —                                              | `_session/steering` injects a follow-up into the running turn at its next step boundary; the client's open `session/prompt` keeps the turn, its output stream, and its stop reason                                                                                                                                                                                                                                                                                                                                 |
| Skills               | —                                              | the `@deepseek-ai/dsh-skill` registry's `userInvocable` entries join the same `available_commands_update` roster as the host commands, commands winning any name collision                                                                                                                                                                                                                                                                                                                                         |

## Fork, steering, and skills

`session/fork` is advertised as `sessionCapabilities.fork`. Without an
extension block in `_meta` it copies the source session's whole committed log
into a new independent session and never touches the source. With
`_meta.jetbrains.air.fork` (version 1, `inclusive`) the new session keeps the
selected assistant message and everything before it. The message is named by
`messageId` (`<turn>:<step>`, or a `<turn>:<step>:segment:<n>` segment id that
resolves to the whole message), optionally pinned with
`messageFingerprint` (`sha256:` + the SHA-256 of the assistant's visible text)
and disambiguated by a 1-based `messageOccurrence`. Tool calls on the selected
message are stripped from the copy, because their results are logged after it
and keeping the calls alone would be an illegal transcript. A fork point that
cannot be resolved is `invalidParams` — never a silent whole-session copy.

A forked child is a platform fork seed (`isSeeded` plus the exact inherited
prefix length) whose open tail `buildForkSeed` closes with `forked` results and
step/turn endings, so it never inherits a half-open turn. Fork lineage sets
`parentSession` but not `origin: 'subagent'`, which is what keeps the branch a
first-class root: listable, loadable, resumable, and promptable. A fork
inherits the conversation, not the route — forking a session pinned to a
non-default model lands on the composition default, and the response carries
the child's full `configOptions` so you can change it first.

`_session/steering` is a custom extension method advertised as
`_meta.steering.supported`. It adds one message to a turn that is already
running, consumed at that turn's next step boundary, and answers
`{ outcome: "injected" }` or
`{ outcome: "promptRequired", reason: "noRunningTurn" }`. The bridge never
starts a turn on the client's behalf: a turn with no waiting request would have
no owner for its stop reason, cost, or output stream.

Skills need no dispatch — `/skill-name` is the harness's own invocation
gesture, so the bridge only adds discoverability by listing the registry's
`userInvocable` entries. This plugin's bundle leaves the composition alone: in
the default `zed` profile `skill-filesystem` and `tool-skill` are still
disabled, so a deployment mounts a provider to see any skills.

## Turn statistics and cost

Every ACP-prompt turn that settles normally ends with a collapsed turn-stats tool card followed — whenever the context facts are available — by a final `usage_update` carrying cumulative session cost and a machine-readable `dsh` `_meta` extension (per-turn and session-lifetime token and timing facts). The card is a synthetic read-kind tool call in the client's tool timeline — never an agent message — so it stays out of the chat stream and never enters the durable DSH session; because expansion is a client-side decision the protocol cannot force, the collapsed title strip itself carries the one-line usage summary (`↑ 45.2k · ↓ 1.2k · $0.0123`, or a currency-styled placeholder — `$--` for USD, `¥--` for CNY, `€--` for EUR, and the default currency's symbol for any other ISO code — for a model missing from the price table), so the facts are visible without clicking. The body is a single two-column table (`metric` / `value`) rendering the token split (cache read / cache write / uncached), the prefix-cache hit rate for the turn and the session (DeepSeek's hit bucket over all three input buckets), output tokens, model and tool time, average first-token latency, decode speed, and turn plus session cost — no stray lines outside it. Zed keeps its native context bar on `used`/`size`; the card surfaces the facts Zed's native display does not render, and other ACP clients may ignore `_meta` per the protocol's extensibility rules. Cancelled or failed turns settle without a card.

Definitions follow dsh's own statistics (`dsh-token-meter` buckets and the harness UI's session stats). dsh maps `TokenUsage.inputTokens` onto its own `uncachedInputTokens`, so the uncached-input figure is never netted against cache reads, and the three prompt buckets are disjoint. Model time is `step/start → assistant/message` per model call; tool time is `tool/call → tool/result`; TTFT is `step/start → first token delta`; and output speed is `first token delta → assistant/message` computed over the steps that recorded **both** that window and their output tokens, so a step without stream timing contributes no rate instead of skewing one. All timings come from committed event times, not projection-time sampling, so they are identical on replay.

Cost uses DeepSeek's published list prices (CNY per 1M tokens, from https://api-docs.deepseek.com/zh-cn/quick_start/pricing/): `deepseek-flash` peak ¥0.04 hit / ¥2 miss / ¥8 out and `deepseek-v4-pro` peak ¥0.3 / ¥9 / ¥27, with off-peak hours billed at exactly half (peak = 09:00–12:00 and 14:00–18:00 Beijing time, weekdays). Retired ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` resolve to `deepseek-flash`. Cache writes bill at the miss rate, matching DeepSeek's billing. The Chinese-public-holiday exclusion is not modeled; unlisted models report no cost.

Declare pricing in the plugin's `prices` config block, on the `zed-acp` row of the profile overlay — no escaping, and an invalid value fails at load instead of being dropped:

```yaml
- id: zed-acp
  config:
    prices:
      defaultCurrency: CNY
      models:
        - id: my-model
          hit: 0.01
          miss: 0.2
          out: 0.5
          currency: CNY
        - id: my-other-model
          hit: 0.1
          miss: 1
          out: 2
          currency: CNY
```

`models` is a list of rows, one per served model id — the same `- id: …` shape the provider routes in _Custom, non-DeepSeek models_ below use. Ids must be unique; a duplicated id fails the schema at load.

Rates are per 1M tokens: `hit` is input served from the prefix cache, `miss` is uncached input plus cache writes, `out` is output. Flat rates apply at every hour (no peak/off-peak split) and shadow the built-in tiers for the same id. An entry's `currency` is an ISO 4217 code defaulting to CNY, matching the built-in prices; write `USD` explicitly for dollar-denominated rates. `defaultCurrency` (default CNY) is the currency the unpriced placeholder renders, consulted only when the session has no priced turn to learn one from: CNY renders `¥--`, USD `$--`, EUR `€--`. Priced amounts use the same symbols — `$0.0123`, `¥1.5000`, `€1.5000`. A code without its own entry borrows the default currency's symbol, falling back to the code form only when the default itself has none — so one currency never has two shapes. Types and non-negative rates are rejected by the plugin schema at load, while a bad currency code or an unknown key is rejected by the price parser; both stop the plugin from starting rather than being silently dropped.

**Model ids are matched case-sensitively against the served id.** Copy the id from the model shown in the turn-stats card title: a mismatched id is silently treated as unpriced, which is the most common reason cost stays empty.

`DSH_ACP_PRICES` remains supported for deployments that already use it — a JSON object of the same flat rates plus a top-level `$defaultCurrency` meta key (its keys are `$`-prefixed precisely so they are never read as model ids). In that path a malformed value is **all-or-nothing**: the whole document is dropped, the built-in table stands, and one `DSH_ACP_PRICES ignored: …` warning is logged. When both sources are set, the `prices` block wins and the environment variable is reported as ignored.

Cumulative totals cover live turns since the agent process opened the session — resuming a session or restarting Zed starts a fresh tally. Cancelled and failed turns settle without the final update.

## Compatibility

Peer ranges declare `~0.2.0-rc.2`: any dsh in the 0.2.x line from
`0.2.0-rc.2` on is accepted; dsh's profile boot checks them at install and
boot and names an incompatible plugin loudly. All `@deepseek-ai/*` modules
load from the host installation — the plugin ships no runtime.

Client-facing extensions degrade gracefully: the display terminal, plan,
session-title, and slash-command projections use only standard ACP updates
except the terminal itself, which activates solely when the client advertises
Zed's `terminal_output` capability at `initialize` — non-advertising clients
never see a terminal-shaped update and keep the plain tool-result content.

## Custom, non-DeepSeek models

The Model select lists the live provider directory of the profile Zed launches (`dsh --profile zed`). Provider routes configured on another profile's Models page (for example the `web` profile) live in that profile's settings — dsh settings sections are per-profile and do not carry over.

To serve self-configured providers (any `dsh-llm-pi-ai` route: OpenAI-compatible gateways, self-hosted servers), declare them where every profile sees them — `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`), applied above each profile's own patch:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:
        apiKeyEnv: MY_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        models:
          - id: my-model
            name: My Model
            contextWindow: 200000
```

Restart the agent after editing: the routes register live and their models join the Model select. To scope them to Zed only, put the same row in `~/.dsh/profiles/zed/cordis.patch.yml` instead.

## Development

```sh
npm install         # pinned dev deps provide the dsh types and test services
npm run typecheck   # tsc --noEmit
npm test            # vitest: the bridge suite boots real cordis scopes, no model calls
npm run build       # esbuild → dist/
```

Iterate against a live profile through a pnpm symlink (`file:` copies and
caches same-version tarballs; `link:` avoids both):

```sh
dsh plugin --profile zed-dev add -w "link:$PWD"   # from the repository root
```

The dev loop is `npm run build` + restart the Zed agent. For poking a live bridge by hand over stdio JSON-RPC, `scripts/acp-probe.mjs` is a minimal manual probe (no arguments; not part of the test suite).

## Release

1. Bump `version` in `package.json` and `registry/agent.json` together.
2. Commit, then push the tag: `git tag zed-acp-v<version> && git push origin zed-acp-v<version>`.
3. The workflow `.github/workflows/zed-acp.yml` runs the three-platform test
   matrix on the tag and publishes to npm when `NPM_TOKEN` is configured; it
   asserts that the tag matches both manifest versions.

## License

MIT. This package derives from `deepseek-harness` (MIT, Copyright (c) 2026
DeepSeek); see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for
attribution details.
