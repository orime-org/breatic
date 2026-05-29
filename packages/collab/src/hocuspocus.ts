/**
 * Hocuspocus server configuration.
 *
 * Configures Hocuspocus with:
 * - PostgreSQL persistence (document storage)
 * - Redis extension (multi-instance sync)
 * - Throttle extension (connection rate limiting)
 * - Authentication hook (session token verification)
 *
 * All tunable parameters are loaded from `config/collab.yaml`.
 */

import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { createRedisClient, createPgClient } from "@breatic/core";
import { Throttle } from "@hocuspocus/extension-throttle";
import * as Y from "yjs";
import {
  parseDocName,
  SpaceRpcRequestSchema,
  type ProjectRole,
  type SpaceRpcResponse,
} from "@breatic/shared";
import { createAuthHook } from "@collab/auth.js";
import { projectAwarenessIntoMetaUsers } from "@collab/awareness-meta-users.js";
import { checkWriteAuthz, WriteAuthzError } from "@collab/before-handle-message.js";
import { createPersistenceExtension } from "@collab/persistence.js";
import { getCollabConfig } from "@collab/config.js";
import { cleanupOnDisconnect } from "@collab/disconnect-cleanup.js";
import { handleSpaceRpc } from "@collab/space-rpc.js";
import { createLogger } from "@collab/logger.js";

const logger = createLogger("hocuspocus");

/** External infra config (env-based, not in YAML). */
export interface CollabServerInfra {
  databaseUrl: string;
  /** General Redis (DB 0) — session verification in auth hook. */
  redisUrl: string;
  /** Stream Redis (DB 2) — Hocuspocus cross-instance pub/sub. */
  streamRedisUrl: string;
  envPrefix: string;
}

/**
 * Create and configure a Hocuspocus server instance.
 *
 * Behavior parameters are loaded from `config/collab.yaml`.
 * Infrastructure connections (DB, Redis) are passed as arguments.
 *
 * @param infra - Database and Redis connection details
 * @returns Configured Server + Hocuspocus instances
 */
export async function createCollabServer(infra: CollabServerInfra): Promise<{ server: Server; hocuspocus: Hocuspocus }> {
  const cfg = getCollabConfig();

  // Session lookup client for the onAuthenticate hook. Routes
  // through the core `createRedisClient` factory so it picks up
  // the production-safety defaults (keepAlive / commandTimeout /
  // reconnectOnError / error logging tagged `collab-auth`) —
  // bare `new IoRedis(url)` was the exact pattern that left the
  // long-running dev:collab drift without a server-side trail.
  const authRedis = createRedisClient(infra.redisUrl, {
    name: "collab-auth",
  });
  // Shared PG pool for space-rpc handlers (soft-delete / restore the
  // canvas-{spaceId} `yjs_documents` row). Auth and persistence each
  // own their own pool today — consolidating is a follow-up cleanup.
  // Uses core `createPgClient` so `idle_timeout` / `max_lifetime` /
  // `application_name` stay aligned with the server-side default.
  const sharedSql = createPgClient(infra.databaseUrl, {
    name: "collab-shared",
    max: 5,
  });

  // Build extensions list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extensions: any[] = [
    createPersistenceExtension(infra.databaseUrl),
    new RedisExtension({
      // Hocuspocus extension-redis supports an explicit `createClient`
      // factory; when present it bypasses the bare `new RedisClient(
      // port, host, options)` path and uses our factory for both the
      // pub and sub connections (extension calls `createClient()`
      // twice — once per role). This is the only way to get the
      // keepAlive / READONLY-aware reconnect / error tagging into the
      // pub-sub pair the extension opens.
      createClient: () =>
        createRedisClient(infra.streamRedisUrl, {
          name: "collab-hocuspocus-pubsub",
        }),
      prefix: `${infra.envPrefix}:hocuspocus`,
    }),
  ];

  // Throttle extension (optional)
  if (cfg.throttle_enabled) {
    extensions.push(
      new Throttle({
        throttle: cfg.throttle_max_attempts,
        banTime: cfg.throttle_ban_time,
      }),
    );
  }

  const wsServer = new Server({
    port: cfg.port,
    quiet: cfg.quiet,

    // Document lifecycle
    unloadImmediately: cfg.unload_immediately,
    debounce: cfg.debounce,
    maxDebounce: cfg.max_debounce,

    // Authentication — verifies session token AND per-project
    // ownership. See packages/collab/src/auth.ts.
    onAuthenticate: createAuthHook({
      redis: authRedis,
      envPrefix: infra.envPrefix,
      databaseUrl: infra.databaseUrl,
    }),

    // Extensions
    // Cast: pnpm hoisting causes duplicate @hocuspocus/server types
    extensions: extensions as never[],

    // Connection limit per document
    onConnect: async ({ documentName, context, socketId }) => {
      const ctx = context as { user?: { id: string } };

      // Check max connections per document
      if (cfg.max_connections_per_document > 0) {
        const doc = wsServer.hocuspocus.documents.get(documentName);
        if (doc && doc.getConnectionsCount() >= cfg.max_connections_per_document) {
          throw new Error(
            `Document "${documentName}" has reached the maximum of ${cfg.max_connections_per_document} connections`,
          );
        }
      }

      logger.info({ documentName, userId: ctx.user?.id, socketId }, "Client connected");
    },

    // `meta.users[userId]` population (2026-05-27 awareness rewrite):
    // the front-end writes `user` into awareness via
    // `provider.awareness.setLocalStateField('user', { id, name, avatarUrl })`
    // and we project it into `meta.users[userId]` here. Awareness is
    // declarative — `setLocalStateField` re-fires for any
    // `currentUser` deps change in `useProjectMeta`, so a user
    // renaming themselves in settings flows through automatically
    // (the prior `users:upsert-self` stateless RPC path missed this
    // because its `sentForProviderRef` guard skipped re-sends).
    //
    // Anti-spoof: only awareness state whose `user.id` matches the
    // connection-context user is honored. Multi-collab-instance dedup
    // falls out of the same check — remote-synced updates land here
    // with a non-matching (or empty) context.user.id and are
    // rejected without writing.
    //
    // Debounce: cursor / selection awareness updates would fire this
    // hook at sub-second rates. The helper diffs the user fields and
    // throttles the `lastSeenAt` refresh to one transact per user
    // per 30s — see `awareness-meta-users.ts`.
    onAwarenessUpdate: async ({
      documentName,
      document,
      awareness,
      added,
      updated,
      context,
    }) => {
      const parsed = parseDocName(documentName);
      if (!parsed || parsed.kind !== "meta") return;
      const ctx = context as { user?: { id?: string } };
      projectAwarenessIntoMetaUsers({
        documentName,
        document,
        awareness,
        added,
        updated,
        contextUserId: ctx.user?.id,
        now: Date.now(),
      });
    },

    onDisconnect: async ({ documentName, context }) => {
      const ctx = context as { user?: { id: string } };
      const userId = ctx.user?.id;
      logger.info({ documentName, userId }, "Client disconnected");
      // Mini-tool state-machine cleanup (ADR 2026-05-11). Strips
      // operationLocks and finishes frontend-driver handling nodes the
      // disconnected client was running.
      if (userId) {
        try {
          await cleanupOnDisconnect(wsServer.hocuspocus, documentName, userId);
        } catch (err) {
          // Cleanup failure is non-fatal — we logged the error inside the
          // helper. Continue so Hocuspocus's own disconnect bookkeeping
          // finishes cleanly.
          logger.error({ err, documentName, userId }, "disconnect cleanup failed");
        }
      }
    },

    // Client write authorization — refuses direct writes to
    // meta.spaces / meta.projectMessages / meta.perUser[someone else].
    // Per ADR 2026-05-23-yjs-collab-only-write-authz.
    beforeHandleMessage: async ({ documentName, document, update, context }) => {
      try {
        checkWriteAuthz({
          documentName,
          document,
          update,
          context: context as { user?: { id?: string } },
        });
      } catch (e) {
        if (e instanceof WriteAuthzError) {
          logger.warn(
            { documentName, err: e.message },
            "write_authz_rejected",
          );
        }
        throw e;
      }
    },

    // Stateless RPC dispatcher — Space lifecycle (space:* / messages:*).
    // Client sends a JSON-encoded `SpaceRpcRequest` on the meta doc;
    // we parse, route to the handler, and broadcast the response back
    // to all connected clients of this meta doc (caller filters by
    // request `id`).
    onStateless: async ({ documentName, document, payload, connection }) => {
      const parsed = parseDocName(documentName);
      if (!parsed || parsed.kind !== "meta") return;

      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        return; // non-JSON stateless message (e.g. frontend cache invalidate)
      }

      const reqResult = SpaceRpcRequestSchema.safeParse(json);
      if (!reqResult.success) return;
      const req = reqResult.data;

      const ctx = (connection.context ?? {}) as {
        user?: { id?: string; role?: ProjectRole; name?: string };
      };
      const callerId = ctx.user?.id;
      const callerRole = ctx.user?.role;
      if (!callerId || !callerRole) {
        document.broadcastStateless(
          JSON.stringify({
            id: req.id,
            ok: false,
            error: { code: "FORBIDDEN", message: "Anonymous caller" },
          } satisfies SpaceRpcResponse),
        );
        return;
      }

      const response = await handleSpaceRpc(
        { hocuspocus: wsServer.hocuspocus, sql: sharedSql },
        parsed.projectId,
        { userId: callerId, role: callerRole },
        req,
      );
      document.broadcastStateless(JSON.stringify(response));
    },

    // Document size limit — reject updates that would exceed max
    onChange: async ({ documentName, document }) => {
      if (cfg.max_document_bytes > 0) {
        const size = Y.encodeStateAsUpdate(document).byteLength;
        if (size > cfg.max_document_bytes) {
          logger.warn(
            { documentName, size, limit: cfg.max_document_bytes },
            "Document exceeds max size limit",
          );
          // Note: Hocuspocus does not support rejecting individual updates.
          // This log serves as an alert. To enforce hard limits, implement
          // a custom extension that closes connections on oversized documents.
        }
      }

      // (Per-user write-boundary enforcement now lives in
      // `beforeHandleMessage` → `checkWriteAuthz`, per ADR
      // 2026-05-23-yjs-collab-only-write-authz. The old onChange
      // audit-log was telemetry-only and has been retired.)
    },
  });

  logger.info({
    port: cfg.port,
    unloadImmediately: cfg.unload_immediately,
    debounce: cfg.debounce,
    throttle: cfg.throttle_enabled,
    maxConnectionsPerDoc: cfg.max_connections_per_document,
  }, "Hocuspocus server configured");

  return { server: wsServer, hocuspocus: wsServer.hocuspocus };
}
