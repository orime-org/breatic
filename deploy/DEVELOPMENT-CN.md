# 开发环境搭建

[English](DEVELOPMENT.md) | **简体中文**

本文面向修改源码、调试或提交贡献的开发者。只想安装使用，请阅读 [个人与局域网部署](LOCAL-CN.md)。命令默认在仓库根目录执行；标明“另一个终端”的命令请另开窗口执行。

**本文采用源码运行方式**：Node.js 运行应用，Docker 运行 PostgreSQL、Redis 和上传服务需要的媒体容器，Wrangler 在本机运行上传 Worker。访问入口是 `http://localhost:8000`，不需要域名和 HTTPS 证书，也不需要先部署 Cloudflare Worker。

**这不是离线部署**：当前存储实现依赖真实 Cloudflare R2；AI 功能需要对应供应商的账户、密钥和可用额度。应用在本机，文件存储和模型调用仍经过外部服务。未配置这些服务时，页面可能打开，但不代表完整运行。

## 1. 准备软件和账户

| 准备项 | 要求 / 用途 |
| --- | --- |
| Git | 获取代码；也可以下载并解压完整源码 ZIP |
| Node.js | 使用 22.x，与仓库 Docker 构建主版本一致 |
| pnpm | **9.15.0**，与根目录 `packageManager` 一致；不要直接使用其他全局版本 |
| Docker | Docker Engine / Docker Desktop，并带 Compose v2；必须已启动 |
| FFmpeg | 本机需能运行 `ffmpeg` 和 `ffprobe`；后台视频工具使用它们，媒体容器内的 FFmpeg 不能代替本机安装 |
| Cloudflare | 开通 R2，准备一个专用于本地试用的 bucket 和该 bucket 的读写凭据 |
| AI 供应商 | 文本聊天可配置 OpenRouter；图片、视频等需要所选模型对应供应商的密钥 |

macOS / Linux 使用终端。Windows 使用 WSL2 的 Linux 终端，并启用 Docker Desktop 对该 WSL 发行版的集成；Node、pnpm、FFmpeg 和源码都放在同一 WSL 环境中。以下不是 PowerShell 命令。

先安装上述软件，再检查：

```bash
node --version
npm install --global pnpm@9.15.0
pnpm --version
docker version
docker compose version
ffmpeg -version
ffprobe -version
```

应看到 Node `v22...`、pnpm `9.15.0`，且 `docker version` 同时有 Client 和 Server 信息。若全局安装提示权限错误，先修正 Node 安装目录权限或使用用户级 Node 版本管理器，再执行安装。

## 2. 下载代码并准备环境文件

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
cp .env.dev .env
pnpm install --frozen-lockfile
```

若使用 ZIP，先解压，再进入**含 `package.json` 和 `pnpm-workspace.yaml` 的目录**，从 `cp .env.dev .env` 开始。若仓库要求登录，使用有访问权限的 GitHub 账户下载。

后续只编辑 `.env`，保留 `.env.dev` 作为模板。不要使用 `.env.docker`：它的服务地址供容器内部使用，不适用于本文在本机启动的 Node 进程。已有 `.env` 时不要再次复制覆盖。

打开 `.env`，核对以下项目。每个变量只保留一个定义；把模板中的示例密钥替换成自己的值，不使用的供应商密钥清空，不能保留假密钥，否则可能被当成已配置的服务。

```dotenv
ENV=dev
COOKIE_DOMAIN=
PORT=3000
COLLAB_PORT=1234
SERVER_HEALTH_PORT=3001
WORKER_HEALTH_PORT=9101
COLLAB_HEALTH_PORT=1235
VITE_DEV_PORT=8000
ALLOWED_ORIGINS=http://localhost:8000
DATABASE_URL=postgres://breatic:breatic@localhost:5432/breatic
YJS_DATABASE_URL=postgres://breatic:breatic@localhost:5432/breatic_yjs
REDIS_URL=redis://localhost:6379/0
REDIS_QUEUE_URL=redis://localhost:6379/1
REDIS_STREAM_URL=redis://localhost:6379/2
REDIS_COLLAB_URL=redis://localhost:6379/3
REDIS_KEY_PREFIX=local-breatic
PAYMENT_ENABLED=false
EMAIL_BACKEND=console
```

`PAYMENT_ENABLED=false` 关闭站内支付和对应扣费检查，**不会免除外部 AI 服务费用**。`EMAIL_BACKEND=console` 将邮件内容输出到本机日志，不投递真实邮件；邮箱密码注册可用，不需要 Google OAuth。恢复码请在注册时自行保存。

本文假设本机只有一套 Breatic。需要空闲端口：`5432`、`6379`、`3000`、`3001`、`1234`、`1235`、`9101`、`8000`、`8787`。如果已有其他实例，先停止自己不再使用的实例，不要让新实例误连已有业务数据。多实例隔离说明见 `.env.dev` 文件头。

## 3. 配置 R2 文件存储

1. 登录 Cloudflare，进入 R2，创建一个本地试用 bucket，例如 `breatic-local-yourname`。不要使用已有生产 bucket。
2. 在 R2 API Tokens 中创建限定到该 bucket 的 **Object Read & Write** 凭据，保存 Access Key ID、Secret Access Key 和账户的 S3 API endpoint。这对凭据不同于 Wrangler 登录凭据。
3. 在 bucket 的设置中启用 **Public Development URL**，取得形如 `https://pub-....r2.dev` 的地址，作为本地试用的公开读取入口。此设置使文件可通过公开链接读取，勿上传私密资料。
4. 在 bucket 的 CORS 设置中填入下面规则并保存：

```json
[
  {
    "AllowedOrigins": ["http://localhost:8000"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

这条 CORS 规则用于浏览器读取图片并进行画布裁剪。上传发送到 Ingest Worker，由下一节的 `ALLOWED_ORIGINS` 控制；两处都要配置。

在根目录 `.env` 中填写：

```dotenv
STORAGE_PROVIDER=r2
R2_BUCKET=breatic-local-yourname
R2_ACCESS_KEY=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_KEY=YOUR_R2_SECRET_ACCESS_KEY
R2_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
UPLOAD_BASE_URL=https://pub-YOUR_PUBLIC_BUCKET_ID.r2.dev
INGEST_BASE_URL=http://localhost:8787
INGEST_SHARED_SECRET=YOUR_GENERATED_SECRET
```

上述 `YOUR_...` 都要替换。`R2_S3_ENDPOINT` 使用控制台提供的 S3 endpoint，`UPLOAD_BASE_URL` 使用公开读取地址，不能互换；两个地址均不带末尾 `/`。

生成一次上传共享密钥：

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

把输出填入 `.env` 的 `INGEST_SHARED_SECRET`，并保留用于下一节。不要把密钥提交到 Git。

Cloudflare 官方操作说明：[R2 公开访问](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)。

## 4. 选择上传服务

如果不修改上传服务，可以按 [使用部署指南](LOCAL-CN.md#cloudflare) 正式部署它，将根目录 `.env` 的 `INGEST_BASE_URL` 指向其 HTTPS 地址，共享密钥保持一致，并将 `http://localhost:8000` 加入正式 Worker 与 R2 的 CORS。不要创建本机 `wrangler.toml`，这样 `pnpm dev` 会略过本地 Ingest；这种情况下略过是预期行为，按实际 HTTPS 地址验收上传。

只有要修改、调试 Ingest 时，继续下面的本地步骤，使用 `8787`。

### 配置本地上传和媒体处理服务

```bash
cp packages/ingest/wrangler.toml.template packages/ingest/wrangler.toml
cp packages/ingest/.dev.vars.template packages/ingest/.dev.vars
pnpm --filter @breatic/ingest exec wrangler login
pnpm --filter @breatic/ingest exec wrangler whoami
```

在浏览器完成授权，确认登录的是创建 R2 bucket 的账户。多账户用户在 `wrangler.toml` 顶部设置 `account_id = "你的账户 ID"`。

编辑 `packages/ingest/wrangler.toml`，替换模板里**所有**尖括号占位内容。即使只运行本地服务，也不能保留 production 部分的无效 TOML 数字占位符。

| 位置 | 本次本地运行填写值 |
| --- | --- |
| 顶层 `[[r2_buckets]]` 的 `bucket_name` | 与根目录 `.env` 的 `R2_BUCKET` 完全相同 |
| 顶层 `[[r2_buckets]]` 的 `remote` | 保留 `true` |
| 顶层 `[[containers]]` 的 `max_instances` | 整数 `5`，不加引号 |
| `[dev]` 的 `port` | 整数 `8787` |
| `[vars]` 的 `ALLOWED_ORIGINS` | `"http://localhost:8000"` |
| `[env.production.vars]` 的 `ALLOWED_ORIGINS` | 此次可先填 `"http://localhost:8000"`，使模板值完整 |
| `[[env.production.r2_buckets]]` 的 `bucket_name` | 此次可先填同一本地试用 bucket 名 |
| `[[env.production.containers]]` 的 `max_instances` | 整数 `5` |

保留两个 `image_build_context = "../.."`，以及模板原有的 `compatibility_date`、Durable Object 绑定和 `exports` 设置。production 部分仅补齐模板，**本文不执行 `deploy:worker`**；正式部署上传服务时，按 [Cloudflare 部署步骤](LOCAL-CN.md#cloudflare) 单独配置云端资源。

编辑 `packages/ingest/.dev.vars`：

```dotenv
INGEST_SHARED_SECRET=YOUR_GENERATED_SECRET
```

必须与根目录 `.env` 中刚生成的密钥完全相同。`.dev.vars` 不放 bucket、端口或 CORS 配置。

`remote = true` 表示本机 Worker 写入真实 R2。去掉它会写进本地模拟存储，而应用仍用公开 R2 地址读取，导致文件无法显示。相关机制见 [Cloudflare R2 Worker 本地运行说明](https://developers.cloudflare.com/r2/get-started/workers-api/)。

## 5. 配置需要使用的 AI 功能

在 `.env` 中填写自己的 `OPENROUTER_API_KEY`，并确认该账户有可用额度、能访问配置中的模型。当前文本模型路由会优先使用已配置的厂商直连密钥，否则走 OpenRouter；不准备使用的 `OPENAI_API_KEY`、`GOOGLE_API_KEY`、`ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 请留空。

图像、视频、音频、语音和 3D 不由一个文本密钥全部覆盖。根据界面准备使用的模型，查看 `config/models/<类型>/providers.yaml` 中的 `api_key_env`，在 `.env` 填写那个变量。例如使用 WaveSpeed 对应的模型就配置 `WAVESPEED_API_KEY`。不需要的模型供应商可以不配置，对应功能不作为本次验收项。

Google 登录、真实 SMTP 邮件、Stripe 支付和 Brave 搜索是独立可选集成，不是启动前置条件。需要这些功能时，再按 `.env.dev` 对应配置段提供凭据；不要通过打开 `PAYMENT_ENABLED` 来解决 AI 供应商额度问题。

## 6. 启动数据库并执行两套迁移

根目录 `.env` 已存在后执行：

```bash
docker compose up -d postgres redis
docker compose ps postgres redis
```

等待两个服务都显示 `healthy`。这里只启动指定的两个服务，**不要去掉 `postgres redis`**，否则会启动另一套 GHCR 镜像部署。

首次创建空数据卷时，仓库初始化脚本会创建 `breatic` 和 `breatic_yjs` 两个数据库。核对：

```bash
docker compose exec postgres psql -U breatic -d postgres -c '\l'
```

若使用的是较早建立的数据卷，列表里没有 `breatic_yjs`，仅在确认缺失时执行：

```bash
docker compose exec postgres psql -U breatic -d postgres -c 'CREATE DATABASE breatic_yjs;'
```

先构建迁移脚本依赖的包，再迁移：

```bash
pnpm exec turbo run build --filter=@breatic/core...
pnpm db:migrate
pnpm db:check-watermark
```

`pnpm db:migrate` 应先报告业务数据库迁移完成，再报告 Yjs 迁移完成，最终退出成功；水位检查也应退出成功。若只执行 `pnpm install` 就迁移，会因为尚无 `packages/core/dist/index.js` 而失败。

这是新数据库的步骤。已有历史数据的升级应先备份；如果检查涉及历史迁移时间戳问题，先运行 `pnpm db:journal-repair` 阅读报告，再决定修复，不要直接对已有数据库试改迁移记录。

## 7. 启动整个应用

保持 Docker 运行，在仓库根目录执行：

```bash
pnpm dev
```

这个命令持续运行，请保持终端打开。它会先构建依赖包，再启动前端、API、后台 Worker、协作服务和 Ingest Worker。Ingest 首次启动需要下载基础镜像并构建媒体容器，耗时取决于网络和机器性能。

如果使用第 4 节的本地 Ingest 模式却看到 `ingest Worker: no wrangler.toml here`，返回第 4 节补齐配置；使用已部署 Ingest 的开发者则无需启动本地 Worker。不要使用 `--enable-containers=false`，否则无法验收视频媒体信息和封面。

打开 **http://localhost:8000**，全程使用 `localhost`，不要混用 `127.0.0.1`，否则 cookie 和 CORS 来源会不同。注册自己的账号，完成个人 Studio / 标识设置，然后创建项目。没有预设的通用管理员账号，也没有免登录模式。

## 8. 验收：怎样判断真正跑通

在另一个终端进入同一仓库，检查：

```bash
curl --fail http://localhost:3001/healthz
curl --fail http://localhost:9101/healthz
curl --fail http://localhost:1235/healthz
curl --fail --output /dev/null http://localhost:8000
curl --fail -i -X OPTIONS http://localhost:8787/ \
  -H 'Origin: http://localhost:8000' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: x-upload-token,content-type'
```

使用已部署 Ingest 的开发者应把上面的 `http://localhost:8787/` 换成自己的正式 Ingest 地址。前三项应返回 HTTP 200，前端应可访问，上传预检应成功且带允许 `http://localhost:8000` 的 CORS 响应头。预检只能证明上传入口可达且允许该网页来源，不验证密钥、R2 绑定或实际写入；这些由后续真实上传检查。

继续在浏览器完成以下检查：

- [ ] 注册、退出、重新登录正常；能创建并重新打开项目。
- [ ] 在同一项目中创建一个 Document Space 和两个 Canvas Space，分别命名并切换。在文档中写一段剧本，在两个画布中分别添加内容；刷新后确认各 Space 的内容独立保留。
- [ ] 在两个标签页中打开同一个 Space，一边编辑，另一边能同步；刷新后内容仍在。分别检查 Canvas Space 和 Document Space。
- [ ] 上传一张图片，能显示；刷新后仍能显示，并能完成一次图片区域裁剪。
- [ ] 上传一个短视频，能看到封面并正常播放，媒体信息正常。
- [ ] 使用已配置的文本模型发送一次聊天，收到完整回复。
- [ ] 使用已配置的生成模型完成一次任务，结果出现在画布上，刷新后仍可见。

只有实际完成相关检查，才能称该功能可用。健康检查通过不代表 R2、模型密钥或余额有效。

开发者还可以安装浏览器测试依赖并运行默认检查，保持 `pnpm dev` 在另一终端运行：

```bash
pnpm typecheck
pnpm test
pnpm --filter @breatic/web exec playwright install chromium
pnpm --filter @breatic/web test:smoke
pnpm --filter @breatic/web test:visual
```

Linux 缺浏览器系统库时可按 Playwright 提示安装系统依赖。两套浏览器测试依次运行，不能并行。默认套件排除需要真实模型、存储等外部资源的场景，不能替代上面的手工验收。详见 [测试说明](../docs/TEST-MANDATE.md)。

## 9. 停止、再次启动和更新

停止应用：在 `pnpm dev` 终端按 `Ctrl+C`。再停止本仓库的数据库容器：

```bash
docker compose stop postgres redis
```

再次启动：

```bash
docker compose up -d postgres redis
pnpm dev
```

以下启停只影响本机进程；正式部署的 Cloudflare Worker 不会随之停止。数据库保存在 Docker 的命名卷，文件保存在 R2，停止进程不等于删除数据。不要使用 `docker compose down -v`，它会删除本项目的数据库卷。改动 `.env` 或 Ingest 配置后，停止并重新运行 `pnpm dev`。

更新前停止应用并备份两个数据库；下面使用不重复的时间戳文件名，数据库容器须运行：

```bash
mkdir -p backups
backup_stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U breatic -Fc breatic > "backups/breatic-${backup_stamp}.dump"
docker compose exec -T postgres pg_dump -U breatic -Fc breatic_yjs > "backups/breatic_yjs-${backup_stamp}.dump"
```

确认命令成功，备份另存到安全位置，不提交到 Git；这两份备份不包含 R2 文件。Git 下载的用户继续执行：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@breatic/core...
pnpm db:migrate
pnpm db:check-watermark
pnpm dev
```

ZIP 用户需下载新版本并保留自己的 `.env`、Ingest 配置与密钥；仓库目录名变化会改变默认 Compose 项目名，应保持目录位置和名称一致，避免误以为旧数据消失。升级后重复第 8 节验收。数据库迁移后不能仅靠切回旧代码保证回滚。

## 10. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| `pnpm` 报 overrides / patches 被忽略，或锁文件不兼容 | `pnpm --version` 必须为 9.15.0；不要删除锁文件或升级依赖来绕过 |
| Docker 只有 Client、无法连接 daemon | 启动 Docker Desktop / Engine；WSL 检查 Docker 集成 |
| `address already in use` | 检查第 2 节端口，停止冲突实例；改端口时同步修改应用、Ingest 和两处 CORS |
| `core/dist/index.js` 不存在 | 先执行第 6 节共享包构建命令 |
| `breatic_yjs` 不存在 / 表或列不存在 | 核对两个数据库地址，按第 6 节建缺失库、执行两套迁移和水位检查 |
| 数据库密码不匹配 | 已有数据卷保留创建时的密码；修改模板不会修改已有数据库用户密码 |
| Wrangler 配置解析失败 | 清除所有尖括号占位，尤其两处 `max_instances` 和 `[dev].port`；数字不加引号 |
| Wrangler 无权访问 R2 | 检查 `wrangler whoami`、账户 ID、bucket 名与登录账户；R2 S3 token 不能代替 Wrangler 授权 |
| 上传返回 401 | 两处 `INGEST_SHARED_SECRET` 必须相同；修改后重启 |
| 上传跨域失败 | Ingest `[vars].ALLOWED_ORIGINS` 精确匹配网页来源，无末尾 `/` |
| 文件上传后 404 / 图片不显示 | 检查 `remote=true`、两处 bucket 名一致、公开访问已启用以及 `UPLOAD_BASE_URL` 正确 |
| 图片显示但裁剪失败 | 检查 R2 公开读取的 GET CORS，不能只配置 Ingest 上传 CORS |
| 视频无封面 / 媒体容器构建失败 | 查看 `pnpm dev` 的 Ingest 输出，检查 Docker、镜像下载和 `image_build_context`，不能禁用容器 |
| 视频工具提示找不到 ffmpeg / ffprobe | 在运行 `pnpm dev` 的同一终端检查二者可执行 |
| AI 功能报密钥、余额或权限错误 | 检查所选模型对应 provider、真实额度，清空未使用的假密钥；查看 API / Worker 日志 |
| 登录后又回到登录页 | 保持 `ENV=dev`、`COOKIE_DOMAIN` 为空，统一使用 `localhost:8000` |
| 收不到邮件 | `console` 模式只打印日志；真实投递需配置 `EMAIL_BACKEND=smtp` 和 SMTP 参数 |

排查基础设施日志：`docker compose logs --tail=100 postgres redis`。应用日志首先看 `pnpm dev` 终端及 `logs/`。分享日志前去掉密钥、cookie 和签名上传令牌。
