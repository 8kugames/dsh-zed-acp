# Use DeepSeek Harness in Zed

English | [中文](zed-acp.zh.md)

This tutorial connects the [Zed](https://zed.dev) editor to DeepSeek Harness over the [Agent Client Protocol](https://agentclientprotocol.com), so Zed's agent panel drives a harness agent in your workspace. After the setup below you can prompt the agent from Zed, switch between the default and plan modes, approve tool work and plan reviews in place, and reopen earlier sessions from Zed's session history.

## Prerequisites

- [Zed](https://zed.dev/download)
- Node.js `^22.19` or `>=24`
- A [DeepSeek API key](https://platform.deepseek.com/) exported as `DEEPSEEK_API_KEY`

## Add the agent server

Install the CLI pinned to the version the plugin targets, add the Zed ACP plugin to a profile, and register the profile in your Zed `settings.json`:

```sh
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
dsh plugin --profile zed add @8kugames/dsh-zed-acp
```

The npm `latest` tag of the CLI may trail the version the plugin targets, and the plugin's compatibility gate refuses older dsh at install time, so the command above pins the version. The plugin installs from the npm registry; to track the branch carrying unreleased work instead, install the repository ref (`dsh plugin --profile zed add "github:8kugames/dsh-zed-acp#zed-acp"`).

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "zed"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

Zed launches the agent as a subprocess and speaks the Agent Client Protocol over its stdio. The first launch initializes the `zed` profile under the harness home, and the plugin's bundle patch mounts the Zed-oriented ACP server over the harness base composition. The plugin ships no runtime of its own: every harness module loads from the installed dsh, so upgrading dsh upgrades the agent. Adding the plugin to the shipped automation profile instead — `dsh plugin --profile acp add @8kugames/dsh-zed-acp` — also works: the patch disables that profile's automation-only ACP transport so exactly one server owns stdio. `env` entries override the environment Zed passes through, so the key can live here or in your shell environment; a key in either place is resolved the same way.

## Plugin configuration

Every option below is optional; defaults cover a plain install. A deployment sets them on the plugin's `zed-acp` row in the profile's own `cordis.patch.yml` overlay (`$DSH_HOME/profiles/zed/cordis.patch.yml`):

```yaml
- id: zed-acp
  config:
    provider: my-gateway # with model: the exact route every new session starts on
    model: my-model
    apiKeyEnv: MY_GATEWAY_API_KEY # credential env var `authenticate` resolves
    prices: # per-model rates, per 1M tokens
      defaultCurrency: CNY # billing currency; drives the unpriced placeholder
      models:
        - id: my-model
          hit: 0.01
          miss: 0.2
          out: 0.5
          currency: CNY
    sessionListPageSize: 100 # max sessions per session/list page
    modelPreferencePath: ~/.dsh/zed-acp-reasoning-efforts.json
    imageInputs: auto # auto | true | false
```

- `provider` + `model` — when both are set, every new session starts pinned to this exact route instead of the composition's default model. Omit both to follow the composition's agent-default-model selection.
- `apiKeyEnv` — the environment variable the `authenticate` handshake resolves (default `DEEPSEEK_API_KEY`); it must name the same variable the composed LLM provider reads its key from.
- `sessionListPageSize` — maximum sessions one `session/list` page returns (default `100`, positive integer).
- `modelPreferencePath` — the file reasoning-effort choices persist to across sessions (default `~/.dsh/zed-acp-reasoning-efforts.json`). Pin an absolute path when parallel installs or tests share one machine.
- `imageInputs` — whether inline image prompts are advertised: `auto` (default) only when the route a fresh session starts on declares image input; `true` is the deployment's explicit promise for adapters whose catalog omits the declaration (the per-prompt route check still refuses unsupported routes); `false` never advertises.
- `prices` — per-model pricing and the deployment's billing currency, so rates can be declared here instead of in the `DSH_ACP_PRICES` environment variable (no JSON-in-JSON escaping, and an invalid value fails at load rather than being dropped with a warning). `models` is a list of rows, one per served model id (`- id: …`, matching the overlay's provider-routing rows), each mapping that id to `{ hit, miss, out, currency? }` per-1M rates; ids must be unique or the schema rejects the block at load: `hit` is input served from the prefix cache, `miss` is uncached input plus cache writes, `out` is output; `currency` is an ISO 4217 code defaulting to CNY, and these flat rates apply at every hour (no peak/off-peak split). Ids are matched case-sensitively against the served id, so copy it from the model id shown in the turn-stats card title — a mismatched id is silently treated as unpriced. `defaultCurrency` (default CNY) is the currency the unpriced placeholder renders, consulted only when the session has no priced turn to learn one from — it is not the currency entries price in, and an entry's own `currency` still has its own default. Symbols come from one table shared by priced amounts and the placeholder (USD `$0.0123`, CNY `¥1.5000`, EUR `€1.5000`); a code without its own entry borrows the default currency's symbol, so a currency never has two shapes. When both `prices` and `DSH_ACP_PRICES` are set, the config block wins and the environment variable is reported as ignored in the log — including when `prices` only declares `defaultCurrency`, in which case move your rates into `prices.models` or drop the block.

## Authenticate and prompt

Open Zed's agent panel and select **DeepSeek Harness**. The first use authenticates against the configured API key: a missing or unusable key returns an explained error instead of a session. Once authenticated, type a task and the agent streams its answer, tool calls, and results into the panel.

The harness agent reads one workspace: the directory Zed opens becomes the session's working directory. Zed's MCP servers are forwarded to the harness, which mounts the HTTP ones it supports.

## Pick an agent preset

The panel's configuration picker offers the deployment's agent presets — the shipped **标准模式 (Standard)**, **PTC 模式**, **极简模式**, and **创造模式 (Authoring)**, plus any presets authored as `@deepseek-ai/dsh-agent-preset` declaration rows in the profile's own `cordis.patch.yml` overlay (`$DSH_HOME/profiles/zed/cordis.patch.yml`). The preset decides the agent's tools, prompt, and skills; pick it before the first message of a session, because a session locks its preset once it has produced output.

## Change the permission mode

The panel's configuration picker also carries a **Permissions** select showing the presets by their product labels — **仅可查看 (Read Only)**, **工作区内修改 (Workspace Write)**, the default, and **完全权限 (Full Access)**. Unlike the agent preset, the permission mode is a live switch — the next tool call runs under the newly selected sandbox and approval settings.

## Switch between default and plan modes

The mode picker in the agent panel offers **Default** and **Plan**. Plan mode is the harness plan-mode service: the agent explores read-only and ends with `exit_plan_mode`, which Zed presents as an approval prompt with **Approve** and **Keep planning** choices. Approving leaves plan mode and the agent carries out the plan from its next step; you can also switch the mode back manually at any time. A mode switch that happens while the agent is working is applied at the next step boundary.

## Reopen earlier sessions

Sessions persist under the harness home, so the session history in Zed lists earlier root sessions from the same working directory. Reopening one loads it through ACP `session/load`: the bridge replays the stored conversation into the panel as `session/update` notifications before the load response, and the next prompt continues that same durable session.

## Watch background subagents

When the agent delegates to a continuable subagent (`backgroundMode: continuable`), the spawned work outlives the tool call that started it, so the bridge keeps the turn open until every background descendant goes idle — the panel keeps its busy state instead of reporting the request as finished while work continues. Each activity period surfaces as one synthetic tool card: it opens titled `Background subagent`, takes the descendant's own task text as its title once its first user message commits, and its body keeps a live readout — the current tool activity or latest assistant line, accumulated prompt/output tokens, elapsed time, and a `stalled` warning once the descendant goes event-silent past two minutes. When the period ends, the card settles with the child's real fate (`failed` for an errored or aborted turn, `completed` otherwise) and its last assistant line. Cancelling settles the turn promptly and leaves the still-running work visible as open cards. A reconciliation pass — driven by every descendant input and a periodic timer — re-reads each agent's mirrored `status`, so a missed terminal event or a stray post-disposal status can no longer wedge the turn; genuinely running descendants stay held by design, with the stall warning surfacing them for cancellation. Reopening the session later replays each descendant's persisted fate from the child session's own log — interrupted or crashed work settles as `failed`, finished work as `completed` — so an interrupted delegation cannot pass as the early-settled spawn call's success. A descendant that wakes again after the turn fully settled only opens a new card; it does not reopen the finished turn.

## Fork from a reply

ACP `session/fork` copies an existing session into an independent new one and leaves the source completely untouched. When the client sends `_meta.jetbrains.air.fork` in the request (version 1, `inclusive`), the new session keeps the **selected assistant message and everything before it** and drops everything after it — which is exactly "branch from this reply".

`messageId` is that message's ACP id (`<turn>:<step>`; a streamed segment id `<turn>:<step>:segment:<n>` also resolves to the whole message). If a reused counter makes an id point at a different message, pin it with `messageFingerprint` (`sha256:` plus the SHA-256 of the assistant's visible text); `messageOccurrence` (1-based) disambiguates a repeated fingerprint.

Tool calls on the selected message are removed from the copied message: their results are recorded after it, so keeping the calls alone would be an illegal transcript and would let the child's `session/load` replay run past the fork point. Earlier calls and results are kept as they were.

A fork point that cannot be found, a fingerprint that disagrees, or an unsupported version all return `invalidParams` — and never silently degrade into a whole-session copy, which would branch from the wrong place with nothing to notice.

A forked child is a platform-native fork seed (`isSeeded` plus the exact inherited prefix length) with its open tail closed by `buildForkSeed`, so it never inherits a half-open turn and it is listable, reopenable, and promptable exactly like any other root session. A fork inherits the conversation, not route state: forking a session pinned to a non-default model lands on the composition default. The fork response carries the child's full `configOptions` so you can change it before prompting.

## Steer a running turn

While a `session/prompt` is in flight, a client can send the custom extension method `_session/steering` to add one more message to that same turn — no cancel-and-restart, and no second request. The message is consumed at the turn's next step boundary, and **the request that made the `session/prompt` still owns the turn**: its output stream and stop reason are unchanged.

- `{ "outcome": "injected" }` — the message joined the running turn.
- `{ "outcome": "promptRequired", "reason": "noRunningTurn" }` — there was no turn to join (no prompt started yet, or the turn already ended). The client sends an ordinary `session/prompt` in that case.

The bridge only calls the agent's injection primitive when a turn is genuinely running; it never starts a turn on the client's behalf, because a turn with no waiting request would have no owner for its stop reason, its cost, or its output stream.

One caveat: a model call still in flight has no step boundary yet, so a steered message waits in the inbox until the next one, and cancelling the turn in that window discards it. Content admission is the same path `session/prompt` takes, so a block this connection never advertised (an inline image, for instance) is refused there too.

Support is advertised as `_meta.steering.supported` in `initialize`. A client that never sends `_session/steering` is unaffected.

## Use skill slash commands

When the deployment composes `@deepseek-ai/dsh-skill`, the bridge merges the registry's `userInvocable` skills into the slash-command roster (`available_commands_update`) alongside the host command registry's entries — and the command registry keeps a colliding name. The `modelInvocable` half is the model's, not yours, and stays out of the menu.

A skill needs no dispatch from the bridge: typing `/skill-name` in a message is the harness's own invocation gesture, so what the bridge adds is discoverability. Listing reads summaries only, never a skill body.

This plugin's bundle leaves the composition alone. In the default `zed` profile `skill-filesystem` (the local provider) and `tool-skill` (the model-facing tool) are still disabled, so a deployment has to mount a provider to see any skills. A failed catalog read only logs a warning; the command roster still ships.

## Serve self-configured models

The Model select lists the live provider directory of the profile behind this agent (`dsh --profile zed`). dsh mounts `dsh-llm-pi-ai` dormant in the base composition: it registers no routes until a settings section or patch declares provider profiles, and settings sections are per-profile — models configured on another profile's Models page never reach this one.

Declare the routes where the zed profile sees them. `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`) applies above every profile's own patch, so one declaration serves all profiles; `~/.dsh/profiles/zed/cordis.patch.yml` scopes them to Zed only:

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

Restart the agent after editing; the routes register live, and their models appear as new groups in the Model select alongside DeepSeek.

## Troubleshoot

- **The Model select misses self-configured models** — they were configured on another profile, and settings sections are per-profile; see [Serve self-configured models](#serve-self-configured-models).
- **Authentication errors name `DEEPSEEK_API_KEY`** — the key is missing or unusable in the environment Zed passed to the agent process. Fix the `env` block or your shell export.
- **No agent response and the log shows non-protocol output** — run `dev: open acp logs` from the command palette. Only JSON-RPC frames may appear on the agent's stdout; a leaked log line is a harness bug, not a Zed one.
- **A prompt fails with a model error while Zed shows the agent as connected** — the session was created before a valid key existed; re-authenticate or restart the agent server from the panel.

## The ACP registry

Zed also installs agents from the [ACP registry](https://zed.dev/blog/acp-registry), which lists one manifest per agent and resolves installs for every ACP client. The plugin ships its prepared registry manifest (`registry/agent.json` in the plugin package); until that listing ships, use the manual configuration above.
