# 通用 Agent 第一阶段：可靠执行与任务完成质量实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划交给 Cursor 在当前工作区按顺序实施；不默认创建 worktree 或启动子 Agent。

**Goal:** 补齐 Skill 健康、模型兼容性、通用任务预算与完成检查、真实任务评测，解决“能画温度图却没有完整回答天气趋势”的问题。

**Architecture:** 沿用单 Mastra Agent、现有 Skill 发布存储、模型目录、纯数据图表与消息协调机制。新增小型 task-quality 模块，天气作为首个有确定性证据检查的领域适配器；不增加规划模型或新工作流引擎。

**Tech Stack:** Node >=22.13.0、TypeScript、Mastra core 1.71.0、PostgreSQL、Zod、React 19、ECharts 6、node:test、Vitest。实际安装版本以 package-lock 和 node_modules 为准，不顺带升级依赖。

**Spec:** [详细设计](../specs/2026-10-22-agent-phase-one-task-quality-design.md)。执行前必须通读；接口、预算、状态和验收标准以该设计与本计划共同为准。

## Global Constraints

- 这是尚未执行的计划；仅在对应测试/命令取得证据后勾选。不把计划中的预计文件当作现有实现。
- 当前工作区执行；先检查 git status，保留用户改动，不做 reset/clean，不自动推送或合并。每批仅提交自己修改的文件，提交前确认未夹带已有改动。
- Mastra 工作前读 `.claude/skills/mastra/SKILL.md`，查询本地已安装文档和类型；所有 agents/tools/workflows/scorers 在 src/mastra/index.ts 注册；使用 package.json 的 dev/build 脚本。
- 不修改 node_modules，不升级框架，不新增规划 LLM、图表库、浏览器、MCP 或文档解析系统。
- 保留鉴权、用户/线程隔离、模型选择、记忆模型/阈值、ETag、Skill pin、配额、公开网络出口与取消规则。
- Skill/模型诊断不得暴露凭证、宿主路径或无权限资源；探针不在启动或聊天时自动付费。
- 新任务预算不取代旧的图表/错误限制；格式与完成修正合计最多一次，不重新发起完整 Agent。
- 迁移仅 additive；014 被占用时用下一编号，不改已应用迁移。真实数据库与 Docker 使用隔离测试环境，禁止清理开发/生产数据。
- 文档中的源码路径均相对仓库根目录，供 Cursor 定位；先确认文件存在再修改。允许因已有重构调整入口，但须在验证记录说明，不能借此改变行为约定。

## Review Focus

1. 天气范围、年份、时区、缺失小时和单位：不能把错日期或少量小时当完整七天日均；Task 5/6 覆盖。
2. public/private 同名模型与凭证更新：探针结果不能串用户或沿用旧 key；Task 3 覆盖。
3. 模型重试、并行工具、重复流事件和恢复：真实执行只计一次，实际重试仍收费；Task 7 覆盖。
4. 存储损坏、只读挂载与无权限访问：检查不能变成隐式修复或泄露资源；Task 2 覆盖。
5. 旧历史、样式跟进与 mixed 请求：升级不得丢数据、改来源或误限合法工具；Task 6/8/9 覆盖。

## 批次与依赖

| 批次 | 任务 | 交付 |
|---|---|---|
| A：可诊断 | 1 → 2 → 3 | 已有故障可见，模型能力可验证 |
| B：需求完整 | 4 → 5 → 6 | 天气需求、来源、呈现和部分交付正确 |
| C：执行受控 | 7 → 8 | 预算不可绕过，终结状态可恢复展示 |
| D：可验收 | 9 → 10 | 固定任务评测、live 记录、部署与回滚说明 |

所有批次均可独立测试。先 observe，最终验证 enforce；不以某一批通过宣称整个第一阶段完成。

## Task 1：固定基线、验证框架接缝并建立 additive schema

**Files:**
- Read: AGENTS.md、package.json、web/package.json、src/mastra/index.ts、agents/agent.ts、models/transport.ts、skills/agent-bindings.ts。
- Create: migrations/014_agent_phase_one_quality.sql。
- Create: tests/task-quality-schema.test.ts、tests/task-quality-hooks.integration.test.ts。
- Create: docs/superpowers/verification/2026-10-22-agent-phase-one-task-quality.md。

**Interfaces:**
- SQL 表：app_skill_health、app_model_capability_checks、app_agent_run_controls、app_agent_run_operations。
- run_controls 主键 server runId，包含 user_id、thread_id、contract jsonb、profile、mode、main_calls、repair_calls、tool_calls、active_ms、revision、status、outcome jsonb、created_at、updated_at；run_operations 唯一 `(run_id, operation_id)`，kind 为 main-model/repair-model/tool，保存状态和必要时间，不存参数正文。
- capability_checks 保存连接指纹、安全检测结果、probeVersion、checkedAt；public/private 分别关联现有模型记录，使用互斥外键/约束，不用没有外键的任意模型 ID。给对应模型表增加 credential_revision（默认 1）。
- skill_health 主键 `(skill_id, version, manifest_hash)`，外键复用版本键，保存检查状态、安全诊断、checking 起始时间；过期 checking 只允许显式新重检接管，不自动重复重建。

- [x] **Step 1:** 记录 git status、实际 Node/依赖版本和现有测试基线；读取已安装 `@mastra/core/dist/processors/index.d.ts` 的 processInputStep/processLLMRequest/processOutputStep、缓存响应与 AbortSignal 定义，及当前 Agent start/resume 绑定。
- [x] **Step 2:** 写失败测试：模拟 provider 记录真实 HTTP 尝试；证明 input/output processor 顺序、缓存响应不调用 provider、真实重试能被单独识别，工具包装保留 inputSchema。运行 `node --import tsx --test tests/task-quality-hooks.integration.test.ts`，应因缺少应用级接缝断言失败；不能把预期 SDK 行为捏造成应用测试。
- [x] **Step 3:** 选择唯一预算接缝：主模型 guarded fetch 外层负责逐 HTTP 请求预留，工具 execute 外层负责逐工具启动预留；processor 只管理策略与完成检查，不重复收费。接缝上下文显式带 server runId、purpose=chat|memory|title|probe，未绑定主 run 的 memory/title/probe 不占主回答额度。将实际 SDK 重试/多 HTTP 行为写入验证记录。
- [x] **Step 4:** 在隔离 PG 写 migration 测试：正确外键、唯一键、credential_revision 默认值；重复 operation_id 不可新增；不可跨 user 更新 run。编写 additive migration，复用现有模型/Skill 主键实际类型，SQL 不包含测试用户或业务数据。
- [x] **Step 5:** 运行 `node --import tsx --test tests/task-quality-schema.test.ts tests/task-quality-hooks.integration.test.ts`；DB 不可用明确 skip，后续最终验收须补跑。记录基线后提交 `chore: add task quality persistence and hook contracts`。

## Task 2：Skill 只读诊断、定向恢复与健康展示

**Files:**
- Create: src/mastra/skills/health.ts、health-repository.ts。
- Modify: src/mastra/skills/reconcile.ts、service.ts、routes.ts、types.ts；按实际需要复用 release-store.ts/blob-store.ts，不改变 manifest 哈希。
- Create: scripts/skills-doctor.ts；Modify: package.json、web/src/agent/skills/skills-api.ts、SkillCard.tsx、SkillPicker.tsx、SkillVersions.tsx。
- Test: tests/skills-health.test.ts、tests/skills-routes.test.ts、tests/skills-reconcile.test.ts、web/src/agent/skills/SkillCard.test.tsx、SkillPicker.test.tsx。

**Interfaces:**
- `inspectSkillStorage(target: ReconcileTarget, deps: HealthDeps): Promise<SkillHealthReport>`；纯只读，报告设计 §5 所列字段。
- `getSkillHealth(auth, skillId, version?): Promise<SafeSkillHealth>`、`recheckSkillHealth(auth, {skillId, version?, repair}): Promise<{status: 'done'|'checking'; report?: SafeSkillHealth}>`；权限沿用现有 policy。
- `reconcileSkills` 增加受信服务层传入的可选 targets 过滤，继续使用既有锁/staging；不让客户端直接构造目标 manifest。
- GET /agent-skills/:id/health、POST /agent-skills/:id/health/recheck，base 与现有 routes 一致。列表增加可选 storageHealth 字段，旧客户端字段缺失仍可工作。

- [x] **Step 1:** 写失败测试：发布树和 blobs 完整→healthy；仅发布树缺→repairable；任一资源 blob 缺/损坏→unavailable；纯指令无 scripts 正常；SKILL.md 可由 DB 精确重建；dryRun 不能把未查 blob 的版本判 repairable。
- [x] **Step 2:** 增加只读文件系统测试：inspect 不 mkdir、不修复、不改变 mtime；资源读取失败保留安全错误码。运行 `node --import tsx --test tests/skills-health.test.ts`，确认新增接口尚不存在导致 FAIL。
- [x] **Step 3:** 实现诊断和 repository；启动协调将报告落库并聚合日志。全扫描离线执行；请求仅查询/检查选中版本。状态缓存必须按 manifestHash 隔离，文件执行原有实时校验不能删除。
- [x] **Step 4:** 添加 API 权限测试：未登录 401，无权资源不泄露是否存在；普通使用者不得 repair；管理者可只读 recheck 和定向 repair；同目标合并；超过 30 秒返回 202，结果可 GET 查询；基础设施失败不把版本永久标坏。
- [x] **Step 5:** 实现 API、CLI 和原有列表健康字段；CLI `--json` 退出码 healthy/repairable=0、unavailable=2、infra=1。UI 分开显示存储与 runtime 状态，资源缺失禁止快捷执行但保留管理入口。添加 `skills:doctor` npm script，显式读取环境文件，日志和 JSON 均脱敏。
- [x] **Step 6:** 运行 `node --import tsx --test tests/skills-health.test.ts tests/skills-routes.test.ts tests/skills-reconcile.test.ts` 与 `npm run test --prefix web -- src/agent/skills/SkillCard.test.tsx src/agent/skills/SkillPicker.test.tsx`；临时目录模拟恢复成功，不修复真实丢失资源。提交 `feat: expose skill storage health and targeted recovery`。

## Task 3：模型兼容性探针、权限和执行路由

**Files:**
- Create: src/mastra/models/capabilities.ts、capability-probe.ts、capability-repository.ts。
- Modify: src/mastra/models/types.ts、repository.ts、service.ts、resolver.ts、routes.ts、transport.ts。
- Modify: web/src/agent/model-catalog-client.ts、ModelSettingsMenu.tsx、PrivateModelMenu.tsx；公共管理页面用 `rg 'model-catalog|supportsVision' web/src` 定位并复用现有入口，不新建平行模型中心。
- Test: tests/model-capabilities.test.ts、tests/model-routes.test.ts、tests/model-transport.test.ts、web/src/agent/ModelSettingsMenu.test.tsx。

**Interfaces:**
- `probeModelCapabilities(auth, modelRef, {signal}): Promise<ModelCapabilityReport>`；safeReport 三项状态 supported/unsupported/unknown。
- `resolveModelCapabilities(auth, modelRef): Promise<ModelCapabilityReport>`；过期或指纹不同返回 unknown。
- `selectStructuredDelivery(capabilities): 'native-schema'|'data-tool'|'compatible-fallback'|'unavailable'`；无静默换模型。
- `createTransportModel(config, options?)` 增加可选 capability/调用上下文，旧调用仍有效；supportsStructuredOutputs 仅在当前连接已验证 supported 时开启，不默认 true。

- [x] **Step 1:** 写模拟供应商测试：正常三项通过；忽略 response_format；忽略指定工具；返回错误参数/nonce；timeout/429/5xx→unknown；明确协议不支持→unsupported；chat/responses 都覆盖，包装后工具必含 inputSchema。
- [x] **Step 2:** 写安全缓存测试：两个用户同名私有模型不共享、改 baseUrl/apiMode/modelId/key revision 立即失效、7 天后 unknown、公共非管理员探针拒绝；调用 60 秒内重复返回 429，同连接最多一个探针。运行 `node --import tsx --test tests/model-capabilities.test.ts` 应 FAIL。
- [x] **Step 3:** 实现 3 个纯值探针，随机 nonce、每次 10 秒、256 output token、总 30 秒、无自动重试。复用 guarded fetch 的出口/重定向检查，不能为探针放松 SSRF 策略。
- [x] **Step 4:** 保存安全报告，添加 POST /model-catalog/:scope/:id/capabilities/probe 和 SafeModel 可选能力字段；更新凭证时同事务递增 revision；删除模型级联诊断。探针禁用配置时返回明确不可用，不发请求。
- [x] **Step 5:** UI 显示能力“已通过/不兼容/未验证”、检查时间和最多 3 次请求提示，点击发起；网络错误可见但不覆盖用户模型选择。将图表 schema/纯值工具分支接入能力解析，unknown 只走有界兼容路径。
- [x] **Step 6:** 运行 `node --import tsx --test tests/model-capabilities.test.ts tests/model-routes.test.ts tests/model-transport.test.ts tests/model-resolver.test.ts tests/model-security.test.ts` 及模型 UI 测试。模拟能力全部通过不算真实供应商通过。提交 `feat: verify model tool and schema compatibility`。

## Task 4：任务约定、需求项和纯函数完成评估

**Files:**
- Create: src/mastra/agents/task-quality/types.ts、contract.ts、completion.ts、config.ts。
- Modify: src/mastra/agents/turn-policy.ts（只增加稳定协作接口，不重写已有意图分类）。
- Test: tests/task-contract.test.ts、tests/task-completion.test.ts。

**Interfaces:**
- `resolveTaskContract(input: {runId; userText; turnPolicy; now; targetTimezone?; hasAttachments; selectedSkillIds; previousContract?}): TaskContract`；完整类型依设计 §7。
- `evaluateTaskCompletion(contract: TaskContract, evidence: CompletionEvidence): TaskOutcome`；evidence 包含已验证图表、天气 coverage、受信文件记录和取消/预算状态，不能接受客户端 completed。
- `resolveTaskBudget(profile, adminConfig): RunBudget`；精确采用 8+1/12/180s、20+1/30/300s、40+1/60/900s，上限遵循设计 §11。

- [x] **Step 1:** 写表驱动测试：天气默认核心字段；“只要气温，不要降雨”排除降雨；明确湿度提升 required；明天起算；显式 HTML；附件/Skill 保持 mixed/general；样式请求继承数据；普通问答不强加图表或预检工具能力。
- [x] **Step 2:** 写完成评估断言：全部可验证必需项 met→complete/verified；温度有而天气缺→partial；全无数据→failed；取消保留已有成果→cancelled；一般长文本只能 model-assessed；unverified 不转 met；预算停止不抹掉已完成成果。先运行 `node --import tsx --test tests/task-contract.test.ts tests/task-completion.test.ts` 确认 FAIL。
- [x] **Step 3:** 实现纯函数，无模型调用、无 HTTP、无文件写入。固定 requirement ID：weather.location、weather.range、weather.condition、weather.temperature、weather.precipitation、weather.humidity、delivery.chart、delivery.file；通用显式文本需求用 generic.explicit.N，check=declared-only。
- [x] **Step 4:** 配置解析拒绝 0/负值/NaN/超上限和非法 mode；observe/enforce 行为只在执行适配层判断，评估纯函数两模式返回相同事实。运行 Task 4 测试及 tests/turn-policy.test.ts 后提交 `feat: define task contracts and completion evidence`。

## Task 5：天气领域适配、日期与来源验证

**Files:**
- Create: src/mastra/agents/weather/types.ts、requirements.ts、evidence.ts、codes.ts、aggregate.ts。
- Modify: src/mastra/agents/chart-data.ts、chart-evidence.ts、chart-data-tool.ts、chart-instructions.ts。
- Create: tests/weather-evidence.test.ts、tests/weather-aggregate.test.ts、tests/fixtures/task-quality/weather/*.json。
- Modify: tests/chart-data.test.ts、tests/chart-evidence.test.ts、tests/chart-instructions.test.ts。

**Interfaces:**
- `readWeatherSubmission(raw, contract, evidence): WeatherValidationResult`：返回已冻结 V2 snapshot 或字段级失败；缺项与无效来源分开。
- `evaluateWeatherCoverage(snapshot, contract): RequirementResult[]`。
- `aggregateHourlyHumidity({times, values, dates, timezone}): Array<number|null>`，首期唯一派生转换 humidity-hourly-daily-mean。
- `weatherCodeToLabel(code: number): {label: string; known: boolean}`，未知不猜测；schema 根据 TaskContract 选择 V1/V2 单一 provider 形状，服务端保留 union 接受历史 V1。

- [x] **Step 1:** 固定时间和真实结构的脱敏数据 fixture；覆盖七天、跨年、目标城市与服务器跨日、DST 23/25 小时、未知代码、错单位、错地点、数组错位和 null。fixture 明确不是当前真实预报，不能将其显示为 live 结果。
- [x] **Step 2:** 写失败断言：同温度不同天气代码不能通过；只相同月日但不同年份拒绝；从兄弟对象拼数组拒绝；伪 source URL 拒绝；低温大于高温拒绝；用户提供的真实数据通过且无虚构链接；来源字段映射错误拒绝。
- [x] **Step 3:** 运行 `node --import tsx --test tests/weather-evidence.test.ts tests/weather-aggregate.test.ts` 应 FAIL；核对供应商官方天气代码和 hourly/daily 单位/时区说明，把所用 URL、映射版本和聚合口径写入验证记录，不猜 API 不存在的 daily humidity 字段。
- [x] **Step 4:** 实现 typed weather schema 与字段路径验证；只支持键数组路径、受限转换，禁止 eval/JSONPath 脚本。温度、降水、天气代码和日期逐字段绑定到可信响应；湿度只对完整当地日历日算平均，缺小时→null/缺项。
- [x] **Step 5:** V1 parser/hash 不变；V2 hash 包含 metadata、metric 和 provenance。restoreChartSnapshot 明确分版本，样式跟进只复用不可变 snapshot。为新 V2 部分数据设计 valid-but-incomplete 返回，不能将 partial 和 schema 不合法混为一谈。
- [x] **Step 6:** 更新取数指导：默认一次预报尽量取得 weather_code、temperature_2m_max/min、precipitation_probability_max 或 precipitation_sum，按请求加 humidity/wind；只在证据不足时必要补取数，不能重复搜索确认相同事实。更新提交 schema 与工具描述，不引导模型输出 HTML/ASCII/ECharts 代码。
- [x] **Step 7:** 跑 Task 5 新测试和 chart-data/evidence/instructions 现有测试，包含 schema 可被当前 SDK 序列化的契约测试。提交 `feat: validate complete weather trend data`。

## Task 6：会话内天气图表与新旧快照兼容

**Files:**
- Create: src/mastra/agents/weather/render.ts、tests/weather-chart.test.ts。
- Modify: src/mastra/agents/chart-data.ts、web/src/agent/message-parts.ts、markdown/EChartsBlock.tsx；仅在需要时新增 markdown/WeatherSummary.tsx 复用现有消息样式。
- Test: web/src/agent/markdown/EChartsBlock.test.tsx、web/src/agent/message-parts.test.ts、新增 WeatherSummary.test.tsx（若新增组件）。

**Interfaces:**
- `buildWeatherChart(snapshot: WeatherSnapshot, coverage): {option; markdown; summary}`，option 为纯 JSON，summary 为可访问的每日天气/补充指标文本。
- data-nero-chart 保留原 type；data 增 schemaVersion/kind/metadata，旧字段保持；旧消息没有版本按 V1 解析。

- [x] **Step 1:** 写失败测试：天气每日文字可见，温度和降水分网格，单位明确；湿度明确请求时无需 hover 也可见；未知天气显示未知；部分数据可渲染但有缺项提示；option 中无函数、远程图片或 HTML formatter。
- [x] **Step 2:** 实现确定性配置与安全 summary。复用 ECharts 及现有清理/错误处理；天气符号使用内置字符或本地资源。360px 宽度布局可读，长中文城市名不覆盖图例。
- [x] **Step 3:** 加旧 V1 数值图、V2 天气图、刷新历史、样式跟进快照哈希不变测试；同一数据 source 不因样式改动重取数；mixed/HTML 不被强行变为天气图。
- [x] **Step 4:** 运行 `node --import tsx --test tests/weather-chart.test.ts tests/chart-data.test.ts` 和 `npm run test --prefix web -- src/agent/markdown/EChartsBlock.test.tsx src/agent/message-parts.test.ts`；临时页面或现有开发页验收移动端与桌面，保留截图到 verification，不运行生产样式重构。提交 `feat: render weather conditions and precipitation inline`。

## Task 7：预算事务、真实调用计数与停止机制

**Files:**
- Create: src/mastra/agents/task-quality/budget.ts、run-control-repository.ts、execution-context.ts、tool-guard.ts。
- Modify: src/mastra/models/transport.ts、agents/run-progress.ts、agents/run-metrics.ts、skills/agent-bindings.ts、agents/agent.ts；复用现有绑定，不创建第二个 server runId。
- Test: tests/task-budget.test.ts、tests/task-budget-db.test.ts、tests/task-budget.integration.test.ts、tests/run-progress.test.ts。

**Interfaces:**
- `reserveRunOperation(auth, {runId, operationId, kind}): Promise<{allowed; duplicate; remaining; reason?}>`，PG 单事务检查所有权、状态和预算，再原子插入/计数。
- `finalizeRunOperation(runId, operationId, result): Promise<void>`，幂等，不保存完整结果正文。
- `withTaskExecutionContext(context, fn)`，使用现有请求链明确传递上下文或 AsyncLocalStorage；并发测试证明不会串 run，memory/title/probe 目的不占主预算。
- `guardTaskTool(tool, control)` 保留 inputSchema/outputSchema/id/toModelOutput，执行前预留、结束后计量、透传 AbortSignal。

- [x] **Step 1:** 写失败测试：第 9 个 simple-chart 主请求禁止，第 1 个 repair 允许、第 2 个禁止；工具第 13 个禁止；general/complex 精确阈值；失败重试每次计数、本地 cache 不计；并行预留不超限、重复事件不加数。
- [x] **Step 2:** DB 测试两个连接争最后额度只有一个成功；同 operationId 不重复扣减；跨用户拒绝；旧 run 恢复保持计数、新用户轮次建立新 run；两用户并发上下文不串。运行 Task 7 测试应 FAIL。
- [x] **Step 3:** 实现 PG reservation 和 Task 1 确认的唯一接缝。HTTP 重试每次生成独立 attempt ID；同一工具回放事件沿用 call ID。预留返回 duplicate 不再执行：复用已有结果、等待原调用，或将缺失结果标未确认；新失败重试使用新 attempt ID。预留后进程崩溃不退还额度，标结果未确认，不自动重试副作用。数据库不可用时受控执行 fail closed，不绕预算继续运行。
- [x] **Step 4:** 实现 active 截止和暂停/继续计时：等待用户不计时，恢复从持久计数继续；AbortSignal 贯穿模型 fetch 和可取消工具，超时不再启动新工具。已有运行无法恢复时终结 interrupted，不伪称自动继续。
- [x] **Step 5:** 统一旧重复失败与新预算决策，保留 ETag/目标变化后的合法恢复。唯一 repair token 由 run control 分配，不能在 chart/completion 各用一次。停止时本地生成安全结果说明，不再请求 LLM 总结。
- [x] **Step 6:** observe 只记录 wouldStop，不绕过原图表/权限限制；enforce 真阻断。测试 memory/title 用独立模型正常、主回答结束后记忆错误不改 outcome。添加终结记录保留 30 天清理，活跃/未确认记录不清理。
- [x] **Step 7:** 运行 `node --import tsx --test tests/task-budget.test.ts` tests/task-budget-db.test.ts tests/task-budget.integration.test.ts tests/run-progress.test.ts tests/run-progress.integration.test.ts tests/run-metrics.test.ts`；报告 DB skip。提交 `feat: enforce per-run model and tool budgets`。

## Task 8：接入完成检查与单回答级终结状态

**Files:**
- Create: src/mastra/agents/task-quality/processor.ts、web/src/agent/task-outcome.ts、task-outcome.test.ts。
- Modify: src/mastra/agents/turn-policy-processor.ts、run-metrics.ts、agent.ts、index.ts、web/src/agent/message-parts.ts、chat-message-reconciliation.ts；展示沿用现有 MessageList 消息组件，不做整页重构。
- Test: tests/task-quality-agent.integration.test.ts、tests/chart-delivery.integration.test.ts、web/src/agent/chat-message-reconciliation.test.ts。

**Interfaces:**
- `createTaskQualityProcessor(): Processor`，创建 contract、注入简短需求、调用 completion；预算真实调用计数不在 processor 再实现一遍。
- data-nero-task-outcome 为设计 §9 完整 payload；同 run 单一权威终结结果，DB revision 单调递增；旧/迟到状态不能覆盖终结。
- 文件证据复用已授权 user file service 返回的文件引用/ETag，验证存在、属于当前用户且生成版本一致；不凭模型文本声称有文件就判 met。

- [x] **Step 1:** 写失败集成测试：模型只提交温度→partial；完整天气→verified complete；普通问答→model-assessed；文件写失败→failed/partial；取消保留已产物；无数据/无可靠提交能力→failed，不能无限 repair。
- [x] **Step 2:** 实现处理链单一所有权：原 turn-policy 管工具/提交，task-quality 管 contract/outcome，run control 管修正额度与停止。先有数据校验再有完成判断；指标最终读取 outcome，不因为没有 toolCalls 就自动认定任务成功。
- [x] **Step 3:** 正常阶段可在剩余预算内补齐核心字段；终结修正仅重提已有证据、纯数据/文本，无联网/写文件。流已发送错误结论时追加更正，最终 partial 清楚标缺项，不伪造撤回。
- [x] **Step 4:** 服务端持久化 outcome 并发送自定义 part；前端按 run/消息 ID 协调，重复流事件不重复显示。刷新、切线程、重连、旧历史均测试，禁止全局 toast 替代该回答的状态。
- [x] **Step 5:** 指标新增预算和 coverage，价格无配置→null；分别保留 answerMs/memoryMs。测试完整提示词、源文件、原始推理和 API key 不进入新指标/诊断输出。
- [x] **Step 6:** 运行新集成与已有图表交付、消息协调、run metrics 测试，验证 wrapped ask_user/web_fetch inputSchema 不丢失；提交 `feat: report verified and partial task outcomes`。

## Task 9：固定质量评测与显式 live runner

**Files:**
- Create: src/mastra/agents/task-quality/evaluation.ts、scripts/eval-task-quality.ts、tests/task-quality-eval.test.ts。
- Create: tests/fixtures/task-quality/cases.json、对应预报/模型响应 fixtures。
- Modify: package.json；验证结果写 docs/superpowers/verification/2026-10-22-agent-phase-one-task-quality.md 及同前缀脱敏 JSON。

**Interfaces:**
- `runQualityEvaluation({mode: 'fixture'|'live', cases, modelRefs, maxMainModelCalls, signal}): Promise<EvaluationReport>`。
- report 包含 caseId、modelRef 安全标识、expected/actual status、requirement coverage、source checks、模型/工具/修正次数、timings、passed、skipped、blocked、hardFailures。未运行不计 pass，金额未知 null。
- npm scripts：`eval:task-quality` 默认 fixture；`eval:task-quality:live` 必须显式 --live，使用已授权测试模型/用户，最多两个模型，套件上限 60 主请求。

- [x] **Step 1:** 把设计 §10 的 20 个固定用例逐项写入 cases.json；每项给输入、受控工具/模型 fixture、期望 outcome、核心 coverage、预算与副作用断言。天气 1 必须有 condition/temp/precip，case 4 温度单图不得 pass。
- [x] **Step 2:** 写 runner 测试：默认不联网、不扣模型额度；fixture 通过生产适配入口，不只直接调用 evaluator；任一硬门槛失败退出 1；skip/blocked 分开计数；重复执行不受真实日期影响。
- [x] **Step 3:** 实现 fixture 依赖注入，无真实文件破坏、HTTP、模型、Docker；保持实际 processor、schema、预算和消息终结逻辑。运行 `npm run eval:task-quality`，20/20 通过且硬失败 0。
- [ ] **Step 4:** live runner 仅在 --live 后使用服务端测试凭证；创建测试线程/文件目录并记录标识，结束清理仅限本次创建的资源，不删除真实聊天。5 项/模型使用受控用户请求，真实取数、真实模型，模拟网络不足用明确测试入口隔离注入并标记该项为 live-model-with-fault-injection。
- [x] **Step 5:** 校验检测与 live 额度不混报；live 主请求预算达到 60 时停止，剩余 blocked，不自动换模型或重跑全部失败项。生成脱敏 JSON/Markdown，保存失败原因、限制及实际耗时。提交 `test: add task completion quality evaluations`。

## Task 10：全量验收、部署说明与交付自审

**Files:**
- Modify: README.md、.env.example、docs/superpowers/verification/2026-10-22-agent-phase-one-task-quality.md。
- Create: docs/agent-phase-one-operations.md（Skill 配套备份、恢复、模型探针与 observe/enforce 上线说明）。
- Modify: 本计划勾选与证据链接，只勾选实际已通过项。

- [x] **Step 1:** 在隔离 PG 执行 `npm run db:migrate`；验证旧数据可读、默认 observe、探针默认关闭、新表无敏感正文。用临时 skill storage 演练完整备份恢复、blob 缺失不可恢复和发布树可重建三种情况，记录命令与结果。
- [x] **Step 2:** 跑 `npm test`、`npm run test --prefix web`、`npx tsc --noEmit`、`npm run build`。如本地 Node 不在 PATH，用已安装 Node 22+ 配置 PATH，不修改 package scripts 绕过版本。构建必须通过项目脚本，不能直接运行 mastra build。
- [x] **Step 3:** 跑 `npm run eval:task-quality` 与隔离 DB 专项；已有 Docker 能力用 `npm run test:sandbox:public` 在支持环境回归，不能拿 fake 替代真实联网/依赖安装验收。未运行列 skip 并说明范围。
- [ ] **Step 4:** 配置测试环境 enforce，使用已授权模型跑 live 五项并核对浏览器：完整天气、仅温度、湿度、缺数据、文件任务；检查无 HTML 误生成、无重复图/终结提示、历史刷新保留天气和 outcome。没有可用凭证/登录时记录阻塞，不代替用户操作授权。
- [x] **Step 5:** 部署说明写出新增配置、预算管理员上限、显式探针额度、存储恢复流程和 observe 回滚步骤；回滚不能删除 V2 parser、诊断记录或用户数据，不能绕过既有安全校验。
- [x] **Step 6:** 自审设计 §12 每项到测试/证据的映射；全文搜索 TODO/TBD/伪完成用语，核实 task schema/类型一致。对于 live/DB/Docker 未覆盖项，最终交付明确列出，不宣称“全部完成”。提交 `docs: document phase one quality rollout and verification`。

## Cursor 执行入口

将以下指令交给 Cursor 即可开始实施，无需重新猜测本会话上下文：

> 阅读 AGENTS.md、`.claude/skills/mastra/SKILL.md`、`docs/superpowers/specs/2026-10-22-agent-phase-one-task-quality-design.md` 和本计划。在当前工作区按 Task 1–10 顺序实施，先检查用户未提交改动；保留现有框架、模型选择、记忆策略和安全边界。各任务先补有意义的失败测试，再实现并运行指定检查，取得证据后更新勾选。不要只改天气提示词：必须实现 Skill 健康、模型检测、任务预算/完成约定和质量评测四条工作线。不要引入 MCP、浏览器、多 Agent 或完整长任务重放系统。真实网络、凭证、DB/Docker 不可用时继续可独立完成的工作，并准确记录未验收项；不能伪造成功或自动切换账户/模型。最终报告改动、验证、未完成项及发布条件。

## 需求到任务映射

| 设计要求 | 任务 |
|---|---|
| Skill 完整性、状态、授权、迁移恢复 | 1、2、10 |
| 实际模型兼容、缓存失效、有限探针 | 1、3、9 |
| 任务约定、显式/默认需求、完成状态 | 4、8 |
| 天气状况/温度/降水/湿度与来源 | 5、6 |
| 请求/工具预算、重试、取消与恢复计数 | 1、7、8 |
| 新旧图表、历史消息和单回答终结 | 6、8 |
| 固定任务评测、live 范围和证据 | 9、10 |
| observe/enforce、部署与回滚 | 4、7、10 |
