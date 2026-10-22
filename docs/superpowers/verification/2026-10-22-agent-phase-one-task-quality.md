# 第一阶段任务质量验证记录

> 审查后的实现与最新验收以 [六项问题修复记录](2026-10-22-agent-phase-one-review-fixes.md) 为准。下文保留原始实施过程，原 fixture 和预算测试不单独证明生产执行闭环。


日期：2026-10-22。本文只记录已经跑过的命令和读到的安装代码，不把未接线的预算当成已强制执行。

## 基线

- 分支 `dev_sxy1`。开始时工作区只有未跟踪的本阶段计划与设计文档，没有其他已改源码。
- Node `v22.22.0`。`package.json` engines 为 `>=22.13.0`。
- 已安装：`@mastra/core` 1.71.0、`zod` ^4.4.3、web `react` 19.1.0、`echarts` 6.1.0、`vitest` 3.2.4。没有为了本阶段升级依赖。
- 全量 `npm test` 未在改动前重跑。后续 Task 10 再跑全量，并单独列出 DB / Docker / live 是否执行。

## Task 1：预算接缝与 schema

安装包 `@mastra/core` 1.71.0 的 processor 类型在 `node_modules/@mastra/core/dist/processors/index.d.ts`：

- `processInputStep` 在每步模型调用前，参数含 `runId?`、`abortSignal?`、`retryCount`。
- `processLLMRequest` 在提示词转换之后、provider 之前。返回 `{ response }` 时，循环用缓存 chunk 代替模型调用。
- `processOutputStep` 在该步模型结果之后、工具执行之前。
- `processLLMResponse` 的类型写明 `fromCache`。1.71.0 的 `agent` 运行文件只在 `cachedResponse` 为空时调用它，缓存命中不会再进这个钩子。

Agent 的 `generate` / `stream` / `resume*` 仍由 `installSkillExecutionBindings` 绑定服务端 runId。预算上下文不复用客户端可写字段，单独走 `AsyncLocalStorage`。

唯一计费接缝：

- 主模型：`createTaskBudgetFetch` 包在 `createGuardedModelFetch` 内层网络调用之前。通过出口校验的每一次 HTTP 使用新的 attempt id。缓存响应不进入 fetch，因此不预留。
- 工具：`guardTaskTool` 包在 `execute` 之外，按 `toolCallId` 预留一次。相同 id 返回 duplicate，不再执行。
- processor 不调用预留。`processorChargesBudget()` 固定为 false。
- 上下文含 `runId` 与 `purpose=chat|memory|title|probe`。只有 `purpose=chat` 且 `runId` 非空计入主回答额度。memory / title / probe 记为 auxiliary。

实测（`node --env-file-if-exists=.env --import tsx --test tests/task-quality-hooks.integration.test.ts tests/task-quality-schema.test.ts`）：

- 处理器顺序为 input → fetch → output。一次普通完成只有 1 次 HTTP。
- 第二次把第一次 `processLLMResponse` 捕获的 chunks 交回 `processLLMRequest` 后，fetch 次数和主预算都不再增加。
- `modelSettings.maxRetries: 1` 时，第一次 HTTP 429、第二次 200。安装代码里模型步骤默认 `retries: modelSettings?.maxRetries ?? 2`，最小间隔 `RETRY_MIN_TIMEOUT_MS = 1000`。本次观察到 2 次 HTTP、2 个不同 attempt id，都计入 main-model。重复提交同一个 attempt id 为 duplicate，主预算仍是 2。测试耗时约 1.0 秒，与一次重试间隔一致。
- 指向 `127.0.0.1` 的请求在 guarded fetch 拒绝，预留数为 0。
- `guardTaskTool` 保持原来的 `inputSchema` 引用。包装后的工具出现在 provider payload 时，`city` 字段仍在 JSON Schema 的 properties 里。

Schema：隔离库 `127.0.0.1|localhost:5433/nero_agent` 上，测试在事务中应用 `migrations/014_agent_phase_one_quality.sql` 后回滚，没有留下测试用户。断言通过：`credential_revision` 默认 1；capability 检查公有/私有外键互斥，孤立 id 被外键拒绝；skill health 外键指向 `(skill_id, version)`；重复 `(run_id, operation_id)` 唯一约束拒绝；`app_update_agent_run_status` 用其他用户返回 `42501`。操作表没有 arguments / prompt / api_key 列。

生产 `createTransportModel` 仍直接使用 guarded fetch，本任务还没有把预算接到真实对话。强制计数在 Task 7。

## Task 2：Skill 存储健康

`node --import tsx --test tests/skills-health.test.ts tests/skills-routes.test.ts tests/skills-reconcile.test.ts`：20 通过，0 失败。

`npm run test --prefix web -- src/agent/skills/SkillCard.test.tsx src/agent/skills/SkillPicker.test.tsx src/agent/skills/SkillVersions.test.tsx`：23 通过。

- 发布树和资源 blob 都完整为 healthy。没有 scripts 的纯指令版本仍为 healthy。
- 只缺发布树、资源 blob 可读、数据库 SKILL.md 与 manifest 一致时为 repairable。改过的 SKILL.md 不能当成可重建。
- 资源 blob 缺失为 unavailable。`reconcileSkills({ dryRun: true })` 仍可能给出 wouldRebuild，健康检查不会据此判 repairable，也不会把发布树写回去。
- inspect 不新增目录、不改 marker 的 mtime。读取失败的错误码是 `BLOB_UNREADABLE`，报告里没有宿主路径。
- 健康记录按 `(skillId, version, manifestHash)` 隔离。检查过程抛基础设施错误时，已有记录不会被写成 unavailable。
- 同一目标的重检合并为一次 inspect。等待超过调用方时限时返回 checking。
- HTTP：未登录 401；无权用户 404 且响应体不包含技能 id；普通用户 `repair: true` 为 403；管理员定向 repair 为 200；只读重检超时形状为 202。请求体里的 skillMd 不会进入服务参数。
- `npm run skills:doctor` 使用 `--env-file-if-exists=.env`。退出码 0/2/1 分别对应健康或可恢复、不可用、基础设施失败。
- 列表可带可选 `storageHealth`。选择器在资源缺失时禁用快捷执行；管理卡片仍保留编辑入口，并分开显示存储和运行状态。

定向恢复仍走原来的 reconcile、锁和 staging。测试在临时目录重建 `skill-a`，没有改仓库外的真实技能目录。

## Task 3：模型能力探针

`node --env-file-if-exists=.env --import tsx --test tests/model-capabilities.test.ts tests/model-routes.test.ts tests/model-transport.test.ts tests/model-resolver.test.ts tests/model-security.test.ts tests/model-schema.test.ts tests/model-catalog-db.test.ts tests/model-admin-page.test.ts`：34 通过。

`npm run test --prefix web -- src/agent/PrivateModelMenu.test.tsx src/agent/ModelSettingsMenu.test.tsx`：14 通过。

`node --import tsx --test tests/turn-policy.test.ts`：7 通过。

- 探针默认关闭。`MODEL_CAPABILITY_PROBE_ENABLED` 不是 `true` 时，私有模型探针返回 400，说明不会发起请求。公共模型的非管理员探针返回 404。
- 模拟供应商：工具、强制工具和 JSON Schema 都回传随机 nonce 时为 supported。忽略工具、错误 nonce、忽略 schema 为 unsupported。timeout、429、5xx 为 unknown。协议明确不支持为 unsupported。chat 与 responses 都覆盖。请求体含 `inputSchema`，不含 API key。
- 指纹按 scope、记录 ID、owner、规范化 baseUrl、apiMode、provider、model、credential revision 和探针版本计算。两个用户的同名私有模型不共享。改 baseUrl、apiMode、modelId 或 revision 后旧结果失效。超过 7 天回到 unknown。60 秒内重复为 429，同一连接已有探针时为 busy。
- 更换 API key 的 PATCH 在同一条更新里把 `credential_revision` 从 1 增到 2。诊断表随模型外键 `ON DELETE CASCADE` 删除。
- `supportsStructuredOutputs` 只有 `jsonSchema === 'supported'` 才为 true。未探测或 unknown 走 compatible-fallback，图表仍使用现有 structuredOutput。工具可用但 schema 不支持时走 data-tool。`forcedToolChoice === 'unsupported'` 时不再强制 toolChoice。
- 对话模型在解析后读取 `nero-agent.model-capabilities`。记忆模型不打开结构化输出。
- 私有模型列表显示未验证、已通过或不兼容，以及检查时间。只有点击“检测能力”才发请求。网络错误显示在页面上，不改当前模型，也不刷新对话所选模型。
- 这些通过来自模拟响应，不是真实供应商探测。

隔离库 `127.0.0.1:5433/nero_agent` 已执行 `npm run db:migrate`，应用了 `014_agent_phase_one_quality.sql`。迁移只增加列和表。

## Task 4：任务约定与完成评估

先运行 `node --import tsx --test tests/task-contract.test.ts tests/task-completion.test.ts`，因模块不存在失败。实现后与 `tests/turn-policy.test.ts` 一起再跑：14 通过。

- 默认天气趋势要求地点、七日范围、状况、气温、降水，湿度为可选。上海时区下 `2026-10-22T04:30:00Z` 的范围是 2026-10-22 到 2026-10-28。“只要气温，不要降雨”去掉状况和降水。“从明天开始”改为 2026-10-23 到 2026-10-29。明确湿度后该项为 required。
- HTML 不带天气图。附件和已选 Skill 保持 mixed，档位不是 simple-chart。样式跟进复制上一份需求，不改日期。普通问答只有 `generic.explicit.1`，check 为 declared-only。
- 预算为 8+1/12/180 秒、20+1/30/300 秒、40+1/60/900 秒。0、负数、NaN、小数、超上限和非法 mode 会拒绝。
- 可核验必需项全部 met 为 complete/verified。温度有而天气缺为 partial。没有成果为 failed。取消为 cancelled，已 met 的项还在。预算停止不把已有成果改成 failed。普通长回答是 complete/model-assessed，需求状态保持 unverified。observe 与 enforce 传入评估函数得到同一结果。

## Task 5：天气证据

`node --import tsx --test tests/weather-evidence.test.ts tests/weather-aggregate.test.ts tests/chart-data.test.ts`：8 通过。V1 图表测试仍通过，旧 hash 仍是数据集 JSON 的 SHA-256。

官方说明来自 2026-10-22 读取的 [Open-Meteo forecast API](https://open-meteo.com/en/docs)。映射版本 `open-meteo-docs-2026-10-22`。

- 日变量包含 `weather_code`、`temperature_2m_max`、`temperature_2m_min`、`precipitation_sum`、`precipitation_probability_max`。单位分别是 WMO code、°C、°C、mm、%。
- 日变量列表里没有相对湿度。`relative_humidity_2m` 只在 hourly，单位 %。日均湿度用 `humidity-hourly-daily-mean`：按当地日历日对小时值做算术平均，预期小时数用时区计算。Europe/Berlin 的 2026-03-29 是 23 小时，2026-10-25 是 25 小时。小时不齐则为 null。
- 同一对象上的日期数组和数值数组才算绑定。兄弟对象里的数组不能拼成一天。年份必须完整相等。未知天气代码可以留下数字，但该日状况不算完成。用户来源的 `sourceUrl` 必须为空。
- fixture `tests/fixtures/task-quality/weather/open-meteo-sample.json` 标记 `live: false`，不是当前预报。
- 提交工具仍使用现有 V1 schema，避免 oneOf 改变当前图表协议。`schemaVersion: 2` 由 `readChartSubmission` 单独验收；不完整但结构合法时返回 coverage，不记成 schema 非法。

## Task 6：天气图

先运行 `node --import tsx --test tests/weather-chart.test.ts`，因 `weather/render` 不存在失败。实现后与 `tests/chart-data.test.ts`、`tests/turn-policy.test.ts` 一起再跑：14 通过。

`npm run test --prefix web -- src/agent/markdown/EChartsBlock.test.tsx src/agent/message-parts.test.ts`：21 通过。

- 每日天气写在图外文字里。温度、降水、湿度分网格，单位写在轴名和文字里。未知代码显示“未知天气（代码 N）”。缺项写在摘要开头。option 里没有函数、远程图片或 HTML formatter。
- 长城市名截断，图例在底部。360px 使用 media query。
- V1 哈希仍是数据集 JSON 的 SHA-256。改标题不改天气数据哈希。HTML 和附件请求不会变成天气图。
- 预览页 `docs/superpowers/verification/weather-chart-preview.html` 在浏览器里打开过。桌面和 360px 区块都能看到温度、降水、湿度和未知天气，长站名没有盖住图例。

## Task 7：按轮预算

先运行 `node --import tsx --test tests/task-budget.test.ts`，因预算模块不存在失败。

之后 `node --env-file-if-exists=.env --import tsx --test tests/task-budget.test.ts tests/task-budget-db.test.ts tests/task-budget.integration.test.ts tests/task-quality-hooks.integration.test.ts tests/run-progress.test.ts tests/run-progress.integration.test.ts tests/run-metrics.test.ts`：内存预算、隔离库争用、fetch 停止、原有钩子、进度和指标都通过。数据库测试没有 skip。

- simple-chart 第 9 个主请求、第 2 次修正、第 13 个工具在 enforce 下拒绝。general 第 21 个、complex 第 41 个主请求拒绝。
- 新的重试 id 单独计数。相同 operation id 不重复扣减。缓存只记 noteCachedResponse，不占主请求。
- 两个并发只拿到最后一个名额。observe 超限仍放行并标记 wouldStop。存储失败时 enforce 返回 unavailable，不继续调用。
- 隔离库两个连接争最后一次主请求，只有一个成功。另一用户被拒绝。同一 run 恢复后工具还能记，主请求剩余是 0。
- 预算门关闭时，模型 fetch 在出网前停止。没有门的旧钩子测试仍然通过。

## Task 8–10

- `3a307cd` 把完成结果写到同一条回答。只交温度是 partial，完整天气是 verified complete，普通问答是 model-assessed。文件失败、取消和无数据不会被标成完成，processor 不追加第二次修正。
- `e729b74` 与 `npm run eval:task-quality`：fixture 20 通过，hardFailures 0，价格 null，模型调用 0。温度限定用例不包含天气状况。晴雨缺失保持 partial。报告在 `docs/superpowers/verification/2026-10-22-agent-phase-one-task-quality-eval.json`。
- `npm test`：574 项，533 通过，41 跳过，0 失败。跳过项是测试文件里原有的条件测试，不是把失败改成通过。
- `npm run test --prefix web` 第一次有 2 个 MessageList 超时，和全量 Node 测试、类型检查同时跑。单独重跑 `src/agent/MessageList.test.tsx`：43 通过。其余 web 测试在第一次运行里已经通过。
- `npx tsc --noEmit` 通过。`npm run build` 通过，使用的是项目脚本 `mastra build --studio`，不是手跑构建命令。
- 隔离库 `127.0.0.1:5433/nero_agent` 执行 `npm run db:migrate`。`app_users` 仍可读。`AGENT_TASK_QUALITY_MODE` 未设置时为 observe。`MODEL_CAPABILITY_PROBE_ENABLED` 未设置，探针关闭。新表列名没有 prompt、api key、password、secret 或正文。
- `node --import tsx --test tests/skills-health.test.ts` 在临时目录通过：完整发布为 healthy；发布树缺失且 blob 还在为 repairable；blob 缺失为 unavailable / `BLOB_MISSING`，检查本身不重建目录。没有动开发用的真实 Skill 存储。

## 设计 §12 对照

| 验收项 | 证据 |
| --- | --- |
| Skill 缺失能定位，不能靠空目录修好 | `tests/skills-health.test.ts`，doctor 退出码 |
| 模型检测不隐式换模型，探针默认关闭 | Task 3 与 `MODEL_CAPABILITY_PROBE_ENABLED` 未设置 |
| 天气图含状况、温度、降水；只要温度会精简 | `tests/weather-chart.test.ts`，评测 `weather-complete` / `weather-temperature-only` |
| 缺项是 partial | 评测 `weather-condition-missing` |
| 预算不能被重试或并发绕过 | `tests/task-budget.test.ts`、`tests/task-budget-db.test.ts` |
| 旧图、文件、权限和记忆仍在 | `npm test` 0 失败；图表交付测试通过 |
| 确定性评测通过；live、Docker 单独记录 | fixture 20/20。live 与 public sandbox 见下 |

## 尚未验收

- Task 9 Step 4 和 Task 10 Step 4 没有勾。没有 `EVAL_LIVE_API_KEY`，live 五项记为 blocked，没有改用别的账户或模型，也没有打开浏览器代为登录。
- Docker 进程可用，但没有 `SANDBOX_IMAGE` 和 `SANDBOX_EGRESS_IMAGE`。`npm run test:sandbox:public` 未运行，不能用假网络代替。
- 真实供应商能力探针没有发。默认配置不会自动发起。
- 发布前仍需在 enforce 下用已授权模型看完整天气、只看温度、湿度、缺数据、文件任务，并确认历史刷新后图和完成结果都还在。
