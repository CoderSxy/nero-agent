# 技能导入与运行环境检查

## 管理端操作

1. 在技能管理页选择「导入技能包」，上传含 SKILL.md 的 ZIP。
2. 预览中查看运行环境报告；失败或缺依赖仍可导入为未启用草稿。
3. 在详情中编辑正文、资源及 skill-runtime.json；保存后重新检查。
4. 发布接口自动重新检查当前草稿；失败不会替换旧发布版。
5. 首次发布后还需启用并配置使用权限。后续同类技能无需重启服务。

已发布旧技能继续工作。旧 schema v1 脚本技能再次发布前需升级声明；纯指令技能不要求运行依赖文件。报告中的工具权限是当前管理账号的检查结果，实际用户仍按自身授权执行。

## skill-runtime.json v2 示例

```json
{
  "schemaVersion": 2,
  "runtimes": ["python3"],
  "runtimeVersions": { "python3": ">=3.10.0,<4.0.0" },
  "entrypoints": ["scripts/main.py"],
  "requiredTools": ["run_skill_script"],
  "network": "none",
  "dependencies": {
    "python": [
      { "name": "python-pptx", "module": "pptx", "version": ">=1.0.0,<2.0.0" }
    ],
    "node": [],
    "commands": []
  }
}
```

- Python name 使用发行包名，module 是可选导入模块路径；不会导入执行该包代码。
- Node name 支持普通及 scope 包名。commands 声明通过固定 `--version` 参数检查的系统程序，例如 libreoffice。
- version 支持数字版本的 `=`、`==`、`>`、`>=`、`<`、`<=` 比较，逗号连接多个条件；暂不支持 `^`、`~`、OR、预发布版本约束。
- 无额外依赖的脚本填写 `"dependencies": {}`。支持的脚本入口扩展名与实际执行器一致：.py、.js、.mjs、.cjs、.sh。
- 检查环境不包含某一历史会话临时安装的依赖。新会话的干净环境也应具备声明依赖；缺包时由管理员更新基础运行环境后再检查。本功能不自动执行 pip/npm 安装，也不执行技能包提供的探测脚本。

## 检查范围与有效期

检查使用固定镜像、UID 10001、无网络的临时容器，无用户工作区或技能包挂载；工作区用有界 tmpfs。任务初始化、venv 和环境变量复用正式执行逻辑。运行条件包括入口解释器、包元数据/模块位置、版本、系统程序及平台配置。公网声明检查策略配置，不能保证外部网站始终可达。环境通过也不保证业务脚本或模型输出一定正确。

报告按内容、依赖声明、当前工具集合和部署配置指纹缓存 5 分钟；失败缓存 5 秒。缓存仅在进程内，最多 100 份，服务重启后重新检查，各实例独立检查；发布始终强制复检。全局每进程最多一个真实探测容器，繁忙时可重试。单条固定命令超时默认 10 秒，总执行信号 60 秒，Docker 控制请求超时 15 秒。检查结束强制移除临时容器；容器清理故障算作检查失败。

首次上线此功能需要部署新版应用；不需要新增数据库迁移。之后上传普通技能不用重新部署。

## 验证命令

```sh
node --import tsx --test tests/skills-readiness.test.ts tests/skills-routes.test.ts
SKILL_READINESS_DOCKER_INTEGRATION=true SKILL_READINESS_TEST_IMAGE=nero-runtime:public-network node --import tsx --test tests/skills-readiness-docker.integration.test.ts
node --env-file-if-exists=.env --import tsx --test tests/skills-readiness-flow.integration.test.ts
npm test
npm test --prefix web
npm run build
```

Docker 验证只复用已有本地镜像；数据库验证仅接受 localhost/127.0.0.1:5433/nero_agent，并清理随机专用测试数据。
