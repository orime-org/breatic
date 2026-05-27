/**
 * @breatic/core — shared backend runtime.
 *
 * All business logic, infrastructure, agent capabilities, and
 * configuration. Imported by @breatic/server and @breatic/worker.
 *
 * @breatic/collab intentionally does NOT depend on this package —
 * it's a deliberately lightweight Hocuspocus process and reaches
 * for ioredis / postgres-js directly to avoid pulling in the full
 * core dependency graph (drizzle / openrouter / etc). See
 * `packages/collab/src/auth.ts` for the rationale.
 */

// ── Database ─────────────────────────────────────────────────────
export { db, rawPg, closeDb, createPgClient } from "./db/client.js";
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
export {
  getRedis,
  closeRedis,
  getQueueRedis,
  closeQueueRedis,
  getStreamRedis,
  closeStreamRedis,
  createRedisClient,
} from "./infra/redis.js";
export { checkRateLimit } from "./infra/rate-limiter.js";
export { checkInfraReady } from "./infra/connectivity-check.js";
export { createQueue, createWorker, defaultJobOpts, closeQueues } from "./infra/queue.js";
export { downloadAndStore, getStorageAdapter, storageKey } from "./infra/storage/index.js";
export { publishNodeEvent } from "./infra/event-stream.js";
export { publishMembersChanged } from "./infra/control-events.js";
export { sendMail } from "./infra/mailer.js";
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
export * as yjsDocRepo from "./modules/yjs-doc.repo.js";
export * as projectAuthService from "./modules/projectAuth.service.js";
export * as projectMembersService from "./modules/projectMembers.service.js";
export * as projectMembersRepo from "./modules/projectMembers.repo.js";
export * as studioService from "./modules/studio.service.js";
export * as studioRepo from "./modules/studio.repo.js";
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
export { extractPromptText } from "./agent/extract-prompt.js";

// ── Utilities ────────────────────────────────────────────────────
export { extractVideoCover } from "./video-cover.js";
export { logger, initLogger } from "./logger.js";
export {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ConflictLockedError,
  ValidationError,
  UnauthorizedError,
} from "./errors.js";
export type { ConflictLockedDetail } from "./errors.js";

// Canvas node Redis lock (spec §10.15.2)
export {
  CANVAS_LOCK_TTL_SECONDS,
  canvasNodeLockKey,
  acquireCanvasNodeLock,
  readCanvasNodeLockHolder,
  verifyCanvasNodeLock,
  releaseCanvasNodeLock,
} from "./infra/canvas-lock.js";
