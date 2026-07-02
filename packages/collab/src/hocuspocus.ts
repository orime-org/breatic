// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import {
  createLogger,
  createRedisClient,
  getRedis,
  getCollabRedis,
} from "@breatic/core";
import { createLoopbackExemptThrottle } from "@collab/infra/loopback-exempt-throttle.js";
import {
  createConnectionRegistry,
  type ConnectionRegistry,
} from "@collab/services/connection-registry.js";
import { shouldTrackConnection } from "@collab/services/connection-tracking.js";
import * as Y from "yjs";
import {
  parseDocName,
  SpaceRpcRequestSchema,
  type ProjectRole,
  type SpaceRpcResponse,
} from "@breatic/shared";
import { createAuthHook } from "@collab/hooks/auth.js";
import { projectAwarenessIntoMetaUsers } from "@collab/hooks/awareness-meta-users.js";
import { checkWriteAuthz, WriteAuthzError } from "@collab/hooks/before-handle-message.js";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import { getCollabConfig } from "@collab/config.js";
import { cleanupOnDisconnect } from "@collab/hooks/disconnect-cleanup.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";

const logger = createLogger("hocuspocus");

/** External infra config (env-based, not in YAML). */
export interface CollabServerInfra {
  /** Collab Redis (DB 3) — Hocuspocus cross-instance pub/sub + space-delete lock. */
  collabRedisUrl: string;
  envPrefix: string;
}

/**
 * Create and configure a Hocuspocus server instance.
 *
 * Behavior parameters are loaded from `config/collab.yaml`.
 * Infrastructure connections (DB, Redis) are passed as arguments.
 * @param infra - Database and Redis connection details
 * @returns Configured Server + Hocuspocus instances + the cross-instance connection registry (caller stops its heartbeat on shutdown)
 */
export async function createCollabServer(infra: CollabServerInfra): Promise<{ server: Server; hocuspocus: Hocuspocus; connectionRegistry: ConnectionRegistry }> {
  const cfg = getCollabConfig();

  // Cross-instance connection registry (#1421). Records each connection
  // in Redis DB3 (the collab-coordination singleton — same connection
  // family as the Hocuspocus pub/sub + the space-delete lock) so the
  // per-document connection cap counts across instances, not just this
  // process's local connections. `instanceId` namespaces this process's
  // members cluster-wide: hostname + pid for log correlation, plus a
  // random suffix so a pid reused after a container restart never
  // collides with a crashed predecessor's not-yet-expired members.
  const instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const connectionRegistry = createConnectionRegistry({
    redis: getCollabRedis(),
    instanceId,
  });
  connectionRegistry.start();

  // Session lookup client for the onAuthenticate hook. Uses the
  // process-wide `getRedis()` singleton (DB 0, the same general-purpose
  // client server / worker use) — a session GET is a plain command, so
  // it shares the per-process singleton rather than hand-rolling a
  // dedicated client. Subscriber / stream / Hocuspocus pub-sub
  // connections below stay separate (protocol requires dedicated
  // sockets for blocking / subscribe modes).
  const authRedis = getRedis();

  // Build extensions list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extensions: any[] = [
    createPersistenceExtension(),
    new RedisExtension({
      // Hocuspocus extension-redis supports an explicit `createClient`
      // factory; when present it bypasses the bare `new RedisClient(
      // port, host, options)` path and uses our factory for both the
      // pub and sub connections (extension calls `createClient()`
      // twice — once per role). This is the only way to get the
      // keepAlive / READONLY-aware reconnect / error tagging into the
      // pub-sub pair the extension opens.
      createClient: () =>
        createRedisClient(infra.collabRedisUrl, {
          name: "collab-hocuspocus-pubsub",
        }),
      prefix: `${infra.envPrefix}:hocuspocus`,
    }),
  ];

  // Throttle extension (optional) — loopback-exempt so a developer's own
  // machine / health probes are never rate-banned (every dev tab shares the
  // loopback IP and trips the threshold in seconds). Real client IPs (carried
  // via x-forwarded-for behind a load balancer) are still throttled.
  if (cfg.throttle_enabled) {
    extensions.push(
      createLoopbackExemptThrottle({
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
      maxConnectionsPerDoc: cfg.max_connections_per_document,
      // Cluster-wide count via the cross-instance registry (#1421), NOT
      // the local `getConnectionsCount()` (which only sees this process).
      // The count excludes this connection: registration happens later, in
      // the `connected` hook (below), so a connection never counts against
      // its own cap check.
      countConnections: (documentName: string): Promise<number> =>
        connectionRegistry.count(documentName),
    }),

    // Extensions
    // Cast: pnpm hoisting causes duplicate @hocuspocus/server types
    extensions: extensions as never[],

    onConnect: async ({ documentName, context, socketId }) => {
      const ctx = context as { user?: { id: string } };
      // The per-document connection cap is decided in onAuthenticate
      // (degrade to read-only); the connection is registered in the
      // cross-instance registry by the `connected` hook below (bound to the
      // Connection lifecycle so it stays symmetric with onDisconnect).
      // onConnect (which fires before auth) only logs.
      logger.info({ documentName, userId: ctx.user?.id, socketId }, "Client connected");
    },

    // Register this connection in the cross-instance registry for the
    // per-document cap (#1421). The `connected` hook fires only AFTER
    // Hocuspocus has created the Connection object (and wired its
    // onClose → onDisconnect), so a member registered here is guaranteed
    // to be unregistered by onDisconnect — the two are bound to the same
    // Connection lifecycle. A connection that passes auth but then fails
    // during document load never reaches `connected`, so it never leaks a
    // phantom member (registering in onAuthenticate instead would, because
    // onDisconnect never fires for a connection whose load failed). Meta
    // docs are exempt from the cap → not tracked.
    connected: async ({ documentName, socketId }) => {
      if (shouldTrackConnection(documentName)) {
        await connectionRegistry.register(documentName, socketId);
      }
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

    onDisconnect: async ({ documentName, context, socketId }) => {
      const ctx = context as { user?: { id: string } };
      const userId = ctx.user?.id;
      // Symmetric to the `connected` registration (#1421): remove this
      // connection from the cross-instance registry on clean disconnect,
      // so the count drops immediately (a crash instead lets it expire via
      // the registry TTL). onDisconnect fires for exactly the connections
      // the `connected` hook registered (both bound to the Connection
      // object's lifecycle). Meta / non-project docs were never tracked.
      if (shouldTrackConnection(documentName)) {
        await connectionRegistry.unregister(documentName, socketId);
      }
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
        { hocuspocus: wsServer.hocuspocus },
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

  return { server: wsServer, hocuspocus: wsServer.hocuspocus, connectionRegistry };
}
