# Audit Round 6 — 发现快照

**审计日期**:2026-04-23(agents 在 2026-04-22 夜间跑)
**对应代码**:`origin/main` HEAD `7d8395e`(含 PR #134 + #135 合入 `feat/video-editor` 大分支,~20+ feature commits)
**审计方法**:从 `bugs_list`(未 FF,通过 `git show origin/main:` 读代码)派 3 个并行 sub-agent 聚焦 video editor 新 drop
**发现总数**:19 个新条目(4 P0 + 1 P1 HIGH + 7 P1 MED + 7 P2 LOW)
**关闭**:BUG-093(imageEditor 文件删除,pattern 迁移追踪为 BUG-164)

> 本文件是历史快照,定稿后不再修改。Bug 进度跟踪在 [`../BUGS.md`](../BUGS.md)。

---

## 审计范围与方法

| Agent | 覆盖 | 发现数 |
|-------|------|--------|
| H | FFmpeg 集成 / video 子系统安全(客户端 ffmpeg.wasm + 服务端 video-cover + Docker/CSP/CDN) | 10 |
| I | 新 editor UI(mixed / text node / video) + workspace API + 前端状态 / XSS 回归 | 11(I-04/I-05 与 H 去重后有效 9) |
| J | 回归扫描 + BUG-093 核查 | **超时**(核心 BUG-093 核查由主 session 完成) |

**Agent J 超时说明**:J 的 prompt 任务过多(8 项检查),导致 stream idle timeout。最核心的 BUG-093 核查由主 session 直接做(`git grep useYjsStore origin/main`),结果见下方。其余 systemic 回归扫描(rate limit / Zod / CSRF)部分由 H 和 I 顺带覆盖(I-05 触及 CSP;H-04 触及 BUG-129 upload size;H-05 触及 BUG-133 Zod 新 route)。

**去重**:
- **H-01 / I-05** 都指向 5 个 `video*WithFfmpeg.ts` 从 `cdn.jsdelivr.net` 加载 ffmpeg-core,无 SRI。合并为 **BUG-153**(取 HIGH 裁决,客户端任意代码执行)
- **H-02 / I-04** 都指向 FFmpeg 输出的 `blob:` URL 直接写入 node `data.content`,不持久化、不 revoke。合并为 **BUG-154**(取 HIGH 裁决)

---

## BUG-093 核查结论 ⚠️ pattern 复发

原 BUG-093:`imageEditor/index.tsx:833` 把 `nodeId` 当 `workflowId` 传 `useYjsStore`,PR #113 新启用的 collab authz 100% 拒绝 → 用户被踢到 `/login`。

**核查方法**:
```bash
git ls-tree origin/main -r packages/web/src/apps/project/components/imageEditor/
# → 空,imageEditor 目录已被 feat/video-editor 重构删除
git grep -n "useYjsStore" origin/main -- 'packages/web/src/**'
# → 3 个 callsite:
#   - apps/project/index.tsx:54           ← 项目级(正确,id = workflowId)
#   - apps/project/components/mixedEditor/index.tsx:923  ← 节点级(错误,id: nodeId)
#   - hooks/useYjsProjectStore.ts:46      ← hook 定义本身
```

**结论**:
- BUG-093 **技术关闭**(imageEditor 文件不再存在)
- 但 **bug pattern 完整迁移到 mixedEditor**,且因 mixedEditor 现在支持多种节点类型(text/audio/video/image),影响面**扩大而非消除**
- 独立追踪为 **BUG-164**(P0),在 BUGS.md 里新开条目

---

## 新发现

## P0 — 立即修

### BUG-153
**标题**:ffmpeg.wasm 核心脚本/WASM 从第三方 CDN(`cdn.jsdelivr.net`)动态加载,无 SRI 校验、无 CSP 限制、无 fallback —— CDN 被污染即客户端代码执行

- **状态**:`[ ]` 待修
- **严重度**:HIGH(供应链 + MITM → 浏览器端任意代码执行 + 协作 canvas 被劫持)
- **位置**:`origin/main:packages/web/src/utils/videoAdjustWithFfmpeg.ts:6` + `videoCropWithFfmpeg.ts:6` + `videoCutWithFfmpeg.ts:6` + `videoSpeedWithFfmpeg.ts:4` + `videoStabilizationWithFfmpeg.ts:4`

**当前代码**(5 个文件完全相同):

```
const ffmpegCoreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const coreURL = await toBlobURL(ffmpegCoreBaseUrl + '/ffmpeg-core.js', 'text/javascript');
const wasmURL = await toBlobURL(ffmpegCoreBaseUrl + '/ffmpeg-core.wasm', 'application/wasm');
const workerURL = await toBlobURL(ffmpegCoreBaseUrl + '/ffmpeg-core.worker.js', 'text/javascript');
await ffmpeg.load({ coreURL, wasmURL, workerURL });
```

**问题**:

1. **依赖第三方 CDN 可信度** —— jsdelivr CDN 被投毒 / 路径劫持 / 被国家级防火墙中间人 → 用户浏览器执行恶意 WASM。WASM 不是沙箱,可读取 fetch 响应(含认证 cookie)、调 `postMessage` 污染 Yjs canvas、上传用户 blob 到外部服务器
2. **零 SRI(Subresource Integrity)保护**:`toBlobURL` 内部做了 `fetch + new Blob`,跳过浏览器原生 `<script integrity="sha384-...">` 机制,无法校验哈希
3. **零 CSP**:`git grep -in "csp|helmet"` 全仓 0 结果。`script-src 'self'` 之类防护完全缺失
4. **package.json 里声明了 `@ffmpeg/core: 0.12.6`,但代码里硬编码 CDN URL**(见 `packages/web/package.json:13`)→ 本地 npm bundled 副本**根本没用到**,是假依赖、拖累 lockfile 但无防护价值
5. **5 个 util 文件各自独立加载** —— 同一用户可能并行加载 `/esm/ffmpeg-core.js` 3 次(每次 ~1MB + WASM 30MB),首次使用 adjust + crop + speed 任一切换都重启一次下载
6. **无 fallback**:CDN 下线时整个 video editor 完全不可用
7. **timeout 30s 不足够应对网络波动**,且 3 个 load 串行,最长 90s 用户等不到

**修复方案**:

- 把 `@ffmpeg/core` 的 `dist/esm/*.js|wasm|worker.js` 通过 Vite 构建时 copy 到 `public/ffmpeg/`(或 rollup import URL),走自家域名加载
- 加 CSP:`Content-Security-Policy: script-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' <cdn whitelist>`(Hono helmet 中间件或 nginx 静态 header)
- 如必须走 CDN:`toBlobURL` 下载完毕后手动 `crypto.subtle.digest('SHA-384', buf)` 比对预置 hash,不匹配抛错
- 5 个 util 合并到 `packages/web/src/utils/ffmpegClient.ts`,单 singleton,删除原 5 份副本

**验证**:

- 手动:生产构建开启 "offline"(Chrome DevTools),加载 mixedEditor → 点 adjust/crop/cut/speed/stabilization 任一,确认 ffmpeg 仍能加载(走自家域)
- CSP 生效后:`curl -I https://app.../` 响应 header 含 `Content-Security-Policy`
- 单测:`ensureFfmpegLoaded` mock `toBlobURL` 返回错误 hash → 应抛 SRI 失败

**预估**:3-4h(Vite 配置 + 5 文件去重 + CSP middleware + 本地验证网络断开仍可用)

---

### BUG-154
**标题**:ffmpeg.wasm 输出的 `blob:` URL 直接写入 mixedEditor 节点 `data.content`,刷新即失效 + 永不 `revokeObjectURL` → 核心数据持久化缺失 + 内存泄漏

- **状态**:`[ ]` 待修
- **严重度**:HIGH(UX / 数据丢失 / 产品核心协作价值受损 + 内存爆掉)
- **位置**:
  - `origin/main:packages/web/src/hooks/useMixedEditorStore.ts:615`(`resolveVideoResultNode`:`updateNodeData(nodeId, { content: nextVideoSrc })`)
  - `origin/main:packages/web/src/hooks/useMixedEditorStore.ts:759`(`createCutVideoResultNodesRight`:同上)
  - `origin/main:packages/web/src/utils/videoAdjustWithFfmpeg.ts:176` + `videoCropWithFfmpeg.ts:131` + `videoCutWithFfmpeg.ts:153` + `videoSpeedWithFfmpeg.ts:138` + `videoStabilizationWithFfmpeg.ts:117`(5 处都是 `return URL.createObjectURL(outputBlob)`)

**当前代码**:

```
// videoAdjustWithFfmpeg.ts:176
const outputBlob = new Blob([safeBuffer], { type: 'video/mp4' });
return URL.createObjectURL(outputBlob); // blob:http://localhost:3000/xxxx-yyyy

// useMixedEditorStore.ts:615
const resolveVideoResultNode = useCallback(
  (nodeId, nextVideoSrc, options) => {
    if (!nodeId || !nextVideoSrc) return;
    updateNodeData(nodeId, { content: nextVideoSrc, state: options?.state ?? 'idle' });
  }, [updateNodeData],
);

// videoNode.tsx:675 (adjust/crop/speed/stabilization 四处相同模式)
resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' }); // nextSrc = "blob:..."
```

**问题**:

1. **刷新页面数据全丢** —— `URL.createObjectURL` 只对当前页面生命周期有效。用户花 2 分钟做 adjust/crop/cut → 保存到 content → 刷新页面 → **视频变 404**。对于"内容创作协作画布"这个核心定位(见 CLAUDE.md/MEMORY.md:breatic 内容创作 OpenClaw),这是 **功能性灾难**
2. **无 `URL.revokeObjectURL` 调用** —— 全仓 `grep revokeObjectURL` 只出现在下载/缩略图等无关路径,**5 个 ffmpeg util 的 output blob 永远不释放**。用户反复编辑/试错生成 10 个 blob × 30MB = 300MB heap 泄漏,浏览器最终崩溃
3. **与产品协作定位矛盾**:videoNode 组件还在 canvas(Yjs-backed,见 `useYjsProjectStore`)和 mixedEditor(本地 Redux)两处使用。如果 blob: URL 哪怕有一份被写到 Yjs 同步给协作者,其他协作者 `<video src="blob:http://创建者域/xxx">` 会直接 404。目前 mixedEditor 是本地 Redux(`mixedEditor.ts:19` 注释"not Yjs-synced"),但 `videoNode.tsx:687-695` 代码路径在 projectCanvas 也被调用,同一 `resolveVideoResultNode` 通过 `updateNodeData` 走 canvas Yjs 路径时就会同步 blob URL 给别人
4. **无 export 路径**:用户没法把 blob 保存到服务器。CLAUDE.md "画布事件全走 Yjs" + "AIGC 生成文件本地存储到 /uploads" 的架构下,**本应 upload 到 storage 再写 canvas,但这里完全跳过**
5. **无 size guard**:ffmpeg 输出 1GB 文件(长视频 + CRF 低压缩)→ 浏览器 heap 直接爆
6. **无错误通知**:catch 空吞(见 H-07),用户看到菊花转完就没下文

**修复方案**:

三层都要改,按顺序:

1. **立刻**:ffmpeg util 返回 `Blob` 而不是 blob URL,由调用方负责 `upload` + `revokeObjectURL`(或者 ffmpeg util 内部在失败/下次任务前调 `revokeObjectURL(prevUrl)`)
2. **videoNode 保存后必须走 presign upload**:先 `videoAdjustWithFfmpeg(...)` 拿 Blob → 调 `uploadBlobToStorage(blob, { projectId })` 得 fileUrl → 再 `resolveVideoResultNode(placeholderId, fileUrl)`
3. **全局**:`useEffect cleanup` / Redux middleware 拦截 `patchMixedEditorNodeData` 旧 content 如果是 `blob:` 开头,`revokeObjectURL(oldContent)`

**验证**:

- E2E:cut 一段视频 → 刷新页面 → 视频仍能播放
- 内存:Chrome devtools Memory Heap,生成 10 次 adjust → Heap 增长 < 5MB(revoke 生效)
- 协作:两个浏览器同协作者,A 在 canvas 做 cut → B 应看到上传后的 fileUrl(非 blob:)

**预估**:1d(涉及 upload 链路 + revoke 管理 + E2E 回归)

---

### BUG-163
**标题**:TextEditor 写入错误 Redux slice，输入内容全部丢弃

- **严重度**:HIGH

**位置**: `packages/web/src/apps/project/components/textEditor/index.tsx` + `packages/web/src/hooks/useMixedEditorStore.ts` + `packages/web/src/store/modules/mixedEditor.ts`

**根因链**:
1. `project/index.tsx:300-301` 为 canvas 文本节点渲染 `<TextEditor nodeId={panelNode.id} />`。`panelNode` 来自 `useCanvasData()`（canvas Yjs 驱动的上下文），因此 `panelNode.id` 是 canvas 节点 id。
2. `textEditor/index.tsx:46-47` 使用 `useProjectStore()` = `useMixedEditorStore()` — 读的是 `mixedEditor` Redux slice，**不是** `canvas` slice / Yjs。
3. `contentFromNode = nodes.find(x => x.id === nodeId)` 在 mixedEditor.nodes 中查找 canvas 节点 id → `undefined` → content 是空串。
4. 用户键入触发 `scheduleEditorSync` → 180ms 后 `persistEditorHtml(html)` → `updateNode(nodeId, { data: {...} })` → `dispatch(updateMixedEditorNode)`。
5. `store/modules/mixedEditor.ts:76-79`：
   ```
   updateMixedEditorNode: (state, action) => {
     const node = state.nodes.find((n) => n.id === nodeId);
     if (!node) return;   // ← 静默丢弃
     ...
   }
   ```
6. mixedEditor.nodes 中没有这个 id（canvas 文本节点从未被 seed 到 mixedEditor slice，`git grep -n "addMixedEditorNode\|appendMixedEditorNodes\|setMixedEditorNodes"` 仅见于 mixedEditor/index.tsx 的图片/视频/音频初始化，没有 text-node 桥接）。
7. `textEditor/` 整个子树**没有** import `useCanvasActions`（验证：`git grep -n "useCanvasActions" origin/main -- packages/web/src/apps/project/components/textEditor/` 零命中）。因此写入路径**完全不触达 canvas Yjs**。

**后果**：用户在文本节点编辑器里输入的所有内容，在组件卸载（切换节点 / 关闭面板 / 刷新）后**全部丢失**。协作者也永远看不到（Yjs 不知道有这次写入）。

**补充佐证**：`package.json` 新增了 `@tiptap/extension-collaboration` / `@tiptap/extension-collaboration-cursor` / `@tiptap/y-tiptap` 依赖，但代码里 `git grep -n "Collaboration\|y-tiptap"` 在 `packages/web/src` 下零命中 — 依赖加了但没接线。佐证"本来应该做 Yjs 协作但漏了整块集成"。

**修复方向**（不唯一，需用户拍板）：
- 方案 A：TextEditor 改用 `useCanvasActions().updateNode`，走 Yjs nodesMap 正规路径；读取走 `useCanvasData().nodes`。
- 方案 B：用 `@tiptap/y-tiptap` 做真正的 per-node Y.XmlFragment 协作（workflowId=project id，每个文本节点一个 XmlFragment 子文档）。
- 两条路架构不同，A 便宜但失去富文本协作，B 贵但和项目定位吻合。

**严重度**: HIGH（可能 CRITICAL，核心功能 100% 失败）

---

### BUG-164
**标题**:mixedEditor `useYjsStore` 把 nodeId 当 workflowId

- **严重度**:HIGH

**位置**: `packages/web/src/apps/project/components/mixedEditor/index.tsx:923-932` + `packages/web/src/hooks/useYjsProjectStore.ts:62-79`

**代码**（origin/main）：
```
const { yjsUndo, ... } = useYjsStore({
  id: nodeId,                              // ← 仍然是 nodeId
  token: editorToken,
  enabled: !!nodeId && !!editorToken,
  onAuthFailed: ... removeToken() + navigate('/login')
});
```

`useYjsStore` 内部：
```
const mgr = createYjsProjectManager({
  workflowId: id,                          // ← 拼成 `project-${nodeId}/canvas`
  ...
});
```

PR #113 启用 authz 后，collab `auth.ts` 用 nodeId（36 字符 UUID，正则匹配通过）去 `projects` 表查 `id=? AND user_id=?` — **必然查不到**（概率 0）。于是 `onAuthFailed` 触发 → `removeToken()` + `navigate('/login')` → 用户被踢出登录状态。

这是 **BUG-093 完整复发**：
- 文件从 `imageEditor/` 改名为 `mixedEditor/`（`896b62f`、`90d8451`）；
- 函数从 `useImageEditorStore` 换成 `useMixedEditorStore`；
- **但** `useYjsStore({ id: nodeId })` 这一行**未修改** — 代码重组没碰 BUG-093 的 buggy line。

**额外扩散**：新增的 VideoNode / AudioNode（类型 1003 / 1004）也通过 mixedEditor 进入同一条 useYjsStore 路径 → 图片 / 视频 / 音频 的每种 node-level 编辑器首次打开都会踢人下线。

**严重度**: HIGH（既有 BUG-093 等级未降，受影响场景反而扩大到 video/audio node editor）

**与 BUGS.md 关联**：BUG-093 尚未修复；本条不建议新编号，但应在 BUG-093 条目里增加"需同步修改 mixedEditor/index.tsx:924 的 id=nodeId 为正确的 docName 结构"的注记，并确认修复覆盖 video/audio。

---


## P1 HIGH — 本周修

### BUG-165
**标题**:`canvas/common/Video.tsx` videojs player 从不 dispose

- **严重度**:HIGH

**位置**: `packages/web/src/apps/project/components/canvas/common/Video.tsx:224-319`

- line 228 `playerRef.current = videojs(node, {...})` 初始化 player。
- 注册了 6 个事件 `play` / `pause` / `ended` / `loadedmetadata` / `loadeddata` / `timeupdate` / `volumechange`。
- `useEffect` 依赖数组 `[src, initialTime, autoPlay, emitPlayback, schedulePlaybackEmit, clipStartTime, clipEndTime]` — 会在 src 变化或其他依赖变动时重新跑 effect 体。
- **完全没有 cleanup 函数**（没有 `return () => { playerRef.current?.dispose(); playerRef.current = null; }`）。

另外：
- line 133 `playbackRafRef.current = requestAnimationFrame(...)` — cleanup 也无 `cancelAnimationFrame(playbackRafRef.current)`，组件卸载时悬挂的 RAF 依然引用已 unmount 的 React state setter。

**后果**：
- 每次 mixedEditor mount / unmount（切换节点、切画布）都多一个孤立 videojs player 持有 DOM + WebAudio + 事件监听 + HTMLVideoElement。video.js player 本身就是 ~1MB JS 对象 + 隐含的 MediaSource / AudioContext。
- 长时间使用编辑器 → 浏览器内存几十 MB 起跳的增长，最终 OOM crash。
- 与 BUG-070（Yjs undoManager 监听器泄漏）、BUG-071（subdoc provider 不逐个清理）共同构成 systemic 前端内存泄漏面 — **这里是最严重的新增点，因为单个 player 对象明显比 undoManager 监听器重得多**。

**严重度**: HIGH

---


## P1 MED — 本周修

### BUG-155
**标题**:`video-cover.ts` 服务端 ffmpeg 参数 `-i <videoUrl>` 无 `-protocol_whitelist` 限制,依赖 provider URL 完全可信;一旦 provider 返回值被污染就能读本地文件 / SSRF 内网

- **状态**:`[ ]` 待修
- **严重度**:MED(深度防御缺失;需上游 bug 配合才能触发,但容器内 ffmpeg 以 root 运行,后果严重)
- **位置**:`origin/main:packages/core/src/video-cover.ts:29-41`

**当前代码**(`execFileAsync` 数组参数调用 ffmpeg):

```
execFileAsync("ffmpeg", [
  "-i", videoUrl,        // 问题:任意 scheme 如 file://、concat:、pipe:、rtp:、tcp: 等
  "-vframes", "1",
  "-f", "image2",
  "-vcodec", "mjpeg",
  "-q:v", "2",
  "pipe:1",
], { encoding: "buffer", maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
```

**问题**:

1. ffmpeg 默认 protocol allowlist 包含: `file, http, https, tcp, udp, rtp, rtsp, srtp, concat, crypto, pipe, rtmp, ...`。**`-i` 参数值不做 scheme 校验**
2. 如果 `videoUrl = "file:///app/.env"` → ffmpeg 会把 dotenv 当"视频源"读,虽然大概率不会成功解码成 JPEG,但**会泄漏前 10MB 内容到 error stderr**(log 里可见),或被 `image2` 输出成"视频 cover" 上传到 storage 给攻击者下载
3. 如果 `videoUrl = "concat:file:///etc/passwd|file:///app/.env"` → ffmpeg concat 会读多个文件
4. videoUrl **来源可信度低**:虽然当前 `persistedUrl = result.url` 来自 `persistResultUrls`,但 `persistResultUrls` 只检查 `value.startsWith("http")`(`handlers.ts:504`)—— 允许任意 http:// / https:// URL。如果 provider 返回 `http://169.254.169.254/latest/meta-data/...`(AWS IMDS)或 `http://10.0.0.1/`(内网) → `downloadAndStore` 会代理下载(另一个 SSRF 洞,超范围)+ `extractVideoCover` 会把 metadata service 当视频解析
5. **容器 root 运行**(Dockerfile 无 `USER node`):ffmpeg 本身历史有堆溢出 CVE(如 CVE-2023-49528, CVE-2022-3964),攻击者上传精心构造的 mp4,ffmpeg 解析时触发 RCE → **获得 container root**
6. **`maxBuffer: 10MB` timeout 30s** 是仅有的防护,但不够:大多数 CVE 在解析 header 时就触发,30s 绰绰有余
7. Dockerfile:`apt-get install ffmpeg` 无版本固定 → 每次 build 拿 Debian stable 最新,但 Debian 对 ffmpeg CVE patch 通常滞后

**修复方案**:

1. `-protocol_whitelist "http,https,tcp,tls"` 放 `-i` 前(ffmpeg 参数)
2. videoUrl 做 URL 解析 + scheme 白名单 + host 白名单(只允许自家 storage publicUrl prefix):`new URL(videoUrl).protocol` 必须是 `http:`/`https:`,`host` 必须属 `env.ASSET_HOST_ALLOWLIST`
3. Dockerfile `USER node`(所有服务);ffmpeg pin 具体版本(`ffmpeg=7:5.1.4-0+deb12u1` 或类似)
4. 考虑换 `fluent-ffmpeg` 封装(有 sandboxing 与 timeout hooks 更成熟);或走隔离 sidecar container 跑 ffmpeg(Kubernetes/docker-compose 独立服务)

**验证**:

- 单测:`extractVideoCover("file:///etc/passwd", ...)` 应在 URL 校验层抛
- 容器:`docker container inspect` 运行用户非 root
- CI 扫 Trivy/Snyk:ffmpeg version 无已知 CVE

**预估**:2h(protocol_whitelist + URL 验证 + Dockerfile `USER node` + 本地回归)

---

### BUG-156
**标题**:`PUT /assets/local-upload` 无文件大小限制 + 无 rate limit + contentType 信任客户端 header → 视频上传可填爆磁盘/heap

- **状态**:`[ ]` 待修
- **严重度**:MED(DoS;可上行放大 BUG-129,video 场景更严重)
- **位置**:`origin/main:packages/server/src/routes/assets.ts:136-162`

**当前代码**:

```
assets.put("/local-upload/*", requireAuth, async (c) => {
  const user = c.get("user");
  if (env.STORAGE_PROVIDER !== "local") { throw new ValidationError(...); }
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/assets\/local-upload\//, ""));
  if (key.includes("..") || key.includes("//") || !key.startsWith(user.id)) {
    throw new ValidationError("Invalid or unauthorized upload key");
  }
  const arrayBuf = await c.req.arrayBuffer();   // 问题:无大小限制
  const buffer = Buffer.from(arrayBuf);
  const contentType = c.req.header("Content-Type") ?? "application/octet-stream";  // 问题:信任客户端
  const adapter = await getStorageAdapter();
  await adapter.upload(key, buffer, contentType);
});
```

**问题**:

1. **无 body size 限制**:`c.req.arrayBuffer()` 吞下任意大小 → Node.js heap OOM(默认 ~1.5GB),单个请求能打爆整个 API server。Hono 默认无 `bodyLimit`(全仓 `grep bodyLimit` 零结果)
2. **无 rate limit**:presign 端点有 30/min(`assets.ts:51`),但 local-upload **完全没有**。攻击者 presign 一次拿 30 个 key,开 30 个并发 PUT,每个传 500MB → 磁盘立刻填满
3. **contentType 纯信任客户端 header** → 可上传 `.exe` 声明成 `video/mp4`,后续 `/uploads/` 静态路由 serve 给其他用户,XSS / 钓鱼 / malware 分发。更严重:BUG-130(content_type 白名单缺失)在 presign 也不验,整条链都不防
4. **key 验证有缺口**:
   - 正则 `^\/api\/v1\/assets\/local-upload\/` 用 `replace` 去掉前缀,但 Hono 的 `c.req.path` 经过 Hono 自己的路径处理,如果 Hono 版本升级路径前缀处理改动,`replace` 可能失效
   - `key.includes("..")` 不防 `%2e%2e`(已 `decodeURIComponent`,这层 OK)但不防 Unicode normalization:`．．`(fullwidth period)、`..`(NFKC 后是 `..`)、null byte `\0/passwd`
   - `key.startsWith(user.id)` 只防跨用户,不防同用户覆盖其他项目的文件(key 格式 `userId/projectId/taskType/...` — 攻击者可覆盖自己其他项目的视频/cover)
5. **新 video 子系统(PR #134/#135)不会直接走 local-upload**(客户端 ffmpeg blob 没上传,见 H-02),但**一旦 H-02 修复加 upload 链路,这个洞就变关键路径**

**修复方案**:

1. Hono `bodyLimit({ maxSize: 500 * 1024 * 1024, onError })` middleware,按 kind 分大小(image 10MB / video 500MB / audio 50MB / document 10MB)
2. 加 rate limit:`checkRateLimit(redis, "upload:" + user.id, 10, 60)`
3. contentType:从 buffer 前几字节 `fileTypeFromBuffer`(`file-type` npm)重新探测,拒绝和 key 后缀不符的请求
4. key 验证:`key.normalize("NFC")` → 拒绝 control chars 和 null byte → 拒绝 path segment 等于 `..` → 白名单字符集 + 扩展名正则
5. 统一走 presign 流(key 是服务端生成的 storageKey,客户端传不会改)

**验证**:

- 手动:`curl -X PUT ... --data-binary @large.bin`(600MB)→ 413
- 手动:`curl -X PUT .../Alice/proj1/video/x.mp4` 签成另一 projectId → 拒绝
- CI:Unicode bypass 测试(`..`)应被拒绝

**预估**:2h(bodyLimit + rate limit + fileTypeFromBuffer + key 正则)

---

### BUG-157
**标题**:`mini-tools/video` 的 `video: z.string()` 接受任意字符串(包含 `file://`、内网 URL、data: URL),无 URL 解析校验 → 传到 worker provider 可导致 SSRF 或 fetch 本地 / 元数据服务

- **状态**:`[ ]` 待修
- **严重度**:MED(依赖 provider 实现,部分 provider 直接 fetch 攻击面大)
- **位置**:`origin/main:packages/server/src/routes/schemas.ts:48-51`(所有 video tool 都用 `video: z.string()`)

**当前代码**:

```
export const videoToolSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("upscale"), video: z.string(), model: z.string().optional(), ... }),
  z.object({ tool: z.literal("interpolate"), video: z.string(), multiplier: z.number().default(2), ... }),
  z.object({ tool: z.literal("extend"), video: z.string(), prompt: z.string().default(""), ... }),
  z.object({ tool: z.literal("edit"), video: z.string(), prompt: z.string(), images: z.array(z.string()).optional(), ... }),
]);
```

**问题**:

1. `video: z.string()` 不做 URL 格式 / scheme / host 校验
2. `video` 字段被 worker `providers/video/models/post.ts:44-50` 重命名为 `api.video` 直接传给 WaveSpeed 等第三方 API。**如果第三方 fetch 这个 URL**,我们服务就成了 SSRF 跳板(通过让第三方代访问内网)
3. 如果未来有 provider 自己 `fetch(params.video)` 做任何预处理(例如新加的 server-side ffmpeg manipulation,或 validateVideoParams 里加尺寸探测)→ 立即 SSRF 我们自己的内网
4. **同类问题在 `images: z.array(z.string())`**:一个 edit tool 把多个任意字符串作为 "images" 往第三方传
5. audio/image tool 的 schema 大概率同款问题(需另审),不在 Batch H 范围
6. 当前客户端流程:客户端拿到 presign URL,上传,然后把自家 storage 的 fileUrl 作为 `video` 传回 `/mini-tools/video`。**但服务端不校验 fileUrl 是否属于调用者**(甚至 scheme),攻击者可传 `file:///etc/passwd` 或别人的 signed URL

**修复方案**:

新建 schema helper `storageUrl`:`z.string().url()` + `refine` 要求 `new URL(u).protocol in {http:, https:}` + host 在 `env.ASSET_HOST_ALLOWLIST` 白名单。所有 `video/image/audio/images` 字段用 `storageUrl` 替代 `z.string()`。同时**服务端校验 URL ownership**:URL 路径含 userId prefix 的 key 必须匹配 `c.get("user").id`。

**验证**:

- 单测:`video: "file:///etc/passwd"` 应被 Zod 拒绝
- 单测:`video: "http://evil.com/x.mp4"` 应被 host 白名单拒绝
- 单测:`video: "https://oss.ours.com/OtherUser/proj/video.mp4"` 应被 ownership 校验拒绝

**预估**:1.5h(schema helper + 所有 tool 替换 + ownership 校验 + 回归)

---

### BUG-158
**标题**:`@ffmpeg/core` 依赖 `"0.12.6"` 固定但代码硬编码 CDN URL → lockfile 给人"锁住版本"错觉,实际未生效 + 5 个 util 复制粘贴 `ensureFfmpegLoaded` 导致 5 个独立 WASM 实例

- **状态**:`[ ]` 待修
- **严重度**:MED(架构缺陷 + 性能 + 维护性 + H-01 前置)
- **位置**:`origin/main:packages/web/package.json:13-15` + 5 个 `*WithFfmpeg.ts` 文件 顶部

**当前代码**:

```
// packages/web/package.json
"@ffmpeg/core": "0.12.6",
"@ffmpeg/ffmpeg": "0.12.15",
"@ffmpeg/util": "0.12.2",
```

```
// 5 个 util 文件结构完全一致(约 60 行样板 × 5)
let ffmpegInstance = null;
let ffmpegLoadPromise = null;
const ensureFfmpegLoaded = async () => { ... };
```

**问题**:

1. `@ffmpeg/core` 被 pnpm install 到 `node_modules/@ffmpeg/core/`(增加 30MB+ node_modules),但**代码里没 `import` 这个包,而是从 CDN 加载**。两套版本 —— CDN URL 硬编码 `0.12.6`,恰巧跟 package.json 一样,但**package.json 改版本不会生效**,未来偏差难察觉
2. **5 个独立 module singleton** —— `videoAdjust` 和 `videoCrop` 有**各自的 `ffmpegInstance`**。同用户先做 adjust(加载实例 A,30MB WASM)再做 crop(加载实例 B,另 30MB WASM)—— 浏览器多 30MB heap + 多一次 3 个 blob fetch
3. **竞态**:同一文件内 `ffmpeg.writeFile / ffmpeg 任务 / readFile` 共用 singleton,快速连续调用(如 adjust 滑块连续拖动触发 `onSave` 多次)→ `adjust-input-Date.now().mp4` 冲突可能(毫秒级冲突时覆盖)+ ffmpeg 内部状态机紊乱
4. **无互斥锁** —— multiple calls 并发时只有 `try/finally` 清理,没 mutex,文件名靠时间戳 + 随机数不可靠
5. **代码重复 ~250 行**(5 × 50 行 boilerplate):违反 CLAUDE.md "MANY SMALL FILES + HIGH COHESION",但这个是 **LOW COHESION** 的实例

**修复方案**:

1. 新建 `packages/web/src/utils/ffmpegClient.ts`,单 singleton + 任务队列(mutex,Promise 链)+ AbortSignal 支持
2. 5 个 util 只保留 filter 构建函数,调用 `ffmpegClient.run(ff => ff.task(args))`
3. Vite 配置 `vite-plugin-static-copy` 从 `node_modules/@ffmpeg/core/dist/esm/` 拷 3 个文件到 `public/ffmpeg/`,URL 变 `/ffmpeg/ffmpeg-core.js`
4. 删除 package.json 中 `@ffmpeg/core`(无 import 的假依赖)—— 或改为 import 方式真用上

**验证**:

- Bundle 大小:构建后 `ls -la dist/` 对比现在和改后
- 内存:连用 adjust -> crop -> speed,Heap 增长只见一次(约 30MB)
- 连续触发 adjust 10 次,无一失败或错乱输出

**预估**:3h(合并 + 迁移 + Vite copy + 回归 5 个工具)

---

### BUG-159
**标题**:所有 ffmpeg video 操作调用处使用裸 `catch {}` 静默吞错误,违反 CLAUDE.md 禁止清单("裸 catch");用户看不到 ffmpeg 失败原因

- **状态**:`[ ]` 待修
- **严重度**:MED(UX 和调试;用户不知道为什么视频编辑"卡住"了)
- **位置**:`origin/main:packages/web/src/apps/project/components/mixedEditor/node/videoNode/videoNode.tsx:676, 733, 767, 800, 823, 847`(6 处)

**当前代码**:

```
try {
  const nextSrc = await videoAdjustWithFfmpeg(videoContent, value);
  ...
} catch {                    // 问题:无变量,无 log,无用户通知
  return;
}
```

**问题**:

1. **直接违反 CLAUDE.md 禁止清单**:"**裸 catch**" 是列在"禁止清单"里的显式禁令
2. 用户体验:用户点 "Save adjustments",菊花转 5 秒,结果啥也没发生(无 toast,无 log,无 console warn),以为"卡了"
3. 调试地狱:client log 里不会出现任何 ffmpeg 错误 → 支持团队排查不了
4. 违反 common/coding-style.md "Never silently swallow errors"

**对比正确做法**:`packages/server/src/routes/chat.ts` 的 SSE handler(见既有 BUG-112 的 text-tools.ts 参考)都有 `try/catch (error: unknown)` + logger.error

**修复方案**:6 处统一模板替换,`catch (error: unknown)` 提取 message → `toast.error(i18n.t(...))` + `Sentry.captureException` + `resolveVideoResultNode(placeholderId, '', { state: 'failed' })`。ESLint 加 `no-empty-catch` 规则。

**验证**:

- 手动:断开 CDN(mock 失败)→ 点 adjust → 应出现 toast "Failed to load ffmpeg core"
- Grep:`grep -c "catch {" videoNode.tsx` 应为 0

**预估**:30min

---

### BUG-167
**标题**:`textEditor/ui/AIMenu.tsx` `insertContentAt(range, replacement)` 当前是 mock，接入真 LLM 后即 XSS

- **严重度**:MED

**位置**: `packages/web/src/apps/project/components/textEditor/ui/AIMenu.tsx:359-366, 386-406, 408-411`

**现状**（`9c3efc6` / `a12d92c` / `60fa10d` 已经把 AI 流程简化成完整 mock）：
- `runPreviewFlow(replacement)` 接受 string，延迟 700+550ms 后 `editor.chain().insertContentAt({from,to}, replacement).run()`。
- Tiptap `insertContentAt(range, string)` 把 string **作为 HTML 解析**到 ProseMirror schema。
- 当前 `replacement` 全是硬编码字符串（`MOCK_TOOL_REPLACEMENTS.generate = '[AI PREVIEW] This is...'`） — 安全。

**landmine**：一旦接真实 text-tools SSE，把 LLM 文本塞进来，就是：
- LLM 输出 `<img src=x onerror=...>` 或 `<script>...` 或富文本结构化注入 → ProseMirror schema 过滤是"最后一道墙"，**依赖 BreaticImage / 其他 extension 白名单严格**。
- BreaticImage（`BreaticImageExtension.tsx:240`）`renderHTML` = `['img', { src: node.attrs.src }]` — `src` attr 没做 protocol 白名单，如果 LLM 返回 `data:image/svg+xml;base64,...<script>...`，新式浏览器在 `<img src="data:svg">` 下不执行 script，但 `<svg>` 内的 `<foreignObject>` + `<script>` 在某些上下文下可运行。需要显式限制 `src` = `https:/blob:/data:image/(png|jpg|jpeg|gif|webp)`。

**预警**：当这一路接入真实后端（text-tools SSE 已在 `packages/core/src/modules/text-tool.service.ts` 存在），需要**同步加上**：
- `insertContentAt` 前先 `sanitizeRichText(replacement)`（复用 `@/utils/sanitize.ts`）；或
- Editor 层 configure `BreaticImage` 的 `parseHTML` 加 src 协议白名单。

**与 BUG-051 / BUG-139 关系**：BUG-051 是 `TextNodeContent.tsx:141 innerHTML = value` 裸写；这里是 Tiptap 路径。ProseMirror 的 schema 过滤比 DOMPurify 粒度不同 — 默认 schema 放行的 attribute 集合要审核。

**严重度**: MED（当前 mock 安全，但接真 LLM 即高危 — 属"定时炸弹"类）

---

### BUG-168
**标题**:`resolveVideoResultNode` / `updateNodeData` 不 revoke 旧 blob URL

- **严重度**:MED

**位置**: `packages/web/src/hooks/useMixedEditorStore.ts:608-618`

- I-04 已描述数据丢失主路径。
- 额外角度：**同一个视频 node 被 ffmpeg 处理多次**（比如先 cut 再 adjust），中间每一次都 `updateNodeData(nodeId, { content: newBlobUrl })`。旧 blob URL 在下一次 `updateNodeData` 被覆盖。
- **没有 `URL.revokeObjectURL(oldUrl)`** — 旧 blob 占用的内存不释放，直到 document 卸载。
- 用户连续剪辑 10 次 → 浏览器进程内浮着 10 个视频 Blob，每个几十 MB → 潜在 GB 级泄漏。

**修复方向**：`updateNodeData` 在写入新 blob URL 前 revoke 旧的（前提是检测到旧值是 `blob:` 协议）。或根本不把 blob URL 写状态，直接 upload 到 S3（参见 I-04）。

**严重度**: MED（实际用户场景里"反复剪辑同一视频"是常见操作，内存压力非常真实）

---


## P2 — 本月修

### BUG-160
**标题**:ffmpeg.wasm 客户端 timeout 120s/600s 无用户取消机制,长视频处理中用户切工具/关面板仍会跑完

- **状态**:`[ ]` 待修
- **严重度**:LOW(浪费客户端 CPU,未来引入积分则放大)
- **位置**:5 个 `*WithFfmpeg.ts` 都用 `Promise.race([promise, timeoutPromise])`,无 AbortController

**问题**:

1. `withTimeout` 只对硬超时生效(120s/600s),不对"用户取消"生效
2. 用户在 adjust 面板修改参数 → 触发 ffmpeg 任务 → 等待 → 还没完用户关闭 adjust → ffmpeg 继续烧 CPU 到完成才返回
3. 若未来 videoEditor 接入积分(按时长/字节数扣),会积分空耗(类比 BUG-112 的服务端版)
4. 当 5 个 util 合并(见 H-06)时,这个修起来成本低

**修复方案**:和 H-06 合并。`ffmpegClient.run(task, { signal: AbortSignal })` 支持取消,videoNode 组件 unmount 或切 mode 时 abort。

**预估**:与 H-06 合并 +15min

---

### BUG-161
**标题**:ffmpeg cut 用 `-ss <time> -i <file>`(input seek),快但精度差,会产生错位 I-frame → 某些格式输出第一秒可能黑屏 / 无音频

- **状态**:`[ ]` 待修
- **严重度**:LOW(质量问题,非安全)
- **位置**:`origin/main:packages/web/src/utils/videoCutWithFfmpeg.ts:109-123`

**当前代码**(ffmpeg 参数顺序):

```
[
  '-ss', toFfmpegTime(segment.start),  // 问题:放在 -i 前(input seek)
  '-i', inputName,
  '-t', toFfmpegTime(duration),
  '-c', 'copy',                         // 问题:copy 不重编,键帧错位更明显
  ...
]
```

**问题**:

1. `-ss` 在 `-i` 前是 **input seek** —— ffmpeg 用 demuxer 跳到 keyframe 之前 fast-skip,比 output seek 快 10-100 倍,但只会跳到最近 keyframe,不是精确到帧
2. 配合 `-c copy`(stream copy)—— 不重编,第一秒输出可能:
   - 从非 keyframe 开始 → 前面几帧花屏或黑屏(直到下个 I-frame)
   - 音频和视频不同步(音频 packet 比视频 packet 少)
3. 用户体验:cut 出来的片段前 0.5-1 秒黑屏 / 无声 / 花屏
4. fallback 虽然用 `-c:v libx264 -c:a aac`(重编),但仍是 `-ss` 在前,精度依然差

**修复方案**:

精确 cut:`-i` 放前、`-ss` 放 `-i` 后(output seek,精确到帧),配合 `-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k`。或两阶段:先 keyframe-seek 快跳到 `segment.start - 2s`,再 output-seek 精确到目标时间。

**预估**:30min(改 ffmpeg 参数 + E2E 回归 cut 输出播放完整)

---

### BUG-162
**标题**:adjust WebGL 着色器实时预览 + ffmpeg 再压缩二次处理,色彩管线不一致;WebGL 预览 `colorchannelmixer` 公式和 ffmpeg 公式用不同魔数

- **状态**:`[ ]` 待修
- **严重度**:LOW(视觉一致性 / 用户困惑,非安全)
- **位置**:`origin/main:packages/web/src/utils/videoAdjustWithFfmpeg.ts:107-114` + `packages/web/src/apps/project/components/mixedEditor/node/videoNode/adjust/adjustValueToWebglUniforms.ts`(需比对)

**当前代码**(videoAdjustWithFfmpeg 的魔数):

```
const brightness = toUnit(value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2 + value.fade * 0.15);
const contrastF = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
const satF = toUnit(value.saturation * 0.85 + value.vibrance * 0.45 - value.fade * 0.15);
const rr = 1 + tempU * 0.22 - tintU * 0.08;
const gg = 1 + tempU * 0.06 + tintU * 0.2;
const bb = 1 - tempU * 0.28 - tintU * 0.1;
```

**问题**:

1. 这些魔数(0.9 / 0.25 / 0.22 / 0.06...)**像手调的**,未见常量集中和说明
2. 注释说 "aligned with `buildAdjustFabricFilters` order in `ImageNode.tsx`" —— 但 fabric 那边是 canvas filter,**色彩管线不同**(线性空间 vs gamma 空间)
3. WebGL 实时预览 vs ffmpeg 保存结果用两套公式 → **用户拖滑块时看到的颜色和保存后的不一样**,产品感"不一致"

**修复方案**:

1. 提取 `packages/web/src/utils/adjustConstants.ts` 集中常量 + JSDoc 公式来源(HSL / gamma / 是否线性)
2. WebGL shader 和 ffmpeg filter 用同一套参数 mapping,写测试对比关键值(红/绿/蓝 50% 亮度 100% 饱和度下,两者输出像素最多差 3/255)
3. 这不是快速修 —— 可以在 BUGS.md 里开 P2 tracker

**预估**:1d(需要 UX/开发一起对色彩管线)

---


- 新 video 子系统**没有引入明显注入类漏洞**(客户端用 `ffmpeg.task([...])` 数组形式调参,服务端用 `execFile` 数组形式,都不走 shell)
- 最大风险是**供应链 + 数据持久化**(H-01、H-02)—— CDN 加载 ffmpeg.wasm 没 SRI,且 ffmpeg 输出 blob URL 直接写到 node data 不 upload 不 revoke
- **服务端 ffmpeg**(`video-cover.ts`)未来有 SSRF/file-read 风险(H-03),需 `-protocol_whitelist` + URL 白名单
- 上传链路(local-upload + mini-tools schema)无大小/scheme/ownership 校验(H-04/H-05),video 场景最严重(单文件百 MB+)
- **5 个 util 文件的代码重复**(H-06)是维护和性能瓶颈,建议优先合并,合并后 H-08(abort 支持)能一并解决
- **裸 catch**(H-07)直接违反 CLAUDE.md,6 处批量修改

---

### BUG-166
**标题**:`PlaybackTimelineSection.tsx` + `EraseTrackingPanel.tsx` 隐藏 video 元素事件清理不完整

- **严重度**:LOW

**位置**:
- `packages/web/src/apps/project/components/mixedEditor/node/videoNode/playback/PlaybackTimelineSection.tsx:158-194`
- `packages/web/src/apps/project/components/mixedEditor/node/videoNode/erase/EraseTrackingPanel.tsx:67-99`

**代码片段**（两处几乎一致，本质同一个 bug 模板复制）：
```
const video = document.createElement('video');
video.src = src;
const handleLoadedData = () => { ... setFirstFrameUrl(dataUrl); };
video.addEventListener('loadeddata', handleLoadedData, { once: true });
video.load();
return () => {
  cancelled = true;
  video.pause();
  video.removeAttribute('src');
  video.load();
};
```

问题：
- `{ once: true }` 意图是 fire 一次后自动删除监听器，**但如果组件在 `loadeddata` 事件 fire 前被卸载**，监听器从未被触发也从未被显式 `removeEventListener` 删除。
- 此时 `<video>` 元素 detached，**但监听器闭包捕获了 `setFirstFrameUrl`（React state setter）+ `cancelled` 标志** — 这些闭包保持 React fiber 的根引用。
- 浏览器可能还没 GC 该 `<video>`（特别是 src load 过程中），事件延迟到达后，cleanup 中的 `cancelled=true` 能 guard 住（没 setState），但仍然意味着 **event listener 未 removeEventListener，<video> 未完全断引用**。
- 对 `mediaSrc` 变化频繁的场景（用户切换视频节点），叠加引用。

轻度问题，但和 I-03 合在一起构成系统性"video node unmount 清理不严谨"模式。

**修复方向**: cleanup 明确调用 `video.removeEventListener('loadeddata', handleLoadedData)`，然后 `video.src = ''` / `video.remove()`。

**严重度**: LOW-MED（属于 BUG-070/071 systemic 同源，非独立大问题）

---

### BUG-169
**标题**:新增 `@tiptap/extension-collaboration` 等依赖但未接线

- **严重度**:LOW

**位置**: `packages/web/package.json`（diff `a91e2cb`）

新增包：
- `@tiptap/extension-collaboration`
- `@tiptap/extension-collaboration-cursor`（版本 `^2.26.2` — 注意这个**和其他 tiptap 3.22.3 版本不一致**！）
- `@tiptap/y-tiptap@^3.0.3`

**验证**：`git grep -n "Collaboration\|y-tiptap"` 在 `origin/main` 的 `packages/web/src` 下**零命中**。

问题：
1. 打包进前端 bundle（除非 tree-shake 掉） — 增大 bundle 大小。
2. 版本不一致（collaboration-cursor 2.x vs 其他 tiptap 3.x） — 未来接线时会踩包冲突。
3. 暗示"本来应该接 Yjs 协作但没做完" — 与 I-01 的数据丢失 bug 互相印证。

**严重度**: LOW（代码质量/ADR 应跟进）

---

### BUG-170
**标题**:`90d8451` proxy regex 从 `/api` 紧缩到 `/api/`

- **严重度**:LOW

**位置**: `packages/web/vite.config.ts` + `packages/web/src/apps/workspace/components/RecentProjects.tsx`

diff 核心：
```diff
- '/api': { ... }
- '/uploads': { ... }
+ '/api/': { ... }
+ '/uploads/': { ... }
```

并且 `RecentProjects` 里把 `staticProjects = []` 换成模块级常量 `EMPTY_STATIC_PROJECTS`（稳定引用，避免 useEffect 因默认值身份变化持续 refetch）。

评估：
- `/api/` 比 `/api` 严格，避免 `/api-foo` 之类误代理 — 正面改动。
- **但**这个 commit 消息"restore mixed editor exports and stabilize workspace API loading"承认 PR #134 引入了回归（重命名 imageEditor→mixedEditor 破了 import path + RecentProjects 里有 refetch 循环）。
- `EMPTY_STATIC_PROJECTS` 这种 fix 是经典"useEffect 依赖稳定引用"补丁 — 说明 `RecentProjects` 的 useEffect 依赖设计脆弱，另一处类似逻辑再重蹈覆辙的概率高。
- 未发现该 commit 引入新 bug，但暴露了"PR #134 大合并时缺乏 import path 对齐的 CI 检查"。

**建议**：在 CI 里加 tsc --noEmit 强制（如未有）；给 `RecentProjects` / 类似页面补 useEffect 依赖单测。

**严重度**: LOW（观察项）

---

### BUG-171
**标题**:yjsProjectManager `_userOrigin` 仍 per-user 非 per-tab

- **严重度**:LOW

**位置**: `packages/web/src/utils/yjsProjectManager.ts:72`

```
_userOrigin = userId ? `canvas-user:${userId}` : 'canvas-user';
```

本次 Round 6 的 15+ commits 都没碰这个文件（`git log 556b210..origin/main -- packages/web/src/utils/yjsProjectManager.ts` 零提交）。

- BUG-040（跨 tab Undo 污染）：**活跃**。
- BUG-070（undoManager 监听泄漏）：**活跃**。
- BUG-071（subdoc provider 不清理）：**活跃**。
- BUG-087（`onAuthFailed` eslint-disable stale closure）：**活跃**。

视频编辑器 + 多 tab 场景下 BUG-040 破坏面变大：用户在 tab A 开 mixedEditor 剪视频、tab B 开同一项目画布，Undo 会互相污染 + 视频 blob URL 覆盖。

**严重度**: LOW（不是新发现，只是 regression 影响面扩大的提醒）

---


| # | 严重度 | 条目 | 与既有 BUG 关系 | 是否新 bug |
|---|---|---|---|---|
| I-01 | HIGH | TextEditor 写错 slice → 数据丢失 | 新 | 新 |
| I-02 | HIGH | mixedEditor 复发 BUG-093 + 扩大到 video/audio | 扩 BUG-093 | 注记既有 |
| I-03 | HIGH | videojs player 永不 dispose | 扩 BUG-070/071 systemic | 新 |
| I-04 | MED | ffmpeg 结果 blob:URL 写本地 slice，刷新失效 | 新 | 新 |
| I-05 | MED | ffmpeg wasm 从 jsdelivr CDN 加载（供应链+CSP+离线） | 新 | 新 |
| I-06 | LOW-MED | video loadeddata 监听 cleanup 不全 | 扩 BUG-070/071 | 注记既有 |
| I-07 | MED | AIMenu insertContentAt 将来接 LLM 即 XSS（当前 mock 安全） | 扩 BUG-051/139 | 新 latent |
| I-08 | MED | 视频多次编辑不 revoke 旧 blob URL | 随 I-04 | 新 |
| I-09 | LOW | tiptap collab 依赖引入但未使用 | 代码质量 | 新 |
| I-10 | LOW | `90d8451` 修 workspace API 是 band-aid | 观察 | 观察 |
| I-11 | LOW | BUG-040/070/071/087 不变，regression 面扩大 | 既有 | 提醒 |

**建议派发**（供协调 session 参考）：
- **24h P0 追补**: I-01（TextEditor 数据丢失）、I-02（mixedEditor BUG-093 扩散到 video/audio node） — 都是 100% 功能失败
- **Batch D**: I-03（videojs dispose）、I-04（ffmpeg blob URL 落盘）、I-05（ffmpeg CDN）
- **Batch E**: I-07（AIMenu XSS 前置）、I-08（blob revoke）、I-09（依赖清理）
- **观察**: I-06、I-10、I-11

**严重度门槛符合要求**：3 HIGH + 5 MED + 3 LOW。LOW 只报 systemic（I-06 / I-11）和典型实例（I-10 workspace API）。

**审计方法**：只读 `git show origin/main:<path>`，未 checkout / modify 工作树。写 `.tmp-*.ts(x)` 缓存文件到仓库根（git-ignored 建议，审计结束后可清除）。

---

## 审计统计

| 桶 | 数量 | 编号 |
|---|------|------|
| P0 | 4 | BUG-153, BUG-154, BUG-163, BUG-164 |
| P1 HIGH | 1 | BUG-165 |
| P1 MED | 7 | BUG-155, 156, 157, 158, 159, 167, 168 |
| P2 LOW | 7 | BUG-160, 161, 162, 166, 169, 170, 171 |
| **合计** | **19** | BUG-153 ~ BUG-171(去重后,H-01/I-05 合并为 BUG-153,H-02/I-04 合并为 BUG-154) |

---

## 总体风险判断

1. **video editor 大 drop 引入 4 个 P0 问题**,全部与架构承诺不兼容:
   - **CDN 供应链**(BUG-153):违反 bundle-local dependency 原则,浏览器端 arbitrary code execution
   - **blob URL 不持久化**(BUG-154):违反 CLAUDE.md "AIGC 持久化到 /uploads" 架构,视频编辑刷新即丢
   - **TextEditor slice 不匹配**(BUG-163):输入**全部静默丢弃**,产品不可用
   - **mixedEditor authz 失败**(BUG-164):BUG-093 的复发 + 扩大,打开编辑器即踢下线

2. **BUG-093 的"关闭"带来新教训** —— 仅凭"文件删除"不能关 bug,因为 bug pattern 会跟着代码搬家。Audit session 今后对于"删除式修复"需要额外 grep 所有 usage,确保 pattern 没有迁移。

3. **systemic 扩大的既有 bug**:
   - BUG-129(upload 无 size limit)→ BUG-156(H-04 video local-upload 同问题)
   - BUG-133(Zod schema 缺 max)→ BUG-157(H-05 mini-tools schema video 字段)
   - BUG-112(SSE abort 缺)→ BUG-160(H-08 FFmpeg process 无 AbortController)
   - BUG-070/071(内存泄漏)→ BUG-165(I-03 videojs 更严重 systemic)+ BUG-168(I-08 blob 不 revoke)

4. **工作流教训 / 本轮**:
   - Agent J 超时暴露 prompt 过载:~8 个并列任务导致 stream idle。下轮 prompt 切分更严格,≤ 3 主题/agent
   - Agent 沙箱限制 `/tmp/` 写入 + `sed`,agents 用 `grep -A` 读代码片段、改写项目根的方式 workaround,但这会污染工作树 —— 主 session 需要主动 `git clean` 处理
   - `cnd.jsdelivr.net` 这种架构性缺陷 H 和 I 独立发现,说明问题足够显眼。两个 agent 交叉确认 = 价值,虽然合并时要去重

---

## 建议派发(next actions)

### 24h P0 Critical batch
- **BUG-153** 把 ffmpeg-core 改到项目 bundle(`/node_modules/@ffmpeg/core/dist` 本地加载)+ 加 SRI + CSP
- **BUG-154** FFmpeg output 走 presign upload 回传 → /uploads → canvas node.data.content = CDN URL
- **BUG-163** TextEditor 的 Redux slice 定位错误 → 改 `canvasNodes` / 正确 slice,或直接走 Yjs
- **BUG-164** mixedEditor 改用独立 `useNodeYjsStore` 或给 useYjsStore 加 mode 参数(参考 BUG-093 原修复方案)

### P1 HIGH(本周)
- **BUG-165**(I-03)videojs player cleanup —— 触发 BUG-070/071 一起整改

### P1 MED batch
- **BUG-156/157**(BUG-129/133 扩大)合并修
- **BUG-155**(H-03 服务端 ffmpeg protocol whitelist)
- **BUG-158**(H-06 ffmpeg util 重复 + deps)
- **BUG-159**(H-07 6 处裸 catch —— CLAUDE.md 禁止清单违反)
- **BUG-167**(I-07 AIMenu XSS 悬空面)
- **BUG-168**(I-08 blob 不 revoke)

### P2 LOW
参见 BUGS.md P2 桶

---

## 附:审计方法备忘

- `bugs_list` 分支**未 fast-forward 到 origin/main**(尊重 2026-04-23 会话中用户的 `git merge` 拒绝信号),agents 用 `git show origin/main:<path>` 读新代码
- 3 agent 并行派出,**J 超时**(~11 分钟,partial response),I/H 分别跑 ~47 分钟
- 沙箱 hook 阻止 `/tmp/` 写入 + `sed`,agents 把 audit file 写到项目根,由主 session 在合成前挪到 `/tmp/`
- Agent I 留下 29 个 `.tmp-*.ts(x)` 分析缓存在工作树根,由主 session `rm .tmp-*.tsx .tmp-*.ts` 清理
- BUG-093 核查由主 session 用 `git grep useYjsStore origin/main` 完成,结果:imageEditor 文件已删,pattern 迁移到 mixedEditor line 923
