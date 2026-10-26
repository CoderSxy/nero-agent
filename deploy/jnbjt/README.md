# 江南百景图静态占位站

2026-10-24 已部署：<https://jnbjt.nerosun.cn/>。

- 阿里云 DNS：`jnbjt`，A 记录 `101.37.135.116`，默认线路，TTL 10 分钟。
- ECS：杭州 `i-bp1224fuv8f6h2w20d38`，通过现有 Workbench 免密会话部署。
- 页面：`/var/www/jnbjt/index.html`，Nginx 直接提供静态文件，无额外进程或数据库。
- 配置：`/etc/nginx/sites-available/jnbjt`，软链接到 `sites-enabled/jnbjt`。
- 独立证书：`/etc/letsencrypt/live/jnbjt.nerosun.cn/`，签发时显示到期日 2027-01-22。实际自动续期采用现有 `snap.certbot.renew.timer`；已核对定时器存在且有下次执行时间，系统没有名为 `certbot.timer` 的单元。
- HTTPS：经用户明确授权，执行 `certbot --nginx -d jnbjt.nerosun.cn --cert-name jnbjt.nerosun.cn --non-interactive --redirect`，HTTP 自动 301 跳转 HTTPS。

`nginx.conf` 是首次配置 HTTP 站点的模板；线上配置已由 Certbot 添加 HTTPS 和跳转，不要用此模板直接覆盖线上配置。

## 验收

- `nginx -t` 通过并已重载。
- DNS 控制台显示记录已启用；ECS 解析到 `101.37.135.116`。
- 公网 HTTPS 返回 `200`，未跳过证书校验；HTTP 返回 `301`，Location 为 `https://jnbjt.nerosun.cn/`。
- HTTPS 页面与本地 `index.html` SHA-256 一致：`e8d79f10eb92ab4eb1c25486e07f9c0b0e2b6222e2729a9d14103430def1b380`。
- Chrome 正常打开，桌面与 390×844 手机尺寸截图见本目录；手机文档宽度与视口均为 390，无水平溢出。
- 原有 `https://agent.nerosun.cn/` 返回 `200`。

## 后续更新

只更新服务器 `/var/www/jnbjt/index.html` 即可，不需要重启应用、数据库或重新构建 Mastra。更新后通过 HTTPS 获取文件并比较 SHA-256；如更改 Nginx，先备份该站点配置，再 `nginx -t` 通过后重载。

这是静态占位页，尚未实现 AI、截图解析或游戏规划功能。
