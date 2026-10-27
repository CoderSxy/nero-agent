# 2026-10-26 Agent 安全恢复运行手册

设计：[观测与宿主恢复](../superpowers/specs/2026-10-26-agent-storage-recovery-design.md)。以下是后续 ECS 操作步骤，本次本地实现没有执行生产命令。保持服务 disabled，不直接套用旧版普通发布的 restart 步骤。

## 准备与停服

先构建并按 [本地发布文档](ecs-release-from-local-build.md) 校验两个上传包、解压到新 release。不要切 current。下文 `CANDIDATE` 是新 release 的 mastra 后端目录，必须按实际路径设置。

```bash
CANDIDATE=/opt/nero-agent/releases/<新发布编号>/mastra
BACKUP=/var/backups/nero-agent/$(date -u +%Y%m%dT%H%M%SZ)-recovery
systemctl stop nero-agent
systemctl is-enabled nero-agent
systemctl show nero-agent -p ActiveState -p MainPID
```

预期 disabled、inactive/failed、MainPID=0。记录原 current、.env、systemd 和业务服务状态。确认本机 `/usr/local/bin/node` 是当前 Node 22。检查磁盘剩余容量能容纳数据库、技能和工作区备份，不删除旧库/WAL 腾空间。云盘快照和文件备份覆盖 `SKILLS_STORAGE_ROOT`、`WORKSPACE_ROOT`，数据库 dump 不包含它们。

旧 DuckDB 主库 708 MiB + WAL 2.25 MiB 要从 `/var/lib/nero-agent` 原件备份，不能使用已经跑过试验的 `/tmp/nero-incident-duckdb-copy-20261026`。

## 备份与迁移门禁

脚本默认备份实际 Docker 的 `nero-agent-postgres/nero_agent`。先人工核对 .env 的 DATABASE_URL 就指向该业务库；不是该目标时设置正确的 PG_CONTAINER、PG_USER、PG_DATABASE，不要改用宿主 psql 猜测。prepare-release 会备份并复核 hash，再事务性执行新包迁移和只读 --check；不会切换发布或启动服务。

```bash
systemd-run --unit=nero-recovery-prepare --wait --pipe --collect \
  -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=25% \
  -p RuntimeMaxSec=600 -p KillMode=control-group \
  -p 'IOReadBandwidthMax=/var/lib/nero-agent 10M' \
  -p 'IOWriteBandwidthMax=/var/backups/nero-agent 10M' \
  /bin/bash "$CANDIDATE/ops/prepare-release.sh" "$CANDIDATE" "$BACKUP"
```

先确保 /var/backups/nero-agent 存在且仅 root 可访问。所有命令退出 0、备份出现 COMPLETE 与 PREPARED 才继续。脚本不覆盖已存在目录；超时/失败保留不完整目录供排查，重试选新目录。PG 恢复目录检查并不等价于实际恢复演练。默认仅备份业务库；若启用独立观测 PostgreSQL，另行备份那个实例，不能以本脚本替代。

使用独立机器或另一个受控 PostgreSQL 实例，创建全新空库，把 postgres.dump 恢复进去并检查用户/会话/技能版本及产物表。不要恢复进线上原库，也不要在当前 2 GiB ECS 上再起一个无内存限制的大数据库。

```bash
# 在隔离恢复环境执行，凭据通过环境/pgpass 提供，不写入仓库：
pg_restore --exit-on-error --no-owner --no-privileges -d "$RESTORE_TEST_DATABASE_URL" postgres.dump
```

该 dump 来自迁移前，可能尚无 015 表；演练库应再执行候选 migrate.mjs/--check，确认能补到新版本。记录恢复结果后才允许启动应用。生产库 --check 应包含 015 和完整三个产物表，不能仅凭 ledger 有名称判断成功。

## 安装宿主防护，不恢复自启

现行补齐设计：[2026-10-27 资源保护](../superpowers/specs/2026-10-27-runtime-resource-guard-design.md)。预算为：Node 自身 512 MiB，所有任务容器共享 512 MiB，二者父 slice 合计最多 960 MiB；PostgreSQL 独立最多 384 MiB。父子上限不是预留内存，也不保证 PPT 不会因超限失败。其它服务仍需留量，不能据此声称整机任意工作负载均安全。

备份完成后，编辑服务器 .env 的已有行，设置 `OBSERVABILITY_STORAGE=off`、`SANDBOX_MAX_CONCURRENT=1`。不要重复追加键，不改连接/密钥，不在 .env 写 INVOCATION_ID，也不要保留与应急 profile 冲突的 guard/NODE_OPTIONS 设置。

**先给 PostgreSQL 设置独立限额。** 新建本地 Compose 实例已声明 384m 内存及相同 memswap；现有 ECS 容器不会因此自动更新。先看实际使用量和配置：

```bash
docker stats --no-stream nero-agent-postgres
docker inspect -f 'memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} parent={{.HostConfig.CgroupParent}}' nero-agent-postgres
```

必须确认 384 MiB 能覆盖现有数据库负载；不够时先调整数据库缓存/连接预算或升配，不能强行在线缩小限额。已有备份、应用已停、维护窗口确认后，可对该指定数据库容器优雅停止，再更新限额并重新启动：

```bash
docker stop -t 60 nero-agent-postgres
docker update --memory 384m --memory-swap 384m nero-agent-postgres
docker start nero-agent-postgres
docker inspect -f '{{.State.Health.Status}}' nero-agent-postgres
```

等待 healthy，并验证现有数据与迁移检查。此步骤不删除/重建数据卷，也不改变数据库 CgroupParent；PostgreSQL 必须保持在应用/任务父 slice 外。不要把整个 Docker daemon 的默认 cgroup parent 改成任务 slice，那会把数据库也放进去。

安装候选包的 slice、独立守护与紧急单元、timer 和主服务 drop-in（先备份已有同名文件），保留原 Docker supplementary group 与工作区挂载配置：

```bash
install -d -m 0755 /etc/systemd/system/nero-agent.service.d
for unit in nero-runtime.slice nero-runtime-workloads.slice nero-runtime-guard.service nero-runtime-guard.timer nero-runtime-emergency.service; do
  install -m 0644 "$CANDIDATE/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 0644 "$CANDIDATE/systemd/nero-agent.service.d/99-resource-protection.conf" \
  /etc/systemd/system/nero-agent.service.d/99-resource-protection.conf
systemctl daemon-reload
systemctl cat nero-agent
```

本步骤先安装，不启动 timer；它的脚本跟随 current，需要下一步切换到新发布后再运行。验证配置：主服务 Slice=nero-runtime.slice、MemoryMax=512M、Restart=no；父 slice=960M，任务子 slice=512M，swap=0；Docker 必须使用 systemd cgroup v2 driver。启动 preflight 会核对实际 memory.max、memory.swap.max、timer、环境标识和 PostgreSQL 配置，缺项就拒绝启动。

I/O 路径映射到所在块设备；两个路径在同一盘时不是两份独立额度。Node 和任务子 slice 均配置 I/O 保护；须检查 journal 无设备/控制器警告和实际 cgroup io.max。普通沙箱空闲停止降为 60 秒，技能执行/探针/代理通过中央 Docker 适配器统一加入任务组。旧代容器在 preflight 被清理，只删除应用专用标签的容器，不删除工作区、数据卷或数据库。

独立守护位于 system.slice，每 15 秒巡检；采样及 Docker 操作累计预算 20 秒，异常时先写熔断标记、终止专用任务及应用 cgroup，再用最多 12 秒清理。独立单元失败还会触发 emergency 单元。主服务停止会立即请求独立回收，无需等待 Node 内部 finally；monitor 停车失败则请求明确的 emergency 单元，控制面不可用时尝试外部 Python 紧急路径。回收无法完成时日志报错并保持任务准入熔断，不能把它当作已完全清理。

## 一次启动和分阶段受控验收

确认历史活动定时任务在测试窗口不会触发负载，记录/暂停已有任务。备份、恢复演练、迁移与数据库预算核验通过后，按普通发布的原子 symlink 步骤切 current 到新 release，Agent 继续保持 disabled；随后仅启用独立 guard timer，不启用 Agent 自启。

```bash
systemctl enable --now nero-runtime-guard.timer
systemctl reset-failed nero-agent
systemctl start nero-agent
bash "$CANDIDATE/ops/monitor.sh" 90
```

ExecStartPre 先检查资源保护并回收旧容器，再检查迁移；ExecStartPost 最多 80 秒等待 JSON 接口就绪。失败不循环手动 start：停止服务、读 journal/cgroup，修复后再决定下一次验证。MemoryCurrent 接近 480 MiB、主机 MemAvailable 低于 256 MiB、服务非 active 或 NRestarts 不为 0 时监测脚本会 stop 服务并非零退出。启动期间也应在另一终端观察系统可用内存；启动保护只限制服务，不能替代整机监测。

之后逐阶段单独监测，人工执行：

1. 一次普通聊天和历史加载，确认结构化接口正常，无缺表/观测存储错误。
2. 一次最小工作区文本写入，查看产物定位、预览和下载。
3. 单用户最小 3 页 PPT；生成真实 .pptx，可下载并由 PowerPoint/LibreOffice 打开。
4. 手动 stop/start 再检查，确认无 DuckDB 初始化/关闭活动，RSS、IO 不持续爬升。

每阶段可运行 `monitor.sh 300`；同时用系统监控观察磁盘 BPS、CPU、swap 和 Docker 各容器用量。监测脚本不自动发送请求，也不把“资源观察通过”当成 PPT 功能验收通过。

```bash
journalctl -u nero-agent --since '10 minutes ago' --no-pager
systemctl show nero-agent -p Slice -p MemoryCurrent -p MemoryPeak -p NRestarts -p Restart -p IOReadBytes -p IOWriteBytes
systemctl status nero-runtime-guard.timer --no-pager
journalctl -u nero-runtime-guard.service -u nero-runtime-emergency.service --since "10 minutes ago" --no-pager
docker stats --no-stream
free -m
```

任何持续磁盘打满、swap 增长、内存持续增长都 stop，保留 disabled。不要贸然回滚会重新打开旧 DuckDB 的应用版本；不自动反向迁移/覆盖数据库。验收稳定后由人工决定升配、恢复任务和是否 enable。

## 熔断后的人工恢复

发现 `/run/nero-resource-guard/tripped` 后先读主服务和 guard 日志，核对可用内存、OOM 计数、数据库健康与遗留容器，解决原因。不要只删除标记就连续重启；当前 profile 不自动重启。

人工确认后，停 timer 和 guard、保持应用停止，重置失败状态，再删除本工具的两个状态文件，最后恢复 timer 并受控启动：

```bash
systemctl stop nero-runtime-guard.timer nero-runtime-guard.service nero-runtime-emergency.service
systemctl stop nero-agent
systemctl reset-failed nero-agent nero-runtime-guard.service nero-runtime-emergency.service
rm -f /run/nero-resource-guard/tripped /run/nero-resource-guard/oom-count
systemctl start nero-runtime-guard.timer
systemctl start nero-agent
```

不要删除整个 /run 目录、数据库或工作区。若 root cgroup 文件、Docker 控制面或回收仍异常，保持应用停止并人工排查。

## 可选：重新启用持久观测

先部署独立 PostgreSQL（建议独立实例，不占当前 2 GiB 宿主），设置独立 URL、OBSERVABILITY_STORAGE=postgres、采样比例及保留天数。URL 指向不同数据库只是最低检查，DNS 别名/代理可能仍指向同一数据库，运维须核实。历史 DuckDB 不自动导入或删除；Studio 历史观测列表会从新库重新开始。应急观测只保存已结束 span 的有限元数据，不保存过程 span、输入/输出、metrics/logs；正常聊天内容由原业务存储保存。

安装包内 nero-observability-maintenance.service/.timer 到 /etc/systemd/system/，启用每日 timer，并验证一次 maintenance.service 成功，再安排受控重启。若启用时 .env 采用独立观测模式，应同步修改/移除应急 drop-in 中的 off 环境配置，检查有效环境，不依赖冲突键的覆盖顺序。维护只处理独立库 nero_observability schema 的五类信号分区，不清理会话/工作区；按 7 天默认保留，每日补未来分区。维护失败必须告警和排查，否则分区会增长且超过预建窗口后写入失败。

## 本地验证记录

见实施计划末尾验证记录；本地隔离库测试和打包检查不能替代上述 ECS 受控验收。
