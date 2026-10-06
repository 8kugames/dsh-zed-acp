# 在 Zed 中使用 DeepSeek Harness

[English](zed-acp.md) | 中文

本教程把 [Zed](https://zed.dev) 编辑器通过 [Agent Client Protocol（ACP）](https://agentclientprotocol.com) 接入 DeepSeek Harness，由 Zed 的 agent 面板驱动你工作区中的 harness agent。完成下面的设置后，你可以在 Zed 中向 agent 发送任务、在默认模式与计划模式之间切换、就地批准工具操作与计划评审，并从 Zed 的会话历史中重新打开早期会话。

## 前置条件

- [Zed](https://zed.dev/download)
- Node.js `^22.19` 或 `>=24`
- 一个 [DeepSeek API key](https://platform.deepseek.com/)，导出为 `DEEPSEEK_API_KEY`

## 添加 agent server

把 CLI 钉到插件对应的版本，把 Zed ACP 插件装进一个 profile，再在 Zed 的 `settings.json` 中注册该 profile：

```sh
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
dsh plugin --profile zed add @8kugames/dsh-zed-acp
```

CLI 的 npm `latest` 标签可能落后于插件对应的版本，而且插件的兼容门会在安装时拒绝更旧的 dsh，所以上面的命令钉住了版本。插件从 npm registry 安装；若要跟踪携带未发布改动的分支，改用仓库 ref 安装（`dsh plugin --profile zed add "github:8kugames/dsh-zed-acp#zed-acp"`）。

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

Zed 以子进程方式启动 agent，并通过其 stdio 交谈 Agent Client Protocol。首次启动会在 harness home 下初始化 `zed` profile，插件的 bundle 补丁会把面向 Zed 的 ACP 服务器挂载到 harness 基础组成之上。插件自身不带任何运行时：所有 harness 模块都从已安装的 dsh 加载，升级 dsh 即升级 agent。把插件装进随附的自动化 profile——`dsh plugin --profile acp add @8kugames/dsh-zed-acp`——同样可行：补丁会禁用该 profile 仅面向自动化的 ACP 传输，保证 stdio 上只有一个服务器。`env` 条目会覆盖 Zed 透传的环境，因此 key 可以放在这里或你的 shell 环境里；两处的 key 以同一方式解析。

## 插件配置

以下选项全部可省略，默认值覆盖普通安装。部署方在 profile 自己的 `cordis.patch.yml` 覆盖层（`$DSH_HOME/profiles/zed/cordis.patch.yml`）中的 `zed-acp` 行上设置它们：

```yaml
- id: zed-acp
  config:
    provider: my-gateway # 与 model 一起：每个新会话起始钉定的确切路由
    model: my-model
    apiKeyEnv: MY_GATEWAY_API_KEY # authenticate 握手解析的凭据环境变量
    prices: # 各模型费率，每 1M token
      defaultCurrency: CNY # 计价币种；决定未计价占位的形态
      models:
        - id: my-model
          hit: 0.01
          miss: 0.2
          out: 0.5
          currency: CNY
    sessionListPageSize: 100 # 每页 session/list 返回的最大会话数
    modelPreferencePath: ~/.dsh/zed-acp-reasoning-efforts.json
    imageInputs: auto # auto | true | false
```

- `provider` + `model`——两者同时设置时，每个新会话都从这条确切路由开始，而不是组合的默认模型；两者都省略则跟随组合的 agent-default-model 选择。
- `apiKeyEnv`——`authenticate` 握手解析的环境变量（默认 `DEEPSEEK_API_KEY`）；它必须与组合的 LLM provider 读取 key 的变量同名。
- `sessionListPageSize`——一页 `session/list` 返回的最大会话数（默认 `100`，正整数）。
- `modelPreferencePath`——reasoning-effort 选择跨会话持久化的文件（默认 `~/.dsh/zed-acp-reasoning-efforts.json`）。多份安装或测试共用一台机器时请钉绝对路径。
- `imageInputs`——是否播报内联图片输入：`auto`（默认）仅当新会话起始路由声明图片输入时播报；`true` 是部署方对目录缺声明的适配器的显式承诺（逐提示的路由检查仍会拒绝不支持的路由）；`false` 从不播报。
- `prices`——各模型费率与本部署的计价币种，可直接写在这里而不必用 `DSH_ACP_PRICES` 环境变量（免去 JSON 套 JSON 的转义，且写错时在加载期就报错，而不是记一条警告后整份丢弃）。`models` 是逐模型一行的列表（`- id: …`，与本覆盖层里 provider 路由的行形态一致），每行以 `{ hit, miss, out, currency? }` 声明该 id 的每 1M 费率；id 必须唯一，重复会在加载期被 schema 拒绝：`hit` 是命中前缀缓存的输入，`miss` 是未缓存输入加上缓存写入，`out` 是输出；`currency` 为 ISO 4217 码、缺省 CNY，这些扁平费率全时段生效（不分峰谷）。id 按大小写精确匹配，请从回合统计卡标题里的模型 id 逐字照抄——对不上会被静默当作未计价。`defaultCurrency`（缺省 CNY）是未计价占位渲染所用的币种，仅在会话还没有任何计价回合可学习币种时才被用到——它不是条目计价所用的币种，条目自身的 `currency` 有自己的缺省。金额与占位共用同一张符号表（USD `$0.0123`、CNY `¥1.5000`、EUR `€1.5000`）；未列入表的币种回落到 `defaultCurrency` 的符号，同一币种不会呈现两种形态。当 `prices` 与 `DSH_ACP_PRICES` 同时存在时以配置块为准，环境变量会在日志里被记为已忽略——包括 `prices` 只声明了 `defaultCurrency` 的情形，此时请把费率一并搬进 `prices.models`，或删掉该配置块。

## 认证并发送任务

打开 Zed 的 agent 面板并选择 **DeepSeek Harness**。首次使用会用配置的 API key 做认证：缺失或不可用的 key 会返回带解释的错误，而不是建立会话。认证通过后输入任务，agent 会把回答、工具调用与结果流式写入面板。

harness agent 读取一个工作区：Zed 打开的目录即会话的工作目录。Zed 的 MCP 服务器会转发给 harness，由它挂载自己支持的 HTTP 类型。

## 选择 agent 预设

面板的配置选择器提供部署的 agent 预设——随附的 **标准模式 (Standard)**、**PTC 模式**、**极简模式** 与 **创造模式**，以及用户在 profile 自己的 `cordis.patch.yml` 覆盖层（`$DSH_HOME/profiles/zed/cordis.patch.yml`）里以 `@deepseek-ai/dsh-agent-preset` 声明行创作的预设。预设决定 agent 的工具、提示词与 skills；请在本会话第一条消息之前选定，因为会话一旦产生输出就会锁定其预设。

## 更改权限模式

面板的配置选择器还带一个 **Permissions** 选择器，按产品标签显示三档预设：**仅可查看**、**工作区内修改**（默认）与**完全权限**。与 agent 预设不同，权限模式是即时切换——下一个工具调用即在新选择的沙箱与审批设置下运行。

## 在默认模式与计划模式间切换

agent 面板的模式选择器提供 **Default** 与 **Plan**。计划模式即 harness 的 plan-mode 服务：agent 只做只读探索，并以 `exit_plan_mode` 收尾，Zed 会把它呈现为带 **Approve** 与 **Keep planning** 选项的批准提示。批准后退出计划模式，agent 从下一步开始执行计划；你也可以随时手动切回默认模式。agent 工作期间发生的模式切换会在下一个步骤边界生效。

## 重新打开早期会话

会话在 harness home 下持久化，因此 Zed 的会话历史会列出同一工作目录下更早的根会话。重开时经 ACP `session/load` 加载：bridge 在 load 响应前把存储的对话以 `session/update` 通知回放进面板，下一条 prompt 继续同一个持久会话。

## 关注后台子代理

当 agent 委派 continuable 子代理（`backgroundMode: continuable`）时，被派生的工作会超出启动它的工具调用的生命周期，因此 bridge 会让回合保持打开直到全部后台后代空闲——面板维持忙碌状态，而不是在工作仍在进行时就报告请求已完成。每个活动期投射一张合成工具卡：开卡时标题为 `Background subagent`，子代理首条用户消息提交后即改为其任务文本；卡片正文维持实时读数——当前工具活动或最新助手输出行、累计输入/输出 token、耗时，以及子代理起过两分钟无事件后的 `stalled` 告警。活动期结束时，卡片按子代理的真实命运（回合出错或中止为 `failed`，否则 `completed`）结算并附其最后输出行。取消会立即结算回合，仍在运行的工作以开着的卡片保持可见。对账通道由每次后代输入与一个周期定时器双路驱动，重读每个 agent 的镜像 `status`，因此漏掉终态事件或 disposal 之后的迟到 status 都不会再卡死回合；真实仍在运行的后代按设计继续被持有，由停滞告警暴露、交由取消处置。之后重开会话时，每个后代的持久命运会从子会话自身的日志回放——被中断或崩溃的工作结算为 `failed`，完成的工作结算为 `completed`——被中断的委派无法冒充早结算 spawn 调用的成功。在后代仍在运行时结束的回合不会就此结算：待其后代空闲，bridge 会为同一张仍打开的 prompt 追加一个**续跑回合**，委派了工作的 agent 因此能读到结果并给出最终答复，而不必自己按住回合等待。该续跑有上界（每个 prompt 至多 `DESCENDANT_WAKE_LIMIT` 次），携带的是本 harness 归因的消息来源而非人类来源，prompt 的 stop reason 与费用仍取自最后一个回合；四个内置预设已在 persona 段写明这条契约，模型因此知道可以直接结束回合，而不必用阻塞式 shell 调用去等。回合完全结算后再次被唤醒的后代只会开新卡，不会重新打开已结束的回合。

## 从某条回复分叉

ACP `session/fork` 会把一个已有会话复制成一个独立的新会话，源会话完全不被改动。若客户端在请求的 `_meta` 里带上 `jetbrains.air.fork`（版本 1，`inclusive`），新会话会**保留选中的那条助手回复及其之前的所有内容**，并丢弃它之后的一切——这正是"从这条回复往下另开一条"的语义。

`messageId` 是那条回复的 ACP id（`<turn>:<step>`；流式分片 id `<turn>:<step>:segment:<n>` 也可，匹配到整条消息）。如果客户端重用了计数器导致 id 指向了另一条回复，可以用 `messageFingerprint`（`sha256:` + 助手可见文本的 SHA-256）钉死；`messageOccurrence`（从 1 开始）用于在指纹重复时消歧。

指向的回复带工具调用时，这些调用会从复制的那条消息里移除：它们的结果记录在消息之后，只留调用会构成非法转录，也会让子会话的 `session/load` 回放越过分叉点。更早的调用与结果原样保留。

找不到分叉点、指纹不符、版本不支持，一律回 `invalidParams`——**不会**悄悄退化成整会话复制，因为那样会让客户端在毫无察觉的情况下从错误的位置分叉。

分叉子会话是平台原生的 fork 血缘（`isSeeded` 加精确的继承前缀长度），经 `buildForkSeed` 补齐开放尾部，所以它不会继承半开的回合，并且与普通根会话一样可列出、可重开、可继续对话。分叉继承的是对话，不是路由状态：在非默认模型上分叉会落到组合默认模型，fork 响应里带着子会话的完整 `configOptions`，可在发 prompt 前改。

## 回合进行中追加指令

`session/prompt` 正在跑时，客户端可以发自定义扩展方法 `_session/steering` 往这一回合里追加一条消息——不需要取消重来，也不会另起一个请求。消息在当前回合的下一个步骤边界被消费，**发起 `session/prompt` 的那个请求仍然持有该回合**：它的输出流和 stop reason 不变。

- `{ "outcome": "injected" }`：消息已进入正在运行的回合。
- `{ "outcome": "promptRequired", "reason": "noRunningTurn" }`：此刻没有回合可加入（例如尚未发起 prompt，或回合已经结束）。此时由客户端发一条普通的 `session/prompt`。

bridge 只在确实有运行中的回合时才调用 agent 的注入原语，绝不替客户端开启一个没有请求在等它的回合——否则那个回合的 stop reason、费用归属和输出流都没有主人。

注意：模型调用还在进行时并没有步骤边界，追加的消息会停在收件箱里直到下一个边界；此时取消回合会丢弃它。内容准入与 `session/prompt` 完全同路，这条连接没通告的块（比如未通告的 inline 图片）同样会被拒绝。

能力通过 `initialize` 的 `_meta.steering.supported` 通告。不发 `_session/steering` 的客户端不受任何影响。

## 使用 skill 斜杠命令

当部署组合了 `@deepseek-ai/dsh-skill` 时，bridge 会把注册表里 `userInvocable` 的 skill 并进斜杠命令目录（`available_commands_update`），与宿主命令注册表的条目合并——同名时命令注册表优先。`modelInvocable` 那一半是给模型的，不进用户菜单。

skill 不需要 bridge 派发：在消息里直接敲 `/skill-name` 走的是 harness 自己的调用手势，bridge 补的只是可发现性。目录只读摘要，不读 skill 正文。

本插件的 bundle 不改动组合：默认 `zed` profile 下 `skill-filesystem`（本地来源）与 `tool-skill`（模型侧工具）仍是禁用的，所以要看到 skill 需要部署方自己挂载 provider。目录读取失败只会记一条 warn，命令目录照常送达。

## 在输入框里执行宿主命令

标准 ACP 客户端把你在目录里选中的命令，当成一条普通的 `session/prompt` 文本发回来。当宿主命令注册表能解析这一行时，bridge 把它交给注册表而不是模型：命令直接作用于自己的领域，自己追加 `command/run` 与 `command/done` 记录，并以 `end_turn` 结束这次 prompt——不开轮次、不走准入、不计统计。

模型通道不健康时这一点最要紧。绕道模型执行命令，取决于模型自己选择对应的工具调用；而那次调用既受部署挂载的审查/审批策略拦截，又消耗模型通道，于是 `/goal pause` 恰恰在最需要它的时刻可能被拒或被限流。走宿主平面则两者都不需要。

handler 的文本以 assistant 消息块返回，按执行配对 id 归组。handler 抛错时同样以文本回报并结束该轮次，不会退回模型——因为已经追加了 `command/run` 的 handler 此刻已经持有领域状态。

有两种形态仍走原来的散文路径：多于一个块的 prompt（注册表的附件准入是另一套契约，bridge 不在这里重复实现），以及注册表解析不出的名字——未注册的 `/word` 不会被吞掉，照原样送到模型。

## 使用自配模型

模型选择器列出的是本 agent 背后 profile（`dsh --profile zed`）的**活跃** provider 目录。dsh 在基础组合中以 dormant 状态挂载 `dsh-llm-pi-ai`：在某个 settings 段或 patch 声明 provider profiles 之前它不注册任何路由，而 settings 段按 profile 隔离——在其他 profile 模型页配置的模型永远不会到达这个 profile。

把路由声明到 zed profile 可见的位置。`$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`）应用在每个 profile 自身 patch 之上，一份声明服务所有 profile；`~/.dsh/profiles/zed/cordis.patch.yml` 则只对 Zed 生效：

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

编辑后重启 agent；路由随即注册，其模型会作为新分组与 DeepSeek 并列出现在模型选择器中。

## 排障

- **模型选择器里没有自配模型** —— 它们配置在了别的 profile 上，而 settings 段按 profile 隔离；参见[使用自配模型](#使用自配模型)。
- **认证错误提到 `DEEPSEEK_API_KEY`** —— Zed 传给 agent 进程的环境里缺少或不可用该 key。修正 `env` 块或 shell 导出。
- **agent 无响应，且日志出现非协议输出** —— 在命令面板运行 `dev: open acp logs`。agent 的 stdout 上只允许出现 JSON-RPC 帧；泄漏的日志行是 harness 的缺陷，不是 Zed 的问题。
- **Zed 显示 agent 已连接，但提示词以模型错误失败** —— 会话建立时还没有有效 key；重新认证，或从面板重启 agent server。

## ACP 注册表

Zed 也可以从 [ACP 注册表](https://zed.dev/blog/acp-registry) 安装 agent；注册表为每个 agent 保存一份清单，并向所有 ACP 客户端提供安装。插件包内已附带准备好的注册表清单（插件包中的 `registry/agent.json`）；在该条目上线之前，请使用上面的手动配置。
