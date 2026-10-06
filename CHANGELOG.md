# 更新日志

本项目的所有显著变更都会记录在此文件。本格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0)，
本项目遵循[语义化版本](https://semver.org/lang/zh-CN/1.1.0/)；各版本日期为 UTC 发布日。

## [未发布]

### 修复

- `session/load` 的子代理结局卡不再成批堆在转录末尾。此前重进一个委派过后台子代理的会话，客户端会在整条父转录之后一次性收到 N 张 `dsh-subagent-*` 卡，看着像「工具调用堆积在末尾且全部失败」（实测一条派发了 10 次的会话：10 张卡全在末尾，而它们的派发点落在 4925 个事件日志的第 1334–1531 位，等于被推迟 3393 个事件才出现）。原因是后代会话各自是独立的持久会话，父日志里没有它们的位置，`replayStoredHistory` 只能在重放完父转录后，把 `origin: 'subagent'` 森林里的每个后代补发一张卡。而父日志其实一直记着位置：每次派发都会就地提交一条 `subagent/catalog`，其 `childId` 点名子会话。现在回放先向持久层取出后代名册，再按 `subagent/catalog` 把每张结局卡放回它自己的派发锚点，与 live 时 `agent/created` 就地开卡的位置对齐；没有锚点可指的后代（孙辈的锚点记在它自己父辈的日志里，以及写下 `subagent/catalog` 之前的旧日志）保持原有的末尾位置并按创建时间排序，覆盖不降。锚点只决定位置、不决定资格：`childId` 若不被持久名册归因于本会话的 `origin: 'subagent'` 后代就不发卡，重复锚点第二次起失效，载荷畸形的锚点直接跳过。**影响**：只改变重进会话时结局卡出现在转录中的位置，卡片内容、`dsh-subagent-<id>` 标识与成败判定一律不变。

- 取消 prompt 后遗留的后台子代理不再拖住后续 prompt 的结算闸门。此前 `cancelPrompt` 只释放当时的等待者，取消瞬间仍在活动的后代照旧计入 `activeDescendantCount()`：紧接着来的 prompt 即使自己派生的后代已全部空闲，也要一起等着这些残留结束，并且每结束一个还会为新 prompt 买一次「唤醒续跑」，背景工作把每条后续 prompt 的结算都攥在手里。现在取消时把仍未空闲的后代全部打上 orphan 标记，结算闸门（`heldDescendantCount()`/`whenDescendantsSettled()`）只统计未孤儿化的活动时段；孤儿后代的活动卡片照常打开、照价可见，只是不再属于任何 prompt 的结算配额，标记会在它空闲或被处置时丢弃，同 id 重建的全新后代则自动重新被闸门接纳。**影响**：`session/cancel` 后 `session/prompt` 不再被旧后台工作拖住，残留后台工作的卡片可见性一点不变。

- 失败的回合不再为其后代买一条续跑。此前结算循环的唤醒判断发生在 `endReason` 检查之前：一个回合在后代仍运行时以错误结束，等待结束后会照旧消耗 `DESCENDANT_WAKE_LIMIT` 配额续跑，而续跑会清掉 `endReason`，让后续任一成功回合的 stop reason 顶替原始失败，prompt 因此以「成功」结案。现在先看 `inflight.endReason`，处于 `error` 的回合直接带错结算、不续跑；其等到的那些后代卡片仍按通常的空闲路径正常关闭。**影响**：此前会被伪装成成功的「失败回合 + 后代在跑」组合，现在会如实附带原始错误返回。

- 统计卡不再计入本 prompt 从未认领的回合，模型字段也改在认领时刻盖章。此前 `turn/start` 在某个 prompt 进行中就打开统计收集器，`turn/end` 则无条件把回合折进该 prompt 的聚合——取消残留或其他不属于本请求的内部 turn 会被账到这张卡上；模型字段同以 `turn/start` 为盖章点，而那时 inbox claim 还没发生，等于随手取值。现在收集器仍对每个 turn 开张（会话终身合计不缺账），但折进 prompt 卡的仅限 `event.data.turn === inflight.turn` 者，且该处由 `onInboxClaimed` 确认归属——那是 turn 被确认属于这个 prompt 的最早点，路由也取自那一刻而非结算时的现选。**影响**：只改变 prompt 卡片计费的归属边界；卡片结构、标识与会话总计不变，总计仍逐回合如实汇总。

- 斜杠命令此前只被「列出」而从不「执行」：`available_commands_update` 已经把宿主命令注册表的目录发给客户端，但标准 ACP 客户端把选中的命令当普通 `session/prompt` 文本送回，bridge 此前一律当散文 `agent.followup()` 交给模型。于是每条宿主命令都被降级成一次「模型是否恰好选择对应工具调用」——那次调用既受部署挂载的审查/审批策略拦截，又消耗模型通道。这在 goal 自动轮次里是致命的：`/goal pause` 是中止自主 goal run 唯一的带内手段，而经模型执行意味着「停止风暴」要依赖风暴正在烧掉的那条通道。实测一次风暴中，`dsh-experimental-auto-review` 的 reviewer 调用绕过 `llm/retry`（该中间件只挂在 `agent/request-error` 上），上游 429 被 `failed()` 物化成「审查拒绝，调用体未执行」，`get_goal`/`update_goal` 连续 11 次被同因拒绝，模型既读不到 revision 也无法 compare-and-set 暂停 goal，`dsh-goal-round-driver` 于是按 `active`+`armed` 一路续跑到 `maxGoalRounds`（默认 256）——而这整段里唯一零 LLM 的出口没有被任何 ACP 传输接上：整棵 dsh 树里 `commands.execute` 的调用方只有 `dsh-api-session-controller` 与 `dsh-client-ui-commands`（Web/API 平面），没有任何 ACP 平面调用它。现在 bridge 在 `session/prompt` 里识别注册表能解析的命令行并交给注册表执行：不开轮次、不走准入、不计统计，handler 文本以 assistant 消息块按执行配对 id 返回，以 `end_turn` 结束，命令因此既不被工具闸门拦截也不受模型限流影响。handler 抛错同样以文本回报并结束轮次，不退回模型（已追加 `command/run` 的 handler 此刻已持有领域状态，退回会二次执行）。两种形态保持原有散文路径不变：多于一个块的 prompt（注册表的附件准入是另一套契约，此处不重复实现）与注册表解析不出的名字（未注册的 `/word` 不被吞掉，照原样送达模型）。命令不开轮次、不占 `inflight` 槽，故并发守卫补一个 `commandRunning` 标志，避免第二个 prompt 在 handler 执行期间穿过守卫。

## [0.3.3] - 2026-10-05

### 新增

- 后台子代理结算唤醒路径：回合在后代仍在运行时结束的，bridge 会在其后代全部空闲后为同一张仍打开的 `session/prompt` 追加一个**续跑回合**（复用 agent 句柄已有的 `followup()`），委派了工作的 agent 因此能读到后代结果并给出最终答复，不必再用阻塞式 shell 调用（例如 `sleep`）把自己的回合按住。此前 `steering.ts` 记录的那个「没有所有者」缺口在这里由已经打开的 prompt 本身补齐：续跑的 stop reason、计费与输出流仍归该 prompt，最终取值来自最后一个回合。续跑消息携带本仓自有的 `MessageSourceMap` 来源 `acp-descendant-continuation` 而非 `user`，因此 `session/load` 的历史回放不会把 harness 发起的续跑当成人类输入，实时投影也不把它当人类消息渲染。每个 prompt 的续跑次数以 `DESCENDANT_WAKE_LIMIT` 为界，避免一条不断派生新后代的委派链把客户端请求无限按住；取消路径不触发续跑。配套把这条契约写进四个内置预设的 persona 段（standard/ptc/cordis 加在 suffix，minimal 因 `complete: true` 只有 prefix 而加在 prefix），明确告知模型「委派的后台工作会在结算后以续跑回合唤醒你，直接结束回合即可」，让模型不再用阻塞式 shell 调用（如 `sleep`）把自己的回合按住等结果。**影响**：一个回合在后代仍在运行时结束的委派会话，现在会多出一个由 bridge 发起的续跑回合。

### 修复

- `_session/steering` 的三处适配缺口与回合统计的模型口径。其一，`_meta.steering.idleBehavior` 此前只在文件头注释里声称「已接受并校验」，实现却从不读 `_meta`：客户端发送未实现的策略会被静默按 `promptRequired` 作答，而注释让它看起来已被拒绝——现在解析期即拒绝未知取值并回 `invalidParams`（`-32602`），缺省仍等同 `promptRequired`、行为不变；错误回显带长度上界且序列化容错，被拒的值不再能决定拒绝响应的大小。其二，转向消息的内容准入此前读会话的**当前**模型选择（`snapshot()`），而回合跑的是 `pinTurn` 钉定的路由（`selection.current`）：回合中经 `session/setConfigOption` 切换模型后，带图转向会按**新**路由判图片能力、却注入跑**旧**路由的回合（或反向误放）——现在准入读钉定路由，与该回合装配模型请求所用的表达式一致。其三，`steer()` 的二次复检此前只问「有没有活回合」：图片准入 await 附件写入期间，原回合可以结算、后续 prompt 可以领取新回合，消息遂以旧回合的准入结论注入一个它从未瞄中的回合——现在复检连同**回合身份**一起钉定（沿用同文件结算路径的 `this.inflight !== inflight` 范式），目标回合已易主即回 `promptRequired`。同时 `steerable()` 补上 `agent.status === 'running'`，该半边以 `ponytail:` 标注为**未复现**的防御加固（`session/event` 在 `append()` 内同步派发，今日不改变任何可观测结果），覆盖的是 settlement 自己已容忍的「`endReason` 迟迟未到」那类窗口，避免驱动器已空闲时由 `agent.steer()` 开出一个没有 ACP 请求在等的回合。其四，回合统计的模型口径：`trackStats` 的计价闭包与 `emitTurnStats` 的卡片标题此前都读会话当前选择，回合中切模型会把**已发生**的用量按新模型计价、把结算卡标题换成新模型——现在按每个 `turn/start` 时仍在钉定中的路由计价与留痕（结算时 `releaseTurn` 已把 pin 还给实时选择，故必须在回合开始时记下），成本与卡片名因此指向真正服务该回合的模型。

**影响**：发送未知 `idleBehavior` 的客户端会收到 `-32602` 拒绝（此前被静默接受）；其余三项为行为修正，无接口变更。

## [0.3.2] - 2026-10-05

### 新增

- 价格可写入插件配置面（profile 自有覆盖层 `$DSH_HOME/profiles/zed/cordis.patch.yml` 的 `zed-acp` 行）：新增 `prices: { defaultCurrency, models: [{ id: <模型 id>, hit, miss, out, currency? }] }`（`models` 为逐模型一行的列表，与本覆盖层 provider 路由的行形态一致，id 必须唯一），费率单位为每 1M token（`hit` 命中缓存的输入、`miss` 未缓存输入加缓存写入、`out` 输出），扁平费率全时段生效。此前的 `DSH_ACP_PRICES` 环境变量不再是唯一入口：写在 Zed `agent_servers` 的 JSON 里需要 JSON 套 JSON 的层层转义，YAML 嵌套没有这个问题。校验分两处：类型与非负费率由插件 schema 在加载期拒绝，ISO 4217 币种码与未知键由价目解析拒绝（拼错的 `defaultCurrency`/`currency` 会显式报错，不再静默按缺省处理），两者都会让插件起不来；环境变量那份则维持「记警告 + 整份丢弃」。两者同时存在时以 `prices` 为准，`DSH_ACP_PRICES` 会在日志里被明确记为已忽略而非静默失效，警告文本会指出需要把费率搬进 `prices.models`；仅用环境变量的既有部署行为不变。`prices.models` 的键按大小写精确匹配服务侧 id，且不再需要 `$` 前缀保留命名空间（`defaultCurrency` 是 `models` 的同级键而非其内部的元键；该保留区只存在于环境变量路径，配置路径原样接受以 `$` 开头的 id）。仅影响费用展示，不改变 token 统计。
- ask_user_question 兜底自由输入：客户端在 initialize 声明 `elicitation.form` 能力时，每个问题菜单末尾自动合成 **Other** 选项（模型自带同名标签则不重复追加），选中后经 `elicitation/create` 表单收集自由文本，答案以 `selected: ["Other"]` 加 `custom` 文本回给模型，避免列出的选项全不合理时用户被锁死；表单 decline/cancel 回到菜单重选，菜单取消仍为 `ASK_CANCELLED`，模型侧自定义的 Other 标签在能力声明下同样路由到表单，未声明时保持普通标签作答（旧版行为）。无选项问题从降级 `NO_PROVIDER` 转正为直接弹出自由文本表单；能力未声明时行为与旧版完全一致（菜单不含 Other、无选项问题照旧降级）。四个预设的 plan-mode 段补一句引导：模型应把 custom 自由文本当作用户权威答案。

### 修复

- compact 后客户端 context 占用不回落：compaction 的摘要调用 usage 记在 log-only 的 `compaction/summary` 上而非带 usage 的 `assistant/message`，唯一 surface 变更又是一条 bridge 此前不投影的 `user/message` 替换事件，而 manual `/compact`（回合间、`turn: null`）的回合无模型调用、`emitTurnStats` 因 stats 缺失早退——两条既有 `usage_update` 发送路径（回合中 assistant 消息、回合末结算卡）都不触发，Zed 的 context 表停在压缩前的旧值直到下一个模型回复。现在实时事件路由对非 append 的 `user/message`（即 compaction 摘要 checkpoint 的替换事件）即刻按 token meter 重测占用并发出一条刷新的 `usage_update`（仅 used/size，与回合中 assistant 消息携带的口径一致）：manual `/compact` 立即回落，回合内自动压缩也在落地瞬间先降一次；压缩失败无替换事件、自然不发。选替换事件而非 `compaction/end` 作为触发点，是因为 bridge 不依赖 `dsh-compaction` 的声明合并类型，且未来任何 surface 替换生产者同样被覆盖；`session/load` 回放路径的 user/message 过滤在 `onSessionEvent` 之前，不受影响。
- 成本跨币种混加：`TurnStatsCollector` 与 `foldTurnStats` 此前把不同 `currency` 的金额直接相加、货币字段取最新一次的值——当 `DSH_ACP_PRICES` 为不同模型配置不同 `currency` 时，同一回合/会话的累计费用会跨币种错加。现在回合内出现两种计价货币时该回合 cost 报 `undefined`（标题栏显示币种样式占位）；会话累计一旦混币即置粘性 `currencyMixed` 标记、此后保持 unpriced；token 与时长统计不受影响。
- stdio 帧行无上限：生产接线的 NDJSON 流此前对无换行字节流无限缓冲、对完整行无上限 `JSON.parse`，失控的对端可用超长单行耗尽内存。现在 stdin 经 `WireLineLimiter`（64MiB 单行上限，常量外部化于 `src/codec.ts`）后再进 SDK 流，超限即断开连接并记录警告。
- 图片 base64 解码前预检：超限图片此前在 attachment store 限额生效前已完整解码并重编码比对（约 3-4 倍输入的内存峰值）。现在按 base64 长度精确估算解码字节数，超出 store 的单图（`maxImageBytes`）或聚合（`maxMessageImageBytes`）限额时在解码前拒绝，store 不再被调用。

### 变更

- 回合统计卡正文收拢为单张两列表（列名 `metric` / `value`）：token 拆分、回合与会话缓存命中率、模型与工具用时、平均首 token 延迟、解码速度、回合与累计费用逐行收进表内，正文不再有表外散行；加粗标题行只保留卡名（`Turn stats · <model>`）。行的出现条件不变——缓存行仍以适配器上报为前提，延迟与速度行仍只统计同时记录了两半的步骤，费用行仍以价目命中为前提。
- `prices.models` 的形状与示例显式化：README 与 docs 的价目示例补至两条目，并写明 `models` 是逐模型一行的 `- id: …` 列表（与本覆盖层 provider 路由的行形态一致），id 必须唯一——重复会在加载期被 schema 拒绝。
- 内置价表与条目缺省币种统一为人民币（CNY）：`DEEPSEEK_PRICE_TABLE` 的两个内置模型此前按美元录入（`deepseek-flash` 峰时 $0.006/$0.3/$1.2、`deepseek-v4-pro` $0.044/$1.32/$3.96，系按汇率折算所得），现直接采用 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> 的人民币公布价（`deepseek-flash` 峰时 ¥0.04/¥2/¥8、`deepseek-v4-pro` ¥0.3/¥9/¥27），`currency` 改为 CNY。峰谷结构不变（高峰 = 北京时间周一至周五 09:00–12:00 与 14:00–18:00，谷时按峰时减半），已退役别名仍按 Flash 计价，中国法定节假日豁免仍未建模。同时，价目条目未声明 `currency` 时的缺省由 USD 改为 CNY——与内置表、占位缺省三者对齐；**影响**：既有未声明 `currency` 的自定义条目，其费用显示会由 `$` 变为 `¥`，需要美元的请显式写 `currency: USD`。内置模型费用显示相应由 `$` 变为 `¥`，数值约为原美元值的 6.7–6.8 倍（原值系折算价，非官方人民币价）。部署方需要其他币种或费率时，用插件 `prices` 配置或 `DSH_ACP_PRICES` 覆盖。
- 回合统计卡标题栏的用量段改用箭头写法：折叠可见的 title 行从 `Turn stats · <model> · in 45.2k / out 1.2k · <cost>` 改为 `Turn stats · <model> · ↑ 45.2k · ↓ 1.2k · <cost>`，token 数字与口径（三个输入桶求和的 prompt token、输出 token）均不变，仅改分隔与箭头。已计价金额、卡片正文与 `usage_update`/`dsh._meta` 的 cost 口径不变。
- 未计价占位改为币种自适应，且金额与占位共用一张符号表：折叠标题栏在 cost 为 `undefined` 时（价表外模型，或跨币种混加后的未计价）此前显示英文词 `unpriced`，现渲染货币样式占位——USD `$--`、CNY `¥--`、EUR `€--`，未列入符号表的 ISO 4217 码回落到 `defaultCurrency` 的符号（缺省 CNY 即 `¥--`），不再以 `-- JPY` 的码后缀呈现。同一张表也管已计价金额，因此 CNY 由 `1.5000 CNY` 变为 `¥1.5000`、EUR 由 `1.5000 EUR` 变为 `€1.5000`，未列入表的币种同样借用 `defaultCurrency` 符号（金额保持 4 位小数），同一币种不再有两种形态；机器可读的 `usage_update` 与 `dsh._meta` 仍透传原始 `amount`/`currency`，口径不变。币种取「会话已发生的计价币种 → `DSH_ACP_PRICES` 顶层新增元键 `$defaultCurrency` → CNY」：模型全程在价表外（占位最常出现的场景）时由该配置决定，会话已有计价事实时跟随会话；该元键缺省 CNY（未配置时占位即 `¥--`），显式配置 `USD` 即为 `$--`。它只影响这一占位，不改变各条目自身 `currency` 的缺省值（仍为 USD）；未知 `$` 元键与非法币种码在解析时快速报错而不是被静默当作模型 id，因此以 `$` 开头的模型条目自本版起不再被接受（保留元键命名空间），属契约变更。已计价金额、卡片正文与 `usage_update`/`dsh._meta` 的 cost 口径不变（仍为 `undefined`）。
- 安装指引与发布状态对齐：README 与 docs 的安装命令改为 npm registry 为主（`dsh plugin --profile zed add @8kugames/dsh-zed-acp`），git ref 降级为跟踪未发布分支的备选——此前文档仍称"首个 npm 发布之前"，而 registry 已发布 7 个版本。
- 中文 README 移至 `docs/README.zh.md`：npm 会把根目录的 `README.zh.md` 选作包首页 README（`readmeFilename`），英文用户在 npmjs.com 首屏只见中文文档；移出根目录后 npm 确定展示英文 README，中文版随 `docs/` 一起发布并保留双语互链。
- `package.json` 的 `files` 加入 `docs`：包内 README 链接的 `docs/zed-acp.md` 与 `docs/zed-acp.zh.md` 此前不在发布物中，npm 用户点击即 404。
- docs 新增"插件配置"一节（双语）：补全 `provider` / `model` / `apiKeyEnv` / `sessionListPageSize` / `modelPreferencePath` / `imageInputs` 六个部署配置项的语义与默认值。
- 版本纪律：此后新功能按 minor 版本发布（历史上的 0.1.1 与 0.2.2 为携带新功能的 patch，已发布版本不做追溯重编号）。
- `usage_update` 与 `config_option_update` 的构造收拢进 `src/updates.ts`（新增 `contextUsageUpdate` / `turnEndUsageUpdate` / `configOptionUpdate`），`src/session.ts` 只负责路由与排队，消除 seam 账本枚举与实现的漂移；`src/version.ts` 注释中不存在的 `lib/` 路径更正为 `dist/`；README 英文版删除重复的一句计费说明，中文版定位语补回"面向 Zed 的"。
- CHANGELOG 修复：补全 0.3.1 / 0.3.0 / 0.2.2 / 0.2.1 的版本引用定义，`[Unreleased]` 的 compare 基线从 v0.2.0 更新至 v0.3.1，统一 `[Unreleased]` 措辞，`[0.1.0]` 补勘误并将日期修正为 UTC 发布日。

### 测试

- `src/startup.ts` 结束零覆盖：新增 `tests/startup.spec.ts`（裸调用发布 `zedAcpStartup` 服务、stdin EOF 经 readiness 有界退出、dispose 后停听 EOF、`--help` 打印帮助且不启动 transport、未知 flag 报错退出不发布服务）。
- 激活 fixture-server 的 `fail` / `crash` 工具：MCP 工具错误结果以 failed 卡片投影且回合正常 `end_turn`；server 进程回复后崩溃（exit 7）时结果照常结算、ACP 会话继续可用。
- steer×cancel 竞态：图片准入挂起（deferred `saveImages`）期间取消回合，steering 返回 `promptRequired` 且图片不落盘。
- `session/list` 标题缓存分支：projection cache 直接快照与 predecessor 回退两条路径均正确出标题。
- 新增 `WireLineLimiter` 与货币混加（回合内/会话累计/粘性）单元测试。

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

## [0.1.0] - 2026-09-27

> **勘误（2026-10-05）**：本节最初误记了两项实际在 0.1.0 tag 之后才合入的能力——"回合统计"（含价表与 `DSH_ACP_PRICES`，由提交 111955d 引入）与"工具调用标题的显著参数提取、`job_*` 归类"（由提交 1d494da 引入）；二者实际随 0.1.1 发布，0.1.0 的发布产物（gitHead 53b7eb3）不含这些能力。本节日期同时从 +0800 撰写口径的 09-28 修正为 UTC 发布日 09-27。

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

[Unreleased]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.3.2...HEAD
[0.3.2]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.3.1...zed-acp-v0.3.2
[0.3.1]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.3.0...zed-acp-v0.3.1
[0.3.0]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.2.2...zed-acp-v0.3.0
[0.2.2]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.2.1...zed-acp-v0.2.2
[0.2.1]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.2.0...zed-acp-v0.2.1
[0.2.0]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.1.1...zed-acp-v0.2.0
[0.1.1]: https://github.com/8kugames/dsh-zed-acp/releases/tag/zed-acp-v0.1.1
[0.1.0]: https://github.com/8kugames/dsh-zed-acp/releases/tag/zed-acp-v0.1.0
