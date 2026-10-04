# @8kugames/dsh-zed-acp

[English](README.md) | 中文

一个面向 [Agent Client Protocol](https://agentclientprotocol.com/) 的服务器，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打包成可自由安装的 dsh 插件。它把 `dsh` 变成 [Zed](https://zed.dev)（或任何 ACP 客户端）可以驱动的外部 agent：流式回答与思考过程、带真实文件差异的工具调用、计划模式、agent 预设、权限预设、会话历史与 MCP 服务器。

按 dsh `0.2.0-rc.2` 构建并测试。插件组合在已安装的 harness 之上运行——它不自带运行时，也绝不把你的 key 写进编辑器配置。

## 安装

前置条件：[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 钉到插件对应的版本（`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`——npm 的 `latest` 标签可能落后）、Node `^22.19 || >=24`，以及 Zed。

在首个 npm 发布之前，直接从本仓库安装（ref 指向携带插件的分支；合并进 `master` 后改为 `master`）：

```sh
dsh plugin --profile zed add "github:8kugames/dsh-zed-acp#zed-acp"
```

重新执行同一条 `add` 命令即可更新已安装的插件——仅重启 profile 不会带来旧版本未携带的文件（`presets/` 下的预设声明就是这类新增）。

`@8kugames/dsh-zed-acp` 发布之后，同一个包从 registry 安装。分功能的完整指引（模式、预设、权限、会话、排障）见 [docs/zed-acp.zh.md](docs/zed-acp.zh.md)。

### 从本地 clone 安装

`npm install` 时的 `prepare` 钩子会自动构建 `dist/`，clone 后无需单独构建。`git clone https://github.com/8kugames/dsh-zed-acp.git` 之后，用 pnpm 符号链接安装本克隆（`link:` 安装在下次重启 agent 时即反映本地修改；`file:` 则会复制并按版本缓存 tarball）：

```sh
dsh plugin --profile zed add -w "link:/absolute/path/to/dsh-zed-acp"
```

若要在克隆内做开发（测试、类型检查、重新构建），先执行一次 `npm install`，之后照常用 `npm run typecheck` / `npm test` / `npm run build`。

然后在 Zed 中把该 profile 注册为 agent server（Zed → 设置 → AI → External Agents，或 `settings.json`）：

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

首次启动会初始化 `~/.dsh/profiles/zed`。也可以把插件加进随附的自动化 profile——`dsh plugin --profile acp add @8kugames/dsh-zed-acp`——bundle 补丁会禁用随附的仅面向自动化的 ACP 传输，保证 stdio 上只有一个服务器。

## 相比随附的 `dsh --profile acp` 多了什么

|            | 随附 `acp` profile                  | 本插件                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话       | `new` / `list` / `resume` / `close` | 相同，且 `session/list` 带每会话**标题**，标题事件实时投射为 `session_info_update`，并经 `session/load` 支持**全量历史重载**（存储日志经与实时流相同的投影回放）                                                                                                                                                                                  |
| 后台子代理 | 不可见；父 Agent 空闲即结束回合     | continuable 子代理运行期间 prompt 保持打开，每个活动期投射一张以子代理任务文本命名的合成工具卡，卡片正文实时刷新当前活动、累计 token、耗时与静默告警，结束时按子代理真实命运（完成/失败）结算并附其最后输出行；另有对账通道定期重读 agent 镜像 status，漏掉终态事件不再卡死回合；`session/load` 回放时从子会话自身日志投影其持久命运（完成/失败） |
| 认证       | 接受但不校验                        | `deepseek-api-key` 方法；`authenticate` 校验凭据并解释缺什么                                                                                                                                                                                                                                                                                      |
| 模式       | ——                                  | 经 `session/set_mode` 的 `default` / `plan`，附 `current_mode_update`                                                                                                                                                                                                                                                                             |
| 配置项     | `model`、`reasoning_effort`         | 另有 **`preset`**（agent 预设）与 **`permission`**（沙箱/审批预设，本地化文案）                                                                                                                                                                                                                                                                   |
| 问题       | ——                                  | 单选 `ask_user_question`（计划评审）经 `session/request_permission` 往返                                                                                                                                                                                                                                                                          |
| 计划       | ——                                  | agent 的 `todo` 快照投射为 ACP `plan` 更新，客户端用原生计划面板渲染                                                                                                                                                                                                                                                                              |
| 斜杠命令   | ——                                  | `available_commands_update` 按会话列出宿主命令注册表的有效目录                                                                                                                                                                                                                                                                                    |
| 工具调用   | 通用 `other` 类别                   | 标准类别（`edit`/`read`/`search`/`execute`/`fetch`/`switch_mode`）、跟随式 **`locations`**，与 `write`/`edit` 结果的原生**文件差异**                                                                                                                                                                                                              |
| 终端       | ——                                  | 命令类工具调用在客户端声明 Zed `terminal_output` 扩展时嵌入**展示终端**，其余客户端保持纯文本投影                                                                                                                                                                                                                                                 |
| 预设       | 宿主面工具                          | web 式拆分：模型面行移入每个预设自己的组成（`standard`/`ptc`/`minimal`/`cordis`）                                                                                                                                                                                                                                                                 |
| 分叉       | ——                                  | `session/fork` 走平台原生 fork 血缘；`jetbrains.air.fork` v1 扩展保留选中的助手回复并丢弃其后的全部内容                                                                                                                                                                                                                                           |
| 转向       | ——                                  | `_session/steering` 在回合的下一个步骤边界注入追加消息，客户端已打开的 `session/prompt` 仍持有该回合、其输出流与其 stop reason                                                                                                                                                                                                                    |
| Skills     | ——                                  | `@deepseek-ai/dsh-skill` 注册表中 `userInvocable` 的条目并入同一份 `available_commands_update` 目录，同名时命令注册表优先                                                                                                                                                                                                                         |

## 分叉、转向与 skills

`session/fork` 以 `sessionCapabilities.fork` 通告。不带扩展块时，它把源会话的整份已提交日志复制进一个新的独立会话，且完全不触碰源会话。带上 `_meta.jetbrains.air.fork`（版本 1，`inclusive`）时，新会话保留选中的那条助手回复及其之前的一切。消息由 `messageId` 指定（`<turn>:<step>`；`<turn>:<step>:segment:<n>` 形式的分片 id 也会匹配到整条消息），可用 `messageFingerprint`（`sha256:` + 助手可见文本的 SHA-256）钉死，用从 1 开始的 `messageOccurrence` 消歧。选中消息上的工具调用会从副本中移除——它们的结果记录在消息之后，只留调用会构成非法转录。分叉点无法解析时回 `invalidParams`，**不会**静默退化成整会话复制。

分叉子会话是平台 fork 种子（`isSeeded` 加精确继承前缀长度），开放尾部由 `buildForkSeed` 以 `forked` 结果与 step/turn 收尾补齐，因此不会继承半开的回合。fork 血缘设置 `parentSession` 但不设 `origin: 'subagent'`——这正是分支仍是一等根会话的原因：可列出、可重开、可继续对话。分叉继承的是对话而非路由：在非默认模型上分叉会落到组合默认模型，响应里带着子会话的完整 `configOptions` 以便先改后用。

`_session/steering` 是自定义扩展方法，以 `_meta.steering.supported` 通告。它向正在运行的回合追加一条消息，在该回合的下一个步骤边界被消费，回答 `{ outcome: "injected" }` 或 `{ outcome: "promptRequired", reason: "noRunningTurn" }`。bridge 绝不替客户端开启回合：没有请求在等的回合，其 stop reason、费用归属和输出流都没有主人。

skills 不需要派发——`/skill-name` 是 harness 自己的调用手势，bridge 补的只是把注册表中 `userInvocable` 的条目列出来。本插件的 bundle 不改动组合：默认 `zed` profile 下 `skill-filesystem` 与 `tool-skill` 仍是禁用的，所以要看到 skill 需要部署方自己挂载 provider。

## 回合统计与费用

每个正常收尾的 ACP 提问回合，都会以一张折叠的回合统计工具卡收束；当上下文事实可得时，其后再跟一条携带累计会话费用与机器可读 `dsh` `_meta` 扩展（回合与会话两级的 token 与时序事实）的最终 `usage_update`。卡片是一次合成的只读工具调用，落在客户端的工具时间线里而非消息流，不进入 DSH 持久会话；由于展开与否是客户端单方决定、协议无法强制，折叠可见的标题栏本身携带一行用量摘要（`in 45.2k / out 1.2k · $0.0123`，价表外模型显示 `unpriced`），无需点开即可看到关键事实。卡片正文为输入三桶拆分（缓存读/缓存写/未缓存）、前缀缓存命中率（回合与会话两级，命中桶占三桶输入之和的比例）、输出 token、模型与工具用时、平均首 token 延迟、解码速度、本轮与累计会话费用。Zed 的原生上下文条继续用 `used`/`size`；卡片补足 Zed 原生展示不渲染的事实，其他 ACP 客户端可依协议扩展性规则忽略 `_meta`。取消或失败的回合不发送卡片。

口径完全沿用 dsh 自身统计（`dsh-token-meter` 分桶与 harness UI 的会话统计）：dsh 把 `TokenUsage.inputTokens` 映射为自己的 `uncachedInputTokens`，因此未缓存输入不会被再去减缓存读取，三个输入桶互斥；模型用时为每次模型调用的 `step/start → assistant/message`，工具用时为 `tool/call → tool/result`，TTFT 为 `step/start → 首个 token delta`，输出速度为 `首个 token delta → assistant/message`，且只在**同时**记录了该窗口与该步输出 token 的步骤上计算，因此没有流式时刻的步骤不贡献速度值、也不拉偏结果。所有时序都来自已提交事件的时间戳，而非投影时刻采样，因此重放时数值一致。

费用采用 DeepSeek 公布价（每 1M token、USD，2026-09 核对）：`deepseek-flash` 峰时 $0.006 命中 / $0.3 未命中 / $1.2 输出，`deepseek-v4-pro` 峰时 $0.044 / $1.32 / $3.96，谷时按峰时减半计费（峰时 = UTC 周一至周五 01:00–04:00 与 06:00–10:00）。已退役的 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 解析到 `deepseek-flash`。缓存写按未命中价计费，与 DeepSeek 计费一致。中国法定节假日的峰时豁免未建模；未列出的模型不报费用。

用 `DSH_ACP_PRICES` 覆盖或扩充价目，值为扁平每 1M 费率的 JSON 对象（全时段生效，同 id 时遮蔽内置分时价）：

```json
{ "my-model": { "hit": 0.01, "miss": 0.2, "out": 0.5, "currency": "CNY" } }
```

格式非法时忽略并记录警告。累计值只覆盖 agent 进程打开该会话以来的活跃回合——恢复会话或重启 Zed 后重新计数。取消与失败的回合不发出该更新。

## 兼容性

peer 范围声明为 `~0.2.0-rc.2`：自 `0.2.0-rc.2` 起的 0.2.x 线 dsh 均被接受；dsh 的 profile 启动会在安装与启动时检查它们，并明确报出不兼容的插件。所有 `@deepseek-ai/*` 模块都从宿主安装加载——插件不自带运行时。

面向客户端的扩展都有优雅降级：展示终端、计划、会话标题与斜杠命令投射只用标准 ACP 更新；终端本身仅在客户端于 `initialize` 声明 Zed 的 `terminal_output` 能力时激活，未声明的客户端不会看到任何终端形状的更新，继续收到纯文本工具结果。

## 自配非 DeepSeek 模型

模型选择器列出的是 Zed 所启动 profile（`dsh --profile zed`）的**活跃** provider 目录。在其他 profile（例如 `web`）的模型页配置的 provider 路由保存在那个 profile 自己的 settings 里——dsh 的 settings 段按 profile 隔离，不会跨 profile 生效。

要让自配 provider（任何 `dsh-llm-pi-ai` 路由：OpenAI 兼容网关、自建服务）对 Zed 可用，把声明放到所有 profile 都能看到的位置——`$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`），它应用在每个 profile 自身 patch 之上：

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

编辑后重启 agent：路由随即注册，其模型会加入模型选择器。若只想对 Zed 生效，把同一行放进 `~/.dsh/profiles/zed/cordis.patch.yml` 即可。

## 开发

```sh
npm install         # 固定版本的开发依赖提供 dsh 类型与测试服务
npm run typecheck   # tsc --noEmit
npm test            # vitest：桥接套件启动真实 cordis scope，不调用模型
npm run build       # esbuild → dist/
```

通过 pnpm 符号链接对接真实 profile 迭代（`file:` 会复制并缓存同版本 tarball；`link:` 两者皆避）：

```sh
dsh plugin --profile zed-dev add -w "link:$PWD"   # 在仓库根目录执行
```

开发循环是 `npm run build` + 重启 Zed agent。

## 发布

1. 同时提升 `package.json` 与 `registry/agent.json` 中的 `version`。
2. 提交后推送 tag：`git tag zed-acp-v<version> && git push origin zed-acp-v<version>`。
3. workflow `.github/workflows/zed-acp.yml` 会在 tag 上运行三平台测试矩阵，并在配置了 `NPM_TOKEN` 时发布到 npm；它会断言 tag 与两处清单版本一致。

## 许可

MIT。本包衍生自 `deepseek-harness`（MIT，Copyright (c) 2026 DeepSeek）；归属详情见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
