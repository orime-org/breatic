/**
 * @breatic/core — shared backend runtime.
 *
 * All business logic, infrastructure, agent capabilities, and
 * configuration. Imported by @breatic/server, @breatic/worker,
 * and @breatic/collab.
 */

// ── Database ─────────────────────────────────────────────────────
export { db, rawPg, closeDb } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export * as schema from "./db/schema.js";

// ── Config ───────────────────────────────────────────────────────
export { env, MONOREPO_ROOT } from "./config/env.js";
export { getWorkerConfig } from "./config/worker.js";
export type { WorkerConfig } from "./config/worker.js";
export { getAgentConfig } from "./config/loader.js";
export * as modelCatalog from "./config/model-catalog.js";
export { getPricingTiers, findTierByName, findTierByPriceId } from "./config/pricing.js";
export { getModelForTool, getPromptForTool } from "./config/text-tools.js";

// ── Infrastructure ───────────────────────────────────────────────
export { getRedis, closeRedis } from "./infra/redis.js";
export { createQueue, createWorker, defaultJobOpts, closeQueues } from "./infra/queue.js";
export { downloadAndStore, getStorageAdapter, storageKey } from "./infra/storage/index.js";
export { publishNodeEvent } from "./infra/event-stream.js";
export { acquireNodeLock, releaseNodeLock } from "./infra/canvas-lock.js";
export { setSession, getSession, deleteSession, deleteAllSessions } from "./infra/session-store.js";
export { runWithContext, tryGetContext, getContext } from "./infra/request-context.js";
export { getStripeClient, verifyWebhookSignature } from "./infra/stripe.js";

// ── Services (all business logic) ────────────────────────────────
export * as taskService from "./modules/task.service.js";
export * as taskRepo from "./modules/task.repo.js";
export * as creditService from "./modules/credit.service.js";
export * as creditRepo from "./modules/credit.repo.js";
export * as nodeHistoryService from "./modules/node-history.service.js";
export * as nodeHistoryRepo from "./modules/node-history.repo.js";
export * as userRepo from "./modules/user.repo.js";
export * as authService from "./modules/auth.service.js";
export * as conversationService from "./modules/conversation.service.js";
export * as conversationRepo from "./modules/conversation.repo.js";
export * as memoryService from "./modules/memory.service.js";
export * as memoryRepo from "./modules/memory.repo.js";
export * as paymentService from "./modules/payment.service.js";
export * as projectService from "./modules/project.service.js";
export * as projectRepo from "./modules/project.repo.js";
export * as skillService from "./modules/skill.service.js";
export * as textToolService from "./modules/text-tool.service.js";
export * as attachmentService from "./modules/conversation-attachment.service.js";

// ── Agent ────────────────────────────────────────────────────────
export { getModel, resolveProvider } from "./agent/llm.js";
export { buildToolSet, DEFAULT_TOOLS } from "./agent/tools/index.js";
export { getSkillRegistry, SkillRegistry } from "./agent/skills-loader.js";
export { listAvailableModels } from "./config/model-catalog.js";
export type { SkillModelInfo } from "./config/model-catalog.js";
export { loadAgents, getAgent, listAgents } from "./agent/agent-loader.js";
export type { AgentDefinition } from "./agent/agent-loader.js";

// ── Utilities ────────────────────────────────────────────────────
export { extractVideoCover } from "./video-cover.js";
export { logger } from "./logger.js";
export {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
} from "./errors.js";
