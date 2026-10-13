# ECS 工作区与沙箱发布

状态（2026-10-13）：宿主工作区已迁入 8 GiB XFS project quota 卷，现有两个用户目录各有 500 MiB 硬上限。线上写入验收发现旧版文件服务跨 project ID 重命名报 `EXDEV`，因此 `USER_FILES_ENABLED=false`，服务正常运行。待发布同目录暂存修复并完成浏览器写入、上传验收后，才能重新开启。`SANDBOX_COMMANDS_ENABLED`、`SANDBOX_FILE_WRITE_ENABLED` 继续为 false。

若线上文件管理能显示空工作区，但 Agent 表示没有 `write_file`，先检查服务实际环境中的 `USER_FILES_ENABLED`。文件列表的 GET 接口不受此开关限制；Agent 文件工具、上传与在线编辑受此开关限制。仅修改本地 `.env` 或发布代码不会改变 ECS 的 `/opt/nero-agent/.env`。完成下述发布检查后，在 ECS 服务环境中设置 `USER_FILES_ENABLED=true`，重启 `nero-agent`，再用新会话验证 `write_file` 与右侧文件列表。不要为此开启 `SANDBOX_COMMANDS_ENABLED` 或 `SANDBOX_FILE_WRITE_ENABLED`。

本轮附件/批量删除/视觉开关功能**不**改变上述门禁：即使本地或预发已验证上传与引用，生产仍须完成下列检查后再打开 `USER_FILES_ENABLED`；沙箱命令与沙箱文件写入继续保持关闭，直到各自门禁通过。

## 已验证的生产事实

- 系统盘 `/dev/vda3` 为 40 GB ext4，无 project quota；从原空闲空间预分配 `/var/lib/nero-workspace/workspace.img`（8 GiB），作为 XFS loop 卷挂载到 `/data/mastra`，挂载选项含 `prjquota`。根盘剩余约 16 GB。`/etc/fstab` 保持重启后挂载，`nero-agent.service` 的 `RequiresMountsFor=/data/mastra` 确保服务等待挂载。尚未进行整机重启演练。
- 已备份原工作区、PostgreSQL、fstab 和 `.env` 到 `/var/backups/nero-agent/`。PostgreSQL custom dump 可由容器内 `pg_restore -l` 读取；尚未进行完整恢复演练。
- 两个现有用户目录分别设置 project ID `100001`、`100002` 和 500 MiB 硬限制。`/data/mastra/users` 的 project ID `900000` 有 1 GiB 汇总上限，作为尚未单独配置的新用户目录的临时保护。500 MiB 探测目录写入 501 MiB 被宿主拒绝，而卷仍有空闲。
- 旧版文件服务从 `/data/mastra/temp` 重命名到用户目录时，Node `rename` 实测返回 `EXDEV`；同一用户目录内暂存再重命名成功。代码修复在 `src/mastra/files/service.ts` 与 `src/mastra/files/workspace-service.ts`，尚待发布。
- 新用户上线前须先分配独立 project ID、设定 500 MiB 硬限制并验证继承属性；当前仓库没有自动配置该宿主配额的流程。不要把父目录 1 GiB 汇总上限当作每个新用户的独立上限。
- `USER_FILES_ENABLED` 当前是全局开关，打开后对所有已认证用户开放文件工具及写入 API，尚无仅管理员灰度的服务端控制。

## 仍待完成

- 发布文件暂存修复，在线上新会话测试 `write_file`、上传和侧栏读取；成功后设置 `USER_FILES_ENABLED=true` 并重启服务。
- Docker Engine 版本、节点是否单进程运行 Mastra
- `/data/mastra` 挂载、UID/GID 10001、镜像 `SANDBOX_IMAGE` digest
- 磁盘监控、日志轮转、整机重启与完整恢复演练结果
- 宿主可用容量是否足以覆盖并发用户个人配额（默认每用户 500 MiB）及 Docker/日志/数据库余量

## 发布顺序

1. 备份 PostgreSQL 与现有 `workspace/`。
2. `npm run db:migrate`（含 `app_workspaces`、`app_sandbox_instances`、附件引用表、`supports_vision` 等；可重复执行）。无迁移成功则不要打开文件 API。
3. **上线前主机容量检查**：确认 `/data/mastra`（或实际 `WORKSPACE_ROOT`）所在卷有足够空闲空间；应用层磁盘保护在使用率 ≥ `WORKSPACE_DISK_WARN_RATIO`（默认 0.8）时禁止大文件写入、≥ `WORKSPACE_DISK_BLOCK_RATIO`（默认 0.9）时禁止写入，且独立于个人 500 MiB 配额。个人配额未满也不能绕过宿主保护。
4. 给空的探测目录配置与工作区相同的宿主 project quota，设置 `WORKSPACE_QUOTA_PROBE_DIR` 和 `WORKSPACE_QUOTA_PROBE_LIMIT_BYTES`，运行 `node scripts/check-workspace-quota.mjs`。脚本会写入直到配额拒绝，确认宿主文件系统仍有余量，再删除探测文件。失败则不要设置 `WORKSPACE_HOST_QUOTA_VERIFIED=true`，也不要打开写入开关。
5. **配额对账**：个人工作区用量以磁盘扫描为准。批量删除后与上传成功后会 `reconcileFromDisk`；列表在**无进行中的配额预留**时按磁盘替换对账（修正失败上传/崩溃遗留的虚高），有预留时仅 `max`（不抹掉未落盘预留）。发布后抽查：API `usage.usedBytes`、数据库 `used_bytes` 与 `du` 对用户根目录的普通文件字节数一致。单文件新上传上限 10 MiB（`FILE_TOO_LARGE`）；超额返回 `WORKSPACE_QUOTA_EXCEEDED`（默认文案「工作区已超过 500 MiB 上限，请删除无效或过期文件后再上传。」）。
6. 构建 `sandbox/Dockerfile` 并写入 digest 到 `SANDBOX_IMAGE`。
7. 如需仅管理员灰度，先补齐服务端的管理员限定；当前 `USER_FILES_ENABLED=true` 会向所有已认证用户开放文件 API 与 Agent 文件工具。完成真实用户目录配额验证后再开启该开关，随后评估 Docker 命令。
8. 回滚：关闭 feature flag，停止带 `nero.sandbox=1` 标签的容器，保留表和 `/data/mastra/users`。

管理员旧 `workspace/` 不得自动映射到普通用户。使用 `node scripts/migrate-admin-workspace.mjs` 列出文件并等待确认。
