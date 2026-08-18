// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `@breatic/core` — shared backend runtime.
 *
 * All business logic, infrastructure, agent capabilities, and
 * configuration. Imported by `@breatic/server` and `@breatic/worker`.
 *
 * `@breatic/collab` also depends on this package: it reaches for the
 * shared infrastructure (connection factories / logging / config)
 * AND the shared authentication kernel (session-store + the
 * `projectMembers` repo + `loadProjectRole` + `membership.repo`, from
 * which it takes the per-document writable-connection ceiling). Auth /
 * session / role / tier is "must be identical across every backend
 * service" logic, so it lives here once instead of being hand-rolled
 * per service. collab
 * does NOT touch `@breatic/domain` (server+worker-only AIGC business).
 */

// ── Database ─────────────────────────────────────────────────────
export { db, rawPg, pingDb, closeDb, createPgClient } from "@core/db/client.js";
export { yjsDb, yjsRawPg, closeYjsDb } from "@core/db/client.js";
export type { DbTx, YjsDbTx } from "@core/db/client.js";
export { runMigrations, runYjsMigrations } from "@core/db/migrate.js";
export { createTestDb, migrateDatabase, migrateYjsDatabase } from "@core/db/test-support.js";
export type { TestDb } from "@core/db/test-support.js";
export * as schema from "@core/db/schema.js";
// Yjs document store schema (separate database — see `yjsDb`). Exported
// so the collab-side repo can import the table definition from core.
// Wildcard re-export (not a named `{ yjsDocuments }`) so the
// breatic/no-yjs-documents-outside-repo guard's symbol scan doesn't
// trip on the barrel — it gates QUERIES, and a re-export isn't one.
export * from "@core/db/yjs-schema.js";
// Pure initial-meta-doc encoder — stays in core (no DB dependency);
// collab's lazy-seed imports it. The `yjs_documents` query repo itself
// MOVED to `@breatic/collab` (collab is the sole runtime owner after the
// two-DB cutover — server's lifecycle ops go through the outbox stream).
export {
  defaultSpaceName,
  encodeInitialMetaState,
  writeSpaceEntry,
} from "@core/db/yjs-bootstrap.js";
export type { SpaceEntryInit, SpaceKind } from "@core/db/yjs-bootstrap.js";
export { loadInitialSpaceType } from "@core/db/project-seed.repo.js";
// Table values + Drizzle row types, also re-exported by name so server
// modules can `import { projects } from "@breatic/core"`. `schema` (the
// namespace, above) stays the canonical form for bulk access.
export * from "@core/db/schema.js";

// ── Config ───────────────────────────────────────────────────────
export { env, MONOREPO_ROOT } from "@core/config/env.js";
// Injection boundary: application entries (server / worker / collab)
// read process.env once at startup and call initCore to inject the
// validated config. Library code reads it via the `env` Proxy above.
export { initCore, getConfig, getRawEnvVar } from "@core/config/runtime.js";
export type { CoreConfig } from "@core/config/schema.js";
export { getWorkerConfig } from "@core/config/worker.js";
export type { WorkerConfig } from "@core/config/worker.js";
export { getStorageConfig } from "@core/config/storage.js";
export type { StorageConfig } from "@core/config/storage.js";
export {
  getMembershipConfig,
  getMembershipLimits,
  getDefaultMembershipTier,
} from "@core/config/membership.js";
export type { MembershipConfig, MembershipLimits } from "@core/config/membership.js";
export {
  getSubscriptionPlans,
  getSubscriptionPlan,
  findSubscribableTierByPriceId,
  getSubscriptionStaleAfterDays,
  getStripeReadTimeoutMs,
  resetSubscriptionConfigCache,
} from "@core/config/subscription.js";
export type {
  SubscriptionPlan,
  SubscriptionPlans,
} from "@core/config/subscription.js";
export { jitterBackoffStrategy } from "@core/infra/retry.js";
export { getAgentConfig } from "@core/config/loader.js";
export { getSkillRouting, resetSkillRouting, SKILL_SURFACES } from "@core/config/skill-routing.js";
export type { SkillRoute, SkillRouting, SkillSurface } from "@core/config/skill-routing.js";

// ── Infrastructure ───────────────────────────────────────────────
export {
  getRedis,
  closeRedis,
  getQueueRedis,
  closeQueueRedis,
  getStreamRedis,
  closeStreamRedis,
  getCollabRedis,
  closeCollabRedis,
  createRedisClient,
  pingRedis,
} from "@core/infra/redis.js";
// Re-export the ioredis client type so consumers (collab subscriber
// clients, domain canvas-lock) type their client refs without taking a
// direct `ioredis` dependency — the driver lives only in core.
export type { Redis } from "ioredis";
export { checkRateLimit } from "@core/infra/rate-limiter.js";
export {
  startHealthServer,
  type HealthCheck,
  type HealthServerOptions,
} from "@core/infra/health-server.js";
export { runGracefulShutdown } from "@core/infra/graceful-shutdown.js";
export type { GracefulShutdownDeps } from "@core/infra/graceful-shutdown.js";
export { checkInfraReady } from "@core/infra/connectivity-check.js";
export { InfraNotReadyError } from "@core/infra/errors.js";
export { createQueue, createQueueEvents, createWorker, defaultJobOpts, closeQueues } from "@core/infra/queue.js";
export { downloadAndStore, getStorageAdapter, storageKey, sha256Hex } from "@core/infra/storage/index.js";
export { sniffMimeType } from "@core/infra/storage/sniff-mime.js";
export type { PersistedObject } from "@core/infra/storage/index.js";
export { sendMail } from "@core/infra/mailer.js";
export type { SendMailOptions, SendMailResult } from "@core/infra/mailer.js";
export {
  publishNodeEvent,
  publishToStream,
  taskEventsStreamKey,
  lifecycleStreamKey,
} from "@core/infra/event-stream.js";
export {
  publishMembersChanged,
  publishActivityNew,
  projectControlChannelPattern,
} from "@core/infra/control-events.js";
export { setSession, getSession, deleteSession, deleteAllSessions, sessionCookieName } from "@core/infra/session-store.js";
export { runWithContext, tryGetContext, getContext } from "@core/infra/request-context.js";

// ── Shared auth kernel (collab + server share these) ──────────────
// Everything a backend service needs to answer "who is this and what may
// they do here": the project_members repo, the `loadProjectRole`
// primitive (server `requireRole` middleware AND collab
// `onAuthenticate` — auth must be identical across services), the
// projects and activity repos, and `membership.repo` — the one door to
// the tier ceilings, which is why collab reads
// `getProjectConcurrentEditorLimit` from here rather than walking to a
// tier its own way. Server-private domain (auth /
// project / payment / user.repo / stripe / mailer / pricing / ...)
// lives in @server/src; AIGC business shared by server+worker (credit /
// task / node-history / agent / model-catalog / canvas-lock) lives in
// @breatic/domain — collab never touches it.
export * as projectMembersRepo from "@core/auth/projectMembers.repo.js";
export * as projectsRepo from "@core/project/projects.repo.js";
export {
  projectActivitiesRepo,
  encodeActivityCursor,
  decodeActivityCursor,
} from "@core/activity/project-activities.repo.js";
export type {
  NewProjectActivity,
  ActivityCursor,
} from "@core/activity/project-activities.repo.js";
export * as projectAuthService from "@core/auth/projectAuth.service.js";
export {
  asKnownTier,
  getUserMembershipTier,
  getStudioMembershipTier,
  getLimitsForUser,
  getLimitsForStudio,
  getProjectConcurrentEditorLimit,
  lockLimitsForUser,
  lockAccountRow,
  changeMembershipTier,
  TIER_CHANGE_REASONS,
} from "@core/auth/membership.repo.js";
export type { TierChangeReason } from "@core/auth/membership.repo.js";
// Subscriptions: the rows, and the reading that turns them into the situation
// an account is in. The reading is here rather than in server because the
// ceilings above are read here too, and a subscription whose paid period ran
// out says the tier on the account is stale.
export {
  listSubscriptions,
  upsertSubscription,
} from "@core/auth/subscription.repo.js";
export type {
  StoredSubscription,
  SubscriptionWrite,
} from "@core/auth/subscription.repo.js";
export {
  subscriptionSituation,
  tierForSituation,
  STRIPE_SUBSCRIPTION_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
} from "@core/auth/subscription-state.js";
export type {
  StripeSubscriptionStatus,
  SubscriptionRecord,
  SubscriptionSituation,
  SituationReading,
} from "@core/auth/subscription-state.js";

// ── i18n (node-side adapter; engine lives in @breatic/shared) ──
export { loadLocales, runWithLocale } from "@core/i18n/locale-loader.js";

// ── Utilities ────────────────────────────────────────────────────
export { logger, initLogger, createLogger } from "@core/infra/logger.js";
export {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ConflictLockedError,
  ValidationError,
  UnauthorizedError,
} from "@core/app-errors.js";
export type { ConflictLockedDetail } from "@core/app-errors.js";
