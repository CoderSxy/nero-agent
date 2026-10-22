# 通用 Agent 第一阶段：可靠执行与任务完成质量设计

日期：2026-10-22。状态：供用户及 Cursor 审阅、实施的设计文档；本文及配套计划的创建不表示产品代码已实现或线上已验收。

配套计划：[实施计划](../plans/2026-10-22-agent-phase-one-task-quality.md)。

## 1. 目标与已确认范围

将通用 Agent 从“工具能执行、图表能显示”提升为“需求覆盖明确、执行受控、结果可验证、基础能力可运维”。第一阶段包含四条工作线：

1. Skill 资源完整性、运行前检查、故障可见性及迁移恢复操作规范。
2. 模型工具调用和结构化输出的实际兼容性检测。
3. 通用任务约定、执行预算、需求覆盖检查及诚实的完成状态。
4. 可重复的真实任务质量评测。

天气趋势作为贯穿第三、第四条的首个完整案例：默认应包含天气状况、最高/最低气温、降水情况；只画温度不能视为完整天气趋势。用户明确只要气温时，不擅自扩大范围。用户说“适度”等影响字段选择的歧义时，可依据上下文识别为湿度并说明；无法确定时使用已有 ask_user，不把模糊词无条件写成强制字段。

本轮只交付设计和计划。后续实现沿用当前工作区，不默认新建 worktree。Cursor 按任务逐步执行、验证并更新计划勾选项，不要求用户重复确认已经明确的范围。

## 2. 当前实现依据

以下是本次检查的现有机制，实施时先复核，避免重复建设：

| 现有位置 | 已有能力 | 本阶段补充 |
|---|---|---|
| `src/mastra/skills/reconcile.ts` | 发布版校验、从 blob 重建、PG/进程锁、GC；默认不可用处理主要输出日志 | 区分资源缺失与可重建，持久化诊断结果，授权查询与重检 |
| `skills/release-store.ts`、`blob-store.ts` | 内容哈希、不可变发布快照、文件校验 | 复用校验，不以空目录或空脚本冒充恢复成功 |
| `skills/runtime.ts`、`service.ts` | runtime/tools/network 可用性、授权及 run pin | 分离存储健康与运行环境可用性，执行入口重新检查 |
| `models/types.ts`、`transport.ts` | 模型目录、视觉属性、chat/responses 适配及出口校验 | 按连接指纹保存兼容性；移除 compatible transport 无条件 `supportsStructuredOutputs: true` 假设 |
| `agents/turn-policy*.ts` | 交付意图、纯图表工具边界、结构化修正 | 扩展为任务约定与需求覆盖；保留图表已有约束 |
| `agents/chart-data.ts`、`chart-evidence.ts` | 纯数据提交、来源比对、不可变快照、平台生成 ECharts | 支持有类型的天气字段，严格日期/单位/来源绑定 |
| `agents/run-progress.ts` | 重复失败识别、按调用 ID 去重、历史恢复计数 | 通用预算、真实调用计费口径与统一停止状态 |
| `agents/run-metrics.ts` | 主回答、工具、首图及记忆耗时 | 补需求覆盖、预算、修正次数、终结状态 |
| `web/src/agent/message-parts.ts`、`markdown/EChartsBlock.tsx` | 会话内图表及持久化消息渲染 | 新旧数据兼容、天气注释、单回答级任务结果 |

曾观察到数据库保留 Skill 发布元数据、外部资源目录缺少 blobs，启动产生 `BLOB_MISSING`。这说明需要资源与数据库配套恢复，不意味着所有部署当前都缺文件。上线前必须重新诊断。

当前有会话内 Observational Memory、定时任务与 resume 绑定。本阶段不宣称重做这些能力，也不承诺服务重启后自动继续任意运行中的外部操作。

## 3. 方案选择与边界

候选 A：只改提示词。成本低，但无法约束忽略 schema 的网关、缺失的 Skill 资源或伪成功。

候选 B：在现有单 Agent 增加小型任务约定、证据校验和预算适配层。复用既有 Mastra、工具、存储、消息协议，逐步启用。**采用 B。**

候选 C：增加独立规划模型、多 Agent 和全新工作流引擎。成本和迁移面大，容易增加天气这类简单请求的耗时，不纳入第一阶段。

不包含：Office/PDF 语义解析、OCR、统一跨格式成果中心、MCP、浏览器操作、项目长期记忆、自动模型切换、Redis 队列、完整运行日志重放系统。现有文件生成仅增加文件存在性和版本证据检查，不承诺每种格式内容都被深度验收。

## 4. 执行总览与模块职责

```text
用户请求 + 已授权附件/Skill + 服务端日期/时区
  → resolveTurnPolicy（保留现有交付模式）
  → resolveTaskContract（目标、范围、需求项、预算档位）
  → Skill/模型能力预检
  → 原有 Agent 循环（每次模型/工具调用前预留预算）
  → 收集受信工具证据、提交数据或文件引用
  → evaluateTaskCompletion（字段、来源、交付、需求覆盖）
  → complete / partial / failed / cancelled
  → 原有消息流 + data-nero-task-outcome + 指标
```

新增的任务模块放 `src/mastra/agents/task-quality/`，不把所有逻辑继续堆进 `turn-policy-processor.ts`。该目录负责约定、预算和完成评估；天气适配器放 `agents/weather/`；存储和模型诊断保留各自模块。无新增规划 LLM、无新增图表库。

所有 agents/tools/workflows/scorers 在 `src/mastra/index.ts` 注册。Processor 在 `agent.ts` 显式装配。Mastra API 以当前 `node_modules` 的文档和类型为准，不修改依赖源码。

## 5. Skill 健康与运行前检查

### 5.1 分开表达两类状态

新增 `SkillStorageHealth`：`unknown | healthy | repairable | unavailable`。保留原有 `SkillAvailability` 的 instructions-only、ready、missing-runtime、missing-tools、network-unavailable 语义，不将存储错误硬塞进 runtime 枚举。

诊断记录包含：skillId、version、manifestHash、status、checkedAt、safeCode、resourceCount、missingCount、corruptCount。管理端可以取得有界的相对资源路径明细；普通使用者仅获得状态、错误码及建议，不暴露宿主路径、无权限版本或完整资源内容。

- healthy：发布树及受引用 blobs 通过完整性检查。
- repairable：发布树不完整，但重建所需内容均存在且哈希正确。缺少 SKILL.md blob 时，允许从数据库 skill_md 恢复其**完全一致**的内容；不能由此推断其他文件可恢复。
- unavailable：任一必要资源 blob 缺失/损坏，或发布数据不一致。保留原始原因，如 BLOB_MISSING，不自动改发布指针。
- unknown：尚未检查；不能在界面显示为“已验证可用”。

`inspectSkillStorage(target, deps)` 必须只读。现有 reconcile dryRun 对不完整发布树只给 wouldRebuild，不能作为 blob 完整性的证明；新增检查需实际读取/验证所引用 blob。自动重建继续走原有 reconcile、锁和 staging 原子替换，不建立第二条修复写路径。

### 5.2 API 与显示

沿用现有 skills route base：

- `GET /agent-skills/:id/health?version=N`：现有查看/使用权限范围内的诊断；默认当前发布版。
- `POST /agent-skills/:id/health/recheck`，body `{version?: number, repair: boolean}`：有管理该 Skill 权限的用户调用。repair=false 只检查；repair=true 才触发原有 reconcile 的定向重建。相同版本合并在途操作，单次接口等待上限 30 秒，超时返回 202 和当前 checking 状态，由之后的 GET 查询；不启动无界后台重试。

新增表 `app_skill_health`，主键 `(skill_id, version, manifest_hash)`，诊断内容不写回发布版正文。启动复用原有单次协调并写入汇总；按错误码聚合日志，保留管理端逐项查询，不在每个聊天请求全量扫描所有 Skill。执行前仅校验本次选中/加载的固定版本，缓存不能替代原有执行时文件完整性和授权检查。

普通聊天的列表显示“资源缺失，暂不可执行”；管理端展示恢复建议。无 Skill 的请求不受其他无关 Skill 故障影响。纯指令 Skill 不因不存在 scripts/ 目录误判失败。

### 5.3 迁移恢复与运行环境

新增只读 CLI `npm run skills:doctor -- --json`，正常退出 0、存在 unavailable 退出 2、基础设施故障退出 1；repairable 单独报告，不自动写磁盘。人类可读与 JSON 输出都不得包含凭证、宿主文件内容。

运维文档规定：暂停发布/import/sync/GC 等写入 → 备份 PG 与完整 skills-storage → 校验备份清单 → 恢复至隔离目标 → 配置持久化目录与权限 → 执行只读 doctor → 显式重建可重建发布树 → 再检查 → 恢复流量。仅复制 releases 或仅迁移数据库都不能作为完整备份。普通 doctor 不自动扫描磁盘、下载未知包或重新导入来源仓库。

运行前复用已有 runtime、工具和 public 网络检查；本阶段仅确认已声明的能力是否具备，不发明旧 Skill 不存在的依赖清单。pip/npm 安装失败归类为运行失败并给出原始有界原因，不在预检中安装依赖。

## 6. 模型实际兼容性

### 6.1 连接指纹与检测结果

`ModelCapability = toolCalling | forcedToolChoice | jsonSchema`。每项状态为 `supported | unsupported | unknown`，另带 checkedAt、safeReason、probeVersion。timeout、429、5xx、凭证错误属于检测失败，保留 unknown，不能据此判定 unsupported。

缓存/数据库指纹包含 scope、模型记录 ID、owner、规范化 baseUrl、apiMode、providerId/modelId、凭证修订号和 probeVersion。不保存 API key 或其可反查摘要；凭证修订号在更换 key 时递增。有效期 7 天，配置变化立即失效。公共模型检测由管理员发起，私有模型由所有者发起，禁止跨用户共用私有结果。

检测接口：`POST /model-catalog/:scope/:id/capabilities/probe`，返回每项状态；结果随已有 SafeModel 安全字段返回。每个连接同时一个检测，重新发起最小间隔 60 秒，过快返回 429。模型删除后清理其诊断数据。

### 6.2 三个无副作用探针

每次最多 3 次付费请求、每次最多 10 秒、每次最大输出 256 token、无 SDK 自动重试；总截止 30 秒。探针使用实际生产 SDK/transport 和对应 chat/responses 模式：

1. 自然工具调用：提供本地纯值 echo 工具，检查真实 tool-call 及参数符合 schema，禁止只检查返回文本包含工具名。
2. 强制指定工具：指定 echo 工具，检查实际工具调用及本次随机 nonce，不执行外部动作。
3. JSON Schema：包含随机 nonce、固定枚举、required 与 additionalProperties=false，验证真实解析结果。未遵守返回形状可判 unsupported；一次通过只表示当前探针通过，不宣称供应商永久完整支持所有 JSON Schema 特性。

探针工具是测试/服务内纯值函数，不向业务 Agent 添加联网或文件能力。界面明确“检测会发起最多 3 次模型请求”，用户点击即授权本次检测；不在启动或每次对话自动消耗额度。

### 6.3 能力如何影响执行

- jsonSchema=supported：允许原有 schema 输出路径；若运行中违规，走已有单次修正并记录兼容性异常。
- jsonSchema=unsupported：不发送已知不支持的 schema 参数，优先使用已验证的纯数据工具提交路径。
- unknown：保留受预算控制的兼容路径，但不能把 SDK supportsStructuredOutputs 一律设 true；在本轮允许的一次修正内回退，不为了“验证能力”新增探针调用。
- forcedToolChoice 不支持时，不反复强制同一参数；可使用普通工具提交或有严格解析的数据返回，仍执行相同来源/覆盖检查。没有可靠数据提交路径时明确失败。
- 工具能力已知不支持且任务依赖工具时，执行前说明不兼容；普通文本问答仍可执行。

不静默切换用户选择的模型，不改变独立的记忆模型选择、阈值或权限策略。模型结果丢失、检测过期不能被当成“肯定支持”。

## 7. 通用任务约定与预算

### 7.1 TaskContract v1

服务端生成，不接受客户端传入 allowTools、预算、completed 或 verified 值作为权威：

```ts
type TaskContract = {
  version: 1;
  runId: string;
  deliveryMode: TurnDeliveryMode;
  profile: 'simple-chart' | 'general' | 'complex';
  domain: 'weather' | 'generic';
  requirements: Array<{
    id: string;
    importance: 'required' | 'optional';
    origin: 'explicit' | 'default';
    check: 'weather-data' | 'chart' | 'file-exists' | 'declared-only';
    description: string;
  }>;
  policyVersion: string;
};
```

`resolveTaskContract(input)` 是无模型调用的纯函数，使用原有意图、显式格式/期限、附件/Skill 和已知领域模板。复杂档仅在用户明确请求多个交付或多步修改操作时选择；不能因“分析”两个字就放大预算。无法可靠结构化的通用自然语言要求标 declared-only，不声称已做语义完整验收。用户新消息覆盖旧约定；样式跟进复用既有已验证数据快照，不篡改日期、数据与来源。

无需为每个简单任务显示计划或询问指标选择。只有歧义会改变地点、交付或关键数据时才询问。上传附件/显式选择 Skill 保留既有 mixed/general 边界，不被天气关键词剥夺所需工具。

### 7.2 默认预算

| 档位 | 主回答真实模型请求 | 定向修正 | 工具实际启动数 | 活跃执行截止 |
|---|---:|---:|---:|---:|
| simple-chart | 8 | 最多 1 | 12 | 180 秒 |
| general | 20 | 最多 1 | 30 | 300 秒 |
| complex | 40 | 最多 1 | 60 | 900 秒 |

主请求与修正分别计数，总请求上限分别为 9/21/41。修正预算覆盖格式与完成条件修正的总和，不允许各模块分别再申请一次。修正只有在已有证据足够、只需重提数据/文本时可用；不能凭空补字段，也不能重开完整 Agent、联网或写文件。正常执行阶段尚有预算时，可以为缺失的核心字段补一次必要取数；到终结后只返回已有结果和缺项。

模型重试包括限流/网络重试均消耗请求数。并行工具每个单独计数。按 runId + 稳定 operationId 幂等预留，重复流事件和本地缓存响应不计数。纯数据提交工具占工具数；最终本地结束消息不额外调用模型。记忆/标题生成单独计量，不混入主回答预算，但保留实际成本；不声称整个生命周期的总模型数等于主回答数。价格缺失时金额为 null，不能写成 0。

截止使用运行期服务端计时，等待用户输入和定时任务等待不计入活跃时长。超时传递 AbortSignal 至模型 fetch 和可取消工具；不能取消的在途操作标记结果未确认，不承诺撤销副作用。工具调用前拦截，防止依赖模型遵守 toolChoice:none。重复同状态错误沿用两次恢复提示、三次停止；新 ETag、有效新目标及成功操作可重置相应失败计数。

新增 `app_agent_run_controls` 与 `app_agent_run_operations` 仅用于预算预留、去重及终结快照；PG 事务防止并发超过额度。只存用户/线程/run 标识、契约 JSON、计数、活跃毫秒、版本和安全终结信息，不存完整输入、参数、推理、工具内容。不存在完整进程恢复时，服务重启中的任务标 interrupted/failed，禁止自动重放副作用。保留 30 天后仅清理已终结记录，活跃记录和未完成调用不能按日期直接删除。

预留命中 duplicate 时不得再次执行工具：已有结果则复用受信持久化结果/原工具消息；仍在执行则等待原调用或返回“执行中”；结果不明则标记未确认，不能用相同 operationId 再执行一次。失败后的合法新尝试必须使用新 attempt ID 并扣额度。已写出文件后模型最终答复失败时，保留文件证据及 partial 状态，不回滚用户文件。

## 8. 天气完整性与数据协议

### 8.1 默认与显式需求

默认“未来七天天气趋势”核心需求：正确地点与时区、连续七日、每日天气状况、最高/最低气温，以及每日降水概率或降水量中至少一项。湿度和风为可选；用户明确要求则提升为 required。明确“只要温度”只要求温度及日期/地点/来源，不强加天气/降水。

未来七天默认含所在地今天，共 7 个日历日；“从明天开始”则次日起算。服务端日期、目标地点时区和 API 响应 timezone 一致，不硬编码日期，不用服务端 UTC 截日代替目标城市日期。地理编码存在同名城市且上下文无法消歧时询问。

核心数据缺失时允许展示真实的部分数据，但 outcome=partial，具体列出缺失项，标题不能继续暗示完整天气预报。来源完全不可验证或没有可用数据则 failed。天气代码不认识时显示“未知天气（代码 N）”，不能猜成晴天；计为该日天气未满足。

### 8.2 向后兼容的数据结构

保留已有数值 `categories/series/sources`。新增版本化天气提交变体，不向数值 values 塞字符串，不把晴雨代码当温度曲线。

- V1：旧纯数值图表，保持原解析和历史恢复兼容。
- V2：`schemaVersion: 2`，`kind: 'weather'`，保留数值 dataset；增加 weather 字段：location、timezone、dates、weatherCodes、字段来源映射。
- 数值 series 在 V2 增加稳定 metric：temperature-max、temperature-min、precipitation-probability、precipitation-amount、humidity-mean、wind-speed-max；name 仅负责展示，不能用名称模糊匹配充当来源证明。
- 每个来源映射包含 sourceUrl、recordPath、dateField、valueField、unitField、transform。recordPath 使用对象键数组，不执行表达式；transform 首期仅 identity 或 humidity-hourly-daily-mean。

`submit_chart_data` 的 Zod/JSON Schema 必须同时接受旧 V1 和新 V2；provider schema 的 oneOf/anyOf 若不兼容，采用由本轮 contract 确定的单一提交 schema，不削弱服务端校验。新旧历史快照显式版本分派；原 V1 hash 算法不改变，V2 hash 覆盖天气元数据、metric、来源映射及全部数据。

V2 的稳定 TypeScript 边界如下；实现时用同名 Zod schema 表达，字段长度/数组上限沿用已有图表约束（最多 366 个类别、8 个数值序列、10 个来源）。weather.dates 必须与 dataset.categories 完全相同：

```ts
type WeatherMetric = 'temperature-max' | 'temperature-min'
  | 'precipitation-probability' | 'precipitation-amount'
  | 'humidity-mean' | 'wind-speed-max';
type WeatherFieldSource = {
  kind: 'url' | 'user';
  metric: WeatherMetric | 'weather-code';
  sourceUrl: string;
  recordPath: string[];
  dateField: string;
  valueField: string;
  unitField: string | null;
  transform: 'identity' | 'humidity-hourly-daily-mean';
};
type WeatherPayload = {
  location: { name: string; latitude: number; longitude: number };
  timezone: string;
  dates: string[];
  weatherCodes: Array<number | null>;
  fieldSources: WeatherFieldSource[];
};
```

V2 顶层沿用 status/reason/title/dataset，并新增 schemaVersion=2、kind=weather、weather: WeatherPayload；dataset.series 使用已有 name/unit/values 加 required metric。status=ready 表示有可提交的真实数据，不代表任务 complete；只有 coverage 决定是否完整。部分可用数据中天气数组允许 null，完全无数据时 status=insufficient-data、dataset=null、weather=null。天气源缺失不能填入看似有效的默认代码。user 来源的字段映射不用 sourceUrl 伪造地址，由原始用户数据证据引用替代；需在 schema 中显式区分 kind=user/url，且 user 分支 sourceUrl 为空、原始消息引用由服务器绑定。

### 8.3 证据与计算

复用本轮成功 web_fetch 收集的结构化证据，不接受 HTML 中“看起来有这些数字”作为数值数组证明。V2 按明确字段路径验证，禁止从兄弟对象拼接无关日期和数组。

- 所有日期必须完整 ISO 日期且与约定范围相等，不能沿用仅比较月/日忽略年份的宽松匹配。
- weatherCodes、温度及降水来自相同地点、时区和日期范围；单位必须来自对应响应字段或已验证的固定单位转换，本期不做任意单位转换。
- 降水概率范围 0–100%，降水量 >=0，湿度范围 0–100%，风速 >=0，低温不得高于高温；不为温度设置过窄的全球阈值。
- 天气文字由受测试覆盖的代码表确定性生成；映射表来源和版本在模块注释及验证文档中记录，实施时核对供应商官方说明。
- 湿度若只有小时数据，由平台按当地日历日聚合算术平均，并写明“日均相对湿度”；仅在该日预期小时完整时计算，正确处理 23/25 小时的 DST 日期。缺小时则 null/缺项，不用少量小时冒充日均，不让模型手算。
- 用户提供数据可作来源，但同样逐字段核对；不得给用户数据伪造 API 链接。

### 8.4 渲染与交付

继续会话内 ECharts，由平台生成配置。主区展示最高/最低温；日期对应天气文字/内置符号；降水采用独立网格小图，概率和雨量注明不同单位。窄屏支持横向滚动或分段布局，不把温度、毫米和百分比放同一数值轴。湿度/风在用户要求时增加独立区或有明确单位的补充表，不能只藏在鼠标悬停中导致移动端不可见。

不加载模型提供的远程天气图标，不执行 formatter 字符串或任意 JS。tooltip 用既有安全渲染方式，天气名称是文本。存在缺项时可见文字提示，与图表同属该回答；不得恢复全局“图表未能生成”横幅。

样式修改只能改变展示，快照数据及来源不变。刷新历史、断线重连后天气标注和 outcome 均可恢复，旧图表不丢失。

## 9. 完成状态与可观测性

`evaluateTaskCompletion(contract, evidence)` 返回 `TaskOutcome`：

```ts
type TaskOutcome = {
  version: 1;
  runId: string;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  verification: 'verified' | 'model-assessed' | 'unverified';
  requirements: Array<{
    id: string;
    status: 'met' | 'missing' | 'unverified';
    evidenceRefs: string[];
  }>;
  reasonCodes: string[];
};
```

验证型需求全部满足才是 verified complete。已知必需项缺失但有可用成果为 partial；没有可用成果为 failed；用户取消为 cancelled，已有成果不抹掉。declared-only 的普通回答可标 complete + model-assessed，但界面不能显示“平台已验证全部需求”。`unverified` 表示无法判定，不能默认转 met。

结果作为 `data-nero-task-outcome` 存在最终 assistant 消息并发送，按 runId/upsert 协调，一轮仅一个权威终结结果。流式回答先前已发出的内容不能假装撤回；若出现部分交付，在同回答追加明确更正并用最终 outcome 说明。旧消息没有 outcome 时正常展示，不追补虚构结果。

新增指标：contract/policy version、profile、需求 met/missing/unverified 数、主模型尝试数、修正数、工具启动/失败数、activeMs、answerMs、memoryMs、预算停止原因和 outcome。保留现有主回答/记忆时间边界。不记录完整提示词、原始推理、正文、令牌或文件内容。首图、主回答、整轮生命周期分别呈现，不以“首图已出”冒充任务完全结束。

## 10. 评测与发布门槛

确定性 fixture 走实际 Agent 适配入口、取数工具适配、校验器和消息组装；不能仅调用纯函数后宣称端到端通过。外部 HTTP/模型/Docker 通过明确的注入接缝替换，不跳过任务控制逻辑。

固定 20 个质量用例：

1. 完整七天天气；2. 只要温度；3. 明确湿度（日均）；4. 晴雨字段缺失；5. 降水缺失；6. 错误年份/时区；7. 湿度小时缺失；8. 天气代码未知；9. 忽略 response_format 的网关；10. 不支持强制工具；11. 模型工具 schema 经包装仍完整；12. BLOB_MISSING；13. 发布树缺失但 blob 完整；14. 跨用户诊断拒绝；15. 通用文件请求；16. 普通问答无需工具；17. 重复失败/预算停止；18. 重复事件与同 run 恢复；19. 刷新历史与样式跟进；20. 显式 HTML 与附件/Skill 混合任务。

确定性套件 20/20 通过；不伪造数据、不越权、不超预算、旧历史兼容这些硬门槛零失败。其他现有测试、类型检查与构建通过；DB/Docker 未运行必须分别报告 skip，不算通过。

真实模型评测显式 `--live` 才联网付费，使用测试用户和临时线程，输出脱敏 JSON/Markdown 至 verification 目录。用户指定或已授权的测试模型最多选两个；未指定不擅自采购/新增模型。每个模型跑完整天气、温度限定、湿度、数据不足、文件请求 5 项；需要凭证且当前没有时，记录 blocked，不冒用其他账户。单次 live suite 最多 60 次主回答模型请求，达到上限停止并报告未执行项。

每项记录完成覆盖、来源正确性、真实调用数、修正次数、耗时；live 不要求固定秒数。首个模型五项行为均正确且硬门槛通过才可宣称该模型已验收；只有一个可用模型时明确限定支持范围。外部数据变化不拿数值和 fixture 生硬比较。

## 11. 配置、迁移与回滚

新增 additive migration `014_agent_phase_one_quality.sql`；若实施时编号已占用，采用下一个空闲编号并同步计划，禁止编辑已应用迁移。新增健康表、模型检测表/凭证修订字段、预算表及必要索引；外键和所有者判定沿用现有模型/Skill 表结构。

配置：`AGENT_TASK_QUALITY_MODE=observe|enforce`（新代码默认 observe）；`MODEL_CAPABILITY_PROBE_ENABLED=false|true`（默认 false）；预算可由管理员配置 JSON 覆盖，只接受正整数且不超过 100 主请求、1 修正、100 工具、1800 秒活跃时间。无效配置启动报明确配置错误，不能无限执行。Skill 健康只读检查不依赖 enforce；原有权限/文件完整性检查一直有效。

先 observe 记录新预算与覆盖判断，沿用旧执行限制，不将新天气要求误标 verified；测试环境 enforce 通过后，由部署配置显式启用 enforce。回滚 observe 只取消新预算/覆盖的强制阻断，不能绕过已有安全门禁或恢复无条件 structured-output 声明；新旧消息解析兼容保留。关闭探针不删除已有诊断。DDL 保留，禁止回滚时删除用户数据。

## 12. 最终验收清单

- 缺失 Skill 可定位到资源类故障，不能靠重启/空目录“修好”；其他正常聊天可继续。
- 管理员可检测公共模型、用户可检测自己的私有模型；缓存正确失效，无隐式模型切换。
- 天气完整图包含天气状况、温度、降水；温度限定请求仍精简；显式湿度有准确统计口径。
- 数据、日期、单位、来源和核心需求均检查；缺项是 partial，不能宣称完整。
- 主回答真实请求和工具预算不可被重试、并发、重连或重复事件绕过。
- 旧图表、HTML/文件交付、附件、Skill、权限、ETag、pin 和记忆策略回归保持。
- 确定性评测全过；live、DB、Docker 分别记录证据与未验收限制。
