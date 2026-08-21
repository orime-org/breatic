// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
// The lot-based engine (#11): the only writer of a lot's lifecycle, its
// designation, and what is left on it.
export * as creditLotService from "@domain/credit/creditLot.service.js";
export * as creditLotRepo from "@domain/credit/creditLot.repo.js";

// ── Studio auth (loadStudioRole + studio_members repo; server+worker) ──
export * as studioAuthService from "@domain/auth/studioAuth.service.js";
export * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";

// ── Task (+ markCompletedAndBill: task·credit cross-table atomic) ─
export * as taskService from "@domain/task/task.service.js";
export * as taskRepo from "@domain/task/task.repo.js";

// ── Node history (per-node content timeline, append-only) ────────
export * as nodeHistoryService from "@domain/node-history/node-history.service.js";
export * as nodeHistoryRepo from "@domain/node-history/node-history.repo.js";

// ── Asset (physical asset registry: within-studio dedup + attribution + usage) ──
export * as assetService from "@domain/asset/asset.service.js";
export * as assetRepo from "@domain/asset/asset.repo.js";

// ── Agent (AIGC execution kernel: model / tools / skill loading / prompt extraction) ──
export { getModel, resolveProvider } from "@domain/agent/llm.js";
export { generateTextRetry, streamTextRetry } from "@domain/agent/model-call.js";
export { buildToolSet, BASELINE_TOOLS, TOOLS_THAT_BLOCK } from "@domain/agent/tools/index.js";
export { buildAgentConfig } from "@domain/agent/agent-config.js";
export { assertSkillUsable } from "@domain/agent/skill-gate.js";
export {
  assertSkillModelRunnable,
  checkSkillModelRunnable,
} from "@domain/agent/skill-availability.js";
export type { SkillModelCheck } from "@domain/agent/skill-availability.js";
export { finalizeTurn } from "@domain/agent/turn-finalizer.js";
export type { TurnSteps, TurnStepFailure } from "@domain/agent/turn-finalizer.js";
export type { AgentConfigRequest, ResolvedAgentConfig } from "@domain/agent/agent-config.js";
export { getSkillRegistry, SkillRegistry } from "@domain/agent/skills-loader.js";
export { extractPromptText } from "@domain/agent/extract-prompt.js";

// ── Model catalog (incl. per-call credit cost: cost_per_call) ────
export * as modelCatalog from "@domain/model-catalog/model-catalog.js";
export { listAvailableModels, estimateTaskCredits, violatesSourceRequirementForModel, violatesReferenceCountForModel, MIN_TASK_CREDIT_COST, getFullModelConfig } from "@domain/model-catalog/model-catalog.js";
export type { ReferenceCountViolation } from "@domain/model-catalog/reference-count.js";
export type { SkillModelInfo, FullModalityConfig, FullModelEntry, FullProviderEndpoint, FullParamSpec, ProviderConnectionConfig } from "@domain/model-catalog/model-catalog.js";

// ── Canvas node lock (overwrite lock; prevents concurrent-overwrite credit loss; spec §10.15.2) ──
export {
  CANVAS_LOCK_TTL_SECONDS,
  canvasNodeLockKey,
  acquireCanvasNodeLock,
  readCanvasNodeLockHolder,
  releaseCanvasNodeLock,
  reacquireCanvasNodeLock,
} from "@domain/canvas-lock/canvas-lock.js";
