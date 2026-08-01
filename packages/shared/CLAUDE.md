# @breatic/shared — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**web + 后端共用**的纯协议层:zod schema · 类型 · 常量 · 跨服务事件契约的数据格式 · **统一 HTTP 传输层**(`http/`)与退避原语(`backoff.ts`)。

## 统一 HTTP 传输层(`src/http/`,#36 2026-07-30)
全项目**唯一**一处带重试的 HTTP:worker 的 provider 调用 · agent 的联网工具 · 浏览器上传全走它。判据在 `decide-retry.ts` 一处,分两层知识:**协议语义归传输层**(429/408 = 对方没处理 → 无条件重;其他 4xx = 请求本身的问题 → 永不重)· **应用语义由调用方声明**(`replaySafe`:再送一遍这个请求会不会产生第二次副作用 —— 只有调用方知道 `POST /predictions` 会多花一次 vendor 的钱)。**`replaySafe` 是事实陈述不是重试偏好**,别为「让它更可靠」到处开 true。重试次数(首次 + 2)与退避基数写死在 `http/constants.ts`、**故意不做配置**(原先 worker 和浏览器各配一份、已漂移成两种含义);per-attempt 超时仍是参数(不同 vendor / 不同文件大小天然不同)。判定题:**我要加的重试参数,是「各场景天然不同」还是「统一一个答案更安全」?后者 → 写死,别开旋钮。**

**等待多久由对方定,上限只用来判断等不等(user 2026-08-01 拍板)**:对方在 `Retry-After` 里报了时间,要么**照它说的等**,要么**根本不等、直接失败并把这个数交回上层**;中间那个「截断成我们自己的数」是错的 —— 它等于假装遵守了一个谁都没同意的约定。上限只做这一个判断:调用方声明 `interactive` 就用 10 秒(有人在屏幕前等)、不声明就用 60 秒。**对方没说话时才轮到我们自己估**(指数退避,唯一允许编数字的地方);报了一个已经过去的时间 = 没有可用指令,同样回到自己估。判定题:**这个等待秒数是对方给的还是我编的?对方给的 → 要么照办要么终止,不许改数字。**

**读 body 有自己的两道闸**:**空闲期限**(`bodyIdleTimeoutMs`,量的是 chunk 之间的静默而不是总时长 —— 500 MB 慢慢来不算故障,发完响应头就装死才算)+ **字节上限**(`maxBodyBytes`,按 chunk 到达时拦,流式读同样受管)。字节上限**默认不开**:绝大多数调用方自己选 URL、自己知道会拿回多大。判定题:**这个请求的 URL 是我们自己定的吗?不是(模型给的 / 外部给的)→ 必须设字节上限**,因为「拿回来之后再截断」截的是已经进内存的东西,拦不住任何事。

**传输层不交出裸 `Response`**,交的是带守卫的句柄(`GuardedResponse`):暴露 `ok` / `status` / `headers` / `retryAfterMs`(对方报的等待时间,已解析)+ 四个读方法。**它没有「丢弃不读」的成员,这是故意的** —— 于是拿到句柄却不读、也不取消,就跟握着一个没读的 `Response` 一样占着连接。判定题:**我拿到句柄后有没有可能一口都不读就返回?**(典型是非 200 直接返回)**有 → 把它读掉再走**,那是唯一的放手方式。

**它也不写日志**(library 边界),失败经 `onEvent` 交给应用层。判定题:**我这个调用方给 `onEvent` 了吗?没给 → 这条路上的重试对运维完全不可见。**

## 进本包判定题
web **用得到**吗?用得到 → `shared`;用不到 → `core`。

## 可 import 谁
- ✅ 外部 npm(必须**浏览器安全**:零 `node:*` / `fs` / `async_hooks`,`sideEffects: false`)
- ❌ `@breatic/core` / `@server` / `@worker` / `@collab` / `@web` —— 一个都不行(shared 是最底层)
- 本包内部用 `@shared/*` 前缀

## 暴露啥
**单入口** `src/index.ts`(`tsup` 全 bundle),不开多 subpath 入口(多入口会把 `@shared/*` 泄漏进 dist)。

## 怎么拿配置
不拿。shared 是纯数据/类型层,不读配置、不读 `process.env`、不写日志。

## 守卫
`breatic/no-relative-import`(走别名)· repo-lint 的 `no-unresolved-alias-in-dist`(dist 不漏别名)· `breatic/no-library-env-access`(零 `process.env`)· `breatic/no-library-logger`(零 logger)。
