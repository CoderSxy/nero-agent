# Bash、公开网络与任务依赖安装

日期：2026-10-20。状态：待用户评审；能力需求已确认，以下具体实现设计尚未确认。本文替代早期方案中“始终离线、禁止运行时安装”的推荐，不表示已修改或启用运行环境。

## 1. 已确认目标

用户希望通用 skill 获得接近参考项目的执行体验，将以下三项作为正式能力：

1. 执行 Bash 命令、脚本、多行内容、变量、管道、重定向和命令组合。
2. 沙箱脚本自行访问公开网络，无需把每次 HTTP 请求改写成 web_fetch 工具。
3. 在当前任务中安装 Python 和 Node 依赖，并在后续命令和 skill 脚本中复用。

继续保留非 root、不可变技能发布版、资源限制、配额、取消与审计。现有权限开关仍控制能力是否可用。当前需求授权修改此前的离线约束，不必再次询问是否允许支持联网或安装。

## 2. 本轮范围与明确边界

首期“公开网络”覆盖 HTTP 与 HTTPS：curl、requests、urllib、pip、npm 以及支持代理的 SDK。HTTPS 通过 CONNECT 隧道传输，不解密服务流量。不限制为预先枚举的少数公网域名。

不承诺任意 TCP/UDP、SSH、邮件协议，也不承诺所有客户端自动遵循代理。忽略代理的客户端会失败并收到可理解的说明，不能悄悄切成 unrestricted bridge 网络。

本轮不实现生图供应商接入、浏览器实时预览、所有技能零适配、apt 系统包安装或 sudo。需要系统库的包由镜像提供，或明确报告缺少系统依赖；运行时 Python/Node 依赖安装属于正式支持范围。

本轮保留已有用户 workspace 挂载和文件授权模型，不顺带改造所有会话的文件隔离。任务依赖按目录分开，但同一用户的 Bash 有能力访问其容器内已挂载的其他目录；不能把这种目录划分描述为会话级安全隔离。

## 3. Bash 工具契约

保留 execute_command 的 command + args 兼容性，并增加 execute_bash 工具，输入包含 threadId 和 script。服务器校验会话归属并确定工作目录；调用者不能传 userId、宿主路径、image、网络配置或任意 cwd。

工具底层使用 bash --noprofile --norc -c <script>。选用非登录 shell，避免系统 profile 重置任务 PATH 等环境。支持完整 Bash 语法，不自行拆分或正则过滤管道。脚本内容有请求大小上限，沿用执行超时、输出截断、取消和队列管理。

每次调用是新的 shell；文件、依赖和显式写入的配置可以保留，source、export、cd 的进程状态不会跨调用保留。Agent 指令必须解释这一点。

execute_bash 与 execute_command 使用同样的鉴权、配额、超时和环境初始化，在 src/mastra/index.ts 注册，并加入 Agent 可用工具。工具返回 exitCode、stdout、stderr、timedOut，非零退出不能被宣称为成功。

## 4. 公开网络出口

采用隔离 Docker 网络加出口代理，避免仅通过 HTTP_PROXY 环境变量声称限制生效。

数据路径：任务容器 → 隔离网络上的出口代理 → 公开 HTTP/HTTPS 目标。任务容器没有直接公网出口；出口代理具有独立出口连接，不暴露宿主监听端口，不挂载用户文件或服务凭证。

隔离网络按用户沙箱划分，通用沙箱和该用户的短生命周期 skill 容器加入对应网络；其代理同时连接该隔离网络和出口网络。禁止把任务容器连接到数据库或应用内部网络。代理容器禁用 IP 转发，只提供代理服务，不能成为任意包转发网关。

代理规则：

- 允许公开 HTTP/HTTPS，首期端口为 80 与 443；其他端口明确拒绝。
- 对目标域名或 IP 规范化，解析后拒绝所有非公网地址，包括 loopback、私网、link-local、云元数据、保留地址、IPv4-mapped IPv6；IPv6 不具备完整防护时默认拒绝。
- 以已检查的目标 IP 建立上游连接，不在检查后重新按域名连接；混合公网/私网解析结果采取拒绝策略，防止 DNS 重绑定绕过。
- HTTP 请求转发和 CONNECT 都执行地址检查；重定向后的新请求同样检查。限制目标 authority 格式，避免 URL 与 Host 不一致导致错连。
- 访问代理自身、宿主或其他内部服务均不属于允许的公开目标。

任务环境配置 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 及大小写兼容变量；NO_PROXY 不包含任何内部网段。环境变量只让客户端找到出口，真正的访问边界由隔离网络和代理检查实现。

代理不可用、网络缺失或策略验证失败时，联网执行必须失败，不回落到 host、default bridge 或直接出口。管理员配置网络、镜像和代理地址，模型或技能不能修改这些设置。

## 5. 任务内依赖环境

以当前 thread 作为首期任务边界，与已有工具契约和配额一致。在当前会话目录下使用 .runtime，内容包括：

- .runtime/venv：Python 虚拟环境。
- .runtime/home：可写 HOME。
- .runtime/cache：pip、npm 及 XDG 缓存。
- Node 项目的 package.json、lockfile 和 node_modules 位于实际任务项目目录，不全局安装。

Python 环境延迟创建：首次执行需要初始化时通过 python3 -m venv 创建，并带完成标记；中断后的半成品环境需清理后重建。初始化与执行使用现有队列，避免相同任务并发初始化冲突。

每次执行由服务器显式设置 HOME、VIRTUAL_ENV、PATH、PIP_CACHE_DIR、npm cache、XDG_CACHE_HOME 和代理变量。PATH 把任务 venv/bin 放在前面，让 python、python3、pip 使用同一个环境。

推荐命令为 python -m pip install <package> 和任务项目内的 npm install <package>。不依赖上次调用 source activate，不向系统 site-packages 或全局 Node 目录写入。

npm lifecycle scripts 与 pip 构建步骤属于已授权的沙箱代码执行，遵循相同网络和文件权限。没有预装的编译器或系统头文件时明确报告安装失败，不自动提权或尝试 apt。

所有依赖与缓存计入现有 workspace 硬配额。保留现有配额值，不自动扩大线上存储；配额不足时准确报告。镜像 digest 或 CPU 架构改变后，检测并重建不兼容 venv；Node 原生依赖需重新安装，不能把不同运行环境的依赖目录当作可直接复用。

## 6. skill 脚本复用

run_skill_script 保留已发布入口与版本 pin 校验，使用和通用执行相同的任务依赖环境。Python 入口使用任务 venv 解释器；Bash 入口获得同一 PATH/HOME；Node 入口需要让包内脚本能够解析到任务项目安装的依赖。

Node 的模块查找不能只设置 NODE_PATH：ESM 不按该变量查找。首期为任务创建固定版本的技能执行副本，保持文件布局，并在副本的合适父目录配置任务 node_modules；保留发布版只读原件。副本绑定技能 manifest hash，执行前校验脚本快照，避免把用户修改后的副本冒充发布入口。Python/Bash 可继续从只读技能挂载运行。

network manifest 增加 public，既有 none 与 server-tools 保持离线语义。public 是请求联网能力的声明，不是自行授权。技能容器仅在 public 模式且管理员启用公开出口时加入网络；否则按既有 none 执行或明确返回网络能力不可用。通用 Bash 受平台公开网络配置控制。

network=none 的脚本即使复用了已安装依赖也没有出口。server-tools 继续表示需要由 Agent 调用服务端工具，不能自动解释为脚本可联网。保留旧版 JSON 解析兼容，并同步可用性展示与工具文案。

通用执行目前不自动获得 /skill 资源。为让 Bash 使用已授权技能，提供显式资源准备步骤：根据当前执行 pin 物化技能快照到任务目录，返回容器路径，拒绝未授权技能及任意宿主路径。平台不承诺 ${SKILL_DIR} 由 argv 自动展开。

## 7. 镜像和生命周期

调整 sandbox/Dockerfile：明确提供 Bash、Python pip/venv、Node 与 npm、curl、CA 证书。继续固定镜像 digest，避免依赖当前离线 fallback 的 Node 二进制复制却遗漏 npm 及其模块。镜像需在目标 Linux 架构验收。

根文件系统保持只读，HOME、依赖、缓存、项目文件写入 workspace，/tmp 保持临时写入。现有非 root、cap-drop 与配额门禁保留。

网络、代理与环境由同一配置模块供普通沙箱和技能容器使用。记录配置指纹，包括镜像、网络策略版本和运行环境版本；旧容器指纹不匹配时先停止并重建，不能仅修改环境变量后继续复用已有容器。

用户代理与隔离网络由平台创建和回收。清理器先确认用户没有活跃命令或 skill 容器，再删除闲置代理与网络；服务重启后依标签恢复状态。清理操作只匹配本应用标签，不处理其他 Docker 资源。

## 8. 配置与迁移

新增配置区分离线与 public-http 网络模式，并单独提供 Bash、任务依赖安装开关。所有网络 ID、代理镜像 digest、端口和超时仅由管理员配置。配置解析采用显式枚举和边界校验。

为兼容已有部署，未配置时保持旧的离线模式；新功能作为正式支持的部署配置提供，不自动改写线上 .env 或启动服务。示例配置明确给出启用三项能力的方法及前置条件。

更新部署说明中 network none 和禁止 pip/npm 的旧限制，标明仅适用于离线模式；更新技能兼容性状态，将 public + 出口未准备与依赖安装失败分别报告。

回滚时停止新联网任务，等待或取消在途执行，销毁旧策略容器并恢复离线配置。保留用户文件；依赖环境可保留在磁盘但不得在不兼容镜像中直接使用。

## 9. 验收标准

单元与集成测试应覆盖：

1. Bash 管道、重定向、多行脚本、合法参数、非零退出、超时和取消。
2. 实际沙箱 curl 与 requests 成功请求公开 HTTPS；不用 web_fetch 代替验收。
3. Python 安装一个指定版本的小型依赖；在下一次命令和 run_skill_script 中成功 import。
4. Node 项目安装依赖；任务代码和技能 CJS/ESM 脚本均可使用。
5. 用户与任务环境分开，缓存计入配额；系统目录与发布原件不可写。
6. 拒绝私网、宿主、元数据、非公开 DNS 结果、重绑定、非允许端口；忽略代理时不能直接出网。
7. 网络故障无直连回退；网络模式变化后旧容器被替换；代理及网络正确回收。
8. 离线旧技能、版本 pin、权限和原 execute_command 调用回归通过。

真实 Docker 网络、依赖安装和拒绝访问测试是上线验收项。FakeProvider 或仅检查 create options 不能替代。若当前机器不能运行 Docker 或不能访问包源，报告未验收项，不宣称正式能力已经可用。

## 10. 预计改动位置

工具与注册：src/mastra/sandbox/tool.ts、types.ts、manager.ts、agents/agent.ts、index.ts。

容器与网络：src/mastra/sandbox/docker/、provider.ts、registry.ts、cleaner.ts，新增出口代理实现、网络管理与对应容器构建配置。

依赖与技能：新增任务运行环境模块，调整 skills/script-runner.ts、script-container.ts、types.ts、package.ts、runtime.ts、service.ts 和资源物化逻辑。

部署与验证：sandbox/Dockerfile、.env.example、部署文档及相关 tests。已有前端未提交修改不在本轮范围内，不覆盖。

## 11. 本轮选择

采用“完整 Bash + 公开 HTTP/HTTPS 出口 + 任务内 Python/Node 依赖”的实现。开放公网原始 TCP/UDP 和操作系统安装器作为将来独立需求，不在本轮默认承诺中。

此设计待用户确认后再编写实施计划并选择执行方式，随后进入代码修改与验收。
