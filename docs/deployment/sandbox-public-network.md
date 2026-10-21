# Bash、公开网络和任务内依赖

状态：实现于 sandbox-public-network worktree；实际验收结果见 ../sandbox-public-network-verification.md。启用前先完成目标宿主验收，不自动改动线上环境。

## 构建

使用 Node >=22.13，在仓库根目录安装锁定依赖后运行：

```bash
npm run build:egress
docker build -t nero-egress:1 -f sandbox/egress/Dockerfile sandbox/egress
docker build -t nero-runtime:1 -f sandbox/Dockerfile sandbox
```

生产将两个镜像推送到可信 registry，使用各自 RepoDigest，不能使用 latest。支持 NODE_BASE、PYTHON_BASE、NODE_BIN、NODE_MODULES 构建参数，以适配等效的本地基础镜像；所有基础版本与目标架构需要记录。安装器缺系统库时不会自动 sudo/apt。

## 配置

保留原有 sandbox 开关及宿主 project quota 验证，再增加：

```dotenv
SANDBOX_PROVIDER=docker
SANDBOX_COMMANDS_ENABLED=true
SANDBOX_FILE_WRITE_ENABLED=true
WORKSPACE_HOST_QUOTA_VERIFIED=true
SANDBOX_IMAGE=registry.example/nero-runtime@sha256:<digest>
SANDBOX_BASH_ENABLED=true
SANDBOX_DEPENDENCIES_ENABLED=true
SANDBOX_NETWORK_MODE=public-http
SANDBOX_EGRESS_IMAGE=registry.example/nero-egress@sha256:<digest>
```

技能另需 AGENT_SKILLS_ENABLED、SKILL_SCRIPT_EXECUTION_ENABLED、既有数据库迁移和显式技能存储路径。网络配置只由管理员提供，用户工具参数不能更换镜像、网络或 cwd。

Docker daemon 需要能创建内部 bridge 网络与出口代理容器。每用户两个独立网络；任务容器只加入 internal 网络，设置 inhibit_ipv4 防止宿主 bridge 地址对任务开放。代理同时连接内部/出口网络，禁用转发，不映射宿主端口、不挂载用户文件。网络创建失败、策略不匹配、代理不健康均拒绝联网执行。

公开网络只支持 HTTP/HTTPS 80/443。代理检查全部 DNS 结果，拒绝非公网地址，选择检查后的 IPv4 连接；不提供 IPv6 或任意 TCP/UDP 出口。支持 HTTP_PROXY/HTTPS_PROXY 的 curl、requests、pip、npm 可以直接使用。忽略代理的 SDK 需要显式配置代理，不能假设设置环境变量就覆盖全部 Node fetch/SDK。

## 使用

execute_command 保留 command + args；execute_bash 接收 threadId 与 script，支持完整 Bash。每次创建新 shell，因此 cd/export/source 的状态不跨工具调用保存。

启用依赖环境后，python/python3/pip 指向当前 thread 下的 .runtime/venv；HOME、pip/npm/XDG 缓存也位于该目录，均计入 workspace 配额。

```bash
python -m pip install python-pptx
npm install is-number
python -c 'import pptx; print(pptx.__version__)'
```

Node skill 复用的是当前会话根目录的 node_modules。若在子项目安装依赖，应从该项目运行通用代码，或在会话根目录安装该技能依赖；不自动猜测任意子项目的依赖目录。安装开关控制平台自动环境初始化，不是阻止已获 Bash 权限的代码自行创建其他环境的安全边界。

安装包的构建脚本与 npm lifecycle scripts 是沙箱内代码，执行受同样文件/网络约束。root 系统目录继续只读。镜像或解释器身份变化时重建 venv；Node 环境身份（镜像、ABI、架构、版本）变化后，旧 node_modules 与任务内 Node 安装目录会移到带 incompatible 后缀的备份目录，并提示重新 npm install；用户自行确认后可删除旧备份。

## Skill 接入

现有 skill-runtime.json 中 network=none 或 server-tools 保持无脚本出口；联网脚本显式声明 network=public，且部署必须已经准备好公开出口。声明本身不授予工具或系统权限。

run_skill_script 按发布入口、权限、pin 运行，Python 复用任务 venv；Node 使用固定版本的任务副本并从上级解析任务 node_modules，支持 CJS/ESM。发布原件仍挂载 /skill:ro。

需要直接使用技能目录的 Bash 时，先调用 prepare_skill_resources({skillName})。工具返回当前 pin 的容器目录，并复制 scripts、templates 等原布局。复制版可写，重新准备会恢复发布内容；发布原件不变。不要把 skill:// 当作 shell 目录，也不要假设 argv 会展开 ${SKILL_DIR}。

ready 表示声明与部署配置匹配，不保证第三方依赖或完整工作流已通过验收；执行时仍实际检查出口与进程状态。

## 验收与回滚

```bash
npm run test:sandbox:runtime
npm run test:sandbox:public
# 仅验证隔离与本地包安装，不代表公网下载成功：
SANDBOX_EGRESS_INTEGRATION=true node --import tsx --test tests/sandbox-public.integration.test.ts
```

两者均需要固定 SANDBOX_IMAGE；public 还需 SANDBOX_EGRESS_IMAGE。测试只创建带测试用户标签的临时容器、网络和工作区；runtime 使用本地测试 wheel/Node 包验证真实安装和跨执行复用，不代表公网下载已成功。公网测试显式启用后若 Docker、包源或 TLS 不可用必须失败。

策略/镜像变化后停止并重建旧容器；回滚可关闭 Bash/依赖开关并设 SANDBOX_NETWORK_MODE=none，然后重启应用。容器指纹防止继续复用旧联网配置，代理与网络按标签在闲置后回收，用户产物保留。不会自动清理缓存来绕过配额，也不会清理其他应用 Docker 资源。
