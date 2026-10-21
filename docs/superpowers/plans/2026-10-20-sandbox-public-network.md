# Bash、公开网络与任务依赖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if the user selects delegation. Steps use checkbox syntax for tracking.

**Goal:** 在现有技能治理后增加完整 Bash、公开 HTTP/HTTPS 出口及任务内 Python/Node 依赖安装。

**Architecture:** Bash 和 argv 执行共用 SandboxManager 与任务环境。普通容器及 public 技能容器加入用户隔离网络，通过独立出口代理访问公网；任务依赖保存在会话目录，离线技能继续无出口。

**Tech Stack:** TypeScript、Mastra 1.71.0、Dockerode、Node HTTP/net/dns、ipaddr.js、Python venv、npm。

**Spec:** ../specs/2026-10-20-sandbox-public-network-design.md

## Global Constraints

- 只在本聊天附属 worktree 修改运行代码；保留原 checkout 的前端未提交改动。
- 非 root UID/GID 10001，根文件系统只读，技能发布原件不可变，保留现有权限及配额门禁。
- 网络范围为公开 HTTP/HTTPS 的 80/443；不支持任意 TCP/UDP、内网访问、sudo 或 apt。
- 默认配置保持离线；联网准备失败不回退到 host/default bridge 或直接出口。
- 使用当前 thread 作为任务边界，不声称同一用户的各会话在容器文件系统中强隔离。
- 新工具在 src/mastra/index.ts 注册；构建使用 package.json 中的脚本。
- 不改线上环境文件、不部署、不读取或传递用户令牌。
- 真实 Docker 验收不可由 FakeProvider 替代，未执行项必须记录。

## Review Focus

- HTTPS CONNECT 中带有预读数据、无效 authority 或断开的 socket，必须正确转发或终止，无资源泄漏（任务 2）。
- 域名同时解析出公网及私网，或返回 IPv4-mapped IPv6，必须拒绝，检查后不得重新解析（任务 2）。
- 两个 thread 的依赖初始化与缓存互不混用，中断初始化能在下一次调用恢复（任务 4）。
- 服务重启后容器网络策略、镜像或副本内容变化，必须检测并重建或拒绝执行（任务 3、5）。
- 技能 ESM 脚本、项目内 package.json 和已有 node_modules 组合，必须解析到任务依赖且保持原相对资源引用（任务 5）。

## 文件职责

- sandbox/runtime-config.ts：开关、网络模式、镜像及策略指纹。
- sandbox/task-runtime.ts：任务 HOME、缓存、venv 与每次 exec 环境。
- sandbox/network/{policy,proxy,manager,docker-engine}.ts：地址策略、HTTP/CONNECT 服务、用户资源生命周期、Docker 网络适配。
- sandbox/tool.ts、manager.ts、docker/client.ts：Bash 工具、鉴权执行、exec 环境透传。
- skills/materialize.ts：固定版本资源与 Node 执行副本。
- sandbox/egress/：代理镜像构建与独立进程入口，不把应用数据库环境带入代理。

所有上述路径相对 src/mastra，除 sandbox/egress 相对仓库根目录。

### Task 1: 配置契约与 Bash 工具

**Files:** Create src/mastra/sandbox/runtime-config.ts; modify sandbox/tool.ts、manager.ts、types.ts、agents/agent.ts、index.ts; create tests/sandbox-bash.test.ts、tests/sandbox-runtime-config.test.ts。

**Interfaces:**
- getSandboxRuntimeConfig(): { bashEnabled: boolean; dependenciesEnabled: boolean; networkMode: 'none' | 'public-http'; proxyImage?: string; policyVersion: string }。
- SandboxManager.executeBash(request: { auth: AuthContext; threadId: string; script: string; abortSignal?: AbortSignal }): Promise<SandboxCommandResult>。
- createExecuteBashTool(managerFactory?) 与 executeBashTool，沿用现有工具注入模式。

- [ ] 写失败测试：关闭开关不暴露工具；script 允许管道、换行、变量；超过 64KiB 或 NUL 拒绝；会话伪造拒绝；旧 command/args 不改变。
- [ ] 运行 node --import tsx --test tests/sandbox-bash.test.ts tests/sandbox-runtime-config.test.ts，确认缺少接口导致失败。
- [ ] 实现独立 Bash 开关，调用 bash --noprofile --norc -c，复用已有 manager.execute；配置只接受 none/public-http，联网要求固定代理镜像 digest。
- [ ] 测试通过，运行 tests/sandbox-manager.test.ts 回归并检查工具注册。
- [ ] 仅提交本任务文件，提交信息 feat: add authenticated bash sandbox execution。

### Task 2: 公开 HTTP/HTTPS 出口代理

**Files:** Create src/mastra/sandbox/network/policy.ts、proxy.ts; create sandbox/egress/Dockerfile、入口与最小构建配置; create tests/sandbox-egress-policy.test.ts、tests/sandbox-egress-proxy.test.ts。

**Interfaces:**
- resolvePublicTarget(host: string, port: number, lookup?): Promise<{ address: string; family: 4; hostname: string; port: 80 | 443 }>。
- createEgressProxy(deps?): http.Server，默认监听代理容器 3128；依赖注入仅用于测试。

- [ ] 写失败测试：拒绝 IPv4 私网、loopback、link-local、元数据、保留地址、IPv6、混合解析、端口越界、无效 CONNECT；允许纯公网 DNS 与规范公网 IP。
- [ ] 为 HTTP/CONNECT 写传输测试：实际传入 connect 的是已验证 IP；保留域名 Host；正确处理 head、双向关闭、超时、请求体、断开连接和 hop-by-hop headers。
- [ ] 运行上述测试确认失败，再用 ipaddr.js 及 Node 内置 HTTP/net/dns 实现。DNS 必须返回全部结果，连接只使用检查后的 IP，不在 net/http 默认 lookup 中再次解析。
- [ ] 构建代理产物仅含代理及必要依赖；代理无数据库配置、用户文件、凭证和宿主端口映射。
- [ ] 测试通过，提交 feat: add public http egress proxy。

### Task 3: Docker 网络管理与容器配置一致性

**Files:** Create sandbox/network/manager.ts、docker-engine.ts; modify sandbox/docker/config.ts、client.ts、provider.ts、factory.ts、cleaner.ts; create tests/sandbox-network-manager.test.ts; extend tests/docker-sandbox.integration.test.ts、sandbox-cleaner.test.ts。

**Interfaces:**
- SandboxNetworkManager.ensure(owner: SandboxOwner): Promise<{ networkId: string; proxyUrl: string; fingerprint: string }>。
- SandboxNetworkManager.removeIdle(owner: SandboxOwner): Promise<void>，在删除前检查当前普通容器、skill 容器与活动队列。
- 独立 DockerNetworkEngine 接口负责 inspect/create/connect/remove 网络，避免所有 Fake DockerEngine 无关实现被迫支持网络。
- DockerCreateOptions 扩充 NetworkingConfig、Env、Cmd、工作目录及必要 Healthcheck；SandboxExecuteOptions 增加 env?: string[]。

- [ ] 写失败测试：离线保持 none；联网任务只接内部网络；代理双网卡且禁用转发；无端口映射；配置不完整拒绝；故障不回退。
- [ ] 写重启与回收测试：恢复有标签的网络/代理；镜像或网络指纹不匹配重建；外部资源不删除；活跃命令与 skill 存在时不回收；部分创建失败能够重试清理。
- [ ] 实现每用户命名与平台标签，核验实际网络 Internal 属性、代理配置和健康，而不只信任标签；代理启动完成后才创建或执行联网容器。
- [ ] 普通容器与 skill 容器共享 manager；扩展 create validator 按已校验服务器网络上下文校验，不允许调用参数指定网络。
- [ ] 测试通过并跑旧 Docker provider/cleaner 回归，提交 feat: manage isolated sandbox egress networks。

### Task 4: 任务依赖环境与镜像

**Files:** Create sandbox/task-runtime.ts; modify sandbox/manager.ts、docker/client.ts、types.ts、sandbox/Dockerfile; create tests/sandbox-task-runtime.test.ts。

**Interfaces:**
- taskRuntimePaths(containerCwd: string): { root: string; home: string; cache: string; venv: string }。
- prepareTaskRuntime({ execute, cwd, imageDigest, proxyUrl?, dependenciesEnabled, abortSignal? }): Promise<{ env: string[]; python: string }>，execute 使用同一容器且不重复获得 commandQueue。

- [ ] 写失败测试：路径仅由受信 cwd 派生；HOME/缓存可写且按 thread 分开；PATH 含 venv/bin；env 不继承服务器凭证；安装关闭时不创建 venv。
- [ ] 写初始化恢复与兼容性测试：完成标记最后写；失败不中途标成功；下一次重建半成品；镜像/架构不匹配重建并提示 Node 原生模块重新安装。
- [ ] 实现容器内 mkdir、venv 与 marker 检查；每次 exec 显式设置运行环境与代理，不依赖 source；同 thread 操作纳入现有队列。
- [ ] 用显式 Python/Node 基础镜像提供 pip、venv、npm、curl 和证书；按 digest 固定运行镜像。验证 npm 模块实际存在，取消仅复制 Node 二进制的完整能力假设。
- [ ] 测试通过，提交 feat: add persistent task dependency environments。

### Task 5: skill public 网络、资源物化与依赖复用

**Files:** Create skills/materialize.ts; modify skills/{types,package,runtime,service,script-runner,script-container,tools,factory}.ts; create tests/skills-materialize.test.ts; extend skills-package/runtime/script-runner/script-container tests。

**Interfaces:**
- SkillRuntimeNetwork 增加 'public'。
- prepareSkillResources(ctx, skillName): Promise<SkillResult<{ containerPath: string; manifestHash: string }>>，只用当前执行 pin 和服务端鉴权。
- materializeSkillExecution({ pin, verifiedReleaseRoot, taskHostRoot, taskContainerRoot }): Promise<{ containerRoot: string; entrypoint(relativePath: string): string }>。
- prepare_skill_resources 工具由 skills/tools.ts 构造，随应用 skill tools 注册。

- [ ] 写失败测试：旧 none/server-tools 兼容；public 缺少平台出口显示 network-unavailable；声明本身不能授权；公开容器创建和执行都要求已就绪出口。
- [ ] 写版本与资源测试：只复制当前 pin；拒绝越界/符号链接；修改执行副本后拒绝或重建；资源相对引用保持；宿主绝对路径不出现在工具结果。
- [ ] 写依赖复用测试：Python 入口走任务 venv；Bash 获得任务 PATH；CJS 与 ESM 入口的上级 node_modules 指向任务依赖，不能仅依赖 NODE_PATH。
- [ ] 实现 Node 副本分层：.runtime/skills/<id>/<hash>/package 下保持技能布局，在上级安排任务 node_modules；副本校验与执行在同一任务队列内。保留发布版校验，不把副本更新写回 release。
- [ ] 调整 argv 字符校验：保留大小、NUL 和路径约束，不把合法 URL 中 & 或文本中 $ 当 shell 注入；显式 bash script 工具承担 shell 语义。
- [ ] 将真实工具与网络可用性传入兼容性计算，ready 不作为未知第三方依赖已安装的承诺。
- [ ] 测试通过，跑既有 skills pin/权限回归，提交 feat: run skills with public egress and task dependencies。

### Task 6: 真实沙箱端到端验收

**Files:** Create tests/sandbox-public.integration.test.ts; add tests/fixtures/skills/public-runtime-demo/; add package script for explicit live integration。

**Interfaces:**
- SANDBOX_PUBLIC_INTEGRATION=true 显式启用；要求两个 digest 镜像及测试临时工作区，不读取或改变生产配置。
- 未启用时明确 skip；启用但 Docker/镜像不可用必须失败，不能 skip 掩盖。

- [ ] 编写实际 Docker 测试：Bash 管道写文件、读回、非零退出、超时和取消。
- [ ] 在联网容器请求公开 HTTPS；在同容器禁用所有代理变量后直接请求失败；通过代理请求私网、元数据、宿主和非法端口失败。
- [ ] Python 安装指定版本 colorama，下一次 Bash 与 skill 脚本 import 成功；Node 安装指定版本小包，任务代码与 skill CJS/ESM 均成功。
- [ ] 验证离线技能无网络、系统目录和发布原件不可写；环境重启与闲置清理保留用户产物。
- [ ] 运行真实集成测试，记录镜像 digest、架构、测试结果与未验收项；提交 test: verify sandbox public network and package installation。

### Task 7: 部署说明、全量回归与交付

**Files:** Modify .env.example、docs/deployment/agent-skills.md、workspace-sandbox-ecs.md; create docs/sandbox-public-network-verification.md。

- [ ] 给出离线及启用三项能力的完整示例，明确 Docker 网络创建权限、代理和运行镜像构建顺序；不编辑 .env。
- [ ] 更新 Agent 指令：shell 状态不持久化、任务安装用法、网络范围、资源准备、缺系统依赖的错误表达。
- [ ] 跑相关测试及 npm test；新失败追因并修复，既有失败单列。使用 Node >=22.13.0。
- [ ] 运行 npm run build:mastra；若原工作区有 dev，构建只发生在当前 worktree，不能清理原 .mastra。通过后无需因未改前端额外重建前端。
- [ ] 自查协议、权限、取消和网络故障路径；按用户选定执行方法安排独立代码审查。
- [ ] 完成验证文档，记录功能配置状态和剩余限制；提交 docs: document sandbox public runtime deployment。

## 执行前基线与待确认项

- worktree: /Users/nerosun/.codex/worktrees/sandbox-public-network/nero-agent，原前端未提交改动未复制。
- 已复制设计稿，链接现有 node_modules；未安装或修改产品依赖。
- 当前 worktree shell 默认 Node 过旧，测试用 /Users/nerosun/.nvm/versions/node/v22.22.0/bin/node；实施命令统一显式 PATH。
- 初次 Docker version 因 sandbox socket 权限被拒，尚未判断 Docker daemon 是否可用；真实验收时需用工具权限升级重试。
- 用户已审阅并选择本会话直接实施；已完成实现、独立审查及相关验证，公网包源下载仍受本机 Docker TLS 环境阻塞。


## 执行结果（2026-10-21）

任务 1–5 已实现并完成相应回归；任务 7 的文档、构建、独立审查与基线对照已完成。任务 6 的真实 Docker 本地安装、skill 复用、网络拒绝、取消/超时/恢复已通过，公开包源 TLS 下载因宿主 Docker 网络受阻而未通过。详细证据及最终统计见 ../../sandbox-public-network-verification.md。未合并、未部署，不将未验收项勾选为成功。
