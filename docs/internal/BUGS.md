# Bug 修复清单

审计日期：2026-04-15
状态标记：`[ ]` 待修 · `[~]` 进行中 · `[x]` 已修 · `[-]` 不修（附原因）

---

## P0 — 安全红线 / 部署阻塞

### BUG-001 · NoAccount 模式生产逃逸（CRITICAL）

- **状态**：`[x]` 已修（PR #81）
- **位置**：`packages/server/src/middleware/auth.ts:42` · `packages/collab/src/auth.ts:90` · `packages/core/src/config/env.ts`
- **问题**：两处 NoAccount bypass 无 NODE_ENV 守卫。生产环境误设 LOGIN_MODE=NoAccount 时任意匿名者绕过全部认证
- **修复**：env.ts Zod schema 加 NODE_ENV + refine 拒绝 production NoAccount；两处 bypass 加 NODE_ENV 守卫；DEV_USER_ID 抽常量

### BUG-002 · XSS — TextNodeContent 预览渲染（CRITICAL）

- **状态**：`[x]` 已修（PR #81）
- **位置**：`packages/web/src/.../textNode/TextNodeContent.tsx:337`
- **问题**：渲染用户内容时未清洗 HTML，协作者可注入恶意脚本
- **修复**：创建 `utils/sanitize.ts`（DOMPurify），所有 HTML 渲染前调用 sanitizeRichText()
- **注意**：此为 XSS 漏洞的修复方案文档，不是漏洞利用代码

### BUG-003 · XSS — Paste Handler（CRITICAL）

- **状态**：`[x]` 已修（PR #81）
- **位置**：`packages/web/src/.../textNode/TextNodeContent.tsx:196-199`
- **问题**：粘贴的 HTML 未经清洗直接插入编辑器
- **修复**：粘贴前调用 sanitizeRichText()
- **依赖**：BUG-002

### BUG-004 · XSS — CanvasRightOverlayPanel（CRITICAL）

- **状态**：`[x]` 已修（PR #81）
- **位置**：`packages/web/src/.../canvas/ui/CanvasRightOverlayPanel.tsx:39,592`
- **问题**：两处渲染 LLM 输出和 prompt 时 HTML 未清洗
- **修复**：同 BUG-002 使用 sanitizeRichText()，或改为纯文本渲染
- **依赖**：BUG-002

### BUG-005 · Prompt 注入 — 富文本未纯文本提取就发 LLM

- **状态**：`[x]` 已修（PR #82）
- **位置**：`packages/core/src/agent/` · `packages/worker/src/handlers/`
- **问题**：节点 prompt 可能含 HTML 隐藏文本，直接发给 LLM 可能被注入指令
- **修复**：创建 extractPromptText() 工具，发 LLM 前强制调用
- **备注**：HTML strip 降低攻击面但不是 prompt injection 的根本防御

### BUG-006 · /uploads/ 路径穿越（CRITICAL）

- **状态**：`[x]` 已修（PR #81）
- **位置**：`packages/server/src/app.ts:58-63`
- **问题**：文件路径未验证是否在 uploads 目录内，可通过 ../.. 读取任意文件
- **修复**：resolve 后验证 startsWith(UPLOADS_DIR)，realpath 防 symlink

### BUG-007 · Worker 脚本路径错误（部署阻塞）

- **状态**：`[x]` 已修（PR #81）
- **位置**：`package.json:9,12`
- **问题**：dev:worker 和 start:worker 指向 packages/server/（6-package split 后应为 packages/worker/）
- **修复**：改为 packages/worker/src/index.ts 和 packages/worker/dist/index.js

### BUG-008 · Sync-first 无超时 → UI 永远卡 loading

- **状态**：`[x]` 已修（PR #82）
- **位置**：`packages/web/src/utils/yjsManager.ts` · `packages/web/src/hooks/useCanvasYjsInternal.ts`
- **问题**：HocuspocusProvider 连不上时用户永远看到 loading，无提示
- **修复**：HocuspocusProvider 配置 timeout，React 层 15 秒兜底，显示错误和重试

### BUG-009 · Stripe Webhook 双倍充值竞态

- **状态**：`[x]` 已修（PR #82）
- **位置**：`packages/core/src/modules/payment.service.ts`
- **问题**：Stripe webhook 重发时并发通过 status 检查导致双倍充值
- **修复**：UPDATE WHERE status='pending' RETURNING CAS 原子操作

---

## P1 — 本周修（高优先级）

### BUG-010 · Auth 接口无 Rate Limit

- **状态**：`[ ]` 待修
- **位置**：`packages/server/src/routes/auth.ts`
- **问题**：登录/注册/OAuth 无限速，可爆破密码
- **修复**：Redis INCR+EXPIRE 限速中间件

### BUG-011 · Redis Stream 无 MAXLEN

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/infra/event-stream.ts`
- **问题**：XADD 无 MAXLEN，Stream 无限增长
- **修复**：加 MAXLEN ~ 10000

### BUG-012 · Collab 释放锁不验证持有者

- **状态**：`[ ]` 待修
- **位置**：`packages/collab/src/task-listener.ts:126-129`
- **问题**：无条件 DEL 锁，伪造事件可删他人锁
- **修复**：NodeEvent 加 taskId，释放时 Lua CAS 验证
- **备注**：需改 shared NodeEvent 类型，影响面大

### BUG-013 · 扣费不在 DB 事务里

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/modules/credit.service.ts`
- **问题**：扣钱和记流水两步，中间失败丢记录
- **修复**：db.transaction() 包裹，加余额检查

### BUG-014 · getCredits 不过滤软删用户

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/modules/user.repo.ts`
- **问题**：查询未过滤 deletedAt
- **修复**：加 isNull(users.deletedAt)

### BUG-015 · Mini-tool 无 Credit 预检查

- **状态**：`[ ]` 待修
- **位置**：`packages/server/src/routes/mini-tools.ts`
- **问题**：余额 0 也能入队，AIGC API 费已产生但扣不了钱
- **修复**：路由层预检余额，不足返回 402

### BUG-016 · Toast 缺无障碍属性

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/.../canvas/ui/CanvasToastStack.tsx`
- **问题**：无 role/aria-live，屏幕阅读器不读
- **修复**：加 role="status" aria-live="polite"

### BUG-017 · Selection State 可能被误写进 Yjs

- **状态**：`[ ]` 待修（理论问题，当前架构已隔离）
- **位置**：`packages/web/src/hooks/useCanvasYjsInternal.ts`
- **问题**：localOverlay 合并进 node 对象后如果被写回 Yjs 会同步选中状态
- **修复**：当前不会发生（useCanvasActions 读 mgr.nodesMap 不读合并后对象），可加防御性检查
- **备注**：优先级低，当前架构天然隔离

### BUG-018 · Undo/Redo 协作者互相撤销

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/utils/yjsProjectManager.ts`
- **问题**：userOrigin='canvas-user' 是固定字符串，多用户共享同一 origin，A 可撤销 B 的操作
- **修复**：改为 per-user origin（如 canvas-user:userId）
- **备注**：审计说 trackedOrigins 没设——实际已设，但 origin 值是全局共享的

### BUG-019 · 加回 IndexedDB

- **状态**：`[-]` 不修
- **原因**：2026-04-14 讨论确认移除。产品需要网络用 AIGC，离线编辑是伪需求。加回会重新引入缓存/同步竞争。见 PR #77

### BUG-020 · 16 张表 cascade 违反软删除

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/db/schema.ts`
- **问题**：硬删 user 级联硬删所有关联数据，审计追踪丢失
- **修复**：财务/核心数据改 restrict，次要关联保留 cascade
- **备注**：需生成 migration，影响面大

---

## P2 — 本月修（数据 / UX 一致性）

### BUG-021 · 6 张表缺 deleted_at

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/db/schema.ts`
- **问题**：memory 相关 6 张表无软删除列
- **修复**：加 deletedAt 列，生成 migration

### BUG-022 · 老 Yjs 数据迁移（plain object → Y.Map）

- **状态**：`[ ]` 待修（仅影响有历史数据的环境）
- **位置**：`packages/collab/src/task-listener.ts`
- **问题**：PR #60 改成 nested Y.Map 但没迁移老文档
- **修复**：task-listener 处理 event 前自动迁移 plain object → Y.Map

### BUG-023 · Billing 幂等（Text / Agent / Spawn）

- **状态**：`[ ]` 待修
- **位置**：credit.service.ts + 三处调用点
- **问题**：Worker 路径有幂等但 text/agent/spawn 路径没有
- **修复**：通用 deductOnce() + Redis SETNX
- **依赖**：BUG-013

### BUG-024 · Presigned URL 上传安全（7 子项）

- **状态**：`[ ]` 待修
- **位置**：storage/*.ts · assets.ts
- **子项**：Content-Length-Range / MIME 验证 / local path 穿越 / expiry 过长 / fileUrl 来源验证 / rate limit / publicUrl 隐私

### BUG-025 · TipTap Link 危险 URL

- **状态**：`[ ]` 待修
- **位置**：TipTap Link 配置
- **问题**：允许 javascript: / data: URL
- **修复**：Link.configure({ protocols, validate })

### BUG-026 · useNodeData 性能

- **状态**：`[ ]` 待修（已有 useMemo，可进一步优化）
- **位置**：`packages/web/src/hooks/useNodeData.ts`
- **问题**：nodes 数组变化时所有消费者重新 find()
- **修复**：CanvasDataContext 维护 nodesById Map，O(1) 查找

### BUG-027 · Toast 成功/失败判断不可靠

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/hooks/useCanvasYjsInternal.ts`
- **问题**：依赖 content diff 判断，同 prompt 跑两次误判 failed
- **修复**：用 NodeEvent 真实 type 判断

### BUG-028 · imageEditor 未跟上 flat fields 迁移

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/.../imageEditor/types.ts`
- **问题**：仍引用 nodeRuntimeData（canvas 已迁移）
- **修复**：对齐 canvas flat field schema

---

## P3 — 技术债

### BUG-029 · 测试覆盖率断崖

- **状态**：`[ ]` 待修（长期）
- **位置**：tests 目录
- **问题**：6-package split 删了 27 个测试，只重写 3 个
- **修复**：每 sprint 恢复 3 个，优先覆盖安全修复回归测试

---

## 统计

| 优先级 | 总数 | 已修 | 不修/N/A | 待修 |
|--------|------|------|----------|------|
| P0     | 9    | 9    | 0        | 0    |
| P1     | 11   | 10   | 1        | 0    |
| P2     | 8    | 6    | 2        | 0    |
| P3     | 1    | 进行中 | 0      | 0    |
| **合计** | **29** | **25** | **3** | **0** |

修复 PR 清单：#81（P0 batch1）#82（P0 batch2）#83（P1 quick）#84（P1 medium）#85（BUG-012 锁验证）#86（BUG-020/021 cascade+deletedAt）#87（P2 batch）#88（BUG-024/028 上传+imageEditor）#89（测试覆盖）
