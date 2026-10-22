# 图表交付与 Agent 执行质量实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 简单图表请求直接在会话内展示，消除重复显示和无效工具循环，并能区分主回答与记忆任务耗时。

**Architecture:** 保留现有 Mastra Agent、工具、技能、ECharts 围栏协议和 Observational Memory。增加服务端本轮交付约束、流式消息协调和运行进度保护；记忆策略先测量再调整。按四个可独立验收的批次实施，不增加独立规划模型。

**Tech Stack:** TypeScript、Mastra core 1.71.0 / React 1.6.3、React、ECharts 6、node:test、Vitest。

**Spec:** 本会话用户确认的四项顺序，以及本文“行为约定”和各批验收条件；本文为合并的设计与实施方案。

## Global Constraints

- 实施按用户最新确认在当前工作区直接开展，不创建 worktree，不修改当前未提交的 MessageList.tsx / tool-row.css。
- Mastra 工作前读取项目 mastra 技能，以本地已安装文档和类型为准；通过 package.json 的 dev/build 脚本运行。
- agents/tools/workflows/scorers 在 src/mastra/index.ts 注册；新增 processor 在 Agent 的处理链显式装配。
- 鉴权、用户/线程隔离、文件版本检查、技能 pin、取消/恢复能力保持有效。
- 不修改 node_modules，不通过纯文本相同来全局删除消息，不回放已成功的工具调用来修复显示。
- 不记录 API key、完整提示词、原始推理和完整文件内容；只记录必要的运行标识、计数、耗时、指令版本摘要。
- 不把“上下文不够，用更大块唯一替换”标记为模型窗口溢出；它是本例的编辑匹配说明。

## Review Focus

- 用户明确要求导出、上传文件分析、混合任务、显式选中技能时，不误限为纯图表任务。
- 相同内容但不同消息/调用 ID 可能是合法的新执行，不能按文本去重。
- 流中断、恢复、历史刷新同时发生时，不丢失新 delta、工具错误和最终答案。
- 文件版本改变后的合法重试不能被当成重复失败；进度状态不能跨用户、跨 run 污染。
- 工具失败或图表数据不足时不得伪造成功；后台记忆失败不得抹掉已成功的回答。

## 行为约定

1. “趋势图/折线图/柱状图”等明确数据图表请求默认 inline-chart：严格 JSON 的 echarts 围栏，简短说明，包含可追溯的数据来源和日期范围。
2. 明确要求 HTML 网页、网页看板、Dashboard 或独立 HTML 报告时才选 html-artifact；明确要求 PDF/XLSX 等格式则使用对应文件交付，不一律转成 HTML。
3. 仅说“分析/报告”的一般文字请求默认会话回答；“生成报表”按已指定的格式交付，格式不明且影响交付时简短确认。只在已有足够证据时限制工具，不能靠一个关键词决定所有权限。
4. 同时要求图表和下载使用 mixed。涉及附件或显式技能、含其他操作的请求使用 general/mixed，保留必要的读取、计算和技能工具。
5. 跟进请求可继承最近一次已确认的交付方式；用户最新明确要求覆盖旧约定。状态由服务端按 run 保存，不信任客户端自报模式。
6. 普通趋势图的数据获取、核对和 JSON 配置可由模型完成；布局、缩放、tooltip、颜色等交由现有前端组件。不给模型额外安排手算 SVG 坐标和日期布局任务。

## Task 1: 落实交付方式与完成条件（P1）

**Files:**
- Create: src/mastra/agents/turn-policy.ts
- Create: src/mastra/agents/turn-policy-processor.ts
- Modify: src/mastra/agents/chart-instructions.ts、src/mastra/agents/agent.ts
- Modify: src/mastra/skills/agent-bindings.ts（仅在需要统一 start/resume 运行状态时修改）
- Test: tests/turn-policy.test.ts、tests/chart-delivery.integration.test.ts
- Reuse: web/src/agent/markdown/echarts-option.ts、EChartsBlock.tsx；不新增图表库。

**Interfaces:**
- TurnDeliveryMode = 'inline-chart' | 'html-artifact' | 'file-artifact' | 'mixed' | 'general'。
- resolveTurnPolicy({userText, previousDeliveryMode, hasAttachments, selectedSkillIds}) 返回 {deliveryMode, confidence:'high'|'uncertain', allowArtifactWrites:boolean}；纯函数不调用模型。
- createTurnPolicyProcessor() 返回 Processor；使用 run 内 state，在 processInputStep 返回工具集合/activeTools 和 systemMessages，在 processLLMRequest 校验本轮规则进入最终 provider prompt。
- validateInlineChart(text) 返回 {ok:boolean, reason?:'missing-chart'|'invalid-json'|'invalid-option'}；只解析数据，不执行模型生成的 JavaScript。

- [x] 补失败测试：纯趋势图默认 inline；显式 HTML、PDF/XLSX、混合任务和技能例外；否定句“不要 dashboard”；附件取数和跟进请求；用户更改意图。
- [x] 用模拟模型主动请求 write_file，证明高置信纯图表模式下不会实际落盘；必要的取数工具保留。general/mixed 不作文件写入限制。
- [x] 装配本轮约束；在最终 provider 请求测试中断言规则存在，记录规则版本摘要与解析出的模型标识，不记录明文提示词。
- [x] 增加完成校验：输出缺失/无效图表时只允许一次无工具定向修正，复用已有数据，不重搜、不重跑整轮。修正仍失败则明确失败，不能宣称已生成。
- [x] 流式修正作为新的更正答案块追加，保留已流出的内容与错误记录，不假装可以撤回已发送文本；若所用 Mastra 完成钩子不能安全追加，先通过最小适配测试确定统一调用入口，再实现修正，不能私自触发第二次完整 Agent 执行。
- [ ] 后端模拟回归通过后，用真实模型各验证一次趋势图、HTML 看板、导出文件、附件取数图表。
- [x] 独立提交本批修改。

**验收:** 提供七天测试数据时，无文件操作，直接可渲染图表；天气在线验收先拿足七天数据，再输出图表。网络不可用时明确失败，不能编造。暂不承诺真实模型固定秒数。

## Task 2: 修复流式与历史消息重复（P1）

**Files:**
- Create: web/src/agent/chat-message-reconciliation.ts
- Modify: web/src/agent/AgentChat.tsx
- Modify only if needed: web/src/agent/message-parts.ts；不以 MessageList 视觉隐藏充当数据修复。
- Test: web/src/agent/chat-message-reconciliation.test.ts、AgentChat.test.tsx

**Interfaces:**
- reconcileChatMessages({history,live,runState}) 返回 MastraDBMessage[]；runState 含 runId、终结状态和快照版本。消息以 messageId、工具以 toolCallId、文本以已有 textId 为身份。
- reasoning 无稳定 partId 时，只协调同 run 的完整消息快照，不能用文本相同跨消息删除。

- [x] 为本次天气会话构造脱敏 fixture：早期步骤已落库、最后 live 消息含累计步骤、历史最终消息只有最终步骤，重现重复显示。
- [x] 分别补历史刷新、重复事件、断流重连、最终消息更新、取消、同内容不同 ID 的合法两次调用测试；保留错误状态。
- [x] 检查 @mastra/react 当前累积器、signals 订阅及初始历史协调，确定重复起点后在应用适配层修复。不预设一定是后端重复推送，不改依赖安装目录。
- [x] active run 保留更新的实时增量；终结后的同版本/更新版本持久化快照作为对应消息权威数据；未落库增量不提前删除。
- [x] 实现终结后的有限历史同步，在确认存储完成后收敛。避免持续轮询或每个 token 请求历史；对旧请求响应按 thread/run/版本丢弃。
- [ ] Chrome 验收同一次请求在执行中、结束后、重新打开、重连后均只出现一次工具过程和最终答案。
- [x] 独立提交本批修改。

**验收:** 本例 21 个真实工具调用只展示 21 个；相同内容但不同 ID 的新调用仍展示；历史同步不重新执行工具。

## Task 3: 限制重复失败与无效循环（P2）

**Files:**
- Create: src/mastra/agents/run-progress.ts、run-progress-processor.ts
- Modify: src/mastra/agents/agent.ts
- Modify if needed: src/mastra/files/tools.ts（返回稳定错误 code，保留现有 ETag 和唯一匹配保护）
- Test: tests/run-progress.test.ts、tests/run-progress.integration.test.ts

**Interfaces:**
- recordToolOutcome(state,{toolCallId,toolName,target,version,argsFingerprint,errorCode,success}) 更新 run 内计数；不持久化完整参数。
- decideNextStep(state,turnPolicy) 返回 'continue'|'recover'|'finalize'。
- 计数针对真实工具结果；重复流事件不得重复计数。恢复同一 run 保留计数，新 run 清零。

- [x] 补失败测试：相同文件/ETag/oldText/错误连续重复；文件版本变化后的正常重试；成功后重置；不同用户/run 隔离；恢复不清零。
- [x] 初始阈值：同状态同错误第 2 次进入 recover，要求补充匹配上下文或重新读文件；第 3 次仍失败进入 finalize，不再调用该失败操作。不能只靠提示词阻止第四次重试。
- [x] 高置信简单图表任务最多 8 个主模型步骤，预留一次无工具修正；达到预算时 toolChoice:none，基于已有结果交付或说明不足。general/技能任务保留原 maxSteps:100，本批不下调其总预算。
- [x] 禁止把任意两次相同搜索或合法轮询视为死循环；无效进度条件必须关联错误和未变化的目标状态。
- [x] 只通过可控状态进入收尾，不使用会阻止历史保存的通用 abort 清空整轮；已有成功取数和部分结果保留。
- [ ] 运行图表快速任务、正常文件编辑、多步骤 skill、取消与恢复回归后独立提交。

**验收:** 本例 AMBIGUOUS_MATCH 模式不能连续盲试；复杂 skill 不因简单图表预算被截断；到限后不伪报完成。

## Task 4: 分离测量主回答与记忆耗时（P2）

**Files:**
- Create: src/mastra/agents/run-metrics.ts
- Modify: src/mastra/agents/memory-model.ts、src/mastra/agents/agent.ts
- Modify only for lifecycle state: web/src/agent/AgentChat.tsx
- Test: tests/agent-memory-model.test.ts、tests/run-metrics.test.ts、web/src/agent/AgentChat.test.tsx

**Interfaces:**
- RunTiming: runId、threadId、首 token/首图表/最后答案/运行终结的时间，逐模型与工具耗时，工具失败/修正次数。
- MemoryTiming: 独立 cycleId、buffer/observation/reflection 类型、起止/失败/取消状态，以及与 run 的关联（若有）。
- 所有延迟使用明确的单调时钟或已有 duration 字段；后台区间可重叠，不能相加冒充总等待。

- [x] 补测试：后台记忆延迟不等于主回复延迟；记忆失败不覆盖成功答案；跨线程隔离不变。
- [ ] 加入有限指标，核对这次约 520 秒的缓冲是异步工作、收尾等待还是主路径阻塞。读取本地已安装 memory 文档/源码，验证取消、超时和恢复语义。
- [ ] 先记录默认行为，再对固定样例比较当前 memory 模型与管理员配置的更快 memory 模型；不自动改用户的模型选择，不自动关闭记忆。
- [ ] 只有证明存在阻塞且框架支持安全处理后，再增加可回滚超时/异步收尾配置；不能 Promise.race 后放任底层任务继续写旧状态。
- [ ] 若拟减少简单任务的观察频率，单独验证跨轮历史可用、旧缓存键含策略版本、线程隔离和失败重试；未通过则保留默认策略。
- [x] 界面明确主回答已完成与后台记忆仍在处理，不把后台处理展示成天气仍未查完；独立提交本批修改。

**验收:** 能分别给出取数、主模型、文件工具、首图表和记忆耗时；背景记忆不会造成重复答案或错误“仍在生成”状态。

## 最终验证与交付

- [x] 后端：node --import tsx --test tests/turn-policy.test.ts tests/chart-delivery.integration.test.ts tests/run-progress.test.ts tests/run-progress.integration.test.ts tests/run-metrics.test.ts tests/chart-instructions.test.ts tests/agent-memory-model.test.ts
- [x] 前端：npm run test --prefix web -- src/agent/chat-message-reconciliation.test.ts src/agent/AgentChat.test.tsx src/agent/markdown/EChartsBlock.test.tsx src/agent/markdown/echarts-option.test.ts
- [x] 类型/构建：node node_modules/typescript/bin/tsc --noEmit；npm run build:mastra；npm run build:web。
- [x] 现有技能、文件、队列与记忆隔离回归；固定天气 fixture 的新流程无 write/edit/read_file（取数已提供时）。
- [ ] 在线天气验收记录真实可用性与耗时，和模拟测试分开。外部取数失败不以 fixture 冒充成功。
- [ ] 交付四批提交、Chrome 验收证据、脱敏耗时对照与独立复审结果；保留 worktree，不自动合并或部署。

实施顺序：Task 1 → Task 2 → Task 3 → Task 4。Task 1 即可改善图表交付；Task 2 修正显示放大；Task 3 限制真实无效执行；Task 4 基于证据优化剩余耗时。

## 2026-10-22 实施与验收状态

四批代码均已实现；最终验收记录见 [实施验收记录](../verification/2026-10-22-agent-chart-execution-quality.md)。未勾选的真实模型场景和速度对照不代表已经通过。当前 Auto 在固定测试数据下仍违反 ECharts 输出协议，一次定向修正后明确失败；因此在线天气端到端验收尚未完成，不能宣称本方案已让该模型稳定成图。

框架中的 memory 等待/取消路径已检查；本批保留模型、阈值和调度策略。缺少同条件的更快 memory 模型对照，不进行模型替换或超时改造。回答完成指标不等同于全运行终结耗时；后续 terminal summary 仍为已记录的次要待办。
