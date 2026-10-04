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
dsh plugin --profile zed add "github:8kugames/dsh-zed-acp#zed-acp"
```

CLI 的 npm `latest` 标签可能落后于插件对应的版本，而且插件的兼容门会在安装时拒绝更旧的 dsh，所以上面的命令钉住了版本。git ref 指向携带插件的分支；插件的首个发布上线后，即可从 npm registry 以 `@8kugames/dsh-zed-acp` 安装。

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

当 agent 委派 continuable 子代理（`backgroundMode: continuable`）时，被派生的工作会超出启动它的工具调用的生命周期，因此 bridge 会让回合保持打开直到全部后台后代空闲——面板维持忙碌状态，而不是在工作仍在进行时就报告请求已完成。取消会立即结算回合，仍在运行的工作以每个活动期一张合成工具卡（`Background subagent`，运行中显示 in-progress）保持可见。之后重开会话时，每个后代的持久命运会从子会话自身的日志回放——被中断或崩溃的工作结算为 `failed`，完成的工作结算为 `completed`——被中断的委派无法冒充早结算 spawn 调用的成功。回合完全结算后再次被唤醒的后代只会开新卡，不会重新打开已结束的回合。

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
