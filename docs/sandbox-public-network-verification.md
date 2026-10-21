# Bash、公开网络、任务依赖验收记录

更新：2026-10-21。实现保存在独立 worktree：`/Users/nerosun/.codex/worktrees/sandbox-public-network/nero-agent`。没有合并、推送或部署；原工作区未提交前端修改保留。

## 实现范围

- execute_bash：完整 Bash、服务器确定的会话目录、既有鉴权/配额/队列/取消链路。execute_command 的 argv 契约保留。
- 任务运行环境：thread 下 venv、HOME、缓存和 Node 安装目录；Python/Node skill 可复用安装包。镜像/ABI/架构变化隔离旧 Node 依赖并提示重装。
- 公网 HTTP/HTTPS 80/443：用户隔离 internal 网络、独立双网络出口代理、全 DNS 结果检查及固定 IP 连接；public 技能显式请求出口，none/server-tools 保持离线。
- prepare_skill_resources：按权限及 pin 复制技能资源；Node 包作用域隔断任务继承，保留自身声明和 Node 22 语法检测。
- 网络与镜像漂移检测、离线启动清理、孤立网络回收。资源复制和元数据替换全部在 UID 10001 的容器内完成，宿主不再解析或写入任务资源路径。容量检查先于出口分配；创建失败回收容器及空闲出口资源。

## 通过的验证

- 相关沙箱、技能包、权限、pin、物化与执行测试：88 项，85 通过、0 失败、3 skip。相关测试无失败，数据库和显式真实集成开关未启用项说明 skip。
- 独立审查发现四项问题及修复引入的两项回归，均已有失败测试和修复后通过证据；审查复核确认限定范围无剩余发现。
- 本轮修复增加容量拒绝、启动失败回收、部分出口创建失败回收、队列退出后回收及容器复制委托回归测试。
- TypeScript `tsc --noEmit` 无错误。
- `npm run build:mastra` 最终构建通过；仅在 worktree 生成 .mastra/output，未触碰原 checkout dev 输出。
- `npm run build:egress` 通过，代理独立产物已实际运行。

真实 Linux/arm64 Docker 验收通过：

1. Bash 管道、变量、重定向、文件落盘、非零退出。
2. pip 安装本地纯 Python wheel，后续调用及 Python skill 成功 import。
3. npm 安装本地测试包，任务代码、CJS 和 ESM skill 均成功加载。
4. public 模式容器能够访问出口代理，代理拒绝私网、loopback、云元数据和宿主目标；绕过代理不能直接出网。
5. none 技能不具备网络；系统根目录不可写。
6. 执行中取消、超时及后续容器恢复。
7. 资源准备后通过普通 Bash 运行技能脚本，固定发布原件保留只读。
8. 在目录校验后替换祖先目录为指向宿主任务目录外的符号链接，复制失败且宿主目标未被改写。
9. 测试出口容器和网络结束后均已清理。

使用的本地测试镜像（Image ID，不是生产 registry RepoDigest）：

- runtime: sha256:8411812c2460cab4fa79bb4bf9cdeb3bb2c97106ef9764eb4f2e96d801adb2be，linux/arm64。
- egress: sha256:a7556c185f32e317c0ef1e724a31d50031db03d0f4e7ad6046ebbe0cd6543121，linux/arm64。

官方基础镜像拉取受本机 Docker 代理配置阻塞，因此测试使用已存在的 python:3.13.7 和 primeai-harness-sandbox:latest 作为构建参数。生产应以固定版本基础镜像重新构建并记录 registry 内容 digest；未做 Linux/amd64 验收。

## 公网下载未验收

真实 `SANDBOX_PUBLIC_INTEGRATION=true` 测试未通过：访问 PyPI HTTPS 出现 TLS unexpected EOF。对照实验中，完全不经过新出口代理、使用普通 bridge 的临时 Docker 容器访问 PyPI、npm registry、example.com 也出现相同 TLS 错误；宿主 curl 可访问 PyPI。

因此只能确认 Docker 当前出口环境有阻塞，不能宣称公网下载或在线 pip/npm 安装已通过。没有修改 Docker Desktop 全局代理、宿主网络或线上开关，也没有以关闭地址保护来绕过问题。

已通过的本地 wheel/npm 安装测试只证明安装器和跨调用复用正常，不能代替公网下载验收。在目标宿主修复 Docker 出口后，用部署文档中的 test:sandbox:public 完成剩余验收。

## 全量测试基线对照

在相同机器、依赖与环境下，从原始提交 c02be9ddf8e1773474c242dcb52433daaf89ff61 导出干净临时快照运行 npm test：461 项，375 通过、49 失败、37 skip。

上一轮全量测试为 479 项，392 通过、49 失败、38 skip；当时失败名称与基线相同，涉及磁盘写入保护及本地 HTTP 验收环境。

本轮目录竞态和出口回收修复后的最新全量测试：484 项，445 通过、0 失败、39 skip。独立复审无新发现，复审者另行重跑 18 项相关测试全部通过。

没有提高磁盘保护阈值、删除用户文件或复制账号凭证来制造通过。宿主硬配额、DB 权限、生产启用和公网包源连通仍需在目标部署环境验收。

## 使用与交付

配置与回滚见 [部署说明](deployment/sandbox-public-network.md)。默认开关保持关闭/离线；启用需要管理员提供运行镜像 digest、出口镜像 digest 及既有配额/文件写入配置。

代码已实现，不代表当前部署已启用，也不代表未提供的 ppt-master 包已经完成兼容验收。


实现分支：codex/sandbox-public-network；主要实现提交：d881808（含前序 Bash、出口、网络与依赖环境提交）。
