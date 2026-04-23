# Fix Plan: BUG-153 — ffmpeg.wasm CDN 供应链风险

> **性质**:audit session 参考 fix 设计,非 fix PR 本身。`bugs_list` audit-only。
>
> **Severity**:P0(客户端供应链 + MITM → 浏览器任意代码执行,影响所有 video editor 用户)
>
> **Audit 记录**:[Round 6 archive § BUG-153](../2026-04-23-round-6-found.md#bug-153)
>
> **相关**:同一修复**顺带关闭** **BUG-158**(5 个 util 重复 + 假 package.json 依赖)+ 部分关闭 **BUG-160**(AbortController)

---

## 1. Bug 精确描述

5 个 `video*WithFfmpeg.ts` util 在加载 ffmpeg.wasm 核心文件时,**硬编码从 `cdn.jsdelivr.net` 动态 fetch**:

```typescript
// 5 个文件第一段完全相同(videoAdjust/videoCrop/videoCut/videoSpeed/videoStabilization)
const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const coreURL = await toBlobURL(`${ffmpegCoreBaseUrl}/ffmpeg-core.js`, 'text/javascript');
const wasmURL = await toBlobURL(`${ffmpegCoreBaseUrl}/ffmpeg-core.wasm`, 'application/wasm');
const workerURL = await toBlobURL(`${ffmpegCoreBaseUrl}/ffmpeg-core.worker.js`, 'text/javascript');
await ffmpeg.load({ coreURL, wasmURL, workerURL });
```

没有:
- SRI(Subresource Integrity)— 内容哈希校验
- CSP(Content Security Policy)限制 script/wasm 来源
- Fallback — CDN 下线整个 video editor 不可用
- 本地 bundle — `package.json:13` 声明了 `@ffmpeg/core: 0.12.6` 依赖但**代码不用本地副本**,是"假依赖"

---

## 2. 攻击路径

### 场景 A:CDN 本身被投毒(供应链攻击)

jsdelivr 历史上有过 CDN 缓存被污染事件。攻击者把 `@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js` 替换为 benign-wrapper-around-malicious-code。**所有 breatic 用户**下次打开 mixedEditor 点任意 video 编辑按钮 → 加载恶意 core.js → 执行在 WASM worker 里。

WASM worker 不是浏览器沙箱,它可以:
- `postMessage` 给主线程,主线程 `message` handler 往 Yjs map 写任意节点 → 协作者 canvas 被污染
- `fetch('/api/...', { credentials: 'include' })` 用户 cookie → 读/写项目数据
- 把用户 video/image blob 外传

### 场景 B:MITM(中间人攻击)

企业内网 / 国家级防火墙 / 公共 WiFi / 错误配置的 proxy 可以在 HTTPS 层拆包(通过下发根证书 + TLS 拦截)。虽然 HTTPS 默认防此类,但:
- 公司 MITM CA 已被用户信任(企业 IT 常做)
- CDN 证书被 compromise(历史上发生过)
- 用户在"忽略证书警告"类极端场景

攻击效果同场景 A。

### 场景 C:CDN 下线(DoS)

jsdelivr 故障 / 被 GFW 掐断 → 所有 video editor 功能完全不可用(无 fallback)。影响面:**100% video editor 用户**。

---

## 3. 根因分析

### 层 1:架构决策错误 — 使用第三方 CDN 而非本地 bundle

`@ffmpeg/core` 的 standard ship 方式是 ES module + wasm + worker.js 三个文件(~30MB)。官方 example 确实 demo 用 jsdelivr,但**生产项目都应该 bundle 进自己域**(参见 ffmpeg.wasm 官方文档 "Production" 章节)。

本项目 `package.json` 里装了 `@ffmpeg/core` 但没实际使用,说明开发者**抄了 example 代码没改**。这是典型的 demo→prod 迁移漏做。

### 层 2:5 个 util 重复定义(BUG-158)

5 个 util 都独立调用 `ffmpeg.load(...)`,每次并行可能导致 3 份下载(即使 jsdelivr 有 cache header 让浏览器只下一次,代码逻辑上是重复的)。第一次使用 adjust + 紧跟 crop → 两次 `ffmpeg.load()`,两个独立实例。

### 层 3:零 CSP — 整个应用缺 defense-in-depth

`git grep -in "csp|helmet|content.?security.?policy" packages/` 全仓 0 结果。Hono app 没有 `@hono/secure-headers` 或 `hono/csp`,nginx 也没 `add_header Content-Security-Policy`。

即使 BUG-153 修好了(本地 bundle),CSP 仍是重要 defense-in-depth,防**其他**未知的 script 注入。

---

## 4. 修复方案

### 方案 A:本地 bundle(Vite `?url` import + `public/` copy)⭐ 推荐

把 `@ffmpeg/core` 的三个 dist 文件通过 Vite 构建时 copy 到 `packages/web/public/ffmpeg/`,从自家域加载:

```typescript
// packages/web/src/utils/ffmpegClient.ts (新文件,取代 5 个 util 里的 load 逻辑)
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

// Vite 配置里把 node_modules/@ffmpeg/core/dist/esm/ copy 到 public/ffmpeg/
const FFMPEG_BASE = '/ffmpeg';

let loadPromise: Promise<FFmpeg> | null = null;

export function getFfmpeg(): Promise<FFmpeg> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    const [coreURL, wasmURL, workerURL] = await Promise.all([
      toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
    ]);
    await ffmpeg.load({ coreURL, wasmURL, workerURL });
    return ffmpeg;
  })();
  return loadPromise;
}
```

**优点**:
- **根治供应链风险** — 文件来自自家服务器,和应用同源
- 离线可用(企业内网部署)
- 消除"假依赖"(BUG-158 顺带修)
- Singleton 模式,5 个 util 共用一个 ffmpeg 实例(BUG-158 顺带修)

**缺点**:
- 首屏 bundle 大 ~30MB(wasm binary),但 public/ 路径是 lazy-load,只有用户点 video 编辑才 fetch
- Vite config 需要 copy plugin(一次性配置)

### 方案 B:保留 CDN + 加 SRI(hash 校验)

```typescript
const EXPECTED_HASHES = {
  'ffmpeg-core.js':    'sha384-AbCd...',   // 手动预计算
  'ffmpeg-core.wasm':  'sha384-EfGh...',
  'ffmpeg-core.worker.js': 'sha384-IjKl...',
};

async function secureToBlobURL(url: string, mime: string, expectedHash: string) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const actual = await crypto.subtle.digest('SHA-384', buf);
  const actualB64 = btoa(String.fromCharCode(...new Uint8Array(actual)));
  if (`sha384-${actualB64}` !== expectedHash) {
    throw new Error(`SRI mismatch for ${url}`);
  }
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}
```

**优点**:保留 CDN 流量卸载(不占自家 bandwidth);修改最小
**缺点**:
- 每次升级 `@ffmpeg/core` 要手动更新 3 个 hash(人手流程易忘记,版本漂移)
- **CDN 下线仍是 DoS**(方案 A 不受影响)
- **CDN 端 HTTPS cert 错误时仍会 fetch 失败**,比自家域脆
- 不消除"假依赖"(BUG-158 未修)

### 方案 C:自托管 CDN(S3 / CloudFront / Aliyun OSS)

把三个文件上传到 `assets.thinkai.cc/ffmpeg/v0.12.6/` 之类路径。优点是卸载主域带宽,缺点是**和方案 A 比没本质区别,多一个 moving part(CDN 配置)**。不推荐。

### 方案 D:全部走服务端 FFmpeg

改为上传视频 → worker 调系统 `ffmpeg`(已有 `video-cover.ts`)→ 回传。消除客户端 WASM 完全。

**优点**:彻底消除客户端风险
**缺点**:
- 大幅 server 负载增加(每次 adjust/crop/speed 都占一个 worker)
- 用户体验变差(上传 + 等待 vs 浏览器本地实时)
- 和 PR #134/#135 的设计意图(客户端 ffmpeg 减少 server 负载)冲突
- 改动范围远超供应链修复

不推荐。

### ⭐ 推荐:方案 A + 后续加 CSP header

**第一批 PR**:方案 A — 换 Vite 本地 bundle,解决根因
**后续独立 PR**:加全站 CSP(不在 BUG-153 scope,但值得另开 bug 追踪)

```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  connect-src 'self' https://api.stripe.com;
  img-src 'self' data: blob: https://<cdn-for-user-uploads>;
  style-src 'self' 'unsafe-inline';
```

理由(对齐 CLAUDE.md #5 "zero tolerance for patch"):
- **方案 A 根治**供应链 + DoS(CDN 下线)+ 假依赖(BUG-158)三个问题
- **方案 B 是 patch**:只修"内容可校验",不解决"CDN 下线 DoS"和"假依赖"
- **方案 C/D 是过度工程**

---

## 5. 具体改动清单

| 文件 | 行 | 改动 |
|------|-----|------|
| **新** `packages/web/src/utils/ffmpegClient.ts` | — | 单例 singleton(见方案 A 代码),导出 `getFfmpeg(): Promise<FFmpeg>` |
| `packages/web/vite.config.ts` | plugins 段 | 加 `viteStaticCopy` 插件,把 `node_modules/@ffmpeg/core/dist/esm/*.{js,wasm}` copy 到 `dist/ffmpeg/`(dev: serve 从 node_modules / plugin 直接 alias;prod: 打包 copy) |
| `packages/web/package.json` | devDependencies | 新增 `vite-plugin-static-copy`(or 等价)。注意:**`@ffmpeg/core` 从"假依赖"变"真依赖"** |
| `packages/web/src/utils/videoAdjustWithFfmpeg.ts` | 1-48 开头 | 删除 `ffmpegCoreBaseUrl` + `toBlobURL` CDN 拼接 + 独立 `ffmpeg.load()`;改为 `const ffmpeg = await getFfmpeg()` |
| `packages/web/src/utils/videoCropWithFfmpeg.ts` | 1-45 | 同上 |
| `packages/web/src/utils/videoCutWithFfmpeg.ts` | 1-58 | 同上 |
| `packages/web/src/utils/videoSpeedWithFfmpeg.ts` | 1-42 | 同上 |
| `packages/web/src/utils/videoStabilizationWithFfmpeg.ts` | 1-42 | 同上 |

**净 diff 估计**:+~80 行(ffmpegClient.ts + vite.config.ts)/ -~200 行(5 个 util 的重复 load 逻辑)= **总减少 120 行**。代码体积**减少**,攻击面消除。

---

## 6. 测试规约(spec for dev CC to implement)

### Unit

1. **`getFfmpeg()` singleton 语义**
   - Setup:调用 2 次 `getFfmpeg()`
   - Expected:两次 return 的 Promise resolve 到**同一个** `FFmpeg` 实例(`===` 比较 truthy)
   - Boundary:并发调 10 次 `getFfmpeg()` → 只触发 1 次 `ffmpeg.load()`(需要 spy + count)

2. **`toBlobURL` 调用参数**
   - Setup:mock `fetch` / `toBlobURL`,spy on URL 实参
   - Expected:3 次调用的 URL 分别是 `/ffmpeg/ffmpeg-core.js` / `.wasm` / `.worker.js`(**无 `cdn.jsdelivr.net`**)
   - Boundary:同上 + 确认无任何 http/https 开头的绝对 URL

3. **CDN 残留扫描(regression guard)**
   - Setup:全量 grep `packages/web/src` 不含任何 `jsdelivr.net` / `unpkg.com` / `cdnjs` 字符串
   - Expected:0 match
   - 实现方式:unit test 读文件 + regex 扫描,作为 CI gate

### Integration

4. **Vite build 产物验证**
   - Setup:`pnpm build` 产出 `packages/web/dist`
   - Expected:`dist/ffmpeg/ffmpeg-core.{js,wasm,worker.js}` 三文件存在
   - Boundary:dev mode(`pnpm dev`)访问 `http://localhost:5173/ffmpeg/ffmpeg-core.wasm` → 200 OK

5. **离线加载(去 CDN 依赖 regression)**
   - Setup:production build + Chrome DevTools Network 设 offline
   - Expected:加载首页 → mixedEditor → 点 crop → ffmpeg 正常加载 + 视频编辑完成
   - 实现方式:Playwright e2e with `page.route('**/cdn.jsdelivr.net/**', r => r.abort())`

6. **Bundle size 检查**
   - Expected:`dist/assets/*.js` 的 entry chunk **不含** ffmpeg-core 内容(即 ffmpeg 保持 lazy-load,不进首屏);`dist/ffmpeg/*.wasm` 存在为独立 asset

### Monitoring / Regression

7. **CSP header 存在性**(后续 CSP PR 合入后)
   - Setup:生产环境 `curl -I https://www.thinkai.cc/`
   - Expected:响应头含 `Content-Security-Policy`,且 `script-src` 不含 `cdn.jsdelivr.net`

---

## 7. 部署风险

| 风险 | 评估 |
|------|------|
| **Bundle 体积变化** | wasm binary ~30MB 挪进 `public/ffmpeg/`。**不进首屏**(`public/` 不自动打入 JS chunks);只在用户点 video 工具时 lazy-fetch 一次。首屏无影响,首次 video 编辑的感知体验 = 之前走 CDN 差不多(浏览器 cache 后同) |
| **依赖变化** | `@ffmpeg/core` 从"假依赖"变"真依赖";删除 `cdn.jsdelivr.net` 的运行时 dep。上 CI 看 `pnpm install` + 构建是否干净 |
| **向后兼容** | 无破坏。所有用户的 first-use-after-deploy 会 fetch `public/ffmpeg/`(新域);cache miss 一次,之后同 |
| **FFmpeg 版本锁** | 之前硬编码 `@0.12.6` 是 runtime URL,无法 tree-shake 或版本协调;现在走 package.json,`pnpm up` 能正常升级 |
| **Docker / 部署** | `packages/web/dist` 挂进 nginx 静态 serve → nginx 自动能 serve `public/ffmpeg/*`。无需 nginx config 改动(除非要给 wasm 加 `Content-Type`,但现代 nginx 默认识别) |
| **测试环境** | Vitest 里 `import.meta.url` 在 jsdom 默认 `about:blank`,需要 mock 或 `node:fetch`(已有 mock pattern 不会有新工程量) |

---

## 8. 相关 context

- **BUG-158**(P1 MED,Round 6):5 个 ffmpeg util 重复 boilerplate + `@ffmpeg/core` 装了不用 + 无 init mutex。**本 PR 顺带关闭**(singleton + `public/ffmpeg/` 消除 3 个问题)
- **BUG-160**(P2 LOW,Round 6):ffmpeg.wasm 无 AbortController。本 PR **部分涉及**(singleton 初始化可以加 AbortSignal,但 5 个 tool 的 job-level abort 另外处理)
- **CSP 缺失**:全仓无 CSP,属于 systemic 问题。建议**独立 bug(可能编 BUG-177 / 178)追踪**,本 PR 不 scope 扩大
- **方案 A 与 PR #140 精神对齐**:PR #140 的 mixedEditor Yjs-first 重写也是"删 1071 行 Redux 换架构级正确",不加 band-aid。本修复方案 A 同样(删 5 份重复 + 消除 CDN → 架构级正确)

---

## 9. 回归检查(修完后 BUGS.md 更新建议)

PR 合入后,audit session 核查时:

- [ ] `git grep 'cdn.jsdelivr' packages/` 返回 0 结果 → BUG-153 ✅ 可关
- [ ] `git ls-tree origin/main packages/web/src/utils/ffmpegClient.ts` 存在 → BUG-158 ✅ 可关(singleton 落地)
- [ ] 5 个 `video*WithFfmpeg.ts` 文件的 `ffmpeg.load()` 调用消失 → 确认 singleton pattern 落地
- [ ] PR body 明确说明"CSP 留给独立 PR"→ 否则审计 note CSP 状态未变

---

**提交渠道**:本文件在 `bugs_list` 分支 `docs/internal/audit/fix-plans/` 目录,merge 进 main 后 dev 可以参考。
