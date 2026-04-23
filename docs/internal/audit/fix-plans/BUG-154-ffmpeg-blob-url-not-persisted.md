# Fix Plan: BUG-154 — ffmpeg 输出 blob URL 直接写 Yjs(不持久化 + 不 revoke + 协作者 404)

> **性质**:audit session 参考 fix 设计,非 fix PR 本身。`bugs_list` audit-only。
>
> **Severity**:P0(核心协作产品功能性损坏 + 内存泄漏 + 与 AIGC 持久化架构直接冲突)
>
> **Audit 记录**:[Round 6 archive § BUG-154](../2026-04-23-round-6-found.md#bug-154)
>
> **相关**:同一修复**顺带关闭 BUG-168**(不 revoke 旧 blob URL systemic)+ **触及 BUG-156 / BUG-130**(upload 大小 / content_type 白名单 — 需在本 PR 加校验)

---

## 1. Bug 精确描述

5 个 `video*WithFfmpeg.ts` util 的 output 最后一步都是 `return URL.createObjectURL(outputBlob)`,返回 `blob:http://<origin>/<uuid>` 形式的 URL 给调用方。

`mixedEditor/node/videoNode/videoNode.tsx` 的 6+ 个 callsite 拿到后,通过 `resolveVideoResultNode(placeholderId, blobUrl, { state: 'idle' })` 写入节点 `data.content`:

```typescript
// useMixedEditorActions.ts:1029
const resolveVideoResultNode = useCallback((nodeId, nextVideoSrc, options) => {
  if (options.state === 'idle') {
    resolveHandlingNode(nodeId, { content: nextVideoSrc });   // ← 写 Yjs Y.Map
  } else {
    updateNodeData(nodeId, { content: nextVideoSrc, state: ... }, { history: 'skip' });
  }
}, [...]);
```

PR #140(Yjs-first 重写)之后,**mixedEditor 的 data 写操作走 Yjs**,协作者立即收到。

---

## 2. 三层具体影响

### 影响 A:刷新即失效(创建者本地)

用户 crop 视频 → 2 分钟处理完 → `content = "blob:http://localhost:5173/abc-123"` 存入 Yjs map → 用户满意,切别的 tab → 刷新页面 → 浏览器重新打开 blob URL → **blob 对象已 GC(每次页面生命周期重置)→ `<video src="blob:...">` 报 404**。

对于"**内容创作协作画布**"的产品核心定位(见 MEMORY.md 里的 breatic 定位),这是 **产品功能破坏**。

### 影响 B:协作者秒级 404(Yjs-first 后新增)

关键新风险:Yjs map 写入 `content: "blob:..."` 会**实时同步**给所有协作者。协作者浏览器渲染:

```html
<video src="blob:http://<创建者本地>/abc-123">
```

协作者浏览器根本没有 `abc-123` 这个 blob —— 实例是创建者本地的。所以:
- 创建者看到正常
- 协作者所有视频节点 **立即 404**
- 且协作者**不知道是 bug**,以为是"创建者视频没上传成功"

这个影响在 Round 6 audit 时是 H 级别描述,**今天 Yjs-first 后 Reality 比预判更糟**。

### 影响 C:内存泄漏

全仓 `git grep revokeObjectURL packages/web/src/` —— 只在 **`mixedEditor/index.tsx:478`**(download 路径,已正确 revoke)和 `tempImageUrl.ts` 等无关路径出现。**5 个 ffmpeg util 的 output blob 永远不释放**。

用户反复试 adjust → 每次生成 30MB blob → 15 次试错 = **450MB heap 泄漏** → 浏览器 tab 崩溃。

---

## 3. 根因分析(两层)

### 层 1:ffmpeg util 的返回类型错 — 返 blob URL 而不是 Blob

```typescript
// videoAdjustWithFfmpeg.ts:183 (5 个文件同款)
const outputBlob = new Blob([safeBuffer], { type: 'video/mp4' });
return URL.createObjectURL(outputBlob); // ← 返 URL,丢弃了 Blob 本体
```

**问题**:`URL.createObjectURL` 把 Blob 包成只在当前页面生命周期有效的 URL。调用方拿到后**无法 upload**(没有 Blob 了,只能 `fetch(blobUrl)` 反 download 一次,丑陋)。

正确做法:util 返 `Blob`,由调用方决定是 upload 还是 preview-only。

### 层 2:`resolveVideoResultNode` 没有 upload step

```typescript
// useMixedEditorActions.ts:1029
const resolveVideoResultNode = useCallback((nodeId, nextVideoSrc, options) => {
  // nextVideoSrc 被当成 final content 直接写 Yjs,无 upload、无 persistence 保证
  resolveHandlingNode(nodeId, { content: nextVideoSrc });
}, [...]);
```

CLAUDE.md 的架构契约:"**画布事件全走 Yjs + AIGC 生成文件本地存储到 `/uploads`**"。当前代码**跳过 upload**,破坏契约。

---

## 4. 修复方案

### 方案 A:ffmpeg util 返 Blob + caller 走 presign upload ⭐ 推荐(根因修)

**步骤 1**:改 5 个 ffmpeg util 签名

```typescript
// 之前
export async function adjustVideoWithFfmpeg(...): Promise<string> {
  // ...
  const outputBlob = new Blob([...], { type: 'video/mp4' });
  return URL.createObjectURL(outputBlob);
}

// 之后
export async function adjustVideoWithFfmpeg(...): Promise<Blob> {
  // ...
  return new Blob([...], { type: 'video/mp4' });
}
```

**步骤 2**:新增 `uploadVideoBlob` helper

```typescript
// packages/web/src/utils/uploadBlob.ts (新)
import axios from '@/utils/request';

export async function uploadVideoBlob(
  blob: Blob,
  opts: { projectId: string; filename?: string; signal?: AbortSignal },
): Promise<{ url: string; key: string }> {
  // 1. 调 /assets/presign 拿 presigned URL
  const presign = await axios.post('/assets/presign', {
    content_type: 'video/mp4',
    size: blob.size,
    project_id: opts.projectId,
  });

  // 2. PUT blob 到 presigned URL
  await fetch(presign.data.upload_url, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': 'video/mp4' },
    signal: opts.signal,
  });

  return { url: presign.data.public_url, key: presign.data.key };
}
```

**步骤 3**:`videoNode.tsx` 的 6 个调用点改签

```typescript
// 改前(示意,每个 callsite 一段)
const nextSrc = await cropVideoWithFfmpeg(src, crop);
resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });

// 改后
const blob = await cropVideoWithFfmpeg(src, crop);
const { url } = await uploadVideoBlob(blob, { projectId, signal });
resolveVideoResultNode(placeholderId, url, { state: 'idle' });  // url 是 /uploads/... 持久化 URL
```

**步骤 4**:resolveVideoResultNode 增加 defensive guard(方案 A+B 防御深度)

```typescript
const resolveVideoResultNode = useCallback((nodeId, nextVideoSrc, options) => {
  // 防御:不许 blob: URL 进 Yjs
  if (nextVideoSrc.startsWith('blob:')) {
    logger.error({ nodeId }, 'Attempted to write blob: URL into Yjs — caller must upload first');
    throw new Error('resolveVideoResultNode: blob: URL not allowed, must upload first');
  }
  // ...写 Yjs
}, [...]);
```

如果未来有 callsite 漏 upload 就会被 catch(CLAUDE.md #5 防御深度)。

**优点**:
- **根治持久化** + **彻底防协作者 404** + **和 AIGC 架构对齐**
- Upload 成功前 blob 仍在内存(caller 可以 `URL.createObjectURL(blob)` 做预览),成功后直接 revoke(见步骤 5)
- `Blob` 类型比 `blob: URL` 更灵活 — caller 决定要 preview 还是直接 upload

**步骤 5**:revoke lifecycle(BUG-168 顺带修)

```typescript
// videoNode.tsx callsite
const blob = await cropVideoWithFfmpeg(src, crop);
const previewUrl = URL.createObjectURL(blob);  // 给用户 preview 用
// ... set preview state (optional)
try {
  const { url } = await uploadVideoBlob(blob, { projectId, signal });
  resolveVideoResultNode(placeholderId, url, { state: 'idle' });
} finally {
  URL.revokeObjectURL(previewUrl);  // preview 完立刻 revoke
}
```

### 方案 B:ffmpeg util 内部 upload

util 直接接收 `projectId` + 返回 upload 后的 URL。**不推荐**,因为 util 被业务层耦合(util 现在是纯工具,知道 projectId 就污染了)。

### 方案 C:middleware 拦截 blob: → 自动 upload + revoke

`useMixedEditorActions` 拦截 `updateNodeData` 的 content 字段,如果 `startsWith('blob:')` 自动反 download + upload + 替换。

**不推荐**:这是**典型 patch** —— 症状级拦截,根因不解决。而且 blob URL 反 download 那一步本身就是"我有 Blob 但套了层 URL,现在又得剥回来",丑陋。CLAUDE.md #5 zero tolerance 会反对。

### ⭐ 推荐:方案 A(util 返 Blob + caller upload + revoke lifecycle + resolveVideoResultNode guard)

理由:
- **根治**三层根因:util 签名错误 / caller 不 upload / resolveVideoResultNode 不校验
- 和 PR #140 的 Yjs-first 哲学对齐(单一数据源 / 架构级正确)
- 和 CLAUDE.md "画布事件全走 Yjs + AIGC 持久化到 /uploads" 的契约对齐
- 防御深度(guard)保证未来 refactor 不回退

---

## 5. 具体改动清单

| 文件 | 改动 |
|------|------|
| `packages/web/src/utils/videoAdjustWithFfmpeg.ts` | 返回类型 `Promise<string>` → `Promise<Blob>`;line 183 `return URL.createObjectURL(outputBlob)` → `return outputBlob` |
| `packages/web/src/utils/videoCropWithFfmpeg.ts` | 同上(line 135) |
| `packages/web/src/utils/videoCutWithFfmpeg.ts` | 返回类型 `Promise<string[]>` → `Promise<Blob[]>`;line 159 `outputUrls.push(URL.createObjectURL(...))` → `outputBlobs.push(outputBlob)` |
| `packages/web/src/utils/videoSpeedWithFfmpeg.ts` | 同 adjust(line 139) |
| `packages/web/src/utils/videoStabilizationWithFfmpeg.ts` | 同 adjust(line 119) |
| **新** `packages/web/src/utils/uploadBlob.ts` | `uploadVideoBlob(blob, opts)` helper(见方案 A 步骤 2) |
| `packages/web/src/hooks/useMixedEditorActions.ts:1029` | `resolveVideoResultNode` 加 `blob:` guard + throw |
| `packages/web/src/apps/project/components/mixedEditor/node/videoNode/videoNode.tsx` | 6+ 调用点:`await ffmpegUtil(...)` → `const blob = await ffmpegUtil(...)` + `const { url } = await uploadVideoBlob(blob, ...)` + `try/finally revokeObjectURL(previewUrl)` |

**行号锚点(callsites)**:
- videoNode.tsx:989 / 1002 / 1063 / 1078 / 1098 / 1106 / 1155 / 1170 / 1210 / 1224 / 1244 / 1257(audit agent 给的具体行)

**Import 补充**:
- videoNode.tsx 增加 `import { uploadVideoBlob } from '@/utils/uploadBlob';`
- 所有 videoNode.tsx 调用点已有 `projectId` 在 context(从 `useMixedEditorData().hostNodeId` 或 `useCanvasUI().workflowId` 读)

---

## 6. 测试规约(spec for dev CC to implement)

### Unit(ffmpeg util 层)

1. **util 返回 Blob 类型**
   - Setup:`adjustVideoWithFfmpeg(mockSrc, { brightness: 0.1 })`(mock ffmpeg.exec output buffer)
   - Expected:return value `instanceof Blob === true`;`.type === 'video/mp4'`
   - Boundary:所有 5 个 util(adjust/crop/cut/speed/stabilization)都测

2. **util 不再返 blob URL**
   - Setup:同上
   - Expected:return value **不以 `blob:` 开头**(regex guard)

### Unit(upload helper)

3. **`uploadVideoBlob` 正常路径**
   - Setup:mock axios 的 `POST /assets/presign` 返 `{ upload_url: 'https://s3/...?sig=...', public_url: 'https://cdn/.../key.mp4', key: 'uuid.mp4' }`;mock global `fetch` 返 PUT OK
   - Input:`uploadVideoBlob(new Blob([new Uint8Array(1024)], { type: 'video/mp4' }), { projectId: 'p1' })`
   - Expected:
     - presign POST body 包含 `content_type: 'video/mp4'` + `size: 1024` + `project_id: 'p1'`
     - PUT 目标是 presign 返的 upload_url
     - return `{ url: 'https://cdn/.../key.mp4', key: 'uuid.mp4' }`

4. **`uploadVideoBlob` abort 传递**
   - Setup:`AbortController`,立即 abort
   - Expected:PUT call 的 signal 是 abort 过的,fetch 抛 AbortError;函数 re-throw

5. **`uploadVideoBlob` 拒绝过大 blob**(对齐 BUG-156)
   - Input:`blob.size > env.UPLOAD_MAX_VIDEO_MB * 1024 * 1024`
   - Expected:不调 presign,直接 throw `ValidationError('blob too large')`

### Unit(resolveVideoResultNode guard)

6. **拒绝 blob: URL**
   - Input:`resolveVideoResultNode('node1', 'blob:http://localhost/abc', { state: 'idle' })`
   - Expected:throws `Error`;不调 `resolveHandlingNode` / `updateNodeData`;logger.error called once
   - Boundary:`'blob:'` / `'BLOB:'` / ` blob:...`(前缀空格)三个变体

7. **接受 /uploads/ URL**
   - Input:`resolveVideoResultNode('node1', 'https://cdn/uploads/x.mp4', { state: 'idle' })`
   - Expected:调 `resolveHandlingNode('node1', { content: 'https://cdn/uploads/x.mp4' })`

### Integration(e2e / 端到端)

8. **crop + 刷新后视频仍可播放**
   - Setup(Playwright):用户登录 → 打开某项目 → 拖 video 节点进画布 → 打开 mixedEditor → 点 crop → 选区域 → apply
   - Expected:
     1. crop 处理完毕,视频节点 content = `https://<uploads>/...` 形式(不是 `blob:`)
     2. **页面 F5 刷新**
     3. 视频节点仍正常播放(不 404)

9. **协作者实时收到持久化 URL(不是 blob:)**
   - Setup:2 个浏览器 tab 作为协作者 A/B,同一项目
   - A:crop 视频(与 case 8 同)
   - B:30 秒内应收到节点更新,content 字段是 `https://<uploads>/...`(不是 `blob:`)
   - B:`<video>` 能播放(不 404)

10. **Bulk revoke — memory 不泄漏**
    - Setup:Chrome devtools Memory tab,初始 heap snapshot
    - Action:crop 同一视频 10 次(每次用不同参数)
    - Expected:最终 heap 增长 < 50MB(revoke 生效;10 次 × 30MB blob 不累积)

### Monitoring / Regression

11. **Server-side /uploads 访问日志**
    - Deploy 后 24h:`/uploads/*.mp4` 的访问量应该大幅 > 0
    - 如果 0 → 说明 upload 没调(caller 没改),客户端 still blob URL,修复漏了

12. **`blob:` URL 不出现在 Yjs persistence**
    - Setup:query `SELECT name, data FROM yjs_documents WHERE name LIKE 'project-%'` 抽 10 条 random
    - Expected:data 里 base64 decode 后的 Y.Doc 状态里,任何 video 节点的 `content` 字段不以 `blob:` 开头

---

## 7. 部署风险

| 风险 | 评估 |
|------|------|
| **上传量增加** | 原来 video 编辑 0 上传,现在每次编辑都上传一次 ~30MB。估算:如果日均 1000 次 video 编辑 → 30GB/day ≈ 1TB/month。OSS / S3 成本需要评估。**缓解**:可以加 "仅 accept 阶段才 upload"(user preview 时不 upload,点保存才 upload)—— 但这会让 UX 复杂,建议第一版直接 upload |
| **Presign rate limit** | `POST /assets/presign` 文档说 30/min(CLAUDE.md "上传走 presigned URL(..., 30 次/分钟限速)")。正常用户够用,但恶意用户连发 ffmpeg job 可能触发 429。**建议**:前端 catch 429 + 提示 "稍后再试" |
| **Upload 失败降级** | 如果 upload fail,video 编辑作废?还是 fallback 到 blob URL 不持久化?**推荐**:fail → 弹 error toast + 不保存到 canvas(让用户 retry)。不 fallback 到 blob(否则 bug 重现) |
| **Abort 处理** | ffmpeg 工作可能 2 分钟,upload 30 秒。用户中途切工具 → AbortController 信号需要**同时** abort ffmpeg + upload(ffmpeg lib 有 `ffmpeg.terminate()` — 需确认) |
| **Content-Type 白名单**(BUG-130) | 本 PR 加 upload 时**强制** `content_type: 'video/mp4'`(硬编码),不 trust user input。也给 BUG-130 systemic 修复留 hook |
| **File size guard**(BUG-156) | 本 PR 在 `uploadVideoBlob` 加 size check,对齐 BUG-156 建议(upload_max_video_mb) |
| **测试环境** | `/assets/presign` 已有 integration test pattern,复用。ffmpeg util 单测要 mock wasm/ffmpeg(已有 pattern) |

---

## 8. 相关 context

- **BUG-168**(P1 MED,Round 6):`resolveVideoResultNode` 不 revoke 旧 blob URL。**本 PR 顺带关闭**(步骤 5 的 `try/finally revokeObjectURL`)
- **BUG-156**(P1 MED,Round 6):`/assets/local-upload` 无 size limit + 信任 client content_type。本 PR 在客户端 upload 做一层 guard,对齐此问题;**但 server 端还要单独修**(BUG-156 scope 不变)
- **BUG-130**(P1 MED,Round 6):`/assets/presign` 无 content_type 白名单。本 PR 客户端硬编码 `'video/mp4'`,但 server 端仍需加白名单校验(BUG-130 scope 不变)
- **CLAUDE.md #5 zero tolerance**:本修复**拒绝方案 C**(middleware 拦截自动 upload)因为那是 patch —— 症状遮蔽 / 根因未解
- **PR #140 Yjs-first 精神对齐**:PR #140 删 1071 行 Redux 换架构正确;本 PR 去 blob URL 耦合换 upload 架构正确,同一哲学

---

## 9. 回归检查(修完后 BUGS.md 更新建议)

- [ ] `git grep 'URL.createObjectURL' packages/web/src/utils/video*WithFfmpeg.ts` 返回 0 → BUG-154 ✅ 可关
- [ ] `git grep 'revokeObjectURL' packages/web/src/apps/project/components/mixedEditor/node/videoNode/videoNode.tsx` 返回 ≥ 6(每个 callsite 一处)→ BUG-168 ✅ 可关
- [ ] 新文件 `packages/web/src/utils/uploadBlob.ts` 存在
- [ ] `resolveVideoResultNode` 含 `startsWith('blob:')` guard(防御深度证据)
- [ ] PR body 明确说明 BUG-156 / BUG-130 的 server 端部分**不在本 scope**,还在 backlog

---

**提交渠道**:本文件在 `bugs_list` 分支 `docs/internal/audit/fix-plans/` 目录,merge 进 main 后 dev 可以参考。
