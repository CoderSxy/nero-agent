# Agent 观测存储与小规格 ECS 恢复设计

## 目标与证据

关联调查：[事故取证](../../deployment/2026-10-26-agent-memory-io-investigation.md)。已复现 DuckDB 观测初始化重复 DDL 与关闭 checkpoint 在 384 MiB 预算下的内存问题；并确认线上漏执行 015。不能据此认定 PPT 是唯一根因，也不能把 708 MiB 主库误写成 WAL。

目标是让应用不再自动打开旧 DuckDB、避免宿主无限竞争内存和重启、阻止缺迁移发布，再通过分阶段验收决定是否恢复线上业务。本次只在当前工作区实现，不操作生产备份、不执行线上迁移、不恢复自启。

## 选择

1. 移除入口的 DuckDB 导入和临时 store 域抽取，不修改 node_modules，也不靠永久关闭 checkpoint 掩盖开销。
2. 默认 `OBSERVABILITY_STORAGE=off`：无持久观测 exporter，采样 never，关闭观测日志双写。普通系统日志继续写 journal；业务会话、记忆、产物和技能仍用原 PostgreSQL。
3. 可选 `postgres` 模式，必须显式配置独立的 `OBSERVABILITY_DATABASE_URL`。使用已安装 @mastra/pg 1.28.0 的 PostgresStoreVNext，独立连接池最多 2，查询/锁超时；拒绝与业务库同一 host/port/database。不是直接将全部观测转存到当前业务库。
4. 可选观测默认采样 10%、不收内部 span、字符串最多 1024、深度 4、数组/对象各 20。再在输出处理器中删除 input/output/requestContext，限制其余载荷；先裁剪再脱敏。使用自有 exporter，仅保存已结束 span，进行中 span/metrics/logs 不落盘；缓存和在途合计硬上限 128、单批最多 32、仅一个写入批次。数据库慢或失败时丢弃超额/失败记录，限频汇总日志，不重试，不累积连接池等待 Promise。依赖自带 maxBufferSize 只是触发 flush 的阈值，不能代替此准入上限。完整工具内容仍由对话业务链路保存。
5. 独立观测库原生按日分区，每日独立维护任务补未来分区并按 7 天策略清理，仅处理观测五类表；一次每表最多 2 个分区，限时 60 秒。旧 DuckDB 只备份保存，不自动导入；历史 Studio 观测列表会从启用新库时开始。

## 初始化与发布门禁

入口在初始化框架存储、注册后台对账前检查 015 迁移登记及三个产物表。缺失则快速退出并提示执行迁移，不能在聊天中重复缺表。storage.init 由入口显式等待；失败传播，不能后台吞错后接受请求。原 PostgreSQL store 的幂等 init 继续交由依赖管理。

迁移逻辑抽成可测试模块，SQL 文件排序、事务、事务级 advisory lock、lock_timeout/statement_timeout。增加 `--check` 只读检查：比较全部预期与已登记名称并确认产物表存在；缺失或出现未知迁移均非零退出。失败 rollback；仅 commit 后打印成功。保留现有 015，不重复写 016 去掩盖漏执行。

部署包增加 migrate.mjs、maintenance.mjs、ops 脚本和 systemd 模板。服务 ExecStartPre 调用当前 release 的 migrate.mjs --check，缺迁移不能启动。上线流程必须先备份，再执行 migrate，再 check，最后才切换服务。自动启动门禁不能替代备份。

## 数据保护

root 运维备份脚本仅在服务 inactive/failed 且 MainPID=0 时运行；使用与实际容器一致的 postgres 用户/库，不连接宿主另一 PostgreSQL。新建私有目录、拒绝覆盖、flock 防并行；失败无完成标记。pg_dump 自定义格式并用 pg_restore --list 校验；成对复制原 DuckDB 主文件与存在的 WAL，比较复制前后源元数据并校验 hash。无 WAL 时记录缺失；孤立 WAL 拒绝。

同时保留 .env、systemd 展开配置、current 指针和数据库清单；生成 SHA256SUMS，最后才生成 COMPLETE。不会删除原文件、WAL、旧发布、技能或工作区。备份前留足磁盘空间；备份本身也应放在受限 transient unit 中，避免大读盘。生产恢复另选隔离数据库进行实际恢复演练，目录可读不代表已经演练成功。技能存储与工作区另做云盘快照/文件备份以覆盖数据库外引用。

## 宿主保护

提供 2 GiB 应急模板：MemoryHigh=384M、MemoryMax=512M、MemorySwapMax=0、V8 old space 256 MiB、CPUQuota=100%、TasksMax=256、OOMPolicy=stop、TimeoutStartSec=90、TimeoutStopSec=30。现行补齐见 [2026-10-27 设计](2026-10-27-runtime-resource-guard-design.md)：Restart=no，应急模式不自动重启，5 分钟最多两次手动启动；父子 slice 覆盖 Node 和所有任务容器。配合 ExecStartPost 本地 /auth/me 的 JSON 401 探针，80 秒未就绪则启动失败，避免 Type=simple 下 TimeoutStartSec 只覆盖进程拉起而不覆盖应用初始化。OOM 后由人工检查再 reset-failed；不自动 enable。

I/O 限制覆盖 Node 的工作目录与工作区所在设备，默认各 10M/s；同一设备应按设备合并核对，不把两个路径误当成独立预算。原模板只保护该 unit 的缺口，已由 2026-10-27 的共享父子 slice、中央 Docker CgroupParent、独立守护补齐；PostgreSQL 保持在任务组外单独限额。沙箱现有 384 MiB/0.5 CPU 保持，命令队列改成读取 SANDBOX_MAX_CONCURRENT（应急 profile=1），仍须盘点空闲容器总数与其它服务内存，不能宣称整机峰值已被完全封顶。

这些是防护起点，不保证 2 GiB 足够生产并发；受控验证后按实际 RSS 和其它服务留量调整。超限时宁可任务失败，不允许反复拖死 SSH/VNC。

## 验证与回退

本地：配置拒绝不合法值、off 模式无持久 exporter、不打开 DuckDB；载荷限制；缺表启动阻止；迁移提交/回滚/并行锁/只读检查；备份不覆盖、运行中拒绝、失败无 COMPLETE；打包与 shell 语法。

ECS：保持 disabled，prepare-release 串行备份并复核 hash、迁移/check；在切换启动前完成迁移前 dump 的隔离恢复及补迁移演练，安装并核验 drop-in。仅 systemctl start 一次，90 秒冷启动观察，采集 MemoryCurrent/Peak/NRestarts、宿主可用内存和磁盘吞吐。先普通聊天，再最小写文件，最后单用户 3 页 PPT。验证产物可打开并下载、停止与再启动、可选观测落盘与保留维护。每阶段异常立即 stop，记录日志，不循环重试。available <256 MiB、swap 持续增长、服务内存触顶、重启增长或磁盘持续饱和都停止测试。

失败保留 disabled/off、停服务和数据，不直接切回仍会打开旧 DuckDB 的旧版，也不自动恢复数据库覆盖新增业务。修复后由人工决定新版本再验证。正式上线和 ECS 实测另行执行。
