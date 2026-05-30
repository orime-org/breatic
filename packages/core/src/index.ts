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
export { db, rawPg, closeDb, createPgClient } from "@core/db/client.js";
export { runMigrations } from "@core/db/migrate.js";
export { createTestDb, migrateDatabase } from "@core/db/test-support.js";
export type { TestDb } from "@core/db/test-support.js";
export * as schema from "@core/db/schema.js";

// ── Config ───────────────────────────────────────────────────────
export { env, MONOREPO_ROOT } from "@core/config/env.js";
// Injection boundary: application entries (server / worker / collab)
// read process.env once at startup and call initCore to inject the
// validated config. Library code reads it via the `env` Proxy above.
export { initCore, getConfig, getRawEnvVar } from "@core/config/runtime.js";
export type { CoreConfig } from "@core/config/schema.js";
export { getWorkerConfig } from "@core/config/worker.js";
export type { WorkerConfig } from "@core/config/worker.js";
export { getAgentConfig } from "@core/config/loader.js";
export * as modelCatalog from "@core/config/model-catalog.js";
export { getPricingTiers, findTierByName, findTierByPriceId } from "@core/config/pricing.js";
export { getModelForTool, getPromptForTool } from "@core/config/text-tools.js";

// ── Infrastructure ───────────────────────────────────────────────
export {
  getRedis,
  closeRedis,
  getQueueRedis,
  closeQueueRedis,
  getStreamRedis,
  closeStreamRedis,
  createRedisClient,
} from "@core/infra/redis.js";
export { checkRateLimit } from "@core/infra/rate-limiter.js";
export {
  startHealthServer,
  type HealthCheck,
  type HealthServerOptions,
} from "@core/infra/health-server.js";
export { checkInfraReady } from "@core/infra/connectivity-check.js";
export { InfraNotReadyError } from "@core/infra/errors.js";
export { createQueue, createWorker, defaultJobOpts, closeQueues } from "@core/infra/queue.js";
export { downloadAndStore, getStorageAdapter, storageKey } from "@core/infra/storage/index.js";
export { publishNodeEvent } from "@core/infra/event-stream.js";
export { publishMembersChanged } from "@core/infra/control-events.js";
export { sendMail } from "@core/infra/mailer.js";
export type { SendMailResult, SendMailOptions } from "@core/infra/mailer.js";
export { setSession, getSession, deleteSession, deleteAllSessions } from "@core/infra/session-store.js";
export { runWithContext, tryGetContext, getContext } from "@core/infra/request-context.js";
export { getStripeClient, verifyWebhookSignature } from "@core/infra/stripe.js";

// ── Services (all business logic) ────────────────────────────────
export * as taskService from "@core/modules/task.service.js";
export * as taskRepo from "@core/modules/task.repo.js";
export * as creditService from "@core/modules/credit.service.js";
export * as creditRepo from "@core/modules/credit.repo.js";
export * as nodeHistoryService from "@core/modules/node-history.service.js";
export * as nodeHistoryRepo from "@core/modules/node-history.repo.js";
export * as userRepo from "@core/modules/user.repo.js";
export * as authService from "@core/modules/auth.service.js";
export * as conversationService from "@core/modules/conversation.service.js";
export * as conversationRepo from "@core/modules/conversation.repo.js";
export * as memoryService from "@core/modules/memory.service.js";
export * as memoryRepo from "@core/modules/memory.repo.js";
export * as paymentService from "@core/modules/payment.service.js";
export * as projectService from "@core/modules/project.service.js";
export * as projectRepo from "@core/modules/project.repo.js";
export * as yjsDocRepo from "@core/modules/yjs-doc.repo.js";
export * as projectAuthService from "@core/modules/projectAuth.service.js";
export * as projectMembersService from "@core/modules/projectMembers.service.js";
export * as projectMembersRepo from "@core/modules/projectMembers.repo.js";
export * as shareLinkService from "@core/modules/shareLink.service.js";
export * as shareLinkRepo from "@core/modules/shareLink.repo.js";
export * as shareInviteMail from "@core/modules/share-invite-mail.js";
export * as notificationService from "@core/modules/notification.service.js";
export * as notificationRepo from "@core/modules/notification.repo.js";
export * as roleUpgradeRequestService from "@core/modules/roleUpgradeRequest.service.js";
export * as studioService from "@core/modules/studio.service.js";
export * as studioRepo from "@core/modules/studio.repo.js";
export * as skillService from "@core/modules/skill.service.js";
export * as textToolService from "@core/modules/text-tool.service.js";
export * as attachmentService from "@core/modules/conversation-attachment.service.js";

// ── Agent ────────────────────────────────────────────────────────
export { getModel, resolveProvider } from "@core/agent/llm.js";
export { buildToolSet, DEFAULT_TOOLS } from "@core/agent/tools/index.js";
export { getSkillRegistry, SkillRegistry } from "@core/agent/skills-loader.js";
export { listAvailableModels } from "@core/config/model-catalog.js";
export type { SkillModelInfo } from "@core/config/model-catalog.js";
export { loadAgents, getAgent, listAgents } from "@core/agent/agent-loader.js";
export type { AgentDefinition } from "@core/agent/agent-loader.js";
export { extractPromptText } from "@core/agent/extract-prompt.js";

// ── i18n (node-side adapter; engine lives in @breatic/shared) ──
export { loadLocales, runWithLocale } from "@core/i18n/locale-loader.js";

// ── Utilities ────────────────────────────────────────────────────
export { extractVideoCover } from "@core/video-cover.js";
export { logger, initLogger } from "@core/logger.js";
export {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ConflictLockedError,
  ValidationError,
  UnauthorizedError,
} from "@core/errors.js";
export type { ConflictLockedDetail } from "@core/errors.js";

// Canvas node Redis lock (spec §10.15.2)
export {
  CANVAS_LOCK_TTL_SECONDS,
  canvasNodeLockKey,
  acquireCanvasNodeLock,
  readCanvasNodeLockHolder,
  verifyCanvasNodeLock,
  releaseCanvasNodeLock,
} from "@core/infra/canvas-lock.js";
