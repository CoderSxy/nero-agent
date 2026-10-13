# AKTools 在同一台 ECS 上运行

本服务供 Mastra 后端通过 `127.0.0.1:18080` 调用。AKTools 自身的 HTTP 接口不经过 Nginx，也不开放 ECS 安全组端口。应用端只允许 `src/mastra/finance/catalog.ts` 中登记的接口与参数。

## 当前部署方式

ECS 使用 Ubuntu 24.04 自带的 Python 3.12 虚拟环境，安装固定版本 `aktools==0.0.91`、`akshare==1.19.1`，由 systemd 管理。官方仓库中的旧 `aktools` 镜像缺少 `aktools` Python 模块，Docker Hub 中转在部署时返回 502，因此不使用该镜像。

```bash
sudo install -d -m 0755 /opt/aktools
sudo python3 -m venv /opt/aktools/venv
sudo /opt/aktools/venv/bin/python -m pip install --no-cache-dir \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  aktools==0.0.91 akshare==1.19.1
# 先把仓库中的 deploy/aktools/aktools.service 上传到 ECS 的 /tmp
sudo install -m 0644 /tmp/aktools.service /etc/systemd/system/aktools.service
sudo systemctl daemon-reload
sudo systemctl enable --now aktools
```

`deploy/aktools/aktools.service` 使用独立动态用户、600 MB 内存上限，日志写入 systemd 管理的 `/var/lib/aktools`，仅监听 `127.0.0.1:18080`。版本升级时，先在新虚拟环境验证五类接口，再切换服务。

## 验收

```bash
systemctl show aktools -p ActiveState -p MainPID -p NRestarts --no-pager
ss -ltnp | grep '127.0.0.1:18080'
curl -fsS http://127.0.0.1:18080/docs >/dev/null
```

分别用 A 股、基金、指数、宏观、期货目录接口测试非空数据、字段、时效，并确认公网不能直连 18080。通过后才在 `/opt/nero-agent/.env` 中设置 `AKTOOLS_BASE_URL=http://127.0.0.1:18080/` 和 `FINANCE_TOOL_ENABLED=true`，按现有发布流程部署 Mastra 与 Web。任何验证失败时保持开关关闭。

## 回退

将 `FINANCE_TOOL_ENABLED=false` 并重启 `nero-agent`，前端入口隐藏，普通会话继续使用原有功能。AKTools 服务本身可用 `sudo systemctl stop aktools` 停止，不影响其他容器或 Nginx。
