# ECS 工作区与沙箱发布

状态：部署门禁未通过。在宿主项目配额实测、Docker 集成测试和回滚演练完成前，保持 `USER_FILES_ENABLED`、`SANDBOX_COMMANDS_ENABLED`、`SANDBOX_FILE_WRITE_ENABLED` 为 false。

本轮附件/批量删除/视觉开关功能**不**改变上述门禁：即使本地或预发已验证上传与引用，生产仍须完成下列检查后再打开 `USER_FILES_ENABLED`；沙箱命令与沙箱文件写入继续保持关闭，直到各自门禁通过。

## 待记录的生产事实

- ECS 实际文件系统类型与是否支持 per-directory project quota
- Docker Engine 版本、节点是否单进程运行 Mastra
- `/data/mastra` 挂载、UID/GID 10001、镜像 `SANDBOX_IMAGE` digest
- 磁盘监控、日志轮转、备份与恢复演练结果
- 宿主可用容量是否足以覆盖并发用户个人配额（默认每用户 500 MiB）及 Docker/日志/数据库余量

## 发布顺序

1. 备份 PostgreSQL 与现有 `workspace/`。
2. `npm run db:migrate`（含 `app_workspaces`、`app_sandbox_instances`、附件引用表、`supports_vision` 等；可重复执行）。无迁移成功则不要打开文件 API。
3. **上线前主机容量检查**：确认 `/data/mastra`（或实际 `WORKSPACE_ROOT`）所在卷有足够空闲空间；应用层磁盘保护在使用率 ≥ `WORKSPACE_DISK_WARN_RATIO`（默认 0.8）时禁止大文件写入、≥ `WORKSPACE_DISK_BLOCK_RATIO`（默认 0.9）时禁止写入，且独立于个人 500 MiB 配额。个人配额未满也不能绕过宿主保护。
4. 给空的探测目录配置与工作区相同的宿主 project quota，设置 `WORKSPACE_QUOTA_PROBE_DIR` 和 `WORKSPACE_QUOTA_PROBE_LIMIT_BYTES`，运行 `node scripts/check-workspace-quota.mjs`。脚本会写入直到配额拒绝，确认宿主文件系统仍有余量，再删除探测文件。失败则不要设置 `WORKSPACE_HOST_QUOTA_VERIFIED=true`，也不要打开写入开关。
5. **配额对账**：个人工作区用量以磁盘扫描为准。批量删除后与上传成功后会 `reconcileFromDisk`；列表在**无进行中的配额预留**时按磁盘替换对账（修正失败上传/崩溃遗留的虚高），有预留时仅 `max`（不抹掉未落盘预留）。发布后抽查：API `usage.usedBytes`、数据库 `used_bytes` 与 `du` 对用户根目录的普通文件字节数一致。单文件新上传上限 10 MiB（`FILE_TOO_LARGE`）；超额返回 `WORKSPACE_QUOTA_EXCEEDED`（默认文案「工作区已超过 500 MiB 上限，请删除无效或过期文件后再上传。」）。
6. 构建 `sandbox/Dockerfile` 并写入 digest 到 `SANDBOX_IMAGE`。
7. 仅管理员灰度文件 API（`USER_FILES_ENABLED=true`），再评估 Docker 命令。
8. 回滚：关闭 feature flag，停止带 `nero.sandbox=1` 标签的容器，保留表和 `/data/mastra/users`。

管理员旧 `workspace/` 不得自动映射到普通用户。使用 `node scripts/migrate-admin-workspace.mjs` 列出文件并等待确认。
