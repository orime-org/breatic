/**
 * @breatic/core — shared backend runtime.
 *
 * Database, Redis, BullMQ, storage, shared services, agent
 * tools/skills, and logging. Imported by both @breatic/server
 * (API) and @breatic/worker (task executor).
 */

// ── Database ─────────────────────────────────────────────────────
export { db, rawPg, closeDb } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export * as schema from "./db/schema.js";

// ── Config ───────────────────────────────────────────────────────
export { env, MONOREPO_ROOT } from "./config/env.js";
export { getWorkerConfig, type WorkerConfig } from "./config/worker.js";

// ── Infrastructure ───────────────────────────────────────────────
export { getRedis, closeRedis } from "./infra/redis.js";
export { createQueue, createWorker, defaultJobOpts, closeQueues } from "./infra/queue.js";
export { downloadAndStore, getStorageAdapter, storageKey } from "./infra/storage/index.js";
export { publishNodeEvent } from "./infra/event-stream.js";

// ── Shared Services ──────────────────────────────────────────────
export * as taskService from "./modules/task.service.js";
export * as creditService from "./modules/credit.service.js";
export * as nodeHistoryService from "./modules/node-history.service.js";
export * as userRepo from "./modules/user.repo.js";

// ── Agent (shared between API chat + Worker skill execution) ─────
export { getModel } from "./agent/llm.js";
export { buildToolSet, DEFAULT_TOOLS, registerTool } from "./agent/tools/index.js";
export { getSkillRegistry, SkillRegistry } from "./agent/skills-loader.js";
export { loadAgents, getAgent, listAgents } from "./agent/agent-loader.js";
export type { AgentDefinition } from "./agent/agent-loader.js";

// ── Video Cover ──────────────────────────────────────────────────
export { extractVideoCover } from "./video-cover.js";

// ── Logging + Errors ─────────────────────────────────────────────
export { logger } from "./logger.js";
export {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
} from "./errors.js";
