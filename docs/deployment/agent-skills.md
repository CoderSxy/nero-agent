# Agent Skills 部署与镜像依赖

更新：Bash、公开 HTTP/HTTPS 与任务依赖安装模式见 [新版部署说明](sandbox-public-network.md)。下文的 network none 和禁止运行时安装约束描述旧的离线模式，不能作为新模式的能力上限。

日期：2026-10-19。覆盖技能存储、脚本沙箱镜像与 B 门禁开关；不备份用户令牌。

## 1. 开关与依赖顺序

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_SKILLS_ENABLED` | `false` | 总开关；关则 API 503、工具不暴露 |
| `SKILL_SCRIPT_EXECUTION_ENABLED` | `false` | 脚本执行；须同时满足既有 sandbox 全开 |
| `SANDBOX_PROVIDER` | — | 须为 `docker` |
| `SANDBOX_COMMANDS_ENABLED` | `false` | 与 sandbox 一致 |
| `SANDBOX_FILE_WRITE_ENABLED` | `false` | 与 sandbox 一致 |
| `WORKSPACE_HOST_QUOTA_VERIFIED` | — | 宿主配额门禁 |
| `SANDBOX_IMAGE` | — | **必须** `name@sha256:<64hex>` |
| `SKILLS_STORAGE_ROOT` | — | 管理员配置的 blob/release 根；禁止指向用户 workspace |
| `SKILLS_IMPORT_TEMP_ROOT` | — | 导入预览临时区 |
| `WORKSPACE_ROOT` | `/data/mastra` | 用户工作区根 |

脚本执行门控（全部为真才暴露 `run_skill_script`）：

`AGENT_SKILLS_ENABLED` ∧ `SKILL_SCRIPT_EXECUTION_ENABLED` ∧ `SANDBOX_COMMANDS_ENABLED` ∧ `SANDBOX_PROVIDER=docker` ∧ `WORKSPACE_HOST_QUOTA_VERIFIED` ∧ `SANDBOX_FILE_WRITE_ENABLED`。

灰度顺序：DB 迁移 → 配置 `SKILLS_STORAGE_ROOT` → 开 `AGENT_SKILLS_ENABLED`（仅指令）→ 宿主配额与 workspace 门禁 → 构建并固定 `SANDBOX_IMAGE` → 再开脚本开关。

## 1.1 HTTP 代理（开发 / 生产）

| 环境 | 配置 |
| --- | --- |
| 本地 Vite | `web/vite.config.ts` 已代理 `/agent-skills` → `http://127.0.0.1:4111` |
| ECS Nginx | 将 `agent-skills` 加入 API `location` 正则（与 `auth`/`finance`/`agent-scheduled-tasks` 同组），例如 `api\|auth\|finance\|agent-skills\|agent-scheduled-tasks\|model-catalog`。未登录 `GET /agent-skills/available` 应返回 `401 application/json`，不能回落到前端 `index.html`。 |

关总开关时聊天原功能继续，技能 API 返回 503 `SKILLS_DISABLED`，界面文案为「技能功能未启用，请联系管理员配置」，且不可重试。空目录或未发布技能不是关闭：列表可为空，草稿不进入可调用目录。未登录是 401，无权限是 403，其他失败可重试。修改 `AGENT_SKILLS_ENABLED` 或两个存储目录后必须重启 Mastra 进程；只改前端不能打开总开关。脚本开关、Docker 网络、配额和磁盘保护保持独立，不因基础技能启用而打开。

## 1.2 本地基础技能目录

`SKILLS_STORAGE_ROOT` 与 `SKILLS_IMPORT_TEMP_ROOT` 必须是两个显式的管理员目录，不能是用户 workspace、仓库 `public` 或 `/tmp`。已有目录里的资源不要覆盖。生产启用不在本地 UI 验收范围内。

## 2. 沙箱 / 技能脚本镜像

构建文件：**仅**使用仓库已有 [`sandbox/Dockerfile`](../../sandbox/Dockerfile)（与通用 `execute_command` 沙箱同一镜像）。不要另起未被部署引用的 Dockerfile。

### 2.1 依赖清单（镜像内预装）

| 组件 | 用途 | 备注 |
| --- | --- | --- |
| `python3` | `*.py` 技能脚本 | 标准库即可；**禁止**运行时 `pip install` |
| `node` | `*.js` / `*.mjs` / `*.cjs` | **禁止**运行时 `npm install` |
| `bash` | `*.sh` entrypoint | argv 调用，不拼接 `sh -c` |
| UID/GID `10001` | 非 root 执行 | 与现有 sandbox 一致 |
| 无外网默认 | `NetworkMode=none` | 技能容器同样 `network none` |

技能短生命周期容器额外挂载：已校验 pin release → `/skill:ro`，本用户 workspace → `/workspace:rw`；标签 `nero.skill-run=1`。

### 2.2 构建与 digest 固定

```bash
# 在仓库根目录
docker build -t mastra-agent-sandbox:1.0 -f sandbox/Dockerfile sandbox/

# 记录 digest（推送到仓库后优先用 RepoDigest；本地未推送可用 Image ID）
docker inspect --format='{{.Id}}' mastra-agent-sandbox:1.0
# 例：sha256:e4cbba692d0ee123704f9fb3ed9508fb9cecb66cfe5603890cc891096b13f937

export SANDBOX_IMAGE="mastra-agent-sandbox:1.0@sha256:<64hex>"
```

本地未推送时，应用侧 Docker engine 若发现本地存在同 ID 镜像，会将 `name@sha256:<id>` 解析为 `sha256:<id>` 再 create，避免误 pull。生产应使用 registry content digest。

### 2.3 解释器版本验收（必须在容器内，不在宿主跑技能脚本）

```bash
PIN="$SANDBOX_IMAGE"
# 或使用 Image ID：sha256:<digest>
docker run --rm --user 10001:10001 mastra-agent-sandbox:1.0 \
  bash -lc 'python3 --version; node --version; bash --version | head -n1'
```

本机 B 门禁实测（2026-10-19，`mastra-agent-sandbox:1.0@sha256:e4cbba692d0ee123704f9fb3ed9508fb9cecb66cfe5603890cc891096b13f937`）：

| 解释器 | 版本 |
| --- | --- |
| python3 | Python 3.13.7 |
| node | v22.23.1 |
| bash | GNU bash 5.2.37(1)-release (aarch64-unknown-linux-gnu) |

> Dockerfile 在 registry/apt 不可达时可用本地 `PYTHON_BASE` / `NODE_SRC` build-arg 离线拼装；生产恢复网络后应以可复现的 slim 基座重建并更换 digest。

## 3. 存储、备份与恢复

同一时刻备份，并按同一时间点恢复（不要混用不同时间的 DB 与文件）：

1. PostgreSQL：`app_skills`、版本、文件引用、run pins、审计事件。不备份用户令牌、会话 cookie、模型密钥。
2. `SKILLS_STORAGE_ROOT/blobs/`（内容寻址，不可变）
3. `SKILLS_STORAGE_ROOT/releases/`（可由受信 blob 重建，但仍与 DB 指针一起保存）
4. 固定的 `SANDBOX_IMAGE` digest（与当时技能脚本所依赖的解释器版本一致）

恢复验证：

1. 先恢复 DB，再恢复 blob 与 release，最后把 `SANDBOX_IMAGE` 指回备份记录的 digest。
2. 启动会在 `AGENT_SKILLS_ENABLED=true` 时跑 `reconcileSkills`：只核对**当前发布指针**。目录缺失且 blob 校验通过则重建；blob 缺失或哈希不符则该版本 **503 不可用**，**不**自动改 `published_version`。
3. 抽查：当前发布目录的 `SKILL.md` 与 DB `manifest_hash` 一致；活动 pin 仍指向恢复前的 version。
4. 再开脚本开关前，用 §2.3 在容器内核对解释器版本。

本仓库**尚未**做一次真实备份恢复演练；上线前须在非生产环境走完上述步骤。Task 15（2026-10-19）再次确认：**未跑备份/恢复**，此项保持未验收。同日在临时源副本 `npm run build:mastra` 成功，未删除正在运行的 dev 所使用的仓库 `.mastra`。

## 3.1 GC（默认 dry-run）

```bash
node --env-file-if-exists=.env --import tsx scripts/skills-gc.ts
node --env-file-if-exists=.env --import tsx scripts/skills-gc.ts --apply
```

无 `--apply` 只打印候选。`--apply` 只删除已满足宽限且无引用的内容：

| 对象 | 保留 |
| --- | --- |
| 未引用 blob / 孤儿 release / 过期 import·sync 临时区 / 孤儿 `.staging-*` | 至少 7 天 |
| run pin | 结束后再保留 7 天；`expires_at` 未到（含执行续期）不删 |
| 当前发布版本、活动 pin 指向的 release | 永不删 |
| 审计 | 仅 `load`/`read`/`search`/`execute` 超过 90 天；发布/授权等事件保留 |

多实例对同一技能 release 使用数据库顾问锁；reconcile 不删除其他实例的 staging，也不删除当前版本目录。孤儿技能容器只匹配 `nero.skill-run=1`，不清理 `nero.sandbox=1` 的普通沙箱。

## 3.2 存储不足

磁盘满或宿主配额门禁触发时，停止新的 blob/release 写入并让相关 API 失败，**不要**靠 GC 当前发布版或活动 pin 腾空间。腾出空间后重新跑 reconcile，确认没有半截 staging 被当成发布版本。GC 不能绕过原有权限。

## 4. B 门禁回归命令

```bash
WS=$(mktemp -d)
ST=$(mktemp -d)
export SKILLS_DOCKER_INTEGRATION=true
export SANDBOX_IMAGE='mastra-agent-sandbox:1.0@sha256:<digest>'
export WORKSPACE_ROOT="$WS"
export SKILLS_STORAGE_ROOT="$ST"

node --import tsx --test tests/skills-docker.integration.test.ts
```

未设置上述变量时测试**显式 skip**并说明原因，**不会**用 FakeProvider 冒充通过。Fixture：`tests/fixtures/skills/reference-demo`、`script-demo`。

## 5. 网络 / 内部业务技能迁移限制

灰度顺序（与 §1 一致，不可颠倒）：DB 迁移 → `SKILLS_STORAGE_ROOT` → 仅开 `AGENT_SKILLS_ENABLED`（指令）→ 配额与 workspace 门禁 → 固定 `SANDBOX_IMAGE` digest → 最后开脚本开关。关总开关时聊天原功能继续，技能 API 返回 503。API 代理见 §1.1：ECS Nginx 与本地 Vite 都必须把 `/agent-skills` 转到 Mastra，未登录请求返回 JSON 401，不能落到 `index.html`。

可迁移：纯指令包，以及只依赖镜像内 python3/node/bash 标准库的离线脚本包。

不能当作“已支持”迁入：

- 需要容器外网、`pip`/`npm` 安装或动态下载依赖的包（标 `network-unavailable`，不打开 Docker 网络，不在对话里安装）。
- 依赖内部业务系统、内网地址或用户令牌的包。令牌不进脚本环境，也不进备份。这类能力要做成服务端工具并单独鉴权，而不是打进技能 ZIP。
- 实时数据走 `web_search` / `web_fetch` / finance 等服务端工具，并在 `skill-runtime.json` 声明 `network=server-tools` 与 `requiredTools`。
