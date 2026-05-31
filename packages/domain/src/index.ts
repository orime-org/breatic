/**
 * `@breatic/domain` — server + worker 共享的业务内核(AIGC 业务大脑)。
 *
 * 装 server 和 worker 都要用、但 collab 永不触碰的共享业务:积分"花"侧
 * (credit + `markCompletedAndBill` 原子扣费)/ 任务 / 节点历史 / agent
 * (模型·工具·skill 加载)/ model-catalog / canvas-lock。
 *
 * 依赖方向 `shared ← core ← domain ← {server, worker}`:domain 只可 import
 * `@breatic/core` + `@breatic/shared`,绝不 import 任何应用包(`@server` /
 * `@worker` / `@collab` / `@web`);collab 也绝不依赖 domain。两条方向均由
 * CI 守卫强制。进包判定题与三层边界见根 CLAUDE.md 与 docs/architecture.md。
 *
 * @remarks
 * 契约地基阶段本 barrel 为空壳 —— 业务模块后续自 `@breatic/core` 迁入,
 * 届时此处按功能逐组 re-export。
 */
export {};
