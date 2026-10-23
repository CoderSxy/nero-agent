# PPT 技能上线包

目标：当前采用 systemd + `/opt/nero-agent/current/mastra` 的 Nero Agent ECS 部署。Node >= 22.13，已执行技能相关数据库迁移。包内不含 `.env`、账号密码、本地数据库或本地用户 ID。

导入器沿用项目的校验、鉴权、内容寻址存储、发布和审计逻辑，同时写 PostgreSQL 与持久资源目录。不能用一段 INSERT SQL 代替它。

## 1. 上传与解压

在本机执行（替换 SSH 地址）：

```bash
scp dist/ppt-skill-deploy.tar.gz root@你的服务器:/tmp/
```

在服务器以 root 执行：

```bash
install -d -o nero-agent -g nero-agent -m 0750 /opt/nero-agent/skill-tools/ppt
# 上传包应为 0644；用服务用户解压，保证资源可读且脚本生成文件不归 root 所有。
chmod 0644 /tmp/ppt-skill-deploy.tar.gz
runuser -u nero-agent -- tar -xzf /tmp/ppt-skill-deploy.tar.gz -C /opt/nero-agent/skill-tools/ppt
cd /opt/nero-agent/skill-tools/ppt
sha256sum -c SHA256SUMS
```

新版本包请解压到新的工具目录，不与旧包混合。默认环境文件为 `/opt/nero-agent/.env`，默认服务用户/名称均为 `nero-agent`。

## 2. 安装并全局发布

先使用现有部署流程备份 PostgreSQL 和 `SKILLS_STORAGE_ROOT`（同一时间点）。以下命令使用线上真实管理员，不能填本地 UUID：

```bash
runuser -u nero-agent -- bash install.sh --admins
runuser -u nero-agent -- bash install.sh --install 上一步输出的管理员UUID
```

结果：创建 `ppt`，设置 `visibility=global`，发布 v1 并启用；线上所有已登录用户可选择技能。脚本调用成功后会核验已发布目录哈希。相同内容且已全局发布启用时重复运行直接核验；同名内容不同、私有或未完成发布时会停止，需从管理页处理，不覆盖旧技能。

可选的数据库只读检查在 `verify.sql`，可在现有 PostgreSQL 客户端执行。它不代替资源哈希验证。检查应得到 global / true / published / 非空 manifest_hash。

如后端路径或环境文件不同，可通过 `BACKEND_DIR`、`ENV_FILE`、`NODE` 指定；这些变量只改变脚本运行位置，不把凭证写进命令。

## 3. 准备离线执行镜像

安装 ≠ 能执行。以下构建会下载官方基础镜像、apt 软件包及 Python 包，可能需要几分钟；只影响新建镜像。默认 linux/amd64，与当前 ECS 一致。依赖版本保存在镜像 `/opt/ppt-python-dependencies.txt`，上线使用最终固定的镜像身份，不自动更新。

```bash
bash build-runtime.sh
```

构建包括原项目 sandbox 基础镜像，以及带 python-pptx、Pillow、CairoSVG、Cairo 和中文字体的 PPT 镜像。脚本在无网络、非 root、根文件系统只读容器内，实际执行备注拆分、SVG 后处理、PPTX 导出，并重新打开 PPTX 检查一页可编辑文本。通过后输出 `nero-ppt-runtime:local@sha256:...`。

必须在应用使用的同一个 Docker daemon 上构建/加载镜像。跨服务器传输镜像时使用 docker save/load，或推送到你自己的可信 registry 并使用 RepoDigest。不要把本机 Docker 的 Image ID 当作另一台机器已有的镜像。

## 4. 启用执行能力

前提：

- 服务用户已具有经管理员授权的 Docker daemon 访问权限，Docker 容器可运行。
- `.env` 已配置 `DATABASE_URL`、`WORKSPACE_ROOT`、`SKILLS_STORAGE_ROOT`、`SKILLS_IMPORT_TEMP_ROOT`，三个持久目录已存在，服务用户能写。
- 宿主工作区已配置并实际验证 project quota，之后才可设置 `WORKSPACE_HOST_QUOTA_VERIFIED=true`。只填写 true 不代表配额生效。

项目原有配额探针也附在包内。给一个**已经设置独立 project quota 的空测试目录**，以应用的写入身份运行，例如：

```bash
runuser -u nero-agent -- env \
  WORKSPACE_QUOTA_PROBE_DIR=/你的空配额测试目录 \
  WORKSPACE_QUOTA_PROBE_LIMIT_BYTES=52428800 \
  /usr/local/bin/node check-workspace-quota.mjs
```

此探针验证现有配额，不负责创建配额。应使用与真实用户工作区相同的配额机制；探针成功也不能代替后续用户目录的配额配置。未配置配额时，启用脚本会停止，不能绕过。

满足前提后，以 root 执行，填入构建脚本实际输出：

```bash
bash enable-runtime.sh 'nero-ppt-runtime:local@sha256:实际的64位镜像ID'
```

该脚本会先校验配置，以服务用户运行镜像导出冒烟检查，再备份并原子修改 `.env`、重启 `nero-agent`。保留环境文件的权限和所有者，不重复追加配置行，不打印现有密码。仅启用 Docker 命令、写入、Bash 与技能脚本；运行期 network=none，依赖预装在镜像中，关闭任务依赖安装以避免隔离 venv 隐藏预装包。已有在线/任务依赖执行配置时停止，请按既有部署方案合并，不覆盖。

这会开启应用的沙箱执行能力，并非只为 `ppt` 单独开关。它不配置图片生成 API、联网图片搜索、录音配音、容器预览端口或 Office/LibreOffice。基础路径支持文本/Markdown/用户已有图片 -> SVG -> PPTX。额外输入格式和媒体能力按实际依赖分别配置。

## 5. 应用内验收与回退

```bash
systemctl status nero-agent --no-pager
journalctl -u nero-agent --since '2 minutes ago' --no-pager -n 50
```

刷新网页，新建聊天，选择 `ppt`，输入：

> 生成一页中文 PPT，标题“上线验证”，正文三个要点；使用纯文字和矢量图形，不调用外部图片或语音服务。设计确认通过聊天完成。

确认八项设计建议后继续，检查技能资源准备、脚本执行、PPTX 下载和实际打开。容器导出测试只验证运行时及导出工具，不能代替真实聊天链路验收。服务 active 或技能 availability=ready 也不是完整验收。

脚本输出 `.env.before-ppt-时间戳` 备份路径。若需要关闭执行：将该备份恢复为原 `.env`（保留原 root:nero-agent 与 0640 权限），再 `systemctl restart nero-agent`。这保留技能与用户产物。若仅需停用 PPT，在技能管理页禁用，不删除数据库或资源目录。
