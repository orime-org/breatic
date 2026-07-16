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
| `canvas_reference_pool_cap` | 50 | 单画布节点参考池上限(参考边 + 聚焦图合计,#1782);经 `GET /canvas/limits` 下发,前端加入时 gate(池在 Yjs,server 不 gate 协作写);区别于按模型的 `images.max_items` 执行 payload 上限(#1735) |

## 4. `config/collab.yaml` — Hocuspocus 协作服务

loader:`packages/collab/src/config.ts`。

| 参数 | 默认 | 含义 |
|---|---|---|
| `port` | 1234 | 协作 WebSocket 端口 |
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
| `http_max_retries` / `http_retry_base_delay` | 3 / 2000 | provider HTTP 重试(full-jitter)|
| `poll_interval` | 3000 | 队列轮询间隔 |

## 6. `config/storage.yaml` — 存储下载重试 + 浏览器上传

loader:`packages/core/src/config/storage.ts`。

`download.*`:`downloadValidated` 转存 provider 结果时,对瞬时失败(5xx / 429)的重试参数;退避加 full-jitter(#1625)。

| 参数 | 默认 | 含义 |
|---|---|---|
| `download.max_attempts` | 3 | 下载总尝试次数(含首次)|
| `download.retry_base_delay_ms` | 500 | 退避基延时(× 尝试次数,再 full-jitter)|

`upload.*`:浏览器上传旋钮(#1609 资产层片2)。前端经 `GET /assets/upload-config`(会话缓存)取;上传上限在 `/assets/presign` 权威校验(413),前端选文件时预检只为体验。

| 参数 | 默认 | 含义 |
|---|---|---|
| `upload.max_upload_bytes` | 2147483648(2 GiB)| 上传硬上限(字节);超限 presign 返 413,前端选文件当场拒 |
| `upload.client_max_attempts` | 3 | 浏览器 presign + PUT 各自总尝试次数(含首次,仅瞬时错误)|
| `upload.client_retry_base_delay_ms` | 1000 | 浏览器重试退避基延时(full-jitter)|
| `upload.client_request_timeout_ms` | 30000 | 浏览器 API 请求单次超时;也是 PUT 停滞守卫的下限 |
| `upload.client_put_min_bytes_per_sec` | 65536 | PUT 停滞守卫速率:单次超时 = max(下限, 文件大小 / 该速率)|

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

在 `@breatic/core` 的 env schema(`packages/core/src/config/schema.ts`)里,zod 校验 + 默认值。典型:`PORT`(3001)/ 三个 healthz 端口 / `DATABASE_URL` / `YJS_DATABASE_URL` / 四个 `REDIS_*_URL`(DB0-3)/ `DB_POOL_SIZE`(10)/ `ALLOWED_ORIGINS` / `COOKIE_DOMAIN` 等。`PATH` / `HOME` 不入 schema(继承宿主)。
