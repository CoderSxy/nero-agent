# ECS 工作区与沙箱发布

状态：部署门禁未通过。在宿主项目配额实测、Docker 集成测试和回滚演练完成前，保持 `USER_FILES_ENABLED`、`SANDBOX_COMMANDS_ENABLED`、`SANDBOX_FILE_WRITE_ENABLED` 为 false。

## 待记录的生产事实

- ECS 实际文件系统类型与是否支持 per-directory project quota
- Docker Engine 版本、节点是否单进程运行 Mastra
- `/data/mastra` 挂载、UID/GID 10001、镜像 `SANDBOX_IMAGE` digest
- 磁盘监控、日志轮转、备份与恢复演练结果

## 发布顺序

1. 备份 PostgreSQL 与现有 `workspace/`。
2. `npm run db:migrate`（含 `app_workspaces`、`app_sandbox_instances`）。
3. 给空的探测目录配置与工作区相同的宿主 project quota，设置 `WORKSPACE_QUOTA_PROBE_DIR` 和 `WORKSPACE_QUOTA_PROBE_LIMIT_BYTES`，运行 `node scripts/check-workspace-quota.mjs`。脚本会写入直到配额拒绝，确认宿主文件系统仍有余量，再删除探测文件。失败则不要设置 `WORKSPACE_HOST_QUOTA_VERIFIED=true`，也不要打开写入开关。
4. 构建 `sandbox/Dockerfile` 并写入 digest 到 `SANDBOX_IMAGE`。
5. 仅管理员灰度文件 API，再评估 Docker 命令。
6. 回滚：关闭 feature flag，停止带 `nero.sandbox=1` 标签的容器，保留表和 `/data/mastra/users`。

管理员旧 `workspace/` 不得自动映射到普通用户。使用 `node scripts/migrate-admin-workspace.mjs` 列出文件并等待确认。
