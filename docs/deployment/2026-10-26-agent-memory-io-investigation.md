# 2026-10-26 ECS Agent 内存与读盘异常调查

本次通过已登录 Workbench 取证，未启动 Agent、恢复自启、执行业务迁移或删除数据。读取原数据库时使用只读模式和只读文件系统保护；另创建临时诊断副本用于隔离检查。时间均为 Asia/Shanghai。

## 结论与置信边界

已经确认 Agent 后端是主要资源消耗进程；其观测存储和宿主保护配置存在明显不匹配。在数据库副本上，观测适配器启动初始化的 127 条 DDL 批次复现了受限进程内存超限；通过跳过已满足的约束变更、再临时关闭退出 checkpoint，两步对照可完成整个初始化与关闭，成为当前最优先且有实验支持的定位路径。服务自启会在多次系统重启后重新运行初始化。

尚未取得故障进程的堆、原生调用栈或 I/O 文件采样，因此不能把“DuckDB 已证实为唯一根因”“WAL 重放卡住”“内存泄漏”“数据库损坏”写成已证实结论。本次未在小规格生产机上重启复现。初步读图时曾将主库和 WAL 文件名看反，复核后已更正：708 MiB 是主库，约 2.25 MiB 才是 WAL，不能据此推导大量 WAL 重放。

另确认下午部署漏执行 015 SQL 迁移，直接导致产物收集失败。这是独立的部署缺陷，不能仅凭错误重复就认定它造成了系统夯住。

## 已核实证据

| 项目 | 观察结果 |
| --- | --- |
| 实例 | 2 vCPU、标称 2 GiB，free 显示总内存约 1740 MiB |
| 服务停止后 | 可用内存约 1022 MiB，Swap 约 3071 MiB、使用量为 0；这是停止后的状态，不代表故障时没有内存压力 |
| 服务状态 | `nero-agent` inactive/dead，UnitFileState=disabled，MainPID=0 |
| 服务保护 | Restart=always、RestartSec=5s；MemoryMax/MemoryHigh 均为 infinity；没有 NODE_OPTIONS 配置项 |
| 当前发布 | `/opt/nero-agent/releases/20261026T1345-skill-readiness` |
| DuckDB 文件 | `/var/lib/nero-agent/mastra.duckdb`，742,404,096 字节（708.01 MiB）；文件创建于 10 月 8 日，不能假定全部由本次 PPT 任务产生 |
| DuckDB WAL | `/var/lib/nero-agent/mastra.duckdb.wal`，2,359,347 字节（约 2.25 MiB），文件创建于 14:53 左右 |
| 观测配置 | `new DuckDBStore().getStore('observability')`，未显式设置 memoryLimit、threads、retention；配置 MastraStorageExporter |
| 线上 DuckDB 包 | @mastra/duckdb 1.11.1，默认 `max_memory` 为 2GB；该值是数据库上限，不是预留内存，也不是整个 Node 进程的上限 |
| 旧版依赖 | 上一 skill-search 发布也是 @mastra/duckdb 1.11.1，旧版也使用 DuckDB；问题风险不是本次才引入 |
| WAL 小样本 | 仅分别读取头尾 2 MiB，包含 execute_command、skill_read、observation、messages、input/output 等标记；不能据此计算整份 WAL 的任务归属或数据比例 |
| 业务迁移 | Docker 中实际业务数据库 app_schema_migrations 仅到 014；015 已随当前发布包交付，但 app_agent_artifact_runs 不存在 |
| 内核日志 | 在此次筛选的 13:00—17:32 窗口未查到 OOM/Killed process 事件；这不能排除回收压力、卡顿或重启前日志未落盘 |
| 受限只读打开 | 独立 transient unit：MemoryMax=384M、MemorySwapMax=0、CPUQuota=25%、磁盘读取上限 10M、20 秒总超时；DuckDB max_memory=128MB、threads=1、READ_ONLY。约 10.16 秒完成打开和表名查询，进程 RSS 约 96 MiB。不能声称数据库无法打开或仅打开即耗尽内存；该结果也不等价于完整应用/故障工作负载的表现。 |
| 副本初始化检查 | 先通过受限进程复制主库与 WAL 到 `/tmp/nero-incident-duckdb-copy-20261026`。再只导入 DuckDBStore 并调用 init，未加载业务入口。MemoryMax=384M、MemorySwapMax=0、CPUQuota=25%、读写各 10M、总超时 45 秒；DuckDB memoryLimit=128MB、threads=1。导入后 RSS 约 94 MiB，进入 127 条 DDL 批次后触发 cgroup OOM；journal 明确记录 Result=oom-kill、384.0M memory peak。它是在更紧预算下的组件级复现，尚不能单独等同于整个线上负载的复现。 |
| 逐条 DDL 定位 | 同一临时副本和相同预算下，将批次改为逐条执行，最后到达第 95 条 `ALTER TABLE score_events ALTER COLUMN traceId DROP NOT NULL`，未完成；该次 journal 记录 Result=signal、SIGKILL、384.0M peak（有 40 秒外部超时，不能把该次也标为已确认 OOM）。 |
| 原库只读约束元数据 | score_events 估计 0 行，feedback_events 估计 0 行；两个表的 traceId 均已经 is_nullable=YES。span_events 估计 15,945 行。每次启动仍执行上述 DROP NOT NULL，属于可避免的重复约束操作。 |
| 副本对照检查 | 相同资源预算下，仅在元数据确认 traceId 已经可空时，跳过 score_events、feedback_events 两条 DROP NOT NULL，其他 125 条初始化 SQL 保持。初始化 8.889 秒完成，RSS 约 187 MiB；得到 15,945 条 span 事件，时间从 10 月 8 日到 10 月 26 日 14:53 左右。这是启动初始化问题的正向对照，不是完整应用已修复的证明；随后 close 阶段未正常完成，须另行检查 checkpoint/关闭开销。临时 guard 只在诊断子进程中使用，未改线上 node_modules 或项目代码。 |

后续已确认副本对照进程在 close 阶段同样被 cgroup OOM killer 终止，Result=oom-kill、384.0M peak。因此不能把“跳过重复 DDL”当作完整修复；关闭/落盘路径也是独立需要解决的内存预算问题。诊断结束时生产服务仍 inactive/disabled，原数据库两文件字节数不变，可用内存约 1015 MiB。

最终对照：在同一副本、相同内存/CPU/I/O 预算下，保留约束状态判断，并只在该进程设置 `PRAGMA disable_checkpoint_on_shutdown`，完整 init/查询/close 正常结束，总耗时 10.935 秒。初始化完成时 RSS 约 182 MiB，关闭后约 120 MiB。这支持关闭 checkpoint 为前一对照的关键开销，但不代表永久关闭 checkpoint 就是生产方案，也不证明故障最初的 PPT 峰值只由该路径造成。未将该 PRAGMA 应用到生产服务。

最后核验：该诊断单元日志为 Deactivated successfully；没有运行中的 `nero-incident-*` 单元；nero-agent 仍 inactive/disabled；原主库与 WAL 字节数保持 742,404,096 / 2,359,347，可用内存约 998 MiB。临时副本保留供后续离线验证，不属于生产数据库。

DuckDB 官方说明，部分操作可在 buffer manager 外分配内存，故 memory_limit 不是整个进程的硬上限：[OOM 指南](https://www.duckdb.org/docs/current/guides/performance/oom)。退出时 checkpoint 的开关见 [Pragmas](https://www.duckdb.org/docs/lts/configuration/pragmas)。与本次更低预算的组件实验结合，说明仍须宿主 cgroup 限额，且不能只限制 V8 堆或执行容器。

售后提供的故障截图中，Node RSS 为 864056 KiB（约 844 MiB），CPU 128.8%；截图是取样值，不是进程内存峰值。它包含嵌入式数据库原生内存，不能全部视为 JavaScript 堆。

## 时间线

- 13:43—13:45：部署初期有入口读取/权限相关失败及自动重试；当时修正权限并完成后续启动。不能将这段已结束的失败直接等同于 15 点后的持续卡顿。
- 13:49 左右：服务启动；随后 PPT 对话能调用工具并留下日志。
- 14:51 左右：用户监控截图显示读盘升高并持续接近约 107 MB/s。
- 14:53：服务多次记录 `relation "app_agent_artifact_runs" does not exist`，涉及 artifact start/before/after 收集路径。
- 15:26、15:45、15:52、16:32 等重启后：服务日志只见 systemd Started，缺少应用完成启动的信息。这与启动初始化被阻塞相符，但没有栈证据证明具体阻塞函数。
- 17:23：日志确认进程退出后 systemd 安排自动重启；解释了单独 kill 不一定能维持停止。
- 17:30:45：服务被停止；当前保持禁用自启并能连接 Workbench。

## 与代码的对应

- `src/mastra/index.ts`：会话等主要存储使用 PostgreSQL，observability 单独使用 DuckDB。708 MiB 是观测主数据库，不能当成 PPT 文件，也不能直接等同于会话数据库。
- `node_modules/@mastra/duckdb/dist/db-BWgrbB_u.js`（已按线上版本核对）：默认 memoryLimit=2GB，未配置 threads 时使用数据库默认并行度。数据库与 Node、PostgreSQL、Docker 和其他服务共同竞争宿主内存。
- `node_modules/@mastra/duckdb/dist/observability-BVE7R9Oz.js`：init 每次运行 ALL_DDL/ALL_MIGRATIONS；其中第 95 条和最后一条分别无条件对 score_events/feedback_events.traceId 执行 DROP NOT NULL。原库该约束已满足，在受限副本上对此增加状态判断能使 init 完成，说明该重复操作是可避免的启动负担。不得仅以批次运行失败就声称 SQL 拼接本身为唯一问题，逐条执行也在第 95 条未完成。
- `src/mastra/sandbox/docker/config.ts` 和 `skills/script-container.ts`：执行容器有 384 MiB、0.5 CPU 的限制，但这些限制不约束宿主 Node 内的 DuckDB。
- `src/mastra/sandbox/execution-queue.ts`：全局最多两个命令槽，同会话串行；这不等价于对宿主后台存储和启动恢复限流。
- `src/mastra/files/artifacts/collector.ts`：产物采集依赖 015 表。缺表是已证实的问题；其扫描也在宿主进程中，不能仅靠容器 I/O 限制覆盖。
- `migrations/015_agent_turn_artifacts.sql`：当前应补齐的业务迁移。

## 建议的下一步（尚未执行）

1. 继续保持 Agent 停止。保留 DuckDB 主文件与 WAL 成对备份，以及 PostgreSQL 备份和故障日志；不要直接删除 WAL。
2. 在隔离且有内存预算的环境，对数据库副本做打开/初始化诊断，采集原生内存、CPU、实际读取文件及数据库恢复结果；如果静态打开正常，再比较完整应用初始化和任务执行。不得用副本覆盖生产原文件来“试修”。
3. 修复观测初始化的重复约束变更（根据真实元数据只执行必要迁移，纳入受控依赖修复与回归），并为观测存储选择适合小规格主机的方案：显式低内存和单线程，或将观测迁往独立存储/按需要关闭本地观测写入；同时控制采样、记录体积与保留期。具体值需以验证结果决定；初始化通过后仍须解决/验证关闭和 checkpoint 的开销。
4. 为宿主服务增加与其他进程留量相容的 MemoryHigh/MemoryMax、重启频率限制和监控。仅设置 V8 max-old-space-size 不能限制 DuckDB 等原生内存。
5. 经数据库备份后执行并核对 015 迁移，修复产物收集；将“预期迁移=实际迁移”作为每次发布的硬检查。
6. 在受控环境先验证冷启动、长 PPT 对话和异常退出后的恢复，再安排线上启动。I/O 保护需同时覆盖执行容器及宿主存储/扫描，限额按总预算制定。

本报告是定位结果及后续验证建议，不代表故障已修复，也不保证单纯升配或回滚代码能处理现有持久数据相关问题。
