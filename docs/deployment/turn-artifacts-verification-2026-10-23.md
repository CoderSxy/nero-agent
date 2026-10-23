# Agent Turn Artifacts 验证记录（2026-10-23）

- Spec: [docs/superpowers/specs/2026-10-23-agent-turn-artifacts-design.md](../superpowers/specs/2026-10-23-agent-turn-artifacts-design.md)
- Plan: [docs/superpowers/plans/2026-10-23-agent-turn-artifacts.md](../superpowers/plans/2026-10-23-agent-turn-artifacts.md)
- Migration: `migrations/015_agent_turn_artifacts.sql`
- Branch: `dev_sxy1`（原地实现；未自动提交、未部署）

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 通过 |
| `set -a && source .env && set +a && node --import tsx --test tests/turn-artifacts-*.test.ts` | **26 pass / 0 fail / 0 skip**（含本地 loopback PG） |
| `npm test --prefix web` | **66 files / 471 tests pass** |
| `npm run build --prefix web` | 通过；既有 >500kB chunk warning 仍在，非失败 |
| `git diff --check` | 通过 |

## 缺口对照（design §11 / plan Task 11）

- 文本工具 / 命令·Bash / 技能脚本采集：后端 collector + lifecycle 测试覆盖。
- 暂停/恢复、失败、mutation 锁、净变化：对应 turn-artifacts-* 测试覆盖。
- 历史 persistence / metadata：lifecycle-contract + repository；GET `/current-workspace/turn-artifacts` 已在 `src/mastra/index.ts` 注册。
- 前端列表位置、默认 3 项、revision 合并、dock/reveal/preview：组件与 hook 测试覆盖。
- 分页/鉴权/路径：routes + repository 在本地 DB 全绿。

## 浏览器验收

未在本轮执行真实 Agent 多轮生成 HTML/PPTX 的手工浏览器矩阵（需交互式发消息与审批流）。本地 `npm run dev` 已在运行；自动化覆盖了列表渲染、面板打开、树定位、personal source、404 文案与草稿切换确认。

未执行项：

1. 两轮真实文件生成后的流式/刷新一致性截图。
2. 审批暂停恢复后的产物归属肉眼确认。
3. 移动端全屏预览手工回归。
4. 生产/远端 DB 迁移与部署（按约束禁止）。

## 数据审计备注

产物 DTO/表字段仅含相对路径、etag、size、run/thread 标识；采集路径不写入文件字节或宿主绝对路径。实现未新增模型调用。

## 已知限制

- 浏览器端到端手工矩阵未跑完，见上。
- 全量 `npm test`（非 turn-artifacts 过滤）历史可能含与本功能无关的既有失败；本功能以 `tests/turn-artifacts-*.test.ts` 与 `npm test --prefix web` 为准。

## 2026-10-23 审查问题修复与复验

本节为审查后的修复记录；上文是 Cursor 初次实现时的验证，不能替代本节结果。

已修复：

1. PostgreSQL 工作区锁使用独立的 10 连接池，与应用查询连接池分离；等待其他用户锁的请求每次 try-lock 失败即释放连接，池等待可取消且有超时。补测持锁者仍可查询、池满取消、两个长任务不阻挡第三用户。
2. 个人文件在线保存与精确替换共用用户级写锁；Agent 已持锁时通过私有 token 复用，保留原 ETag、配额和路径检查，防止手动保存混入 Agent 快照。
3. 消息产物支持真实流式 custom part / transport runId 关联，不强制要求 canonical message ID；生成文件后模型报错也能在本轮末尾保留列表。
4. 文件树定位绑定实际加载的 source、workspace、refresh 与 reveal id，切换来源后等待新目录，并在每次点击时刷新；过期点击不再滚动新目标。
5. 采集/落库失败按服务端 user/thread/run 留存降级标记，在终态落为 partial；数据库不可用不阻止或重复原文件操作，模块导入不再提前要求数据库。前端查询失败显示摘要暂不可用并支持重新加载。

新增回归测试先确认失败后修复；只读复核发现独立锁池容量不能限制为两个用户，已调整容量并补第三用户并发案例。

最终验证：

| 检查 | 实际结果 |
| --- | --- |
| `npm test`（允许本机监听端口的环境） | **621 tests：572 pass / 0 fail / 49 skip** |
| `node --env-file-if-exists=.env --import tsx --test tests/turn-artifacts-*.test.ts tests/sandbox-egress-proxy.test.ts` | **33 pass / 0 fail / 0 skip**；本地 loopback PostgreSQL，独立测试数据 |
| `npm test --prefix web` | **66 files / 474 tests pass** |
| `./node_modules/.bin/tsc --noEmit` | 通过 |
| `./web/node_modules/.bin/tsc -b web` | 通过 |
| `git diff --check` | 通过 |
| `npm run build` | 临时隔离副本内 Mastra + web 完整构建通过；使用项目 Node 22.22.0。原目录有正在运行的 Mastra dev，按 CLI 保护未在原目录强制构建 |

说明：普通受限环境全量测试的两项端口监听 EPERM，已在允许本机监听环境复跑全量通过。临时构建保留既有大 chunk warning；Mastra CLI 遥测 DNS 失败不影响构建成功。不改变用户浏览器权限。

本次未进行新的真实浏览器多轮生成/人工审批验收，组件交互与后端持久化、并发通过上述回归验证。未自动提交，未部署线上，未重启本地或线上开发服务。
