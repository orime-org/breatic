# 配置参数手册(Configuration Reference)

> **MANDATORY 原则:运行参数不硬编码。** 任何「可调运行参数」(限流、产品旋钮、分页大小、超时、并发、容量上限等)必须放进 `config/*.yaml`,经 zod 校验的 loader 读入,并在本文件登记。**禁止**在代码里写死这类字面量。
>
> **判定题**:这个数字是不是「运维 / 产品可能不改代码就想调」的?是 → yaml 配置 + 本文件登记;否(纯 schema 校验边界,如字符串最大长度、数组最大条数、UUID 格式)→ 留在 zod schema 里(它就是接口契约,改它要走代码评审)。
>
> 边界示例:「每分钟允许几次请求」= 限流旋钮 → yaml;「URL 最长 2048 字符」= 校验边界 → 留 schema。

## 1. 配置机制(三类来源)

| 来源 | 放哪 | 怎么读 | 用于 |
|---|---|---|---|
| **业务 / 运行 yaml** | `config/*.yaml` | 各包 `config/*.ts` loader(zod 校验 + 首次读缓存,照 `limits.ts` 模式) | 产品旋钮 / 限流 / 分页 / 并发 / 容量等可调参数 |
| **环境变量** | `.env`(不进仓)/ 部署注入 | `@breatic/core` 的 `env` Proxy / `getConfig()`(zod schema 校验) | 端口 / 数据库 / Redis 连接串 / 密钥 / 跨域等**部署级**配置 |
| **schema 校验边界** | zod schema 内联字面量 | —— | 字符串最大长度、数组最大条数、格式约束等**接口契约**(非旋钮) |

新增可调参数流程:① 加进对应 `config/*.yaml`(带注释说明含义)→ ② 在 loader 的 zod schema 加字段(带 `.default()`)+ getter → ③ 代码经 getter 读、**不写字面量** → ④ 本文件登记。

## 2. `config/rate-limits.yaml` — 限流(Redis 滑动窗口)

loader:`packages/server/src/config/rate-limits.ts`(`getRateLimit(action)`);中间件:`rateLimitFor(action, keyBy)`。`max` = 窗口内允许请求数,`window_seconds` = 窗口秒数;key 维度(IP 还是 user)按 action 在代码里固定(安全考量),只有次数在 yaml 调。

| action | 默认 max / 窗口 | key 维度 | 用途 |
|---|---|---|---|
| `login` | 5 / 60s | IP | 登录 |
| `register` | 10 / 3600s | IP | 注册 |
| `google` | 10 / 60s | IP | Google 登录 |
| `forgot` | 3 / 3600s | IP | 忘记密码 |
| `reset` | 5 / 3600s | IP | 重置密码 |
| `reset-recovery` | 5 / 3600s | IP | 恢复码重置 |
| `verify-email` | 10 / 60s | IP | 邮箱验证 |
| `resend-verify` | 1 / 60s | IP | 重发验证邮件 |
| `slug-check` | 60 / 60s | user | studio slug 可用性检查 |
| `studio-create` | 10 / 3600s | user | 建 studio |
| `studio-update` | 30 / 3600s | user | 改 studio 名称 / slug / 简介 |
| `avatar-upload` | 20 / 3600s | user | 上传 studio 头像(每次都永久新增一个存储对象)|
| `presign` | 30 / 60s | user | 上传预签名 URL |
| `asset-report` | 120 / 60s | user | 活动流上报(`/assets/uploaded`、`/assets/deleted`) |

## 3. `config/limits.yaml` — 业务容量 + 分页

loader:`packages/server/src/config/limits.ts`。

| 参数 | 默认 | 含义 |
|---|---|---|
| `studio_member_cap` | 100 | 单 studio 活跃成员上限(共享钱包滥用护栏) |
| `project_collaborator_cap` | 100 | 单 project 显式邀请人数上限(基线 viewer 豁免不计) |
| `activity_feed_page_default` | 50 | 活动流分页:客户端不传 `?limit` 时的页大小 |
| `activity_feed_page_max` | 100 | 活动流分页:客户端 `?limit` 被裁剪到的硬上限 |
| `canvas_reference_pool_cap` | 50 | 单画布节点参考池上限(参考边 + 聚焦图合计,#1782);经 `GET /canvas/limits` 下发,前端加入时 gate(池在 Yjs,server 不 gate 协作写);区别于按模型的 `images.max_items` 执行 payload 上限(#1735)。聚焦图另受前端硬顶 `MAX_FOCUS_ENTRIES`(200,`web data/focus-images.ts`)约束——旋钮调高于 200 时聚焦图仍在 200 处被拒(带 toast) |
| `node_history_page_size` | 20 | 节点历史找回面板每页请求的行数(无限滚动,#1619);经 `GET /canvas/limits` 下发,前端取(未加载前退化用 server 默认 20) |
| `decision_window_days` | 7 | 等人答复的五件事共用的答复期限(天):studio 邀请 · project 邀请 · studio 转让 · project 转让 · 角色升级请求。**同一个数管四处**——落库的 `expires_at`、邮件链接令牌的 Redis TTL、邀请/转让邮件正文里的那句话、邀请落地页过期卡片里的天数,全部读它,任何一处都不许再写自己的数字。改这个值只影响此后新建的行,老行按当初盖的截止时间走 |

## 4. `config/collab.yaml` — Hocuspocus 协作服务

loader:`packages/collab/src/config.ts`。**只有行为参数,没有端口** —— WebSocket 端口跟另外两个服务的端口一起放在 core env schema 的 `COLLAB_PORT`(默认 1234)。同一类设置放同一处。当初端口作为普通 key 待在这份 yaml 里、只有一个 schema 默认值,**没有任何 env 能设它** —— 于是它成了四个服务端口里唯一改不了的那个,vite dev 代理只能把 1234 硬编码抄一份(#1831)。

| 参数 | 默认 | 含义 |
|---|---|---|
| `debounce` / `max_debounce` | 2000 / 10000 ms | 文档持久化防抖 |
| `max_document_bytes` | 10485760(10 MB) | 单 Yjs 文档字节上限(0 = 不限) |
| `max_connections_per_document` | 100 | 单文档跨实例连接数上限(0 = 不限) |
| `throttle_max_attempts` | 200 | 单 IP 60s 窗口内连接尝试上限,超则 ban |
| `throttle_ban_time` | 1(分钟) | ban 时长(**单位是分钟**,扩展内部乘 60×1000) |
| `handling_lease.default_budget_ms` | 3600000(1 小时) | handling 租约默认预算,超时清扫 |

## 5. `config/worker.yaml` — BullMQ Worker

loader:`packages/core/src/config/worker.ts`。

| 参数 | 默认 | 含义 |
|---|---|---|
| `concurrency` | 5 | 单 worker 并发任务数 |
| `job_attempts` | 3 | 任务失败重试次数 |
| `job_backoff_delay_ms` | 2000 | 重试退避基延时(full-jitter,自定义 backoffStrategy)|
| `lock_duration_ms` | 600000(10 分钟) | 任务锁时长 |
| `http_max_retries` / `http_retry_base_delay` | 3 / 2000 | **已无消费方**:provider HTTP 自接入 [共享 HTTP 传输层](./ARCHITECTURE.md#shared-http-transport)(第 1 批)起,重试次数与退避基数由传输层写死(3 次投递 / 1000ms 基数),这两项已无业务消费方(core 的 zod schema 仍解析它们);条目留到守卫收尾批随 sweep 一并删除 |
| `poll_interval` | 3000 | 队列轮询间隔 |

## 6. `config/storage.yaml` — 存储下载重试 + 浏览器上传

loader:`packages/core/src/config/storage.ts`。

`download.*`:`downloadValidated` 转存 provider 结果时,对瞬时失败(5xx / 429)的重试参数;退避加 full-jitter(#1625)。

| 参数 | 默认 | 含义 |
|---|---|---|
| `download.max_attempts` | 3 | 下载总尝试次数(含首次)。**接入共享传输层后删除** |
| `download.retry_base_delay_ms` | 500 | 退避基延时(× 尝试次数,再 full-jitter)。**接入共享传输层后删除** |

`upload.*`:浏览器上传旋钮(#1609 资产层片2)。前端经 `GET /assets/upload-config`(会话缓存)取;上传上限在 `/assets/presign` 权威校验(413),前端选文件时预检只为体验。

| 参数 | 默认 | 含义 |
|---|---|---|
| `upload.max_upload_bytes` | 2147483648(2 GiB)| 上传硬上限(字节);超限 presign 返 413,前端选文件当场拒 |
| `upload.client_max_attempts` | 3 | 浏览器 presign + PUT 各自总尝试次数(含首次,仅瞬时错误)。**接入共享传输层后删除** |
| `upload.client_retry_base_delay_ms` | 1000 | 浏览器重试退避基延时(full-jitter)。**接入共享传输层后删除** |
| `upload.client_request_timeout_ms` | 30000 | 浏览器 API 请求单次超时;也是 PUT 停滞守卫的下限。**接入后保留** —— 它是算给传输层的单次投递超时用的 |
| `upload.client_put_min_bytes_per_sec` | 65536 | PUT 停滞守卫速率:单次超时 = max(下限, 文件大小 / 该速率)。**接入后保留**,同上 |
| `upload.presign_expires_seconds` | 300 | 云存储(S3 / 阿里云 OSS)预签名 PUT 地址的有效期(秒)。这是存储服务商自己的 PUT 窗口,跟下发记录表无关 —— 后者不设上传时限;本地存储没有预签名地址,该项不生效 |

`avatar.*`:studio 头像。头像**不走预签名直传**,字节经服务器进来,所以这个上限同时也是单次请求在进程里缓冲的上限。头像是挂在 studio 行上的一条 URL、不是资产,**服务端不读图像内容**(不看尺寸、不看内部结构);但它仍会按字节签名认一次类型来决定存成什么扩展名和 content-type,**签名不是 PNG 的会被 415 拒掉**——所以这个字节上限是"对图片唯一的度量",不是"唯一的拒绝理由"。前端裁剪成 512×512 PNG。PNG 无损、没有质量旋钮,字节数跟画面内容走:纯色几 KB,噪点照片几乎压不动 —— 实测单帧 512×512 RGBA 最坏 1,049,473 字节(像素和 alpha 全随机),所以上限按 2 MiB 定,给最坏情况留两倍。

| 参数 | 默认 | 含义 |
|---|---|---|
| `avatar.max_bytes` | 2097152(2 MiB)| 单次头像上传字节上限;超限返 413。按 PNG 最坏情况定,见上方说明 |

## 7. `config/agent.yaml` — LLM 韧性(节选)

loader:`packages/core/src/config/loader.ts`。`config/agent.yaml` 含 MainAgent 行为 / 记忆 / 工具旋钮;韧性相关:

| 参数 | 默认 | 含义 |
|---|---|---|
| `llm_max_retries` | 2 | 每次 LLM 调用的重试次数(maxRetries),由 model-call wrapper 统一注入(#1625 Slice 3)|

## 8. 连接 / 存储上传韧性(代码内,非 yaml)

基础设施底层韧性值,硬编码在代码里(不 per-deploy 调):

| 项 | 值 | 位置 |
|---|---|---|
| Redis `keepAlive` / `commandTimeout` / `connectTimeout` / `maxRetriesPerRequest` | 30000 / 5000 / 10000ms / 3 | `core/infra/redis.ts` |
| S3 上传 `maxAttempts` / `retryMode` | 3 / `standard`(exp + jitter)| `core/infra/storage/s3.ts`(#1625)|
| Aliyun OSS 上传 | 库内部 retry(ali-oss@6 无构造 retry 选项)| `core/infra/storage/oss.ts` |
| 本地 FS 写 | 无重试(失败非瞬时)| `core/infra/storage/local.ts` |

## 9. 其他 yaml

| 文件 | loader | 内容 |
|---|---|---|
| `config/pricing.yaml` | `packages/server/src/config/pricing.ts` | 积分购买档位(Stripe test/live Price ID) |
| `config/text-tools.yaml` | `packages/server/src/config/text-tools.ts` | 文本 mini-tool 模型 + 参数 |
| `config/agent.yaml` | `packages/core/src/config/*` | MainAgent 行为 / 记忆 / 工具 / worker 限制 |

## 10. 环境变量(部署级,非 yaml)

在 `@breatic/core` 的 env schema(`packages/core/src/config/schema.ts`)里,zod 校验 + 默认值。典型:`PORT`(3000)/ 三个 healthz 端口(3001 / 1235 / 9101)/ `COLLAB_PORT`(1234)/ `DATABASE_URL` / `YJS_DATABASE_URL` / 四个 `REDIS_*_URL`(DB0-3)/ `DB_POOL_SIZE`(10)/ `ALLOWED_ORIGINS`(默认 `http://localhost:8000` = vite dev server 的 origin)/ `COOKIE_DOMAIN` 等。`PATH` / `HOME` 不入 schema(继承宿主)。

**所有数字型变量都把空值当"没设"**:`.env` 里写 `VAR=` 留空是常见写法,但 zod 会把它当成 `""` 而不是 undefined,`z.coerce.number()` 再把 `""` 变成 0,`.positive()` 就炸 —— 于是"删掉整行没事、留空就起不来",报错还是一句指不到原因的 "Too small"。schema 里统一用 `numeric()` helper 兜住(空白 → 走默认值);写错成 `abc` 仍然抛错,那是真配错、静默用默认更糟。

**`VITE_DEV_PORT` 不在这个 schema 里**(默认 8000)——它只被 `packages/web/vite.config.mts` 和 `playwright.config.ts` 经 vite 的 `loadEnv` 读,后端进程碰不到它,进 core schema 就成了后端为前端保管配置。改它必须同步改 `ALLOWED_ORIGINS`,否则浏览器 origin 对不上、所有 API 调用挂在 CORS 预检。

**`REDIS_KEY_PREFIX`(默认 = `ENV`)**:一套部署的命名空间,管的是 **DB 号和端口都隔离不了的那两样东西** —— Redis **pub/sub 频道**和 **session cookie 名**。别的一概不管。

| 管什么 | 为什么 DB 号 / 端口救不了 | 值 |
|---|---|---|
| Redis pub/sub 频道 | `SUBSCRIBE` 是实例级的、不认 `SELECT` —— 四个 `REDIS_*_URL` 的 DB 号把 session / 锁 / BullMQ / Streams 这些普通 key 全隔离了,唯独隔离不了频道 | `{prefix}:…`(见下表两族)|
| session cookie 名 | **cookie 不按端口隔离**(RFC 6265 §8.5):`localhost:3000` 和 `localhost:3010` 共用一个 cookie jar,同名 cookie 后登录的覆盖先登录的;而各自的 token 只存在自己那个 Redis DB 里,于是被覆盖的那边读到的是"查无此 session" = 静默登出 | `breatic_session_{prefix}`(`sessionCookieName()`)|

两套部署共用一台机器 / 一个 Redis 实例就必须给不同值。

**频道有两族,漏掉任何一族隔离就是半吊子**:

| 频道族 | 谁发谁收 | 传什么 | 频道名 |
|---|---|---|---|
| Hocuspocus 文档同步 | collab 实例之间 | Yjs 文档更新 | `{prefix}:hocuspocus:{docName}` |
| 控制平面 | server / worker 发,collab 收 | 成员变更、Space CRUD(**写操作**)| `{prefix}:project:{id}:*` |

**真正防串台的是「前缀后面紧跟一个字面 `:`」,不是「前缀放在最前面」**(真 Redis 实测,2026-07-27):`PSUBSCRIBE dev:*` 收不到发往 `dev-agent:project:x:...` 的消息,但 `PSUBSCRIBE dev*` **收得到** —— 分隔符才是那道墙。所以定新频道族只有一条硬规则:**通配符绝不能直接贴着前缀**。至于前缀放头还是放尾是另一个更弱的问题(`project:*:dev` 同样安全);这里放头是为了跟 Hocuspocus 频道一致 —— 它的 `prefix` 选项只会产出 `{prefix}:hocuspocus:{doc}`,没得选。「一个前缀是另一个的字符串前缀」(`dev` / `dev-agent`)这种命名确实最自然,专门的测试钉着它们互相听不见。

- 不设 / 留空 / 纯空格 → 回落 `ENV`,单 worktree 与生产**行为完全不变**(空值回落是刻意的,理由同上面的数字变量)
- **两样东西刻意不受它影响**:① 跨服务 stream key(`taskEventsStreamKey()` 等)—— server / worker / collab 三方必须字节一致,跟着 per-deployment 值走就是自找断链;② collab 的 stream **cursor key** —— cursor 必须跟它所指的 stream 同命名空间,给一个正在跑的部署改前缀会让 cursor 变成"不存在",而 `startStreamConsumer` 把找不到 cursor 当作从 `0-0` 读,等于把整条 stream 的历史事件重放一遍

**同一台机器跑多个 worktree**:上面这些默认值会全线互撞(最隐蔽的是共享 BullMQ 队列 → 一个 worktree 的任务被另一个的 worker 执行,跑在另一个的库上)。偏移方式 + 建库命令 + Google OAuth origin 的 caveat 见 `.env.dev` 顶部的 "Running several worktrees at once"。
