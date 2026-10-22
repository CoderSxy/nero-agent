# 第一阶段任务质量验证记录

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

## 尚未验收

- 全量测试、web 测试、`tsc`、`npm run build`。
- `npm run db:migrate` 尚未把 014 应用到持久库。
- Docker public sandbox、live 模型评测、浏览器天气验收。
