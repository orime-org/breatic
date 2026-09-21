# 个人与局域网部署

[English](LOCAL.md) | **简体中文**

适用：自己使用，或分享给家庭、私密小组、同一组织内的同事。主站安装在一台电脑上，其他人通过浏览器访问这台电脑。**使用发布镜像，不启动源码开发服务器。** 修改源码请看 [开发环境](DEVELOPMENT-CN.md)，有私有服务器和域名请看 [服务器指南](SERVER-CN.md)。

[LICENSE](../LICENSE) 允许个人、非公开招募的私密群体及组织内部使用；未经另行授权，不能向公众提供 Breatic，收费和免费都不允许。局域网部署也应限定到自己的授权使用群体。

## 1. 部署完成后是什么样

```text
本机 / 局域网浏览器 → 主机 Nginx → API、协作服务、后台任务
                                     ↓ PostgreSQL + Redis
浏览器上传 ────────→ 已部署的 Cloudflare Ingest Worker → R2
API / 后台任务 ────→ Ingest Worker / AI 供应商
```

主机上通过 Docker Compose 运行应用及数据库。Ingest Worker 和媒体容器正式发布到**你自己的 Cloudflare 账户**，不会因为你关闭部署终端而停止。主机和浏览器都要能连接上传服务和文件读取地址。

这不是离线部署：存储依赖 R2，生成依赖外部模型。无需为了日常使用运行 `pnpm dev`、`wrangler dev` 或监听 `8787`。安装阶段目前仍需用 Node/pnpm/Wrangler 发布一次云端组件，这是部署操作，不是开发调试。

## 2. 准备条件和版本

- 主机安装并启动 Docker Engine / Docker Desktop，带 Compose v2。当前核对的 GHCR `main` 前后端镜像只发布了 `linux/amd64`：本安装路径以 x86-64 主机为基线（Linux、Intel Mac 或 x86-64 Windows/WSL2）。Apple Silicon / ARM 主机不能据此视为原生支持，需等待配套 ARM 镜像或单独验证模拟运行；不要直接照用并期望 Docker 自动解决架构问题。Windows 在启用 Docker Desktop 集成的 WSL2 终端执行命令。
- 能访问 GitHub、GHCR、Docker 镜像源、Cloudflare 和所需模型服务。
- Cloudflare 账户已开通 R2，并具备 Containers 使用资格。按 [Cloudflare 前置条件](https://developers.cloudflare.com/containers/get-started/) 确认账户计划及计费。
- 准备自己的模型 API 密钥和额度。至少配置文本模型才能使用 AI 聊天，媒体生成还需对应供应商。
- 发布云端组件的机器安装 Node.js 22.x 和 pnpm 9.15.0。它可以是应用主机，也可以是另一台电脑；构建媒体容器时 Docker 必须运行。
- 单机首次体验使用 `http://localhost`；局域网共享使用固定内网 IP 和所有客户端信任的 HTTPS 证书，见第 7 节。

检查：

```bash
docker version
docker compose version
node --version
npm install --global pnpm@9.15.0
pnpm --version
```

Docker 应有 Server 信息，Node 应为 `v22...`，pnpm 应为 `9.15.0`。当前仓库没有经过验证的硬件最低配置承诺；启动后用 `docker stats` 检查内存和 CPU，按实际并发和媒体任务增加资源。

下载完整仓库并进入根目录：

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
cp .env.docker .env
```

也可以下载源码 ZIP，进入同时包含 `docker-compose.yml`、`Dockerfile` 和 `package.json` 的目录。后续命令均在仓库根目录执行。已存在 `.env` 时不要覆盖。

**版本要配套**：主站前后端镜像、Ingest 源码和部署配置应来自同一发布版本。`BREATIC_TAG` 指定两个主站镜像的标签；选发布标签前确认两个镜像均已发布，不要自行猜版本号。`main` / `latest` 是持续变化的分支镜像，适合体验，不能代替可复现的发布版本。若暂用分支镜像，保存实际 digest 和源码提交；配置更新不会自动改变已发布镜像里的内容。

## 3. 配置主站

打开 `.env` 编辑原有条目，每个键只定义一次。首次仅本机 HTTP 使用：

```dotenv
BREATIC_TAG=main
WEB_BIND_ADDRESS=127.0.0.1
ENV=dev
COOKIE_DOMAIN=
ALLOWED_ORIGINS=http://localhost
PAYMENT_ENABLED=false
EMAIL_BACKEND=console
REDIS_KEY_PREFIX=personal
```

这里的 `ENV=dev` 是现有代码中允许 HTTP 会话 cookie 的运行配置，**不表示启动开发服务器**；容器仍运行编译产物。切换 HTTPS 后使用 `ENV=prod`。支付关闭不会免除外部模型费用；`console` 邮件只输出日志，不投递真实邮件。真实邮件、Google 登录、Stripe 和搜索可按模板另行配置。

保留容器内部连接地址：

```dotenv
DATABASE_URL=postgres://breatic:breatic@postgres:5432/breatic
YJS_DATABASE_URL=postgres://breatic:breatic@postgres:5432/breatic_yjs
REDIS_URL=redis://redis:6379/0
REDIS_QUEUE_URL=redis://redis:6379/1
REDIS_STREAM_URL=redis://redis:6379/2
REDIS_COLLAB_URL=redis://redis:6379/3
```

**不能把这些地址改成 `localhost`**：在应用容器里，localhost 是容器自身。保留模板里的应用内部端口。主站默认只监听本机；数据库、Redis 和 API 的主机端口也只绑定回环地址，不向局域网开放。局域网用户只通过 Nginx 访问。

供应商密钥必须替换为自己的有效值；不使用的密钥留空。配置 `OPENROUTER_API_KEY` 可以为未配置厂商直连密钥的文本模型提供调用入口，具体仍受模型可用性和账户额度限制。图像、视频等按 `config/models/<类型>/providers.yaml` 的 `api_key_env` 配置；例如 WaveSpeed 对应模型需要 `WAVESPEED_API_KEY`。

<a id="cloudflare"></a>
## 4. 正式部署 Cloudflare 上传服务

### 4.1 创建存储和公开读取入口

在 Cloudflare R2 创建专用 bucket，例如 `creator-assets-personal`，并创建限定到该 bucket 的 **Object Read & Write** S3 凭据。保存 Access Key ID、Secret Access Key 和 S3 endpoint。不要共用另一套实例的生产 bucket。

在 bucket 设置中启用 Public Development URL，取得 `https://pub-....r2.dev`，供本机试用读取文件。这个地址名称里的 Development 不表示运行本地 Worker；它是 Cloudflare 提供的公开读取入口。长期稳定使用应绑定自己的资产域名，`r2.dev` 有使用限制，见 [公开 bucket 文档](https://developers.cloudflare.com/r2/buckets/public-buckets/)。

当前资产通过公开 URL 读取；Breatic 实例私有并不自动使 R2 文件私有。不要把需要私密访问控制的素材放入这套公开读取配置。

在 bucket 的 CORS 设置中保存：

```json
[
  {
    "AllowedOrigins": ["http://localhost"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

R2 的 GET CORS 用于读取、裁剪图片；上传 Worker 另有一份来源配置，两者都要维护。操作参考 [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)。

### 4.2 准备正式发布配置

在发布机器的同版本仓库中执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @breatic/ingest exec wrangler login
pnpm --filter @breatic/ingest exec wrangler whoami
```

确认登录到 bucket 所在账户。**创建** `packages/ingest/wrangler.toml`，使用以下仅供正式部署的配置，替换账户 ID 和 bucket 名。文件已被 Git 忽略；如果原来用于开发，先备份它，不要把开发配置和本配置合并。

```toml
name = "creator-ingest-config"
main = "src/index.ts"
compatibility_date = "2026-03-10"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"

[env.production]
name = "creator-ingest-personal"
workers_dev = true

[env.production.vars]
ALLOWED_ORIGINS = "http://localhost"

[[env.production.r2_buckets]]
binding = "BUCKET"
bucket_name = "creator-assets-personal"

[[env.production.containers]]
class_name = "MediaContainer"
image = "./Dockerfile"
image_build_context = "../.."
max_instances = 5

[[env.production.durable_objects.bindings]]
name = "MEDIA"
class_name = "MediaContainer"

[env.production.exports.MediaContainer]
type = "durable-object"
storage = "sqlite"
```

同一 Cloudflare 账户安装多套实例时，为每套使用不同的 production `name`、bucket 和密钥；不要覆盖已有 Worker。正式配置没有 `[dev].port`、`remote=true` 或 `.dev.vars`。

生成一份随机共享密钥并安全保存：

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

设置到 Cloudflare，命令提示时粘贴刚生成的值：

```bash
pnpm --filter @breatic/ingest exec wrangler secret put INGEST_SHARED_SECRET --env production
pnpm --filter @breatic/ingest deploy:worker
```

首次设置 secret 若询问是否创建尚不存在的 Worker，确认名称是你本次的新实例后创建。首次发布会构建并上传媒体容器，最后输出 Worker HTTPS 地址。使用输出的实际地址，例如 `https://creator-ingest-personal.YOUR_SUBDOMAIN.workers.dev`，不要猜账户子域名。有关发布行为见 [Cloudflare Containers 部署说明](https://developers.cloudflare.com/containers/guides/deploy/)。

如果账户未开通 Containers、镜像构建或发布失败，先解决错误；不要通过禁用媒体容器来宣称上传链路完整。

### 4.3 连接主站

在应用主机根目录 `.env` 填写：

```dotenv
STORAGE_PROVIDER=r2
R2_BUCKET=creator-assets-personal
R2_ACCESS_KEY=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_KEY=YOUR_R2_SECRET_ACCESS_KEY
R2_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
UPLOAD_BASE_URL=https://pub-YOUR_PUBLIC_BUCKET_ID.r2.dev
INGEST_BASE_URL=https://creator-ingest-personal.YOUR_SUBDOMAIN.workers.dev
INGEST_SHARED_SECRET=YOUR_GENERATED_SECRET
```

替换全部 `YOUR_...`。共享密钥必须与刚设置到 Cloudflare 的完全相同，bucket 必须一致；公开读取地址和 S3 endpoint 不能互换，URL 不带末尾 `/`。不要把密钥提交到仓库。

Cloudflare Worker 不需要回调你的本机主站，因此个人使用不需要端口映射、内网穿透或公网主站域名。

## 5. 启动主站

确认第 3、4 节已完成，主机的 80、443、5432、6379、3000 端口没有被其他服务占用，再执行：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps -a
docker compose logs --tail=100 migrate
```

启动顺序是基础设施健康 → 迁移两个数据库 → API / 协作 / 后台任务 → Web。`migrate` 成功退出（`Exited (0)`）是正常状态；它不是常驻服务。其他服务应处于运行状态，API、collab、worker、postgres、redis 应健康。

用浏览器打开 **http://localhost**，注册自己的账号、保存恢复码并完成个人 Studio 设置。首次迁移失败时不要绕过 `migrate` 启动应用。

如果原有 PostgreSQL 数据卷缺少第二个数据库，在确认不存在后执行：

```bash
docker compose exec postgres psql -U breatic -d postgres -c '\l'
# Only when breatic_yjs is absent:
docker compose exec postgres psql -U breatic -d postgres -c 'CREATE DATABASE breatic_yjs;'
docker compose up -d
```

已有数据库密码由初次初始化决定，后改模板不会修改数据库用户密码。

## 6. 完整验收

- [ ] `docker compose ps -a` 显示迁移退出 0、所有常驻服务运行且探针健康。
- [ ] 注册、退出、登录成功，能创建并重新打开项目。
- [ ] 在同一项目中创建一个 Document Space 和两个 Canvas Space，分别命名并切换。在文档中写一段剧本，在两个画布中分别添加内容；刷新后确认各 Space 的内容独立保留。
- [ ] 上传图片，刷新后仍显示，并完成一次裁剪。
- [ ] 上传短视频，得到封面、媒体信息且能播放。
- [ ] 在两个标签页或两位获授权用户的浏览器中打开同一个 Space，一边编辑另一边同步；分别检查 Canvas Space 和 Document Space。
- [ ] 使用已配置的文本模型收到回复；使用一个已配置的媒体模型完成生成，结果保存在画布上。
- [ ] 重启应用后，项目、上传素材和生成结果仍然可读。

这里没有本机 `8787` 验收项。主站探针健康也不代表云端存储和模型已经可用，必须做真实上传与生成。

## 7. 让局域网内其他人访问

使用同一套容器，不需要每位用户安装应用。先给主机固定一个内网 IP，例如 `192.168.1.50`。其他设备不能用 `localhost` 访问它，因为那会指向设备自己。

### 7.1 配置可信 HTTPS

局域网 IP 的 HTTP 页面不享有 localhost 的安全上下文例外，剪贴板等浏览器能力会受限。局域网使用可信 HTTPS，不把“忽略证书警告”当作完成配置。

家庭或小团队可以按 [mkcert 官方安装说明](https://github.com/FiloSottile/mkcert) 安装 mkcert，使用本地 CA：

```bash
mkcert -install
mkdir -p docker/certs
mkcert -cert-file docker/certs/cert.pem -key-file docker/certs/cert.key localhost 127.0.0.1 ::1 192.168.1.50
mkcert -CAROOT
```

将示例 IP 换成主机实际固定 IP。`mkcert -install` 只使当前电脑信任 CA，其他客户端也要按其操作系统/浏览器要求安装并信任该目录里的 **`rootCA.pem`**，随后验证浏览器无证书警告。**不要分发 `rootCA-key.pem` 或站点私钥。** 组织环境应使用组织签发且客户端已信任的证书。证书必须包含实际访问的 IP / 域名，地址变化时重新签发。

### 7.2 同步访问地址

主站 `.env` 改为：

```dotenv
WEB_BIND_ADDRESS=0.0.0.0
ENV=prod
COOKIE_DOMAIN=
ALLOWED_ORIGINS=https://192.168.1.50,https://localhost
```

`0.0.0.0` 监听主机所有 IPv4 网卡；在主机防火墙中仅允许可信局域网访问 80/443，不做路由器公网端口转发。如果只需一个网卡，也可以将 `WEB_BIND_ADDRESS` 设为该网卡内网 IP。

在 `wrangler.toml` 的 `[env.production.vars]` 中把 `ALLOWED_ORIGINS` 更新为同样的来源列表并重新执行 `pnpm --filter @breatic/ingest deploy:worker`。同时把 R2 CORS 的 `AllowedOrigins` 更新为这两个 HTTPS 来源。域名、协议和端口要精确一致，没有末尾 `/`，不需要把每位用户电脑的 IP 加进去。

让容器读取新 `.env`，并让 Nginx 重新选择证书配置：

```bash
docker compose up -d --force-recreate server collab worker web
```

所有人访问 **https://192.168.1.50**。在第二台电脑上重复第 6 节的登录、上传、裁剪和协作验收。证书续期后执行 `docker compose restart web`；修改 `.env` 要重建相关容器，仅 `restart` 不会重新读取 Compose 环境变量。

## 8. 日常运行、备份与升级

停止：`docker compose stop`。再次启动：`docker compose up -d`。Docker 及主机需要持续运行；睡眠时局域网用户无法访问。停止本机不会停止云端 Worker，也不会删除 R2 文件。

不要执行 `docker compose down -v`：它会删除数据库卷。不要随意更换仓库目录名或 Compose 项目名，否则会连接一套新的空卷。

升级前先让用户退出、等待进行中的生成完成，再停止应用写入并备份两个数据库：

```bash
docker compose stop web server worker collab
mkdir -p backups
backup_stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U breatic -Fc breatic > "backups/business-${backup_stamp}.dump"
docker compose exec -T postgres pg_dump -U breatic -Fc breatic_yjs > "backups/yjs-${backup_stamp}.dump"
```

确认每个命令成功，另行保存 `.env`、云端配置/密钥、证书、源码版本、两个镜像 digest 和 R2 文件备份。数据库备份不含 R2 对象或队列中的未完成任务；不要在任务执行中声称获得一致性快照。`backups/` 不应提交到 Git。

读取目标版本的升级说明，取对应源码和配置，保留自己的配置；发布配套 Ingest 后修改 `BREATIC_TAG`，再执行：

```bash
docker compose pull
docker compose up -d
docker compose ps -a
```

重复第 6 节验收。回滚涉及数据库时，应在停止应用后恢复**配套的两个数据库、应用版本、Ingest 版本及配置**；只切换旧镜像不能保证兼容。首次恢复请在隔离实例验证备份，不覆盖仍在使用的数据。

## 9. 排错

| 现象 | 处理 |
| --- | --- |
| 镜像不存在或没有匹配的平台 | 确认前后端标签均存在且发布支持该 CPU 架构；不要用不同版本混搭，也不要声称未发布架构受支持 |
| Web 502 / 启动失败 | `docker compose logs --tail=100 web server collab`；核对 API 服务名为 `server`，镜像是否与当前源码版本匹配 |
| migrate 非零退出 | 查看 migrate 日志，检查两个库、凭据、版本和迁移文件；不要绕开迁移依赖 |
| 本机可打开，别的设备打不开 | 检查主机 IP、`WEB_BIND_ADDRESS`、防火墙、主机休眠及客户端证书信任 |
| HTTPS 登录循环 | 使用受信证书，`ENV=prod`，`COOKIE_DOMAIN` 留空，统一访问地址 |
| 上传 401 | 主站与 Cloudflare 的共享密钥不一致；重新配置并重建主站容器 |
| 上传跨域失败 | 更新正式 Worker 的来源并重新发布；局域网地址不能仍填写 localhost |
| 图片 404 或裁剪失败 | 核对 R2 bucket、公开读取地址和 GET CORS；上传 CORS 无法代替读取 CORS |
| 视频无封面 | 检查 Cloudflare 媒体容器发布、运行及日志，不要禁用容器 |
| AI 报错 | 核对所选模型供应商、密钥、额度及网络；站内支付开关不解决供应商问题 |
| 收不到邮件 | console 只写 `docker compose logs server`；真实发送需 SMTP |

Cloudflare 日志可在发布机器运行 `pnpm --filter @breatic/ingest exec wrangler tail --env production` 查看。分享日志前删除密钥、cookie 和签名令牌。
