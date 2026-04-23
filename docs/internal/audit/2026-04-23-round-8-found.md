# Audit Round 8 — 发现快照

**审计日期**:2026-04-23(slim,夜间)
**对应代码**:`origin/main` HEAD `41dc590`(含 PR #144 合入 video editor workspace + exporters + TTS placeholder · PR #149 mixed-editor toolbar / dev proxy fix + CI guard)
**审计方法**:单 agent slim,严守 3 主题(exporters 持久化 / timeline 资源 / CSP systemic)
**发现总数**:8 个新条目(0 P0 + 3 P1 MED + 5 P2 LOW)

> Agent 运行时长 ~6.5 分钟,不 timeout,**再次验证**"≤ 3 主题 / agent" 规则(Round 7 8 min / Round 8 6.5 min)

## 编号映射

| Agent 临时编号 | 全局 BUG 编号 |
|---|---|
| BUG-R8-01 | BUG-177 |
| BUG-R8-02 | BUG-178 |
| BUG-R8-03 | BUG-179 |
| BUG-R8-04 | BUG-180 |
| BUG-R8-05 | BUG-181 |
| BUG-R8-06 | BUG-182 |
| BUG-R8-07 | BUG-183 |
| BUG-R8-08 | BUG-184 |

## 最大正面观察:若干 pattern 没有复发

Round 8 的**反面**发现:PR #144 新增的 video editor workspace + exporters + timeline 代码里,以下既有 bug pattern **都没复发**:

- **BUG-070/071/165**(memory leak / listener cleanup systemic):新代码所有 mount/unmount 对称**全部合格**,无任何 listener / RAF / observer leak
- **BUG-153**(ffmpeg.wasm CDN 供应链):新 exporters 是 stub,零 FFmpeg / CDN 引用
- **BUG-154**(blob URL 写 Yjs):新 exporters 不输出 blob URL
- **BUG-093 / 164**(useYjsStore 误用 nodeId):新代码全部走 PR #138/#140 建立的 `useYjsNodeEditor` / `MixedEditorDataContext` 模式,无新复发

这说明:前几轮 audit 的 findings 已经**进入 dev 团队的 defensive 习惯**。audit 的价值在于**增量改善 code culture**,不只是挑单点问题。

---

# Round 8 Audit — PR #144 (feat/video-editor 第二批)

**范围**:`packages/web/src/utils/videoEditor/` 新三件 exporters、`packages/web/src/apps/videoEditor/` 全新 workspace + timeline + preview、TTS placeholder、CSP / 安全 header systemic 复查。

**审计时间**:2026-04-24
**基准 commit**:`41dc590`(bugs_list 已 FF 到 origin/main HEAD)
**覆盖文件**:`imageExporter.ts`(38L) · `videoExporter.ts`(32L) · `audioExporter.ts`(23L) · `apps/videoEditor/**`(共 ~4.5k 行,15 个组件) · `TextToSpeechPlaceholderNode/Panel`(23L + 268L) · `docker/nginx*.conf` · `docker/breatic-locations.conf` · `packages/web/src/index.html` · `packages/server/src/**` · Round 6 BUG-136 原文

---

## 主题 1:Exporters 的持久化 / revoke / CDN 耦合

**结论**(一句话):PR #144 的三件 exporters 全部是 **stub/占位实现**,零 FFmpeg、零 CDN、零 blob: URL、零 revoke。BUG-153 / BUG-154 的 pattern **未复发**到新 exporters。但 UI 调用侧的"Blob → 保存"链路本身缺失,**export UX 路径未完成就已合入 main**。

### 现状

| 文件 | 行数 | 实际实现 |
|---|---|---|
| `imageExporter.ts` | 38 | 画一个 "Preview export (stub)" 灰底 canvas,toBlob PNG。不碰媒体 |
| `videoExporter.ts` | 32 | 返回一个 `text/plain` 的 TextEncoder blob,内容是一句英文告示 |
| `audioExporter.ts` | 23 | 返回一个 `new Blob([], { type: 'audio/wav' })`,完全空 |

- 没有 `import { FFmpeg } ...`、没有 `cdn.jsdelivr.net`、没有 `URL.createObjectURL`(搜 `revokeObjectURL` / `createObjectURL` in `utils/videoEditor/*.ts` = 0 命中)
- `exportAsMP4` / `exportFrameAsPNG` / `exportAudio` 都返回原始 `Blob`,签名 clean,给调用侧下载保存用
- `VideoExportOptions` / `AudioExportOptions` 字段完整,**但所有字段都是 `_options` 前缀忽略**(下划线参数占位,TS lint 允许)

### ✅ 没有复发的:

- BUG-153(cdn.jsdelivr.net): 无 FFmpeg import → 无 CDN 引入
- BUG-154(blob: URL → `data.content`): 签名返回 Blob,由 caller 决定怎么持久化。**但**下面的新问题提醒该路径迟早会写,需要前置防御

### ⚠️ 但仍需记录的 finding:

---

### BUG-177:Video/Audio Exporter 是"假成功"占位,用户以为导出成功实际只下了几十字节

- **严重度**:🟠 MED(UX / 用户信任 / 数据完整性认知)
- **位置**:
  - `packages/web/src/utils/videoEditor/videoExporter.ts:27-31`
  - `packages/web/src/utils/videoEditor/audioExporter.ts:20-22`
- **问题**:
  - `exportAsMP4` 把进度推到 100%,但返回的 Blob 是 `text/plain` 里写"Video export is not bundled in this dev build"。调用侧若直接 `a.download='export.mp4'; a.click()` 会下载一个 **MIME 伪装的 txt 文件**,用户双击播放会失败,但没人告诉他"这是 stub"
  - `exportAudio` 更糟:返回空 blob,`audio/wav` 标签,用户以为导出了 0 字节音频
  - 没有 `throw new Error('not implemented')`、没有 UI 显示"功能未就绪"、**进度条推到 100% = UI 说谎**
  - `exportFrameAsPNG` 稍好(画了个灰底字样),但同样冒充真实导出
- **修复方案**(简述):
  - 短期:在函数内显式 `throw new Error('Video export is not implemented in this build — please use server-side export')`;UI 层在按钮处展示"Coming soon" banner,而不是走进度条
  - 中期:export UI 全部下线/灰掉,直到真正的 FFmpeg pipeline ready
  - 长期:FFmpeg pipeline 上线前,在 `VideoEditor` 顶部加个 `exportImplemented` flag,import exporter 前先检查,否则不渲染 Export 按钮
- **测试规约**(spec for dev CC to implement):
  - Unit: `exportAsMP4(clips, items, '16:9', setProgress, opts)` → expect `throws Error /not implemented/`(断言错误消息明确提示未实现)
  - Unit: `exportAudio(...)` → expect `throws`(同上)
  - Integration: 渲染 `<ExportPanel>` 点击"Export MP4" → expect 看到 "Coming soon" 文案或按钮 disabled,**不应**看到 "100%" 后下载了一个 txt 文件
  - Boundary: 传入 signal.aborted=true → expect `AbortError`(保持现有行为)
- **预估**:30m(throw + UI disable;真正实现 FFmpeg pipeline 不在本 bug 范围)

---

### BUG-178:imageExporter 尺寸 clamp 到 1920×1080,忽视 `_resolution` 参数但签名仍暴露

- **严重度**:🟡 LOW(接口契约 + 未来 regression 风险)
- **位置**:`packages/web/src/utils/videoEditor/imageExporter.ts:21-22`
- **问题**:
  - 签名接受 `_resolution: string`,但实现 `canvas.width = Math.max(2, Math.min(width, 1920))`
  - `_resolution` / `_imageFormat` 参数下划线忽略 → 4K / 8K 调用者传了也没用,**无警告**
  - 未来有人替换实现时,很容易误以为 clamp 到 1920 是故意的业务约束,把上限硬编码带进生产
- **修复方案**:
  - 短期:在函数入口加 `console.warn('[imageExporter] stub implementation, resolution/imageFormat ignored')`(dev only)
  - 中期:用 TSDoc 明确标 `@deprecated stub — replace with real compositor`,避免误用
- **测试规约**:
  - Unit: `exportFrameAsPNG(..., '4K', ..., '16:9')` → expect 返回 blob 且 `blob.size > 0`(保留现行为),但控制台有 stub warning
  - Boundary: `getBaseCanvasSize` 返回 `{ width: 3840, height: 2160 }` → expect canvas.width 最终为 1920(记录该限制为"已知 stub 行为",等真正实现时移除)
- **预估**:15m

---

## 主题 2:Timeline / workspace 资源管理 + N² 风险

**结论**(一句话):React mount/unmount 对称性总体合格(mouse listener / ResizeObserver / wheel / click 都有 cleanup),但 **drag 路径的 N²+ CPU 爆表** + **播放计时器 drift** + **displayDuration 读取 DOM ref 但不在 deps** 三个实际问题。没发现 BUG-070/071/165 pattern 的 systemic 复发。

### ✅ 合格的 mount/unmount 对:

| 位置 | listener/observer | cleanup |
|---|---|---|
| `timeline/ClipItem.tsx:137-143` | mousemove/up | ✅ `removeEventListener` |
| `timeline/PlaybackCursor.tsx:92-100` | mousemove/up + body style | ✅ 反向清理 + body reset |
| `timeline/TrackRow.tsx:42-51` | ResizeObserver | ✅ `disconnect()` |
| `timeline/TrackRow.tsx:64-68` | scroll listener | ✅ removeEventListener |
| `preview/InfiniteCanvas.tsx:184-188, 251-255` | click/wheel(capture: true) | ✅ removeEventListener(capture: true) |
| `preview/PreviewCanvas.tsx:273-291` | window resize + ResizeObserver | ✅ 按分支清理 |
| `preview/PreviewCanvas.tsx:392-399` | 多级 setTimeout refs | ✅ unmount 时 clearTimeout |
| `preview/FullscreenPreview.tsx:108-117` | fullscreenchange | ✅ removeEventListener |
| `rightPanel/FontSelector.tsx:147` | mousedown | ✅ cleanup(见 useEffect) |
| `rightPanel/CropModal.tsx:246-247, 307` | mousemove/up + ResizeObserver | ✅ |
| `videoEditor/index.tsx:80-93` | setInterval 播放帧 | ✅ `clearInterval` in return |

---

### BUG-179:`handleDragMove` 在每个 mousemove 帧做 O(N) 三次扫描,100 clip 时 CPU 可能 10x 浪费

- **严重度**:🟠 MED(大项目性能 / 用户感知卡顿)
- **位置**:`packages/web/src/apps/videoEditor/components/timeline/TimelineEditor.tsx:397-484`(`handleDragMove`) + `:20-34`(`checkCollision`) + `:37-69`(`snapToPosition`)
- **问题**:
  - `handleDragMove` 每次 drag move 事件(典型 60Hz)都做以下 O(N) 扫描,N = clips 总数:
    1. `clips.find(c => c.id === itemId)` — O(N)
    2. `snapToPosition(newStart, ...)` — 内部 `clips.forEach(push snapPoints)` + `snapPoints.forEach`, O(N)
    3. `snapToPosition(newEnd, ...)` — 同上,再一次 O(N)
    4. `clips.filter(c.trackIndex === overTrackIndex && c.id !== itemId)` — O(N)
    5. `for (const targetClip of targetTrackClips) ... overlap check` — O(K),K ≤ N
    6. `clips.some((c) => c.id !== itemId && c.trackIndex === overTrackIndex)` — O(N)
  - 单帧 ≈ 6N 次操作;100 clips × 60Hz × 6 = **36,000 ops/sec** 仅因拖一个片段,没算其他状态更新触发的 React re-render
  - `handleDragEnd`(line 487-646) 更糟:`clips.map(...)` 全量 rebuild(O(N)),包含 3 个 find/filter/some。拖结束瞬间单帧 rebuild 数千对象,**大项目 GC 压力**
  - `dragSourceTrackRef.current = clip.trackIndex` 缓存了 source track,本可以用相同 pattern 缓存 `clipById`(Map)
  - `checkCollision`(line 20-34)另外 O(N),每次 drag 多调 2 次
- **修复方案**(简述):
  - 用 `useMemo(() => new Map(clips.map(c => [c.id, c])), [clips])` 替 `clips.find` → O(1) 查找
  - 用 `useMemo(() => groupBy(clips, 'trackIndex'), [clips])` 换 `clips.filter(trackIndex===...)` → O(1) 取某轨 clips
  - `snapPoints` 同一 drag session 内可 memoize(ref),只在 `clips` 或 `draggingClipId` 变化时重建
  - `handleDragMove` 内联 throttle/rAF(16ms 节流),避免 60Hz × N²
  - 参考飞书/剪映等真实 timeline 编辑器:用 interval tree 或 R-tree 索引 overlap,直接 O(log N)
- **测试规约**:
  - Unit: `snapToPosition(5.0, 0, clips_100, 'clip-50')` → expect 执行时间 < 1ms(100 clips 基准)
  - Unit: `buildClipIndex(clips_500)` → `index.get('clip-42')` → expect O(1) 不走 find
  - Integration: 模拟 500 clips 场景 drag 一个片段 100ms,用 `performance.now()` 前后对比 → expect 单次 `handleDragMove` < 2ms(P95)
  - Boundary: clips=0 → `handleDragMove` 不 throw;clips=10000 → 单次 `handleDragMove` < 16ms(不掉帧)
- **预估**:2-3h(memoize + index 重构)

---

### BUG-180:`setInterval(..., 33)` 播放计时 drift + 不使用 `performance.now()` delta,长视频会偏移

- **严重度**:🟡 LOW(UX / 长视频累积误差)
- **位置**:`packages/web/src/apps/videoEditor/index.tsx:78-94`
- **问题**:
  - `setInterval(() => setCurrentTime(prev => prev + 0.033), 33)`
  - setInterval 在浏览器 throttle tab 或 CPU 占用高时会拖延,`0.033` 是假设每 tick 真的是 33ms → 实际可能 50ms+,**当前时间会比真实视频时间慢**
  - 在 10 分钟视频中 1-2% drift = 几秒偏移,导致 playhead 与视频 `<video>` 元素的 `currentTime` 不同步
  - `requestAnimationFrame` + `performance.now()` delta 才是正解(剪映 / Premiere 的做法)
  - 同时 `0.033 * 60Hz` 只有 ~1.98 fps 更新精度(因为 setInterval 33ms 最低粒度),比 rAF 粗
- **修复方案**:
  - 改用 rAF + `performance.now()` 计算 delta,`setCurrentTime(prev => prev + (now - lastNow) / 1000)`
  - 或者把 `currentTime` 完全从 `<video>.currentTime` 读取,UI 只跟随,不自己维护
- **测试规约**:
  - Unit: mock `performance.now()` 返回 `[0, 50, 100]`,驱动 rAF loop 3 次 → expect `currentTime` 精确到 `[0, 0.05, 0.1]`(而不是固定 `+0.033`)
  - Integration: 播放 60s 视频,每 1s 对比 `currentTime` 与 `video.currentTime`,|差| < 50ms
  - Boundary: tab hidden / visibilityState=hidden → expect 计时器不累积(或正确 pause)
- **预估**:40m

---

### BUG-181:`useMemo` 读取 `containerRef.current?.clientWidth` 但 ref 不在 deps,容器尺寸变化后 `displayDuration` stale

- **严重度**:🟡 LOW(视觉抖动 / 响应式布局边界)
- **位置**:`packages/web/src/apps/videoEditor/components/timeline/TimelineEditor.tsx:649-675`
- **问题**:
  - `const { displayDuration, scaleContainerWidth } = useMemo(() => { const containerWidth = containerRef.current?.clientWidth || window.innerWidth - 270; ... }, [clips, pixelsPerSecond, draggingMaxEnd]);`
  - ref 当前值被读但不在 deps。窗口 resize 或布局重算 → `containerRef.current.clientWidth` 变了,**但 useMemo 不重算**(除非 clips/pixelsPerSecond/draggingMaxEnd 其一变)
  - 结果:用户拉宽浏览器,时间轴刻度条仍然是旧容器宽度。下一次 clips 变化才追上
  - Workaround 写的 `|| window.innerWidth - 270` 说明作者知道这有问题,但没彻底解决
- **修复方案**:
  - 把 `containerWidth` 通过 ResizeObserver 放到 state,加进 deps
  - 或改 `useMemo` 为普通函数,在每次 render 时计算(containerWidth 随渲染读)—— 但 re-render 频率高,需考虑性能
- **测试规约**:
  - Unit: render `<TimelineEditor>`,触发 `window.resize` 改容器宽度 → expect `displayDuration` 重算
  - Integration: 用 `@testing-library/react` 调 `resize`,断言 `<TimelineScale width=...>` 的 width 属性变化
  - Boundary: containerRef.current = null(初始 render) → expect 用 `window.innerWidth - 270` fallback 不崩
- **预估**:20m

---

### BUG-182:`TimelineScale.drawScale` 刻度线数量无上限,超长时间轴 + 细粒度 zoom 会在 canvas 画数万条线

- **严重度**:🟡 LOW(极端场景,默认 zoom 不会触发;但无 guard)
- **位置**:`packages/web/src/apps/videoEditor/components/timeline/TimelineScale.tsx:70-93`(`drawScale` loop)
- **问题**:
  - `const totalSubScales = Math.ceil(duration / subScaleTime);` 无上限
  - `scale` 由 `useState(8)` 初始,subScaleTime = scale / scaleSplitCount
  - 假设用户导入 60 分钟视频(3600s)+ 缩放到 scale=0.1、scaleSplitCount=10 → subScaleTime=0.01 → **360,000 次 ctx.stroke/fillText** 每帧
  - Canvas 2D 对单次 strokeText 调用没有硬限,但 React 每次 zoom 或 time 变化 `useEffect` 重跑 drawScale,性能退化
  - 无 `Math.min(totalSubScales, MAX_TICKS)` 兜底
- **修复方案**:
  - 加常量 `const MAX_TICKS = 10_000`,`const effective = Math.min(totalSubScales, MAX_TICKS)`
  - 或在 scale / duration 超过阈值时,强制 `scaleSplitCount = 1`(只画主刻度,省掉次刻度)
- **测试规约**:
  - Unit: `drawScale(ctx, { duration: 36000, scale: 0.1, scaleSplitCount: 10, ... })` → expect `ctx.stroke` 调用次数 ≤ MAX_TICKS
  - Boundary: `duration=0` → expect loop 不执行,ctx 无调用
  - Boundary: `subScaleTime → 0` 避免死循环(如果 scale/split 异常,应 early return)
- **预估**:15m

---

### BUG-183:`console.log` 大量留存于生产代码(InfiniteCanvas clickHandler 每次点击都打印)

- **严重度**:🟡 LOW(性能细微 + 日志污染 + 禁止清单违规)
- **位置**:`packages/web/src/apps/videoEditor/components/preview/InfiniteCanvas.tsx:151, 166-174, 179` + `timeline/TimelineEditor.tsx:627`
- **问题**:
  - `InfiniteCanvas.tsx` 的 clickHandler 每次点击都 `console.log('[InfiniteCanvas clickHandler]', {...})`,含 target 全量 className、tagName、id 细节
  - `CLAUDE.md` 禁止清单和 `typescript/coding-style.md` 都明确 "No `console.log` statements in production code"
  - `TimelineEditor.tsx:627` 的 `console.warn('⚠️ 碰撞检测:...')` 也算日志输出到 user console
  - 性能影响小(每次点击 1 次),但 user devtools 打开会被刷屏;生产 monitoring 也捕获不到结构化信息
- **修复方案**:
  - 删除所有 `console.log` 或改走 `import.meta.env.DEV && console.log(...)` 保留 dev only
  - 碰撞检测 warning 改走 toast / UI feedback,不进 console
- **测试规约**:
  - Lint: ESLint `no-console` rule enforce(允许 warn/error 但禁止 log)—— 加到 CI
  - Unit: 渲染 `<InfiniteCanvas>` + click → expect `console.log` 未被调用(vitest spy on console)
- **预估**:15m

---

## 主题 3:CSP / 安全 header systemic 状态复查

**结论**(一句话):Round 6 BUG-136 **依然未修**,而且 grep 结果证实:**全仓零安全 header**(Hono / nginx / index.html 三层零命中)。按用户指示开独立编号 `BUG-184`,说明 systemic **且升级触发面**,**不并入** BUG-136(BUG-136 停留在 R5 原始 LOW 记录)。

### 验证

```bash
# Hono app / server 中间件
grep -rni "helmet|content-security-policy|x-frame-options|x-content-type-options|strict-transport-security|secureHeaders" packages/server/
# → 0 hits

# web 前端 index.html meta
grep -ni "http-equiv" packages/web/src/index.html
# → 0 hits

# nginx 配置(三个 conf)
grep -ni "add_header|X-Frame|X-Content|Content-Security|Strict-Transport|Referrer-Policy|Permissions-Policy" \
  docker/nginx.conf docker/nginx-ssl.conf docker/breatic-locations.conf
# → 0 hits

# web 前端其他(service worker / helmet 类)
grep -rni "helmet|content-security-policy" packages/web/
# → 0 hits
```

`nginx-ssl.conf` 仅设 `ssl_protocols TLSv1.2 TLSv1.3` + `ssl_ciphers HIGH:!aNULL:!MD5`(含老 DES-CBC3,不是 Mozilla intermediate),**没有**:

- `add_header Strict-Transport-Security` (HSTS 缺失 → 首次 HTTP 访问可被 MITM 降级)
- `add_header X-Content-Type-Options nosniff` (uploads MIME sniff 风险)
- `add_header X-Frame-Options DENY` / `Content-Security-Policy "frame-ancestors 'none'"` (clickjacking)
- `add_header Referrer-Policy` (泄漏 URL 到第三方)
- `add_header Permissions-Policy` (geo / camera / mic 默认权限)
- `/uploads/` location 没有 `Content-Disposition: attachment`(LLM 生成 HTML 上传后直接以 text/html 打开 → 存储型 XSS)

---

### BUG-184:Security header set 仍 systemic 缺失;PR #131 后 XSS 修复减少,但无 CSP 无纵深防御

- **严重度**:🟠 MED(按用户指示升级 — systemic 重复发现 + 触发面新增)
  - 注:BUG-136 原为 🟡 LOW,R5 发现后未修;R8 在 **新增了 videoEditor 路由 + exporter UI + LLM-generated HTML (BUG-137 path) + XSS 尚未全量修的背景下**,LOW 不再合适。建议 Round 8 验证这条后优先级拉到 MED,不并入 BUG-136
- **位置**:
  - `packages/server/src/app.ts`(无 `app.use('*', secureHeaders(...))`)
  - `docker/breatic-locations.conf`(无 `add_header`)
  - `docker/nginx-ssl.conf`(无 HSTS + ssl_ciphers 包含老协议)
  - `packages/web/src/index.html`(无 CSP meta 作为 fallback)
- **问题**(叠加 R6 后的新触发面):
  - **Round 6 之后新增的触发面**:
    - PR #144 引入 videoEditor 独立路由,exporter 产生的 Blob 若未来写 `a.download` 触发,无 CSP 限制 `script-src` → 任何上传污染即可 RCE
    - LLM-generated 输出(agent / mini-tool / text-tool SSE)渲染到 UI → 即便 DOMPurify 漏过一个 pattern,无 CSP 兜底
    - BUG-137(历史 LOW)`content: z.string().url()` 接受任意 URL,若前端 iframe 或 `<img>` 直接渲染用户提交的外链,无 `frame-ancestors` / `img-src`
  - **为什么不能并入 BUG-136**:
    - 用户明确指示"独立编号追踪 systemic 部署",避免 R5 LOW 被长期拖延
    - BUG-136 描述聚焦 "加 secureHeaders + add_header",本 bug 强调 **完整 header set 交付 + CI enforce + 新触发面**
    - 闭 BUG-184 即同步闭 BUG-136;闭 BUG-136 不等于闭 BUG-184(后者要求 enforcement)
- **修复方案**(简述):
  1. **Hono 层**(`server/src/app.ts`):
     ```ts
     import { secureHeaders } from 'hono/secure-headers';
     app.use('*', secureHeaders({
       contentSecurityPolicy: {
         defaultSrc: ["'self'"],
         scriptSrc: ["'self'"],
         styleSrc: ["'self'", "'unsafe-inline'"], // if inline CSS is needed
         imgSrc: ["'self'", 'data:', env.UPLOAD_BASE_URL],
         connectSrc: ["'self'", env.API_URL, 'wss:' + env.COLLAB_WS_HOST],
         frameAncestors: ["'none'"],
       },
       xFrameOptions: 'DENY',
       strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
       xContentTypeOptions: 'nosniff',
       referrerPolicy: 'strict-origin-when-cross-origin',
     }));
     ```
  2. **nginx 层**(`breatic-locations.conf` 全局 + `/uploads/` 加强):
     ```nginx
     add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
     add_header X-Content-Type-Options "nosniff" always;
     add_header X-Frame-Options "DENY" always;
     add_header Referrer-Policy "strict-origin-when-cross-origin" always;
     add_header Permissions-Policy "geolocation=(), camera=(), microphone=()" always;
     location /uploads/ {
       add_header Content-Disposition "attachment" always;
       add_header X-Content-Type-Options "nosniff" always;
     }
     ```
  3. **nginx-ssl.conf**:`ssl_ciphers` 替换为 Mozilla intermediate cipherlist + `ssl_prefer_server_ciphers on;`
  4. **CI enforcement**:加 integration test 调 `curl -I https://...` → expect 8 个 header 都存在;任何回归挂测
  5. **index.html meta fallback**(仅兜底,SPA 生产不靠它):`<meta http-equiv="Content-Security-Policy" content="...">`
- **测试规约**(spec):
  - Integration: `GET /api/health` → expect response headers 包含 `{ "Strict-Transport-Security": /max-age=\d+/, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": /default-src 'self'/, "Referrer-Policy": /./, "Permissions-Policy": /./ }`
  - Integration: `GET /uploads/<some-file>` → expect `Content-Disposition: attachment`
  - Unit: render `<script src="https://evil.com/x.js">` in DOM → CSP 应 block(浏览器行为,E2E 验证 window.onerror 捕获 CSP violation)
  - E2E(Playwright): 打开 `/project/:id`,用 devtools check `document.contentSecurityPolicy` / response headers → expect 8 项 header
  - Boundary: 访问 `http://` 版本(非 SSL) → expect 301 到 https + HSTS 生效(第二次访问直接 HTTPS)
  - Regression: CI 断言 `docker/breatic-locations.conf` 必须含 `add_header X-Content-Type-Options`(grep-based config test)
- **预估**:2-3h(Hono + nginx + CI enforce + 手动 csp 兼容测试)

---

## Summary

- **总 findings**:8 个
- **严重度分布**:🟠 MED × 3(R8-01 exporter stub 伪装成功 / R8-03 drag N² CPU / R8-08 CSP systemic 升级) · 🟡 LOW × 5(R8-02 imageExporter 尺寸 clamp / R8-04 setInterval drift / R8-05 useMemo stale ref / R8-06 TimelineScale 刻度无上限 / R8-07 console.log 生产残留)
- **BUG-153 / BUG-154 pattern 复发**:**未复发**(PR #144 的 exporters 是 stub,零 FFmpeg,零 blob: URL 写 `data.content`)
- **BUG-070/071/165 systemic pattern 复发**:**未复发**(mount/unmount 对称性全部合格)
- **BUG-136(CSP)复查**:**仍未修**,且新增触发面 → 独立编号 BUG-184,严重度按用户指示升级为 MED
- **合规性**:PR #144 虽引入新路由,但 exporter 路径的 "100% 进度 + 伪 blob" 是"stub 伪装成功"范式的第一例,值得作为**测试规约**样本(UI 说谎 = MED 严重度基线)
