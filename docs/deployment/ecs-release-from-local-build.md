# 本地构建并发布 Mastra 后端与 Web 到 ECS

适用范围：本仓库的 ECS 部署。Mastra 继续由 `nero-agent.service` 在宿主机运行，Web 继续由 Nginx 提供；本地 Docker 只生成 Linux/amd64 后端产物。此流程不在 ECS 执行 `npm install`，也不重建、清理线上沙箱容器。

本简化流程适用于已经配置好发布入口的现有 ECS：systemd 从 `/opt/nero-agent/current/mastra/index.mjs` 启动，Nginx 从 `/opt/nero-agent/current/web` 提供静态文件。服务器沿用现有 PostgreSQL、DuckDB、工作区与沙箱。新功能需要环境变量或 API 路由时，按下文先更新 `.env` 与 Nginx 配置。切换前任一检查失败就停止；切换后的验收失败时不要将发布视为完成。

## 执行位置与文件去向

| 步骤 | 执行位置 | 操作 |
| --- | --- | --- |
| 1 | 本地 Mac 项目根目录 | 构建两个 tar.gz 包 |
| 2 | 本地 Mac 或 Workbench 文件传输 | 上传到 ECS 的 /tmp |
| 3 | ECS Workbench 终端 | 校验并解压到新 release |
| 4 | ECS Workbench 终端 | 按需配置环境变量与 Nginx API 路由；仅有 PostgreSQL 结构变动时运行迁移 |
| 5 | ECS Workbench 终端 | 切换 current 并重启服务 |
| 6 | ECS Workbench 终端及浏览器 | 验证线上服务 |

本地 dist 目录不能在 ECS 终端直接访问；ECS 的 /tmp 也不是本地目录。

## 1.【本地 Mac｜项目根目录】构建与检查

若本次代码修改了项目自己的 PostgreSQL 表、字段、索引或约束，**先在 `migrations/` 新增下一个编号的 SQL 文件**（例如现有最新为 `008_...sql`，下一个从 `009_...sql` 开始），再构建产物。`scripts/migrate.ts` 只执行文件名尚未记录在 `app_schema_migrations` 中的迁移；改动一个线上已执行过的旧 SQL 文件不会更新生产库。需要修改既有字段时，写新的向前迁移并确认旧版代码在切换期间是否兼容新 schema。没有数据库结构变化时，无需凭空新增迁移文件。

确认本次 schema 变更已有对应的新迁移文件后，在**本地 Mac 的项目根目录**只运行：

```bash
sh scripts/build-release-macos.sh
```

脚本完成 Docker Linux/amd64 后端构建、Web 依赖安装与构建、文件检查、打包，并打印两个压缩包的 SHA-256。打包时关闭 macOS 扩展属性和 `._` 资源文件。输出固定为 `dist/mastra-linux-amd64.tar.gz` 和 `dist/nero-agent-web.tar.gz`。如果任一步失败，脚本退出且不会把不完整的新压缩包作为成功结果。上传前记下脚本打印的两个 SHA-256。

后端包包含 `migrate.mjs`、所有 SQL 迁移文件和 Linux 运行依赖。脚本检查并保留必需的 Linux `duckdb.node`，发现 `.duckdb`、WAL、`.db`、`.env` 或 macOS 原生依赖时会终止；这些本地数据文件不会随包上传。Web 包只包含静态文件。ECS 无需再次安装 npm 包，也不要把本机 `.mastra/output`、`src/mastra/public`、`.env`、数据库或 `web/node_modules` 另外上传。

## 2.【本地 Mac 或 Workbench 文件传输】上传产物

第 1 步生成的两个文件分别上传到 ECS 的 /tmp。SSH 可用时，在本地 Mac 项目根目录运行：

~~~bash
scp dist/mastra-linux-amd64.tar.gz dist/nero-agent-web.tar.gz root@101.37.135.116:/tmp/
~~~

也可以使用 Workbench 的文件传输界面上传。下面的命令均在 ECS Workbench 终端执行，不要在 ECS 上运行 npm install 或重新构建。

## 3.【ECS Workbench 终端】校验并解压

先确认两个包存在，并将 SHA-256 与第 1 步脚本打印的值逐项比对：

~~~bash
ls -lh /tmp/mastra-linux-amd64.tar.gz /tmp/nero-agent-web.tar.gz
sha256sum /tmp/mastra-linux-amd64.tar.gz /tmp/nero-agent-web.tar.gz
~~~

校验一致后创建本次发布目录。以下变量在同一个终端会话内使用；断线重连后重新设置 RELEASE_DIR。

~~~bash
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE_DIR=/opt/nero-agent/releases/$RELEASE
sudo install -d -m 0755 "$RELEASE_DIR/mastra" "$RELEASE_DIR/web"
sudo tar -xzf /tmp/mastra-linux-amd64.tar.gz -C "$RELEASE_DIR/mastra"
sudo tar -xzf /tmp/nero-agent-web.tar.gz -C "$RELEASE_DIR/web"
sudo chgrp nero-agent "$RELEASE_DIR/mastra"
sudo chmod 750 "$RELEASE_DIR/mastra"
sudo -u nero-agent test -r "$RELEASE_DIR/mastra/index.mjs"
sudo test -s "$RELEASE_DIR/mastra/migrate.mjs"
sudo test -s "$RELEASE_DIR/web/index.html"
sudo find "$RELEASE_DIR/mastra" "$RELEASE_DIR/web" -name '._*' -print -quit
sudo find "$RELEASE_DIR/mastra" "$RELEASE_DIR/web" -type f -name '*.duckdb' -print -quit
~~~

最后两条 find 应无输出。macOS tar 的目录元数据可能把 mastra 目录覆盖为 0700，导致服务用户无法读取入口文件；因此必须执行 chgrp、chmod 和服务用户读取检查。tar 输出的 LIBARCHIVE.xattr 警告可以忽略，但 test 失败、出现 ._* 文件或 DuckDB 数据文件时应停止切换。

## 4.【ECS Workbench 终端】按需配置并迁移

首次启用财经工具时，先确认同机的 `aktools.service` 正常，并且 AKTools 只监听本机地址。备份现有 `.env` 后加入以下两项；已有配置时修改原有行，不要重复追加。`.env` 应保持为 `root:nero-agent`、权限 `0640`，以便 systemd 服务用户读取且避免其他本机用户读取密钥。

~~~bash
sudo systemctl show aktools -p ActiveState -p NRestarts --no-pager
curl -fsS http://127.0.0.1:18080/docs >/dev/null
sudo cp -p /opt/nero-agent/.env /opt/nero-agent/.env.before-finance
sudo chmod 640 /opt/nero-agent/.env /opt/nero-agent/.env.before-finance
sudo sh -c 'echo AKTOOLS_BASE_URL=http://127.0.0.1:18080/ >> /opt/nero-agent/.env'
sudo sh -c 'echo FINANCE_TOOL_ENABLED=true >> /opt/nero-agent/.env'
sudo grep -E '^(AKTOOLS_BASE_URL|FINANCE_TOOL_ENABLED)=' /opt/nero-agent/.env
~~~

当前 Nginx 仅将已列出的 API 路径代理到 Mastra。首次发布财经功能时，还要把 `/finance` 加入 `/etc/nginx/sites-available/nero-agent` 中现有的 API `location` 正则，例如将 `api|auth|model-catalog` 改成 `api|auth|finance|model-catalog`。先备份配置，再执行 `sudo nginx -t`；测试通过后才 `sudo systemctl reload nginx`。`/finance/capabilities` 未登录时应返回 `401 application/json`，不能返回前端首页的 `200 text/html`。AKTools 的 18080 端口无需对公网开放。后续发布无需重复添加环境变量或路由。

首次启用 Agent Skills HTTP 时，同样把 `agent-skills` 加入该 API `location` 正则（与 `agent-scheduled-tasks` 同组）。未登录 `GET /agent-skills/available` 应返回 `401 application/json`，不能回落到前端 `index.html`。开发代理见 `web/vite.config.ts`；说明见 `docs/deployment/agent-skills.md` §1.1。

### 按需迁移 PostgreSQL

**本次没有 PostgreSQL 表、字段、索引或约束变动，也没有新增迁移 SQL 时，整步跳过。** 不需要每次发布都运行 migrate.mjs。

若本次新增了 migrations 中的 SQL 文件，先按第 1 步确认它是新编号的向前迁移，而且旧版服务在切换前能兼容新 schema，再运行：

~~~bash
cd "$RELEASE_DIR/mastra"
sudo /usr/local/bin/node --env-file=/opt/nero-agent/.env ./migrate.mjs
find "$RELEASE_DIR/mastra/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort > /tmp/nero-expected-migrations.txt
sudo docker exec nero-agent-postgres psql -U nero_agent -d nero_agent -Atc 'SELECT name FROM app_schema_migrations ORDER BY name' | sort > /tmp/nero-applied-migrations.txt
diff -u /tmp/nero-expected-migrations.txt /tmp/nero-applied-migrations.txt
~~~

migrate.mjs 只执行尚未记录在 app_schema_migrations 中的 SQL。迁移命令必须成功，diff 必须无输出且退出码为 0；否则停止，不切换 current。以上 PostgreSQL 容器名和数据库名来自现有 ECS 配置；若配置变化，应改用当前生产数据库的实际连接方式。

## 5.【ECS Workbench 终端】切换并重启

先确认现有 systemd 和 Nginx 已使用 current 发布入口。以下两条命令都必须找到对应路径；若没有，先修正现有服务配置后再继续。

~~~bash
sudo systemctl cat nero-agent | grep -F '/opt/nero-agent/current/mastra/index.mjs'
sudo nginx -T 2>&1 | grep -F 'root /opt/nero-agent/current/web;'
~~~

将 current 原子切换到本次发布目录，再重启后端、检查并重载 Nginx：

~~~bash
sudo test ! -e /opt/nero-agent/current.next
sudo test ! -L /opt/nero-agent/current.next
sudo ln -s "$RELEASE_DIR" /opt/nero-agent/current.next
sudo mv -Tf /opt/nero-agent/current.next /opt/nero-agent/current
sudo systemctl restart nero-agent
sudo nginx -t
sudo systemctl reload nginx
~~~

除第 4 步明确需要的配置外，这里不改变 PostgreSQL、DuckDB 工作目录、/data/mastra/users 或沙箱容器。后端的 systemd WorkingDirectory 继续使用 /var/lib/nero-agent。

## 6.【ECS Workbench 终端及浏览器】验收

~~~bash
sudo readlink -f /opt/nero-agent/current
sudo systemctl show nero-agent -p ActiveState -p MainPID -p NRestarts --no-pager
sudo journalctl -u nero-agent --since '2 minutes ago' --no-pager -n 30
sudo docker inspect -f '{{.State.Health.Status}}' nero-agent-postgres
curl -fsS https://agent.nerosun.cn/ | cmp - /opt/nero-agent/current/web/index.html
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://agent.nerosun.cn/auth/me
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://agent.nerosun.cn/finance/capabilities
~~~

核对 readlink 指向本次 RELEASE_DIR、ActiveState=active、NRestarts 不增长且近期日志没有启动错误。首页 HTML 应与本次产物完全相同；未登录时 `/auth/me` 和 `/finance/capabilities` 返回 `401 application/json` 属于正常响应，说明 API 已经通过 Nginx 到达后端。再在浏览器打开 https://agent.nerosun.cn/，检查页面、登录及需要的会话功能。财经功能还应在已登录会话中检查“财经数据”分类菜单、选择后标签和移除操作。
