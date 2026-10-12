# 在 macOS 本机构建 ECS 发布包

在项目根目录执行：

```bash
sh scripts/build-release-macos.sh
```

脚本在 `dist/` 生成 Mastra Linux/amd64 后端包 `mastra-linux-amd64.tar.gz` 和 Web 静态包 `nero-agent-web.tar.gz`，并打印 SHA-256。后端包包含迁移脚本、SQL 文件和 Linux 运行依赖；脚本检查并排除本地 DuckDB 数据文件与 `.env`。

上传路径、ECS 解压目录、数据库迁移、服务切换和回滚步骤见 [ECS 发布流程](ecs-release-from-local-build.md)。
