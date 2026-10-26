# Agent Thread History Performance Review

后续状态：本报告是修复前审查，后续实现与最终验证见 [修复记录](2026-10-24-agent-thread-history-performance-fixes.md)。

日期：2026-10-24。对象：当前工作区 Cursor 实现（含 untracked 文件），不是仅 HEAD diff。对照同日 design / plan；本轮只审查，不修改业务实现、不部署。

结论：不建议直接合并或上线。新窗口接口与产物请求去重已有实现，但分页、搜索、缓存刷新、滚动及构建存在阻断问题，按需渲染与定时任务适配也未完成。

## 已执行验证

- 前端相关 14 个测试文件，133 项通过。AgentPage 的 39 项测试显式 mock `isThreadHistoryWindowEnabled: () => false`，因此没有覆盖默认开启的新页面链路。
- 无 env 的后端 suites：18 项通过、1 项 DB 集成跳过。随后使用项目本地测试数据库运行 history-repository：5 项全部通过（含真实 PostgreSQL 1 项），随机 fixture 已由测试清理。
- `npm run build --prefix web`：失败，2 个 TS2741，详见 R1。
- 临时诊断测试复用了现有 AgentChat/hook harness，复现 R5/R6/R8/R9；四个期望均失败。临时文件已清理，不改变用户测试文件。
- 直接调用真实 selectHistorySlice 复现 R2/R3/R7，具体输入/输出如下。
- `git diff --check` 通过。未进行真实浏览器性能 profiling，因此不能声称首屏改善 50% 或锚点误差达标。

## R1 [P1] 前端生产构建失败

位置：`web/src/agent/AgentShell.tsx:36` 新增必填 threadHistoryCache；`web/src/agent/ScheduledTasksPage.test.tsx:59`、`web/src/agent/skills/SkillsPage.test.tsx:107` 的 context fixture 未更新。

`npm run build --prefix web` 在 tsc 阶段报两个 TS2741，不能产出前端包。需要补齐所有 typed context fixture，并保持该能力在真实 AgentShell 的生命周期内清理；不建议把字段随意改 optional 来躲过编译。

## R2 [P1] after 翻页跳过靠近边界的消息

位置：`src/mastra/history/turns.ts:394-399`；关联 `service.ts:203-211,335-338`。

仓库按 ASC 读取 after 边界后的前 201 条，但选择器仍使用 latest 的“最后 8 轮”策略，下一 cursor 又越过选中末尾。真实纯函数复现：201 条独立 user 消息 m000…m200，mode=after，只返回 m193…m200。m000…m192 从向后续页路径被跳过。单轮 201 条 assistant 时也会丢掉靠边界的探针行。

修复方向：after 保留边界之后最早的连续前缀，预算移除远端较新内容；latest/before 才从尾部截取。测试覆盖双向分页完整 ID 集合、轮数/条数/字节预算和 cursor 推进，不能只有 before 全遍历。

## R3 [P1] around 的预算裁剪会删除目标消息

位置：`src/mastra/history/turns.ts:197-199,369-391`。

按字节裁剪时总是 shift 最早轮，未保护 around target；按总条数裁剪的 targetPos<=0 / >=last 分支同样会删掉目标所在边缘轮。

真实复现：target 为 user、contentBytes=600000；后续 later 为 user、contentBytes=8。`selectHistorySlice(rows,'around','target',...)` 返回 ids=['later']。HTTP 可以成功，但页面找不到搜索目标。

修复方向：目标必须为不可移除的锚点，从目标向两侧构造连续片段；目标本身超预算时按设计允许超大单条。测试必须断言返回 ids 包含 target，而不是只检查有双向 cursor。

## R4 [P1] 轻量 metadata 查询实际读取了所有候选正文

位置：`src/mastra/history/repository.ts:244-250,300-307`。

readMetadata 查询 SELECT content，随后 mapMetadataRow 在应用进程解析；findTurnContext 又读取最多 200 条完整 content。即使最终只返回最近 8 个小问答，也可能先从数据库传出并解析数百条旧工具结果。候选每条 2 MiB、200 条就约 400 MiB 原始正文，512 KiB 响应预算无法约束这部分成本。

修复方向：位置查询只投影 ID、时间、role/type、字节数和 signal 必需小字段；对选定 IDs 才读正文。上下文定位也只读轻量标识，找到起点后限长获取摘要。测试需检查真实 SQL projection/传输列，当前 spy 只检查独立 readMessages 调用无法捕捉该问题。

## R5 [P1] 缓存刷新后的新消息被冻结的旧 seed 覆盖

位置：`web/src/agent/AgentChat.tsx:132-135,213-218`。

useChat seed 被冻结，chat.messages 长期保留该初始快照；展示时 mergeMessagesById(historyLoaded,reconciledMessages) 又让后者同 ID 无条件获胜。因此后台刷新读到的新正文、落库工具结果会被旧 seed 覆盖，即使当前没有 live run。

诊断：相同 assistant ID，hook 消息是 REVIEW_OLD_VALUE，historyState 是 REVIEW_NEW_VALUE；实际页面只能找到 OLD，期待 NEW 的测试失败。温缓存后台刷新、同线程切搜索目标和 goLatest 都可能遇到。

修复方向：明确 canonical loaded history 与当前 live tail 的归属，只让实际执行中的 live 更新覆盖对应 ID，不把整份初始化历史当永远优先的 live。分页不重置 stream 的约束仍需保持。

## R6 [P1] 缓存重验证被拒后仍被标记 ready

位置：`web/src/agent/use-thread-history.ts:85-95`；关联 `AgentPage.tsx:233-259`、`AgentChat.tsx:213-218`。

缓存命中后请求返回 403/404，虽然清了 hook.state/cache，但 setStatus 仍因 cached 存在而设 ready，finally 清 validating。页面只在 status=error 分支处理拒绝，故无法进入预期拒绝/导航流程；旧 useChat seed 仍能保留在屏幕，并解除发送阻止。401 甚至不在清缓存分支。

诊断：命中缓存后 mock 403 Access denied，期望 status=error、消息清空；实际 status=ready，测试失败。这不是已证明的服务端授权绕过，服务端仍有 owner 检查，但客户端缓存撤销和交互状态不符合设计。

修复方向：401/403/404 为明确终止状态；清除/卸载该会话的显示和 live 状态，不能仅清窗口数组。暂时网络错误可保留缓存，但不得和拒绝访问混为 ready 可操作。

## R7 [P2] before 续页把长轮归并给了更早的另一轮

位置：`src/mastra/history/turns.ts:220-225`。

openTurnId 被分配给本页 first/最早轮；before 方向实际延续的是本页 newest/靠边界轮。复现：[u1,a1,u2,a2]，openTurnId='partial:upper:a2'，返回 u1.replacesTurnIds=['partial:upper:a2']，u2 无替代标记。前端据此把已加载的 u2 长轮片段归到 u1。

修复方向：根据 cursor 方向将 continuation 绑定到边界相邻轮；测试同一续页同时包含长轮起点和更早用户轮，验证替代 ID 与用户归属。

## R8 [P2] 搜索窗口无 gap 时无法加载后续或回到最新

位置：`web/src/agent/history/HistoryBoundary.tsx:31-46`；`AgentChat.tsx:575-587`。

组件接收 hasAfter 却未使用，两个按钮只在 gap=true 出现。正常 around 响应具有 nextCursor，但 merge replace 设置 gap=false，因此按钮都不存在。真实 AgentChat 诊断 nextCursor='next-page', mode=around, gap=false，两个按钮的存在性测试失败。

修复方向：hasAfter 与 gap 是不同条件；有后续页即提供加载后续，around 模式始终提供回最新入口。加载状态/错误也须透传，当前 AgentChat 硬编码 loadingBefore=false/loadingAfter=false/error=null，分页失败没有可见反馈。

## R9 [P2] prepend 锚点在数据到达前被清除

位置：`web/src/agent/AgentChat.tsx:241-256`。

handleLoadBefore 记录锚点，但 layout effect 在任何一次 visibleMessages 引用变化后就恢复并清空；加载状态导致的中间渲染会创建新展示数组，即使还没插入历史，锚点也已经消耗。随后真正 prepend 时失去参考。

诊断：scrollTop=1000，锚点在视口50px，先发生一次 loading 渲染，再插入500px历史；应恢复至1500，实际仍1000。

修复方向：把锚点绑定到该次分页 request/commit，只有对应 prepend 提交后恢复；请求失败、取消、切线程时显式处理。图片/图表后续 resize 另做测量补偿，不能靠一次布局读取验收。

## R10 [P2] 重内容延迟挂载组件没有接入实际消息列表

位置：`web/src/agent/AgentChat.tsx:589-594`、`web/src/agent/MessageList.tsx:239,277,328-338`。

HistoryTurnShell / DeferredHistoryText 只有各自测试与定义，实际 AgentChat→MessageList 路径未使用；MessageList 未接收 turns，历史 reasoning 仍 open，正文/代码/图表依旧全量初始化。已有验证文档承认 integration deferred，不能作为完成 Task 7。

修复方向：接通真实渲染入口与 pin/alias/焦点/高度状态，增加 MessageList/AgentChat 集成测试，确认离屏和关闭的详情确实未调用 Markdown/图表初始化。DeferredHistoryText 当前还把整段原文放入隐藏 span 和 data 属性，接入时也需避免为了保存复制文本而把原文重复塞入 DOM。

## 其他未完成范围

- `use-scheduled-thread-updates.ts:96` 仍在 fallback/terminal 调用全量 loadScopedThread，并用 saved 替换聊天状态；未落实 Task 6 的有界尾部合并，旧 assistant 在 subscription 分支也有被过滤风险。
- `history-tail-client.ts:23-27` 只取一次 around，不遍历 after；`use-reconciled-chat-messages.ts:57` 又用该单窗口检查整个 chat.messages（包括初始 seed）。长当前轮或 seed 超出 around 范围时，即便全部已持久化也无法 historyCoversLive，每次重试仍无法补齐。需要只检查当前 live tail 并连续取覆盖片段。
- AgentChat 没有接顶部滚动阈值自动 loadBefore；目前只有手动按钮。与产品“上滑自动加载”尚有差距。
- 旧页消息未传给 useTurnArtifacts（其 input 仍是 reconciledMessages），因此翻到旧页后，旧 run 不会进入 needed run 集合；超过产物接口第一页的旧记录无法保证恢复。应由当前已加载窗口的 run 集合驱动补齐。
- performance fixture 已建，但真实 cold/warm、长任务、挂载图表数和 ±4px 锚点指标未测。现有 memory-boundary 的 signal 用例只断言本地对象字段相等，并未实际走发送/记忆 fallback，不应作为完整框架边界证明。

## 修复与重验建议

先处理 R1 构建与 R2/R3/R7 分页完整性，再处理 R5/R6 的 history/live 与拒绝状态，之后补 R8/R9 UI 入口和锚点，再完成 R4 查询减负与 R10 渲染集成及其他范围。R4 若在低内存机器可能造成显著资源压力，应在上线前完成。

将本报告复现固化成永久 regression，开启 window flag 做 AgentPage/AgentChat 集成测试，补齐 after 全遍历和 around 超限场景，再运行本地 DB、前端 suites 与生产构建。没有真实 profiling 就如实标记体验指标未验证，不能仅用“已有测试全绿”替代验收。
