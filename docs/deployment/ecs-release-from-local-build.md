# 本地构建并发布 Mastra 后端与 Web 到 ECS

适用于现有 ECS：后端由 `nero-agent.service` 运行，入口 `/opt/nero-agent/current/mastra/index.mjs`；Nginx 静态根 `/opt/nero-agent/current/web`；后端工作目录 `/var/lib/nero-agent`。ECS 不执行 npm install 或应用构建。

**普通更新只需：1 构建 → 2 上传 → 3 校验解压 → 4 判断是否有额外处理 → 5 切换 → 6 验收。** 没有新迁移、配置或镜像变化时，第 4 步全部跳过。任何检查失败立即停止，不继续切换。

## 1.【本地 Mac｜项目根目录｜每次必做】构建与检查

```bash
sh scripts/build-release-macos.sh
```

必须等脚本成功并打印两个 SHA-256，再进入下一步。失败时 dist 可能仍保留旧包，不能上传它们充当新版本。Docker 拉基础镜像若提示本地代理端口 connection refused，修正 Docker Desktop 的代理配置后重试。

脚本生成 Linux/amd64 后端和 Web 静态包，自动带入全部 SQL 迁移、migrate.mjs 和 Linux 依赖，检查 DuckDB 原生依赖并排除本地数据库、环境文件和 macOS 依赖。不要额外上传本机 `.mastra/output`、`.env` 或 node_modules。

只有开发了新的数据库结构变更时，才需要先新增下一个编号的 SQL 迁移；正常发布无需编写迁移。不要修改线上已执行过的旧 SQL 来更新数据库。

## 2.【本地 Mac 或 Workbench 文件传输｜每次必做】上传产物

本地项目根目录执行，或通过 Workbench 上传同样两个文件到 ECS `/tmp`：

```bash
scp dist/mastra-linux-amd64.tar.gz dist/nero-agent-web.tar.gz root@101.37.135.116:/tmp/
```

## 3.【ECS Workbench｜root 终端｜每次必做】校验并解压

```bash
sha256sum /tmp/mastra-linux-amd64.tar.gz /tmp/nero-agent-web.tar.gz
```

逐项核对第 1 步的 SHA-256，一致才继续。以下变量在同一个终端会话中使用；断线后按实际目录重新设置，不能直接继续后续命令。

```bash
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE_DIR=/opt/nero-agent/releases/$RELEASE
PREVIOUS_RELEASE=$(readlink -f /opt/nero-agent/current)
BACKUP_DIR=/var/backups/nero-agent/$RELEASE
install -d -m 0700 "$BACKUP_DIR"
printf '%s\n' "$PREVIOUS_RELEASE" > "$BACKUP_DIR/previous-release"
cp -p /opt/nero-agent/.env "$BACKUP_DIR/env"
cp -p /etc/nginx/sites-available/nero-agent "$BACKUP_DIR/nginx.conf"
install -d -m 0755 "$RELEASE_DIR/mastra" "$RELEASE_DIR/web"
tar -xzf /tmp/mastra-linux-amd64.tar.gz -C "$RELEASE_DIR/mastra"
tar -xzf /tmp/nero-agent-web.tar.gz -C "$RELEASE_DIR/web"
chgrp nero-agent "$RELEASE_DIR/mastra"
chmod 750 "$RELEASE_DIR/mastra"
sudo -u nero-agent test -r "$RELEASE_DIR/mastra/index.mjs"
test -s "$RELEASE_DIR/mastra/migrate.mjs"
test -s "$RELEASE_DIR/web/index.html"
find "$RELEASE_DIR/mastra" "$RELEASE_DIR/web" -type f \( -name '._*' -o -name '*.duckdb' -o -name '*.db' -o -name '.env' \) -print -quit
```

所有命令须成功，最后 find 应无输出。chgrp/chmod 不能省略：Mac tar 可能把后端目录权限还原为 0700，造成服务用户读不到入口。

## 4.【ECS Workbench｜仅满足对应前提时】额外处理

| 前提 | 必须处理的事项 | 已配置后的普通更新 |
| --- | --- | --- |
| 新包含线上未执行的 SQL 迁移 | 按下方备份、迁移并核对记录 | 无新迁移则跳过 |
| 新增 API 前缀或当前 Nginx 缺路由 | 加入现有 API location，执行 nginx -t | 已存在则跳过 |
| 首次启用基础 Skills | 配置两个持久目录及 Skills 总开关 | 保留配置和目录，无需重复创建或导入 |
| 首次启用财经工具 | 确认本机 AKTools 健康，配置 FINANCE_TOOL_ENABLED、AKTOOLS_BASE_URL 和 finance 路由，见 [财经部署](aktools-ecs.md) | 沿用现有服务 |
| 启用/更新沙箱脚本、Bash、依赖安装或公开联网 | 单独交付目标 linux/amd64 镜像、固定 digest 并完成宿主验收，见 [沙箱部署](sandbox-public-network.md) | 未变更镜像、策略及开关则跳过 |

### 有新迁移时：先备份，再迁移

确认旧版代码兼容新 schema 后执行。备份命令必须成功，pg_restore 能读取备份目录才继续。

```bash
docker exec nero-agent-postgres pg_dump -U nero_agent -d nero_agent -Fc > "$BACKUP_DIR/postgres.dump"
test -s "$BACKUP_DIR/postgres.dump"
docker exec -i nero-agent-postgres pg_restore -l < "$BACKUP_DIR/postgres.dump" > "$BACKUP_DIR/postgres-contents.txt"
cd "$RELEASE_DIR/mastra"
/usr/local/bin/node --env-file=/opt/nero-agent/.env ./migrate.mjs
find migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | sort > /tmp/nero-expected-migrations.txt
docker exec nero-agent-postgres psql -U nero_agent -d nero_agent -Atc 'SELECT name FROM app_schema_migrations ORDER BY name' | sort > /tmp/nero-applied-migrations.txt
diff -u /tmp/nero-expected-migrations.txt /tmp/nero-applied-migrations.txt
```

迁移须退出 0，diff 须无输出且退出 0。migrate.mjs 只执行未登记文件，整个批次在一个事务内；失败时不要因日志打印了 Applied 就当迁移已提交。

### 缺路由时：只补入现有代理

`/etc/nginx/sites-available/nero-agent` 的 API location 应覆盖：

```text
api|auth|finance|agent-skills|agent-history|agent-scheduled-tasks|model-catalog|user-files|current-workspace|model-admin
```

沿用原来的边界匹配、鉴权和代理参数，不替换整份 Nginx 配置。修改后执行 `nginx -t`，成功后在第 5 步 reload。验收未登录 `/agent-skills/available`、`/agent-scheduled-tasks` 和 `/agent-history/threads/<threadId>/window` 返回 JSON 401，不能是首页 HTML 200。使用已登录账号打开已有会话，确认历史窗口返回 JSON 且消息可正常显示；仅检查首页和 `/api/agents` 不能证明新增业务路由已接通。

### 首次启用基础 Skills 时

创建 release 之外的持久目录：

```bash
install -d -o nero-agent -g nero-agent -m 0750 /var/lib/nero-agent/skills /var/lib/nero-agent/skill-imports
```

在 `/opt/nero-agent/.env` 设置以下值（修改已有行，不能重复追加），保持文件 root:nero-agent、0640：

```dotenv
AGENT_SKILLS_ENABLED=true
SKILLS_STORAGE_ROOT=/var/lib/nero-agent/skills
SKILLS_IMPORT_TEMP_ROOT=/var/lib/nero-agent/skill-imports
SKILL_SCRIPT_EXECUTION_ENABLED=false
AGENT_TASK_QUALITY_MODE=observe
MODEL_CAPABILITY_PROBE_ENABLED=false
```

这只启用基础 Skills，不开启脚本或沙箱联网。首次安装目录可为空；技能需在管理页导入/创建并发布，本地技能不会随后端包自动迁入。已有技能时，迁移或恢复应同步备份数据库与 skills 存储根，不能只保留发布目录。当前产物未包含 skills:doctor 运维脚本，不能在 ECS 解压目录直接运行该 npm 命令。

## 5.【ECS Workbench｜每次必做】切换并重启

已有服务必须确实使用 current 入口；首次部署或修改过服务配置时先核对 `systemctl cat nero-agent` 和 `nginx -T`。完成第 4 步所有适用项后执行：

```bash
nginx -t
test ! -e /opt/nero-agent/current.next && test ! -L /opt/nero-agent/current.next
ln -s "$RELEASE_DIR" /opt/nero-agent/current.next
mv -Tf /opt/nero-agent/current.next /opt/nero-agent/current
systemctl restart nero-agent
systemctl reload nginx
```

不清理 PostgreSQL、DuckDB、用户工作区或 Docker 资源。此流程不构建/更新沙箱镜像，也不代替沙箱启用验收。

## 6.【ECS Workbench及浏览器｜每次必做】验收

```bash
readlink -f /opt/nero-agent/current
systemctl show nero-agent -p ActiveState -p MainPID -p NRestarts --no-pager
journalctl -u nero-agent --since '2 minutes ago' --no-pager -n 30
docker inspect -f '{{.State.Health.Status}}' nero-agent-postgres
curl -fsS https://agent.nerosun.cn/ | cmp - "$RELEASE_DIR/web/index.html"
for route in auth/me finance/capabilities agent-skills/available agent-scheduled-tasks agent-history/threads/00000000-0000-0000-0000-000000000000/window; do
  curl -sS -o /dev/null -w "$route %{http_code} %{content_type}\n" "https://agent.nerosun.cn/$route"
done
```

current 应指向新 release，服务 active、重启次数不增长，日志无启动/对账错误，PostgreSQL healthy，首页比对成功，以上未登录 API 应返回 JSON 401。浏览器打开 [线上应用](https://agent.nerosun.cn/)，登录后验证会话与本次变更；启用 Skills 时检查列表/导入，定时任务变更时检查任务页及执行结果。仅服务 active 或仅 401 不代表业务功能验收完成。

**验收失败时回滚应用**：先确认 `$PREVIOUS_RELEASE` 是本次记录的旧版本，并且旧代码兼容当前 schema，再按第 5 步方式原子切回旧目录并重启。若改过 .env/Nginx，按需从 `$BACKUP_DIR` 恢复后校验、重载。保留新增表、技能内容及用户数据；不要自动回滚数据库或删除目录。

## 当前 ECS 基线（2026-10-22）

- 已发布 `/opt/nero-agent/releases/20261022T113542Z`；上一版 `/opt/nero-agent/releases/20261013T113816Z`。
- 本次数据库与配置备份：`/var/backups/nero-agent/20261022T113542Z`；迁移已执行至 `014`。
- 本次发现公共模型表缺少原 `002` 定义的主键；确认 42 行 ID 唯一且非空后恢复 `app_public_models_pkey`，再完成迁移。修复 SQL 保存在上述备份目录。这是线上历史结构修复，后续正常发布不重复执行；遇到同类错误先核对结构，不能跳过外键。
- 基础 Skills 已开启，存储和导入目录采用第 4 步路径；脚本执行关闭，沙箱命令/写入开关保持关闭，质量模式 observe，模型主动探针关闭。Nginx 已包含 Skills 与定时任务路由。
- 后端 SHA-256：`fe794cdcd0fb5c594ae03799e824c2afd4b64fcc9d198eead41c0da659476f5f`；Web SHA-256：`f2fcf7cbddbec1d88b2d37776b32d645f4f4df38a19586c74d97780f720675bb`。
- 本次验收：首页、JS/CSS 与新包一致；服务 active、NRestarts=0；PostgreSQL healthy；四个未登录 API 均为 JSON 401；登录、Skills 空列表、定时任务空列表及一次最小聊天通过。测试会话 `fd4619c1-f9ae-4f1c-af98-ef46280d800f` 保留供核对。尚未验收技能导入/发布、调度实际执行或沙箱联网。
