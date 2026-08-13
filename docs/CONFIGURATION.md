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
| `studio_member_cap` | 100 | 单 studio 活跃成员上限(共享钱包滥用护栏)。**这一项将被会员档位取代**——接上之后取值来源换成 §7.2 的 `studio_members`,这里连同 loader 里的字段一起删 |
| `project_collaborator_cap` | 100 | 单 project 显式邀请人数上限(基线 viewer 豁免不计)。**同上,将被 §7.2 的 `project_members` 取代** |
| `activity_feed_page_default` | 50 | 活动流分页:客户端不传 `?limit` 时的页大小 |
| `activity_feed_page_max` | 100 | 活动流分页:客户端 `?limit` 被裁剪到的硬上限 |
| `canvas_reference_pool_cap` | 50 | 单画布节点参考池上限(参考边 + 聚焦图合计,#1782);经 `GET /canvas/limits` 下发,前端加入时 gate(池在 Yjs,server 不 gate 协作写);区别于按模型的 `images.max_items` 执行 payload 上限(#1735)。聚焦图另受前端硬顶 `MAX_FOCUS_ENTRIES`(200,`web data/focus-images.ts`)约束——旋钮调高于 200 时聚焦图仍在 200 处被拒(带 toast) |
| `node_history_page_size` | 20 | 节点历史找回面板每页请求的行数(无限滚动,#1619);经 `GET /canvas/limits` 下发,前端取(未加载前退化用 server 默认 20) |
| `decision_window_days` | 7 | 等人答复的五件事共用的答复期限(天):studio 邀请 · project 邀请 · studio 转让 · project 转让 · 角色升级请求。**同一个数管四处**——落库的 `expires_at`、邮件正文里的那句话、决策落地页过期卡里的天数、以及任何需要「多久」而不是「到几时」的地方,全部读它,任何一处都不许再写自己的数字。代码经 `getDecisionWindowDays()` / `getDecisionWindowMs()` / `getDecisionWindowSeconds()` 读,ESLint 规则 `breatic/no-hardcoded-request-ttl` 禁止调用点自己把天数算出来(作用域 `packages/server/src/modules/**`,测试豁免;判的是算出来的**值**是不是整天数,所以换个写法绕不过去,正当的例外同行标 `request-ttl:allow` 加理由)。改这个值只影响此后新建的行,老行按当初盖的截止时间走 |

## 4. `config/collab.yaml` — Hocuspocus 协作服务

loader:`packages/collab/src/config.ts`。**只有行为参数,没有端口** —— WebSocket 端口跟另外两个服务的端口一起放在 core env schema 的 `COLLAB_PORT`(默认 1234)。同一类设置放同一处。当初端口作为普通 key 待在这份 yaml 里、只有一个 schema 默认值,**没有任何 env 能设它** —— 于是它成了四个服务端口里唯一改不了的那个,vite dev 代理只能把 1234 硬编码抄一份(#1831)。

| 参数 | 默认 | 含义 |
|---|---|---|
| `debounce` / `max_debounce` | 2000 / 10000 ms | 库自己触发存盘钩子的节奏。**#40 起那次调用落到我们这儿是空返回**(只有定时循环和卸载闸能真正写库),这两个值保留是因为调大它们不是选项 —— 存盘挂起期间 `shouldUnloadDocument` 恒为假,调大等于让每份文档都卸载不掉 |
| `store_interval_ms` | 10000 | 定时存盘间隔。**这是写库压力旋钮,不是安全旋钮** —— 正常关页面和正常重启都由卸载闸兜住,崩一个实例由别的实例兜住(它们连转发来的更新也计数、会自己写),全部实例同时断电则 2 秒和 10 秒没有区别,那一格靠救援文件加告警 |
| `store_rescue_dir` | `logs/collab/rescue` | 补传也没成时,内容写到哪。相对路径从仓库根解析;Docker 下落在挂载的 `./logs` 卷里。**永不自动清理** —— 每个文件都是某人工作的最后一份拷贝 |
| `store_alert_email` | 空 | 收告警的运维邮箱。**生产必须配** —— 没人知道的救援文件等于没有。注意 `EMAIL_BACKEND` 默认 `disabled` 且两个 env 模板都是 disabled,那种情况下告警只到日志,collab 会明说而不是静默 |
| `store_alert_timeout_ms` | 3000 | 发告警邮件的超时。**这是唯一一个超时,而且它管的不是存盘** —— 邮件传输层没配任何超时,继承 nodemailer 默认的两分钟连接超时,而卸载闸要等这封信发完。库故障期间 SMTP 又不通的话,每份正在卸载的文档都会被挂住两分钟——内存被文档填满,正是整套设计要消灭的那个故障从另一扇门进来。信里不带内容(救援文件在发信之前就已经落盘),所以放弃等它不会丢任何东西 |
| `store_alert_window_ms` | 600000(10 分钟) | 同一份文档在这个窗口内只发一封告警。一次库故障 = 每份打开的文档每轮一次失败,不去重会刷屏 |
| `max_document_bytes` | 10485760(10 MB) | 单 Yjs 文档字节上限(0 = 不限) |
| `max_connections_per_document` | 100 | 单文档跨实例连接数上限(0 = 不限)。**这一项将被会员档位取代**——接上之后取值来源换成 §7.2 的 `concurrent_editors`,这里连同 loader 里的字段一起删 |
| `max_documents_per_socket` | 1000 | 一条 socket 要能承载多少文档(= 一个 project 的 Space 数 + meta)。库里**几个**「超了就关掉整条 socket」的上限都从这一个数推导(`infra/socket-ceilings.ts`),因为只抬其中一个不算修 —— 下一个照样撞、症状一模一样。字节上限和静默超时实测远够用,故意保留库默认值 |
| `throttle_max_attempts` | 200 | 单 IP 60s 窗口内连接尝试上限,超则 ban |
| `throttle_ban_time` | 1(分钟) | ban 时长(**单位是分钟**,扩展内部乘 60×1000) |
| `handling_lease.default_budget_ms` | 3600000(1 小时) | handling 租约默认预算,超时清扫 |
| `presence_stale_after_ms` | 90000(90 秒) | 在场名单里一条「在线」记录在没人刷新的情况下还被相信多久。**meta 文档的 awareness 通道上只有心跳**(光标只在 canvas / document 这类空间文档上;meta 的 socket 上另跑着 space / tab 的 stateless RPC,走别的钩子、不碰在场状态),每个心跳都写、不做任何限流,所以两次写之间的最大间隔就等于浏览器的心跳间隔。门槛必须盖过那个间隔中最慢的一档 —— 不是页面在前台时那一档(实测 18 秒:库是「静默满 15 秒补发」,但用 3 秒一跳的定时器检查,那一跳每次都差几毫秒够不到 15 秒),而是隐藏的浏览器标签页超过 5 分钟后定时器被节流到**每分钟一次**(Chrome),而 socket 一直开着(保活的 pong 由网络层回,不跑 JS)。所以 60000 正好压在那个周期上、会让人每分钟在线离线闪一次,90000 才有余量。`presence-config.test.ts` 钉住这个关系,改小会红 |

**存盘路径上没有任何超时,这是故意的。** 存盘是一件有两个结果的事:写进去了,或者没写进去 —— 只有那次写自己说得清是哪一个。在旁边掐表取消不了任何东西,放弃等待也就得不到答案,只会凭空造出第三种状态「说不清」,而这个状态接下来会让文档被写进救援文件、让运维收到告警。这不是设想:曾经有三封这样的告警是在库健康、250 毫秒就能应答的情况下发出去的。所以定时那一轮和卸载前那一次,都等到写库给出答案为止。

**存盘只有一条路,没有第二种顺序**:一份文档要离开内存的时候先写库,写成了就完事,没写成才把内容写到磁盘、记日志、通知运维。上面那个定时存盘完全不碰磁盘 —— 它失败了什么都不用做,下一轮会把内容写进去。

## 5. `config/worker.yaml` — BullMQ Worker

loader:`packages/core/src/config/worker.ts`。

| 参数 | 默认 | 含义 |
|---|---|---|
| `concurrency` | 5 | 单 worker 并发任务数 |
| `job_attempts` | 3 | 任务失败重试次数 |
| `job_backoff_delay_ms` | 2000 | 重试退避基延时(full-jitter,自定义 backoffStrategy)|
| `lock_duration_ms` | 600000(10 分钟) | 任务锁时长 |
| `poll_interval` | 3000 | 队列轮询间隔 |

## 6. `config/storage.yaml` — 浏览器上传 + 头像

loader:`packages/core/src/config/storage.ts`。

`upload.*`:浏览器上传旋钮(#1609 资产层片2)。前端经 `GET /assets/upload-config`(会话缓存)取;上传上限在 `/assets/presign` 权威校验(413),前端选文件时预检只为体验。

| 参数 | 默认 | 含义 |
|---|---|---|
| `upload.max_upload_bytes` | 2147483648(2 GiB)| 上传硬上限(字节);超限 presign 返 413,前端选文件当场拒 |
| `upload.client_max_attempts` | 3 | 浏览器 **presign** 的总尝试次数(含首次,仅瞬时错误)。PUT 已接入共享传输层、不读它 |
| `upload.client_retry_base_delay_ms` | 1000 | 浏览器 **presign** 重试的退避基延时(full-jitter)。PUT 已接入共享传输层、不读它 |
| `upload.client_request_timeout_ms` | 30000 | PUT 停滞守卫的下限,算出来的值作为传输层的单次投递超时。**名字有误导**:它不管 presign 的超时,那个在 axios 客户端里 |
| `upload.client_put_min_bytes_per_sec` | 65536 | PUT 停滞守卫速率:单次超时 = max(上一行的下限, 文件大小 / 该速率),算出来的值作为传输层的单次投递超时。**它和上一行都有上界约束**:算出来的超时必须落在定时器能表达的范围内(2147483647 毫秒),传输层遇到超范围的值是拒收、不是夹紧。所以这两项跟 `max_upload_bytes` 一起在启动时校验,填得太低会启动失败,报错里带着当前上限下最低能填多少(2 GiB 上限时是 1001) |
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
| `thinking_enabled` | false | 要不要向 provider 索取模型的思考过程。**默认关,因为现在要了也拿不到** —— 2026-08-11 对 claude-sonnet-4-6 实测,按名字要了摘要仍然三轮零 reasoning,其中一轮的提问明写「show your reasoning step by step」。开着只会每轮白等一次、换一个空的折叠块。承载它的那条通路已经建好也测过,缺的在 provider 那一侧 |
| `skill_agent_max_steps` | 15 | worker 跑一个 skill 时的步数上限。跟 `max_tool_iterations`(主对话 40)分开:主对话有人在等、可以多轮,worker 是一个有边界的后台任务 |
| `web_fetch_timeout_ms` | 30000 | `web_fetch` **一次投递**的时长上限,不是整次抓取的:统一 HTTP 传输层最多投递 3 次,每次都拿这个数;跟着重定向走时每一跳还要再乘一遍。上界是定时器能装下的最大延迟(2147483647),超了定时器会把它悄悄改写成 1 毫秒,所以在配置加载时就拒 |
| `web_search_timeout_ms` | 10000 | 同上,给 `web_search`。它是一次请求、没有重定向,所以给得比抓网页短:搜索接口要么答要么不答,而一个网页可能因为自己的原因慢 |

## 7.1 `config/skill-routing.yaml` — 哪个 skill 能在哪儿用、谁能调

loader:`packages/core/src/config/skill-routing.ts`。这三个答案原本在各 skill 自己的 `metadata.json` 里 —— 那等于让 skill 自己声明自己的权限。搬到宿主端的配置文件有两个好处:第三方 skill 原样拿来就能用(不往它的 frontmatter 里加字段),以及路由不再取决于谁写的这个 skill。

**缺省方向按轴分开,这是关键**:

| 字段 | 不写时 | 为什么 |
|---|---|---|
| `surfaces` | `[chat, canvas]` | 这是**可见性**。开着无非多显示一个入口 |
| `user_invocable` | `false` | 这是**授权**。开着等于任何登录用户都能直接调 |
| `model_invocable` | `false` | 同上,模型能不能自己调起也是授权 |

`surfaces` 取值:`chat` · `canvas` · `image_node` · `video_node` · `document`,写错会在启动时报错而不是静默隐藏这个 skill。

**没列进这个文件的 skill,哪儿都不能用** —— 沉默从不授予任何权限。

## 7.2 `config/membership.yaml` — 会员档位的六项上限

loader:`packages/core/src/config/membership.ts`。**惰性加载**:首次被调用时才读文件跑 zod 校验,之后返回内存里那份冻结的副本——所以配置残缺是在首次用到它的那一刻抛 `ZodError`(注册写档位、或某个配额检查),不是启动那一刻。**没有任何服务入口在启动时预热它。**

把写错的文件挡在生产之外的是 CI:`packages/core/src/config/__tests__/membership.test.ts` 加载的就是仓库里这份真文件并断言它的内容,而 `config/` 随镜像构建(`Dockerfile` 的 `COPY config/`),所以改这份文件必然过一遍 CI。给所有惰性配置做统一的启动检测对自托管(他们改自己那份、不经过我们的 CI)有价值,但那要一个机制覆盖全部配置,不是给其中一份单独加一段,是另一件事。

**这个文件跟别处不同的两点,先说清楚**:

| 特点 | 说明 |
|---|---|
| **没有任何 `.default()`** | 少写一项就是首次调用那一刻抛 `ZodError`。配额悄悄回落到一个我们编的数,会让写配置的人以为自己写的那份正在生效 |
| **没有「无限制」这个概念** | 每个值都是普通的非负整数上限,判定一律 `count >= limit`,代码里没有针对特定值的分支。想表达不设限就填一个够不着的数(计数填 9999,存储填 100 TiB)。所以 `base.team_studios: 0` 就是真值零——那一档确实一个团队 studio 都不能建 |

`default_tier`:新注册账号落哪一档,**在 `createUser` 里写入**。这一个字段就是自托管部署和我们线上服务的区别,没有单独的「自托管模式」开关。数据库列另有一个 `base` 默认值,那是给迁移当时表里已有的行用的,不是新注册的兜底。

`tiers.*`:四档各六项。**前三档(`base` / `pro` / `team`)的数值来自 2026-07-30 会员分档决议,那份是权威**;`self_hosted` 不在那份决议里——它是部署形态不是价目表上的一档,数值由部署方自己填,下表那一列只是发货时给的一组够不着的默认值,随便改。

| 参数 | base | pro | team | self_hosted | 含义 |
|---|---|---|---|---|---|
| `team_studios` | 0 | 1 | 3 | 9999 | 这个账号自己能管几个团队 studio |
| `projects_per_studio` | 10 | 100 | 300 | 9999 | 每个 studio 能建几个 project |
| `concurrent_editors` | 2 | 6 | 20 | 9999 | 每个文档同时可写的**连接**数(不是人:一个人开四个标签页占四个) |
| `studio_members` | 1 | 10 | 100 | 9999 | 一个 studio 的成员上限 |
| `project_members` | 4 | 12 | 40 | 9999 | 一个 project 的成员上限 |
| `storage_bytes` | 5368709120 | 214748364800 | 536870912000 | 109951162777600 | 该账号所有 studio 的存储字节数之和的上限 |

**档位只有这四个**。产品上还有企业版(决议里的「商务谈」),它的数值一家一谈、将来从数据库读,所以既不在这个文件里、也不在档位枚举里——在这儿编一组数字,会让被设成企业版的账号拿到谁都没谈过的额度而且不报错。

**目前只有 `team_studios` 真的在拦人**,其余五项配置已就位、检查点随后续几批接上。

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
| `config/skill-routing.yaml` | `packages/core/src/config/skill-routing.ts` | 哪个 skill 能在哪个面用、用户能不能直接调、模型能不能自己调起 |

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
