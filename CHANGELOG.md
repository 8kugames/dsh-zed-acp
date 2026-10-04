# 更新日志

本项目的所有显著变更都会记录在此文件。本格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0)，
本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-10-04

后台子代理进度卡片、回收对账加固与 Turn stats 标题栏常显摘要。

### 新增

- continuable 子代理活动卡升级为进度卡：开卡仍为通用标题，子代理首条用户消息提交后即以任务文本补丁替换标题（`tool_call_update` 的 patch 语义，仅改 title）；卡片正文随子会话已提交事件实时整卡替换（content 替换语义、status 保持 in_progress）——当前工具活动（复用工具卡标题提取）/最新助手输出行、累计输入/输出 token（含缓存桶）、活动期耗时，以及超过 `DESCENDANT_STALL_WARN_MS`（两分钟）无事件后的 `stalled` 告警行。活动期结束时按子代理自身最后一次 `turn/end` 保真结算（completed/max-tokens/forked → `completed`，interrupted/aborted/blocked/error → `failed`，无 fate 默认 `completed` 维持旧行为），并携带其最后一条助手单行摘要；fate 映射从 reload 投影器提取为共享的 `turnEndToFate`，live 与 reload 永不分歧。ponytail：若任务消息作为会话构造 seed 提交（seed 事件不发 `session/event`），live 标题保持通用名，reload 仍能从持久日志学到任务文本。

- 后代事件路由：`session/event` 处理器在直连会话未命中时回落 `descendantRoots` 血缘路由，把子会话已提交事件喂给根会话的进度卡；收养迟 status 时同步登记事实与 agent 句柄。

- 回收对账加固：新增 `reconcileDescendants` 对账通道，由每次后代输入（born/status/session 事件）与 `DESCENDANT_RECONCILE_MS`（15 秒，unref）定时器双路驱动——逐个重读 agent 镜像 `status`，状态表非 idle 而真值已 idle 的项立即结算并记结构化 warn，同时刷新开卡的正文读数（耗时/停滞）；状态表清空即停定时器，`close` 同步清理全部后代追踪状态。终结了两个卡死路径：漏掉终态事件的 `known`/`running` 项永久持有结算门控，以及 disposal 后迟到 `running` 被收养后永无终态事件可清。真实仍在运行的后代按既定语义继续被持有（不引入强制超时释放），取消仍是唯一强制出口；活跃后代清零即停定时器（idle 留存项不再空转，running 重开时自动重臂），born/status 入口带 closing 守卫堵住 close 后迟事件的复活口；驱动死亡且镜像冻结在 running 的极端情形公开事件面不可区分于真实挂起，由停滞告警暴露。ponytail 已标明该天花板。

- Turn stats 卡片标题栏常显摘要：折叠可见的 title 行从 `Turn stats · <model>` 升级为 `Turn stats · <model> · in 45.2k / out 1.2k · $0.0123`，价表外模型（如自定义网关路由）显示 `unpriced` 而非静默省略 cost 段——因为展开与否是客户端单方决定，ACP 无展开控制字段。正文统计卡内容与 `usage_update`/`dsh._meta` 口径不变；新增 `formatTokenCount` 紧凑格式化。

### 变更

- 后代事件面导出调整：`toolCallTitle`/`oneLineText` 从 `src/updates.ts` 导出供进度卡复用；`descendantActivityOpen` 增加可选 title 参数、`descendantActivitySettle` 增加 outcome/summary 参数（默认值保持旧调用形状）。

## [0.3.0] - 2026-10-04

三项协议能力：分叉、转向、skills 目录。

### 新增

- `session/fork`：`initialize` 通告 `sessionCapabilities.fork`。不带扩展块时把源会话的整份已提交日志复制进一个新的独立会话，源会话完全不被改动；带 `_meta.jetbrains.air.fork`（版本 1，`inclusive`）时保留选中的助手回复及其之前的一切。消息由 `messageId`（`<turn>:<step>`，`<turn>:<step>:segment:<n>` 匹配整条消息）指定，可用 `messageFingerprint`（`sha256:` + 助手可见文本的 SHA-256）钉死、`messageOccurrence`（从 1 开始）消歧；id 命中但指纹不符视为未命中，使被重用的计数器无法选到另一条消息。选中消息上的工具调用从副本移除（其结果记录在消息之后，只留调用是非法转录，也会让子会话 `session/load` 回放越过分叉点），更早的调用与结果原样保留。分叉点无法解析、指纹不符、版本不支持一律 `invalidParams`，绝不静默退化成整会话复制。子会话是平台原生 fork 种子（`meta.isSeeded` + 精确 `inheritedEventCount`），开放尾部由 `buildForkSeed` 以 `forked` 结果与 step/turn 收尾补齐，因此不继承半开的回合。响应带回与 `session/new` 同形的 `modes` 与 `configOptions`。分叉继承对话而非路由：非默认模型上的会话分叉后落到组合默认模型，可先按响应改路由。

- fork 血缘的委托门禁修正：`parentSession` 是平台的 fork 血缘字段，`session/fork` 子会话与 spawn 子会话带同一份 header 血缘，只有 spawn 工具额外盖 `origin: 'subagent'` 戳。此前 `session/list`、`session/resume`、`session/load` 以及实时后代路由一律以 `parentSession !== undefined` 判定 delegated，会把每个 fork 子会话挡成一等根之外、变成只写不可寻回的记录。现统一改判 `origin === 'subagent'`：分叉分支可列出、可重开、可继续对话，而真正的委派子会话仍照旧不可见。

- `_session/steering`：自定义扩展方法，以 `initialize` 的 `_meta.steering.supported` 通告。向正在运行的回合追加一条消息，在该回合的下一个步骤边界被消费，客户端已打开的 `session/prompt` 仍持有该回合、其输出流与其 stop reason。回答 `{ outcome: "injected" }` 或 `{ outcome: "promptRequired", reason: "noRunningTurn" }`；没有运行中的回合时 bridge 绝不替客户端开启回合——没有请求在等的回合其 stop reason、费用归属与输出流都没有主人。内容准入与 `session/prompt` 同路（`admitAcpPrompt`），因此转向消息无法绕过连接的图片能力与路由校验。可 steer 的判据是「在飞 prompt 已认领回合、回合未结束、未被取消」；`settlementStarted` 不作为判据——它在 prompt 入队时即置位，因为结算在整个回合生命周期内持续等待静止。

- skills 斜杠命令目录：部署组合 `@deepseek-ai/dsh-skill` 时，注册表中 `userInvocable` 的条目并入同一份 `available_commands_update`，排在宿主命令注册表条目之后，同名时命令注册表优先（它才是自己命名空间的权威）。`modelInvocable` 那一半属于模型侧，不进用户菜单。skill 无需 bridge 派发——消息里的 `/skill-name` 是 harness 自己的调用手势，bridge 补的只是可发现性；目录只读摘要不读正文。`availableCommandsUpdate` 因此从同步改为异步：命令目录的 tail 位置在 skill 目录读取开始前同步捕获，读取本身与该 drain 并行，投递仍排在调用时已入队的全部更新之后。新增可选 peer 依赖 `@deepseek-ai/dsh-skill`。目录读取失败只记 warn，命令目录照常送达。**本插件的 bundle 不改动组合**：默认 `zed` profile 下 `skill-filesystem` 与 `tool-skill` 仍禁用，部署方需自行挂载 provider 才看得到 skill。

- `agentCapabilities._meta` 现在通告两个带命名空间与版本的扩展能力块（`steering`、`jetbrains.air.fork`）。标准路径保持完整：从不读取 `_meta` 的客户端仍拿到普通整会话 `session/fork`、不调用转向方法、拥有完整的会话/prompt/取消/认证/配置项契约。

### 修复

- 分叉活跃源会话会读到空日志：活跃会话的已提交事件在持久化屏障之前对读句柄不可见，而分叉的常见来源正是屏幕上正在进行的那个会话。现在 `AcpSession.fork` 在读取前对本进程内活跃的源会话执行 `ctx.sessions.flush`，否则分支会静默地从空对话分叉。

### 变更

- peer 依赖、开发依赖与直接依赖 `@deepseek-ai/dsh-brand` 从 `0.2.0-rc.1` 全面对齐到 `0.2.0-rc.2`，`registry/agent.json` 的运行时钉版与全部文档安装指引同步升至 dsh `0.2.0-rc.2`。经对全部 40 个 `@deepseek-ai/dsh-*` 包 rc.1/rc.2 的发布 tarball 全量对比，rc.2 无破坏性变更（CLI 的 Desktop 载体支持、`dsh-user-questions` 的 timed 问询、`dsh-tool-ask-user` 的可选 timed 模式均为向后兼容的增量，默认行为不变），插件源码零改动即完成对齐；typecheck 与全部 273 个测试在 rc.2 下直接通过。`THIRD_PARTY_NOTICES.md` 的 `dsh-brand` 版本行同步校正（此前停留在 `0.1.7-rc.2`）。

## [0.2.2] - 2026-09-29

### 新增

- ACP `session/load` 全量历史重载：`initialize` 通告顶层 `loadSession` 能力；加载路径复用 `session/resume` 的校验与 Agent 恢复，再经只读持久句柄读出存储事件日志，用与实时流完全相同的投影在 load 响应前把用户消息（仅直接人类提示，compaction 摘要等合成注入不回放）、助手消息、工具调用与结果、计划、模式和标题回放为 `session/update` 通知。回放转录取 append-origin 表面事件（平台契约：模型面会遮蔽被替换范围，append-origin 事件才是人类转录的持久来源），被压缩段的原始对话照常重建，摘要副本不回放；重放完成后面板即重建完整对话，下一条 prompt 继续同一持久会话。`session/resume` 保持无回放语义不变。

- continuable 子代理的回合保持、活动卡片与重载命运投影：`subagent` 工具以 `backgroundMode: continuable` 派生的后代代理超出父回合存活，现会通过宿主级 `agent/created/status/disposed` 事件按 `parentSession` 血缘（含孙代传递）路由到根 ACP 会话——正常结算路径在父 Agent 空闲后继续等待全部后台后代空闲才回答 prompt（取消仍立即结算），每个后代活动期在父会话投影一张合成工具卡（`Background subagent`，born → `in_progress`，idle/disposed → `completed`；不进入 DSH 持久会话）。取消后存活的后代仍由卡片维持可见，会话关闭时沿既有 drain 顺序拆除。`session/load` 回放末尾新增命运投影：沿 `parentSession` 血缘递归收集 `origin: subagent` 后代森林（含孙代，与 live 路由对称），逐个只读其持久日志，按其最后 `turn/end`（completed/max-tokens/forked → 完成；interrupted/aborted/blocked/error → 失败，崩溃遗留回合在 resume 时由 loop 补 interrupted closer；有事件无 turn/end 亦判失败）投影已结算的命运卡（标题取子会话首条任务文本，摘要取最后助手消息），重载客户端不再把被中断的后台工作误认为已随早结算的 spawn 调用完成；fork 血缘无 subagent 标记者不参与投影。注：全静止结算后若后代再次被唤醒，仅开新卡不再持有已结束的回合（静止即结算的边界语义）。

- `reasoning_effort` 选择跨模型切换与会话持久化：显式选择的推理档位按精确路由记忆——切换模型时优先恢复目标路由的历史选择，其次结转目标仍支持的相同档位 id，均不满足才回落该模型默认（切换本身绝不因此失败）；选 "Provider default" 视为清除该路由记忆。选择默认写入 `~/.dsh/zed-acp-reasoning-efforts.json`（读时容错、写时同目录 rename 原子落盘且同进程多会话写入串行化，跨进程单路由 last-writer-wins；文件格式损坏时下一次写入从空表自愈重建，其余 I/O 失败仅记 warn 不触碰既有内容、不阻断会话），新会话自动采纳持久化选择；部署可用新配置 `modelPreferencePath` 改写存储路径（应为绝对路径）。

- 统计卡新增前缀缓存命中率：卡片表格下方新增 `cache hit 87.5% · session cache hit 91.2%` 一行（命中桶 / 三桶输入之和，仅在适配器上报了缓存读时显示）；`_meta.dsh` 的 turn/session 两级同步新增 `cacheHitPercent` 镜像字段。

## [0.2.1] - 2026-09-29

### 修复

- `reasoning_effort` 选择器不再因路由解析瞬时失败而无声消失：模型路由解析在一次成功之后再失败时，选择器改为从该路由最近一次成功解析的 reasoning 元数据降级组装（含默认 effort 回填为当前值；成功解析报告不支持时同步淘汰旧缓存），并记 warn 日志（含 provider/model 与底层错误）；首次解析失败仍大声报错，解析成功但模型确实不支持 reasoning 时仍不发布该选项。

### 新增

- 恢复回合统计卡：正常收尾的回合在客户端工具时间线（而非消息流）里以一张折叠的只读工具卡呈现 markdown 统计——输入三桶拆分（缓存读/缓存写/未缓存）、输出、模型与工具用时、平均首 token 延迟、解码速度、本轮与累计会话费用。卡片先于终态 `usage_update`（仍携带累计费用与 `dsh._meta`）按序发出，取消或失败的回合不发送；卡片不进入 DSH 持久会话。

## [0.2.0] - 2026-09-29

### 变更

- peer 依赖与开发依赖从 `0.1.7-rc.2` 全面对齐到 `0.2.0-rc.1`，使插件可安装在 dsh `0.2.0-rc.1` 运行时上（旧声明会被插件管理器以 peerDependencies 不兼容为由拒绝安装）。

### 新增

- 协作模式选择器：桥在 `session/new` / `session/resume` 的 `configOptions` 中发布 `category: "mode"` 的 `session_mode` 选项（Default / Plan），与旧的 `modes` 字段并存。两条路径都收敛到同一份 `planMode` 状态，切换后以既有的 `current_mode_update` 通知客户端；未组合 plan-mode 的部署不发布该选项。
- `imageInputs` 配置项：`'auto'`（默认）保持"路由必须声明图像输入"的严格探测；`true` 在挂载了附件存储时无条件声明图像输入，供目录未披露 `inputModalities` 的适配器使用；`false` 永不声明。无论取哪个值，逐条提示的路由校验仍然拒绝真正不接受图像的模型。
- `minimal` 预设补齐 `plan-mode` 组合（与 standard / ptc / cordis 一致的 `planning` 分组与 guidance section）。

### 修复

- 初始化时的图像能力探测不再使用插件配置里静态钉死的 provider/model，而是探测新会话实际起始的路由（显式 pin 优先，其次组合的 agent-default-model 默认选择）。此前部署中 pin 指向已退役或不存在的模型 id 时，`promptCapabilities.image` 恒为 false，Zed 端完全无法输入图片。
- 初始模型选择（model/reasoning 芯片的 current 值与新会话回退路由）同样回填自 agent-default-model；bundle 层不再默认钉死 `deepseek-official/deepseek-v4-flash`（已退役 id），新会话直接继承组合默认模型，与 bundle 注释宣称的设计一致。
- Zed 代理面板此前没有模式选择器：桥只发布旧的 `SessionModeState`，而当前 Zed 走 `category: "mode"` 的配置项路径，`modes` 字段仅作兼容。
- 选中 `minimal` 预设（或默认落到它）时该预设未组合 `plan-mode`，模式切换静默不可用。

## [0.1.1] - 2026-09-28

### 新增

- 工具调用 `locations`: `tool_call` 与完成的 `tool_call_update` 从文件型参数（`path`/`file_path`/`filePath`/`file`）携带标准跟随式位置，供客户端的 follow-along 特性使用。
- 展示终端：客户端在 `initialize` 声明 Zed `terminal_output` 扩展（`clientCapabilities._meta`）时，`execute` 类工具调用嵌入标准 `terminal` 内容块（以 callId 为展示终端 id），结果把捕获输出经 `_meta.terminal_output` 流上终端并以 `_meta.terminal_exit` 收束（失败退出码 1）；未声明的客户端保持纯文本投影。
- 计划投射：`todo/write` 快照投射为 ACP `plan` 更新（条目一一对应，优先级恒 `medium`，非法条目丢弃、未知状态回退 `pending`）。
- 会话标题：`session/title` 事件投射为 `session_info_update`。
- 斜杠命令：会话创建/恢复时与宿主 `commands/change` 事件后发布 `available_commands_update`（宿主命令注册表的有效目录，同名去重）；新增可选 peer 依赖 `@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-tool-todo`。

### 变更

- 删除回合末尾的 Turn stats markdown 卡片：正常收尾的回合只发携带累计费用与 `dsh._meta` 机器可读统计的最终 `usage_update`。
- 终态 `usage_update` 的 `dsh._meta` 统计口径对齐 dsh 自身分桶：输入拆为互斥三桶（`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens`，取代原 `inputTokens` 净额），并新增 `llmMs`/`toolMs`/`decodeMs`/`decodeTokens`/`ttftAvgMs`/`outputTps` 时序字段。
- `current_mode_update` 的构造从 `src/session.ts` 移入 `src/updates.ts`（事件路由与 update 构造分职）。

### 修复

- tool_call 标题提取: 把 code 加入 SALIENT_TITLE_FIELDS(位于 command 之后), 让 dsh 保留的 PTC run_code 工具在 Zed(kind=execute → 'Run Command')下显示其执行的 TypeScript 代码体, 而不是描述性 description 短语。其他工具的标题因字段不冲突保持不变。

## [0.1.0] - 2026-09-28

首次发布：作为 DeepSeek Harness (`@deepseek-ai/dsh@0.1.7-rc.2`) 的 Zed ACP 适配器插件，对应 ACP SDK `@agentclientprotocol/sdk@1.4.0`。

### 新增

- ACP 协议服务：`initialize` / `authenticate` / `session.{new,list,resume,close,setConfigOption,setMode,cancel}` / `prompt` 全部端点。
- `deepseek-api-key` 认证方法，启动时校验凭据是否解析可用，缺失时给出可操作的错误说明。
- 会话模式：通过 `session/set_mode` 在 `default` 与 `plan` 之间切换，并以 `current_mode_update` 实时通知客户端。
- 配置选项：`preset`（agent 预设）、`permission`（沙箱/审批预设，本地化文案）、`model` 与 `reasoning_effort`。
- 工具调用更新：标准 `kind` 映射（`edit` / `read` / `search` / `execute` / `fetch` / `switch_mode`），`write`/`edit` 结果以原生 ACP `diff` 内容块呈现。
- 助手消息：推理块走 `agent_thought_chunk`，正文走 `agent_message_chunk`，每轮结束附带上下文占用 `usage_update`。
- 图像提示：当连接声明 `promptCapabilities.image` 时，按四类受控栅格格式（png / jpeg / webp / gif）做严格 base64 解码与路由二次校验，缓存可寻址写入。
- MCP 装载：把会话级 `mcpServers` 列表翻译到 dsh-mcp-client；stdio 命令解析 PATH 上的可执行名，HTTP URL 白名单 http/https，header 通过 Node `validateHeaderName/Value` 校验，环境条目防 `__proto__` 注入。
- 单选用户问题（plan review）：经由 `session/request_permission` 通道表达。
- 回合统计：每轮以 markdown 卡片呈现输入拆分（缓存读 / 缓存写 / 未缓存）、输出（含 reasoning）、模型用时、工具用时、平均首 token 延迟、解码速度、本轮费用与累计会话费用；终态 `usage_update` 携带机器可读 `dsh._meta` 扩展。
- 价表：内置 DeepSeek 公布价（`deepseek-flash` 与 `deepseek-v4-pro`，峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00，谷时减半；已退役 id `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 解析到 `deepseek-flash`），可用 `DSH_ACP_PRICES` 环境变量按模型 id 覆盖或扩展。
- 启动 latch：commander 入口先发布 `zedAcpStartup` 服务再让 ACP bridge 占用 stdio，`--help` / `--dump-config` 不再误抢协议通道。
- 工具调用标题：从持久事件里恢复工具的显著参数（`command` / `pattern` / `url` / `file_path` / `description` / `queries`），单行截断，避免把整段粘贴脚本作为显示标签。
- 任务类工具（`job_*`）归类为 `execute` / `read`，子代理桥的 `exit_plan_mode` 归类为 `switch_mode`。

### 安全

- 环境变量名集合使用 `Object.create(null)`，避免 `__proto__` 注入。
- `authenticate` 错误消息不携带 key 值，只指明环境变量名与替代渠道。
- 所有协议层通知都经 `outputTail` 串行化，避免客户端解析乱序。

### 文档

- 双语 README 与 docs/zed-acp（英 / 中）。
- `THIRD_PARTY_NOTICES.md` 列明运行时依赖与宿主 peer 依赖的版本与许可。

[未发布]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.2.0...HEAD
[0.2.0]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.1.1...zed-acp-v0.2.0
[0.1.1]: https://github.com/8kugames/dsh-zed-acp/releases/tag/zed-acp-v0.1.1
[0.1.0]: https://github.com/8kugames/dsh-zed-acp/releases/tag/zed-acp-v0.1.0
