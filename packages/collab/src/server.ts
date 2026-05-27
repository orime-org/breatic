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
import { Throttle } from "@hocuspocus/extension-throttle";
import IoRedis from "ioredis";
import postgres from "postgres";
import * as Y from "yjs";
import {
  parseDocName,
  SpaceRpcRequestSchema,
  type ProjectRole,
  type SpaceRpcResponse,
} from "@breatic/shared";
import { createAuthHook, ensureUserInMetaDoc } from "./auth.js";
import { checkWriteAuthz, WriteAuthzError } from "./before-handle-message.js";
import { createPersistenceExtension } from "./persistence.js";
import { getCollabConfig } from "./config.js";
import { cleanupOnDisconnect } from "./disconnect-cleanup.js";
import { handleSpaceRpc } from "./space-rpc.js";
import { createLogger } from "./logger.js";

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

  const authRedis = new IoRedis(infra.redisUrl);
  // Shared PG pool for space-rpc handlers (soft-delete / restore the
  // canvas-{spaceId} `yjs_documents` row). Auth and persistence each
  // own their own pool today — consolidating is a follow-up cleanup.
  const sharedSql = postgres(infra.databaseUrl, { max: 5 });

  // Build extensions list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extensions: any[] = [
    createPersistenceExtension(infra.databaseUrl),
    new RedisExtension({
      host: new URL(infra.streamRedisUrl).hostname,
      port: Number(new URL(infra.streamRedisUrl).port) || 6379,
      options: {
        db: Number(new URL(infra.streamRedisUrl).pathname.slice(1)) || 0,
      },
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

    // Q11 v2 — ensure `meta.users[userId]` reflects the latest
    // username + avatar so ProjectMessagesButton and friends can
    // render display names via a live Yjs lookup. Runs in
    // `afterLoadDocument` (NOT `onConnect`) because the Hocuspocus
    // hook order is `onConnect → connected → onAuthenticate →
    // onLoadDocument → afterLoadDocument`. context.user is populated
    // by onAuthenticate, so any pre-auth hook sees `context.user =
    // undefined` and the ensure call silently no-ops.
    //
    // CRITICAL — fire-and-forget. Awaiting `ensureUserInMetaDoc`
    // here deadlocks the WebSocket: `openDirectConnection` opens a
    // second connection to the SAME meta doc, and Hocuspocus
    // serializes doc-level work so the inner connection can never
    // resolve while the outer `afterLoadDocument` is still awaiting.
    // The end-to-end symptom is "Client connected" firing on every
    // reconnect attempt with no `onSynced` ever landing (banner
    // stuck at 'connecting'). The fix is to dispatch the write off
    // the hook's promise — the meta.users entry usually lands a few
    // hundred ms after sync completes, and the frontend renders an
    // em-dash for the brief window where the actor lookup misses.
    afterLoadDocument: async ({ documentName, context }) => {
      const ctx = context as {
        user?: {
          id?: string;
          name?: string;
          avatarUrl?: string | null;
        };
      };
      const parsed = parseDocName(documentName);
      if (!parsed || !ctx.user?.id || !ctx.user.name) return;
      const userId = ctx.user.id;
      const userName = ctx.user.name;
      const avatarUrl = ctx.user.avatarUrl ?? null;
      ensureUserInMetaDoc(wsServer.hocuspocus, parsed.projectId, {
        id: userId,
        name: userName,
        avatarUrl,
      }).catch((err) => {
        logger.error(
          { err, documentName, userId },
          "ensure_user_in_meta_doc_failed",
        );
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
