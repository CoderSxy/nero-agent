# 第一阶段审查问题修复与验证

日期：2026-10-22。范围：本会话审查发现的六项问题。代码在当前工作区修改，未创建 worktree，未自动提交或推送。

本记录补充并更正早期 `2026-10-22-agent-phase-one-task-quality.md` 的验收口径：原预算函数测试不代表生产执行已受预算控制；原 fixture 注入 coverage 不代表任务闭环已通过；原 live blocked 不只是缺凭证，原实现也没有真实调用分支。下面记录的是修复后的实现和实际验证。

## 修复对应关系

| 问题 | 修复 |
|---|---|
| 预算未接入生产 | `task-quality/runtime.ts` 复用服务端绑定 run/thread；主模型 transport 逐 HTTP 尝试预留 PG 预算，最终工具集合统一执行前预留。记忆/标题不接主回答预算。 |
| V2 被提交 Schema 拒绝 | 服务端工具接受 V1/V2；按本轮意图给供应商暴露单一 numeric/weather Schema，避免顶层 union 的兼容问题。 |
| 缺项/未验证字段仍 complete | 每个提交 metric 和非空天气代码必须有唯一来源；解包真实 web_fetch JSON；核对单位、数组、日期、范围和需求缺项。缺降水或天气为 partial，来源不明则拒绝。 |
| 固定日期/时区 | 生产使用当前服务端时间和上下文时区；保留本轮 referenceInstant，用预报所在地时区验证当地七日范围。固定日期只存在于 fixture。 |
| 历史文件冒充本轮成功 | 仅由已鉴权的写工具登记本轮文件证据，完成时重新读取并匹配 ETag；旧 run、删除和版本变化均不能通过。历史路径文字不再是证明。 |
| fixture/live 未实现闭环 | fixture 通过真实 Agent/SDK、取数适配器、提交、来源校验和 completion，不注入 coverage/fileVerified。live 使用指定测试用户和已配置模型，实际调用生产 Agent；有 enforce 和套件 60 次上限。 |

额外回归：模型选择中读取记忆模型不再覆盖聊天模型能力；预算耗尽后可本地终结，不为总结再付费；天气 V2 历史恢复兼容实际保存的 metadata；湿度检查单位、小时槽完整性及夏令时重复小时，不能用 24 个相同小时冒充完整一天。

## 已执行检查

- 完整后端：`node --import tsx --test tests/*.test.ts`，582 项，541 通过、41 条件跳过、0 失败。因代理测试需要监听回环端口，本次完整回归在获准的执行环境运行。
- 数据库专项：隔离库 `127.0.0.1:5433/nero_agent` 的 `tests/task-budget-db.test.ts` 通过：并发争最后额度仅一次成功、重复操作不扣费、其他用户拒绝、恢复沿用计数。测试只创建并清理自己标识的测试用户和运行记录。
- 生产接线集成：`tests/task-quality-production-budget.test.ts`，实际 SDK/model transport + processor 工具，共享服务端预算；预先消耗 19 次 general 请求后，本次只有一次请求到达模拟网络，工具执行一次，下一步本地结束。
- 六项问题回归：`tests/phase-one-review-regressions.test.ts`，覆盖实际提交 Schema、未绑定数据、缺降水、当前时区日期、旧文件误判、文件版本、错误年份及重复湿度小时。
- 固定评测：`npm run eval:task-quality`，20/20，blocked=0、hardFailures=0。报告保存在同目录 `2026-10-22-agent-phase-one-task-quality-eval.json` / `.md`。modelCalls 是模拟 SDK 请求数，paidModelCalls=0，没有外部模型付费调用。
- 前端全量：`npm run test --prefix web -- --maxWorkers=2`，62 文件、441 项全部通过。最初与构建/后端并行时 Mermaid 单项发生 5 秒超时；单独重跑 43 项通过，降低并行度后的全量也通过，没有修改测试超时或隐藏失败。
- 类型检查：`npx tsc --noEmit` 通过。
- 构建：项目 `npm run build` 通过，最后后端改动又通过 `npm run build:mastra`。构建期间遥测 DNS 不可达不影响构建结果。
- 收尾改动的针对性回归也已运行：图表交付、生产预算、SDK hooks、天气与评测测试通过。

## 运行与验收边界

- 当前默认仍是 observe；强制预算需要部署设置 `AGENT_TASK_QUALITY_MODE=enforce`，没有自动修改开发或生产 `.env`。
- 本次未指定真实评测测试用户/模型，未运行付费模型或真实天气供应商验收。不能把模拟数据报告作为实时天气结果或供应商兼容性证明。
- live 命令、显式测试用户/模型配置、退出码和测试资源保留策略见 `docs/agent-phase-one-operations.md`。
- Skill 资源恢复、现有公开网络出口、数据库迁移和用户数据均未被本次修复自动修改。
