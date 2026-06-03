/**
 * `@breatic/domain` — AIGC business kernel shared by server + worker.
 *
 * Holds the business logic both server and worker need but collab never
 * touches: the credit "spend" side (credit + `markCompletedAndBill`
 * atomic deduction) / tasks / node history / agent (model · tools ·
 * skill loading) / model-catalog / canvas-lock.
 *
 * Dependency direction `shared ← core ← domain ← {server, worker}`:
 * domain may only import `@breatic/core` + `@breatic/shared`, never any
 * application package (`@server` / `@worker` / `@collab` / `@web`), and
 * collab never depends on domain. Both directions are enforced by CI
 * guards. See the root CLAUDE.md + docs/ARCHITECTURE.md for the
 * package-placement decision tree and the three-layer boundary.
 */

// ── Credit (the "spend" side: deduction + balance + ledger) ──────
export * as creditService from "@domain/credit/credit.service.js";
export * as creditRepo from "@domain/credit/credit.repo.js";

// ── Task (+ markCompletedAndBill: task·credit cross-table atomic) ─
export * as taskService from "@domain/task/task.service.js";
export * as taskRepo from "@domain/task/task.repo.js";

// ── Node history (per-node content timeline, append-only) ────────
export * as nodeHistoryService from "@domain/node-history/node-history.service.js";
export * as nodeHistoryRepo from "@domain/node-history/node-history.repo.js";

// ── Agent (AIGC execution kernel: model / tools / skill loading / prompt extraction) ──
export { getModel, resolveProvider } from "@domain/agent/llm.js";
export { buildToolSet, DEFAULT_TOOLS } from "@domain/agent/tools/index.js";
export { getSkillRegistry, SkillRegistry } from "@domain/agent/skills-loader.js";
export { loadAgents, getAgent, listAgents } from "@domain/agent/agent-loader.js";
export type { AgentDefinition } from "@domain/agent/agent-loader.js";
export { extractPromptText } from "@domain/agent/extract-prompt.js";

// ── Model catalog (incl. per-call credit cost: cost_per_call) ────
export * as modelCatalog from "@domain/model-catalog/model-catalog.js";
export { listAvailableModels } from "@domain/model-catalog/model-catalog.js";
export type { SkillModelInfo } from "@domain/model-catalog/model-catalog.js";

// ── Canvas node lock (overwrite lock; prevents concurrent-overwrite credit loss; spec §10.15.2) ──
export {
  CANVAS_LOCK_TTL_SECONDS,
  canvasNodeLockKey,
  acquireCanvasNodeLock,
  readCanvasNodeLockHolder,
  verifyCanvasNodeLock,
  releaseCanvasNodeLock,
} from "@domain/canvas-lock/canvas-lock.js";
