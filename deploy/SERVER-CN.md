# 私有服务器与域名部署

[English](SERVER.md) | **简体中文**

适用：将同一套 Breatic 镜像部署到组织内部服务器、VPN 内服务器，或只供明确私密群体使用的服务器，通过固定域名访问。个人电脑和局域网安装见 [LOCAL.md](LOCAL-CN.md)，源码调试见 [DEVELOPMENT.md](DEVELOPMENT-CN.md)。

## 1. 先明确访问范围

以仓库 [LICENSE](../LICENSE) 第 1 条为准：

- 允许个人使用、非公开招募或开放注册的私密群体，以及同一组织内部使用。
- 未经另行授权，不允许向公众提供 Breatic 平台，**免费和收费都不允许**。
- 服务器放在哪里、有没有域名，不等于是否向公众开放。服务器指南不授予额外部署许可。

本指南以 VPN / 私有网络限制访问为默认前提。若主机有公网 IP，在网络边界限制主站访问，只允许目标组织或私密群体连接。应用本身的登录页不等于部署范围受限，因为可达的注册入口仍可能接受陌生用户。需要面向公众提供平台时，先联系 [licensing@orime.ai](mailto:licensing@orime.ai) 获取相应授权。

## 2. 与本机部署相同的部分

镜像、数据库、迁移、Ingest 和 R2 的工作方式与本机部署完全相同。先完成 [LOCAL.md 第 2–4 节](LOCAL-CN.md) 的软件、版本、Cloudflare 正式发布和配置准备，**在启动主站前**按下文替换访问地址和证书。不要启动本地 Wrangler，不使用 `8787`。

可在管理员电脑上发布 Cloudflare；服务器运行主站仅需 Docker/Compose 和部署文件，不需要持续运行 Node/pnpm。源码、前后端镜像和 Ingest 必须来自同一版本。

## 3. 域名、DNS 和证书

假设你控制的域名是 `canvas.example.net`，将其 DNS 记录指向客户端通过私有网络可达的服务器地址。确认客户端先连接 VPN，再能解析并访问该地址。示例域名需要替换为自己的域名，不要因使用本项目而注册违反 LICENSE 商标条款的域名。

准备与该域名匹配的受信 HTTPS 证书：

- 组织内部可以使用组织 CA，确保客户端已经信任。
- 使用公共 CA 时，可通过其 DNS 验证流程取得证书，不必为验证而将应用向公众开放。申请和自动续期方式按组织所用证书工具配置。

将 PEM 完整证书链放到 `docker/certs/cert.pem`，对应私钥放到 `docker/certs/cert.key`。限制私钥读取权限，不提交到 Git。Nginx 会保留访问域名，不强制添加 `www`；只给实际要使用的域名配置 DNS、证书和来源白名单。

证书文件由管理员维护，项目不会自动申请或续期。配置到期监控、定时续期和续期后的 `docker compose restart web`，不要等证书过期才处理。

## 4. 主站和云端统一来源

主站 `.env`：

```dotenv
WEB_BIND_ADDRESS=0.0.0.0
ENV=prod
COOKIE_DOMAIN=
ALLOWED_ORIGINS=https://canvas.example.net
PAYMENT_ENABLED=false
EMAIL_BACKEND=smtp
SMTP_HOST=YOUR_SMTP_HOST
SMTP_PORT=587
SMTP_USER=YOUR_SMTP_USER
SMTP_PASSWORD=YOUR_SMTP_PASSWORD
SMTP_FROM=YOUR_SENDER_ADDRESS
```

将 SMTP 占位替换为有效值。如果明确不需要真实邮件，可选择 `EMAIL_BACKEND=disabled` 并使用注册时提供的恢复码；不要误认为 disabled 会发送重置邮件。Google OAuth、支付等按模板另行配置，不是本流程必需项。

`WEB_BIND_ADDRESS` 也可以填写服务器的 VPN / 内网网卡 IP，以限制监听网卡。主机防火墙和上游安全组只允许目标网络连接 80/443；不要把数据库、Redis 或 API 端口开放给用户。

Ingest 的 `INGEST_BASE_URL` 使用自己的正式 HTTPS 地址。将其 `[env.production.vars].ALLOWED_ORIGINS` 设置为 `https://canvas.example.net` 并重新发布。R2 CORS 的 `AllowedOrigins` 设置为 `["https://canvas.example.net"]`。长期运行使用资产自定义域名作为 `UPLOAD_BASE_URL`，并核对其 CORS 响应。

**注意：私有主站访问限制不会自动保护公开 R2 资产 URL。** 当前存储读取模式不能宣称是私密文件托管；如果组织要求文件必须经过身份验证才能读取，当前配置不满足该要求，不能靠调整 CORS 获得访问控制。

## 5. 首次启动和验收

完成上述配置后，在仓库根目录：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps -a
docker compose logs --tail=100 migrate
```

迁移服务退出 0，其他常驻服务正常后，通过 **https://canvas.example.net** 注册和使用。按 [LOCAL.md 第 6 节](LOCAL-CN.md) 完成登录、上传、裁剪、视频封面、协作、AI 生成和持久化验收。

此外检查：

- [ ] VPN / 组织内的另一台设备能正常使用，浏览器没有证书警告。
- [ ] 非目标网络访问不到主站；检查的不只是登录页面。
- [ ] 浏览器 WebSocket 协作和聊天流式回复正常。
- [ ] 真实邮件配置时，重置密码邮件实际送达。
- [ ] 资产域名可从用户网络和服务端正常访问，CORS 来源正确。

主站直接由本仓库 Nginx 终止 HTTPS 是本文唯一入口方案。如果已有额外反向代理，需要单独验证代理的 WebSocket、SSE、来源头和证书配置，不要将两套 HTTPS 重定向规则盲目叠加。

## 6. 运维要求

沿用 [LOCAL.md 的备份和升级流程](LOCAL-CN.md)，并增加：

- 定期备份业务库、Yjs 库、R2 文件与配置，保存配套的镜像 digest 和 Ingest 版本；做隔离恢复演练。
- 监控磁盘、数据库连接、容器健康、模型调用错误、Cloudflare 容器状态及证书到期。
- Docker 标记 `unhealthy` 不会自动重启进程；`restart: unless-stopped` 只处理进程退出与重启策略，健康失败需要告警和处理。
- 发布前等待任务完成、暂停用户写入，再迁移数据库并升级配套组件。迁移后的回滚需要考虑数据兼容，不仅是改镜像标签。
- 在外层访问范围确定之前，不向公众开放注册。新增成员应符合本实例的许可使用范围。

完成上述验收后，再将该实例交给实际用户。
