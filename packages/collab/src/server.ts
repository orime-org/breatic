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
import * as Y from "yjs";
import { createAuthHook } from "./auth.js";
import { createPersistenceExtension, ensureTable } from "./persistence.js";
import { getCollabConfig } from "./config.js";
import pino from "pino";

const logger = pino({ name: "hocuspocus" });

/** External infra config (env-based, not in YAML). */
export interface CollabServerInfra {
  databaseUrl: string;
  redisUrl: string;
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

  await ensureTable(infra.databaseUrl);

  const authRedis = new IoRedis(infra.redisUrl);

  // Build extensions list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extensions: any[] = [
    createPersistenceExtension(infra.databaseUrl),
    new RedisExtension({
      host: new URL(infra.redisUrl).hostname,
      port: Number(new URL(infra.redisUrl).port) || 6379,
      options: {
        db: Number(new URL(infra.redisUrl).pathname.slice(1)) || 0,
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

    onDisconnect: async ({ documentName, context }) => {
      const ctx = context as { user?: { id: string } };
      logger.info({ documentName, userId: ctx.user?.id }, "Client disconnected");
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
