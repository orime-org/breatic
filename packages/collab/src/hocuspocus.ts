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
import { resolve } from "node:path";
import {
  createLogger,
  createRedisClient,
  getRedis,
  getCollabRedis,
  getProjectConcurrentEditorLimit,
  sendMail,
  MONOREPO_ROOT,
} from "@breatic/core";
import { createConnectionGate } from "@collab/infra/connection-gate.js";
import { socketCeilings } from "@collab/infra/socket-ceilings.js";
import {
  createConnectionRegistry,
  type ConnectionRegistry,
} from "@collab/services/connection-registry.js";
import {
  shouldRegisterConnection,
  shouldTrackConnection,
} from "@collab/services/connection-tracking.js";
import {
  createHandlingSweeper,
  scheduleLoadSweep,
  resolveLeaseBudget,
  type HandlingSweeper,
} from "@collab/services/handling-sweeper.js";
import * as Y from "yjs";
import {
  parseDocName,
  SpaceRpcRequestSchema,
  type ProjectRole,
  type SpaceRpcResponse,
} from "@breatic/shared";
import { createAuthHook } from "@collab/hooks/auth.js";
import {
  recordHeartbeat,
  recordPresenceOnConnect,
  stampIdentityOnAwareness,
} from "@collab/hooks/presence-wiring.js";
import { isMetaWriteAttempt } from "@collab/hooks/meta-write-attempt-log.js";
import { createPersistenceExtension, storeDocumentNow } from "@collab/services/persistence.js";
import { createUnloadGate, type UnloadGate } from "@collab/hooks/unload-gate.js";
import { createStoreLoop, type StoreLoop } from "@collab/services/store-loop.js";
import { createStoreAlerter } from "@collab/services/store-alert.js";
import {
  writeRescueFile,
  writeRescueNote,
} from "@collab/services/rescue-file.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import { getCollabConfig } from "@collab/config.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";

const logger = createLogger("hocuspocus");

/** External infra config (env-based, not in YAML). */
export interface CollabServerInfra {
  /** Collab Redis (DB 3) — Hocuspocus cross-instance pub/sub + space-delete lock. */
  collabRedisUrl: string;
  /**
   * WebSocket listen port (`COLLAB_PORT`). Passed in rather than read here so
   * `index.ts` stays the only module that touches env — same path as
   * `redisKeyPrefix` below.
   */
  port: number;
  /**
   * Namespace for the Hocuspocus pub/sub channels (`REDIS_KEY_PREFIX`,
   * which resolves to `ENV` when unset). Two deployments sharing a Redis
   * instance MUST differ here: pub/sub ignores the DB number, so the
   * `REDIS_*_URL` split isolates every ordinary key but not channels.
   */
  redisKeyPrefix: string;
}

/**
 * Create and configure a Hocuspocus server instance.
 *
 * Behavior parameters are loaded from `config/collab.yaml`.
 * Infrastructure connections (DB, Redis) are passed as arguments.
 * @param infra - Database and Redis connection details
 * @returns Configured Server + Hocuspocus instances + the cross-instance connection registry and the handling-lease sweeper (caller stops both on shutdown)
 */
export async function createCollabServer(infra: CollabServerInfra): Promise<{ server: Server; hocuspocus: Hocuspocus; connectionRegistry: ConnectionRegistry; handlingSweeper: HandlingSweeper; storeLoop: StoreLoop }> {
  const cfg = getCollabConfig();

  // Handling-lease budgets (#1580 #2): default + per-operation overrides,
  // consumed by both the load-time sweep and the periodic sweeper.
  const leaseBudgets = {
    defaultBudgetMs: cfg.handling_lease.default_budget_ms,
    overrides: cfg.handling_lease.budget_overrides,
  };

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
    // First of every chain (#40). It watches the Yjs document directly rather
    // than through `onChange`, so no other extension's failure can hide an
    // edit from the store tracker, and it owns dropping a document's
    // bookkeeping once the document has actually left memory.
    createChangeTrackingExtension(),
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
      prefix: `${infra.redisKeyPrefix}:hocuspocus`,
    }),
  ];

  // Connection gate (optional) — identifies every incoming connection by its
  // peer address during the upgrade, then either exempts a developer's own
  // machine or hands a real client to the throttle to be counted. See
  // `infra/connection-gate.ts` for why the verdict has to be decided that
  // early and why it travels as a header.
  if (cfg.throttle_enabled) {
    extensions.push(
      createConnectionGate({
        throttle: cfg.throttle_max_attempts,
        banTime: cfg.throttle_ban_time,
      }),
    );
  }

  // Assembled after the server exists, because the gate's final store
  // attempt goes through the instance. The hooks below run long after that,
  // so reading it late is safe.
  const storeGate: { current?: UnloadGate } = {};

  const wsServer = new Server({
    port: infra.port,
    quiet: cfg.quiet,

    // The library installs its own SIGINT / SIGQUIT / SIGTERM handler by
    // default (`stopOnSignals`, hocuspocus-server.esm.js:1675-1682) and it is
    // `await destroy(); process.exit(0)` — no coordination with anything else.
    // Ours does the store settle: one final attempt per document, a rescue file
    // for whatever did not land, its note, and an email to operations. Leaving
    // both installed means the library can exit the process in the middle of
    // that, and the part it would cut off is the part that tells anyone the
    // file exists. Shutdown has one owner, and it is `index.ts`.
    stopOnSignals: false,

    // Document lifecycle
    unloadImmediately: cfg.unload_immediately,
    debounce: cfg.debounce,
    maxDebounce: cfg.max_debounce,

    // How many documents one socket may have awaiting authentication. The
    // framework defaults this to 100 and closes the WHOLE socket past it,
    // which assumes one document per socket. Ours carries a project: the meta
    // doc plus one per open Space tab, and a member who has never closed a tab
    // has every Space open. See config/collab.yaml for the ceiling and for
    // what actually bounds abuse here.
    ...socketCeilings(cfg.max_documents_per_socket),

    // Broadcast every change the moment it is applied, which is what the
    // framework did before it grew a batching window. The window (default
    // `0`, meaning "coalesce whatever lands in this event-loop turn") would
    // trade fewer frames for a broadcast that no longer happens inside the
    // transaction — and the Space RPC commit boundary is built on the
    // broadcast being the synchronous, observable commit point. Turning it on
    // is a behaviour change to weigh on its own, not something to inherit
    // from a default.
    flushDelay: false,

    // Authentication — verifies session token AND per-project
    // ownership. See packages/collab/src/auth.ts.
    onAuthenticate: createAuthHook({
      redis: authRedis,
      // The ceiling belongs to the studio that owns this project, read from
      // its current admin's membership tier (#88). It is looked up per
      // handshake and deliberately not cached: a handshake happens once per
      // socket, and a stale ceiling would outlive a tier change or a studio
      // transfer with nothing to invalidate it.
      resolveConnectionLimit: getProjectConcurrentEditorLimit,
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

    // The last chance to get a document's content out before it is
    // destroyed. Measured: without it, a failed store plus the last client
    // leaving loses the content silently (#40).
    beforeUnloadDocument: async ({
      documentName,
      document,
    }: {
      documentName: string;
      document: Y.Doc;
    }): Promise<void> => {
      await storeGate.current?.beforeUnloadDocument({ documentName, document });
    },

    onConnect: async ({ documentName, context, socketId }) => {
      const ctx = context as { user?: { id: string } };
      // The per-document connection cap is decided in onAuthenticate
      // (degrade to read-only); the connection is registered in the
      // cross-instance registry by the `connected` hook below (bound to the
      // Connection lifecycle so it stays symmetric with onDisconnect).
      // onConnect (which fires before auth) only logs.
      logger.info({ documentName, userId: ctx.user?.id, socketId }, "Client connected");
    },

    // Handling-lease load sweep (#1569): a cold doc's zombie handling
    // nodes are invisible until someone opens it — reclaim them shortly
    // after the doc loads. Uses the DIRECT document reference the hook
    // hands us — NEVER openDirectConnection from a load hook: that same-doc
    // re-entry provably deadlocks
    // (feedback_hocuspocus_after_load_no_await_same_doc; #1567 verified the
    // onDisconnect variant safe, load hooks are not). Meta / non-canvas
    // docs are skipped. #1580 #9: the sweep is JITTERED (not run in the
    // load tick) so a restart reloading every doc doesn't stampede N sweeps
    // + N broadcast transactions at once; the jitter is negligible against
    // the 1h budget, and a doc unloaded while waiting is skipped.
    afterLoadDocument: async ({ documentName, document, instance }) => {
      const parsed = parseDocName(documentName);
      if (!parsed || parsed.kind !== "canvas") return;
      scheduleLoadSweep({
        documentName,
        document,
        documents: instance.documents,
        resolveBudget: (phase, operation) =>
          resolveLeaseBudget(phase, operation, leaseBudgets),
        onSwept: (swept) => {
          logger.warn(
            { documentName, swept, reason: "handling_lease_swept_on_load" },
            "handling_lease_swept",
          );
        },
      });
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
    //
    // ONLY WRITABLE CONNECTIONS TAKE A SEAT (#88). `connectionConfig` here
    // is the very object the auth hook mutated: the framework builds one per
    // document per connection (ClientConnection.ts:620), hands that same
    // object to onAuthenticate (:373) and spreads it into this payload
    // (:433). So `readOnly` has already settled, and reading it needs no
    // second channel through `context`.
    connected: async ({
      documentName,
      socketId,
      context,
      instance,
      connectionConfig,
    }) => {
      if (shouldRegisterConnection(documentName, connectionConfig.readOnly)) {
        await connectionRegistry.register(documentName, socketId);
      }
      // The id comes from what onAuthenticate resolved out of the credential,
      // so the list reflects who the server knows is here.
      recordPresenceOnConnect({ documentName, context, instance }, {
        now: Date.now,
        staleAfterMs: cfg.presence_stale_after_ms,
      });
    },

    // Whose caret is whose, decided here rather than taken from the client.
    // Every peer derives the name and colour it shows from this id, so the
    // server writes it from the credential it validated at the handshake.
    // Runs on every document, not just the meta one: carets live in the canvas
    // and document files, which is where an id becomes a name on a screen.
    beforeHandleAwareness: async ({ states, connection, context }) => {
      stampIdentityOnAwareness({ states, connection, context });
    },

    // Every heartbeat does two things: keeps its own owner's timestamp moving,
    // and sweeps whoever nobody is refreshing any more. The sweep lives here
    // rather than on the document-load hook because that hook fires when the
    // records are freshest and then never fires again while anyone is in the
    // project — see `recordHeartbeat` for the full story.
    onAwarenessUpdate: async ({ documentName, document, connection }) => {
      recordHeartbeat({ documentName, document, connection }, {
        now: Date.now,
        staleAfterMs: cfg.presence_stale_after_ms,
      });
    },

    onDisconnect: async ({ documentName, context, socketId }) => {
      const ctx = context as { user?: { id: string } };
      const userId = ctx.user?.id;
      // Remove this connection from the cross-instance registry on clean
      // disconnect, so the count drops immediately (a crash instead lets it
      // expire via the registry TTL). onDisconnect fires for every connection
      // the `connected` hook saw, both being bound to the Connection object's
      // lifecycle. Meta / non-project docs were never tracked.
      //
      // THIS IS DELIBERATELY WIDER THAN THE REGISTER SIDE (#88). Registration
      // also asks whether the connection was writable; this one cannot —
      // `onDisconnectPayload` carries no `connectionConfig` at all. It does
      // not need to: removing a member that was never added is a no-op, so
      // unregistering every tracked document is correct and idempotent. The
      // asymmetry is safe in this direction only, and a test in
      // `connection-tracking.test.ts` pins that registration stays a subset.
      if (shouldTrackConnection(documentName)) {
        await connectionRegistry.unregister(documentName, socketId);
      }
      logger.info({ documentName, userId }, "Client disconnected");
      // NOTHING about the document's contents is touched here, and both
      // halves of that are deliberate.
      //
      // The presence list is not written because this socket ending says
      // nothing about whether its owner is still in the project: one person
      // holds several connections at once, and on a multi-instance deployment
      // the others may be on a machine this one cannot see. Absence is
      // inferred by the sweep instead, from nobody anywhere refreshing the
      // timestamp (see `hooks/presence.ts`).
      //
      // Canvas node state is not touched either. A disconnect hook used to
      // reclaim a frontend driver's `handling` here; that was removed on
      // 2026-07-02 (#1580 slice 4) because a closing socket is not evidence
      // the work died — an upload goes straight to object storage, invisible
      // to collab and outliving the socket. The 1h lease sweeper
      // (`services/handling-sweeper.ts`) is the guarantee. The other half,
      // stripping `operationLocks`, went with the field itself in #1889: the
      // mini-tool configure lock's only producer went with the 2026-05-18 web
      // rewrite, so nothing had written an entry since and the pass walked
      // every node on every disconnect to find nothing.
    },

    // A client trying to write the meta doc gets ONE LOG LINE and nothing
    // else. Refusing the write is not this hook's job: the connection to
    // that doc is read-only for every client (`hooks/auth.ts`), and the
    // framework enforces that at each site where it would apply an update.
    //
    // This replaces a gate that decided here whether to reject, which
    // required recognising a write from the raw frame — and it got that
    // wrong, silently, for its entire life. Keeping only the observation
    // means a mistake costs a log line rather than a hole.
    //
    // Nothing in the frontend writes the meta doc, so this should never
    // fire. When it does, it is a stale build or someone probing.
    beforeHandleMessage: async ({ documentName, update, context }) => {
      const ctx = context as { user?: { id?: string } };
      if (isMetaWriteAttempt(documentName, update, ctx)) {
        logger.warn(
          { documentName, userId: ctx.user?.id },
          "meta_write_attempt",
        );
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

    // Document size limit — reject updates that would exceed max.
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

      // (Nothing enforces write boundaries here. The meta doc is
      // read-only for every client — see `hooks/auth.ts` — and per-user
      // tab changes go through the `tab:*` RPCs below. The old onChange
      // audit-log was telemetry-only and has been retired.)
    },
  });

  logger.info({
    port: infra.port,
    unloadImmediately: cfg.unload_immediately,
    debounce: cfg.debounce,
    throttle: cfg.throttle_enabled,
    // The writable-connection ceiling is per-project now (#88), so there is
    // no one number to print. Name its SOURCE instead: an operator reading
    // this banner needs to know where to look, and a stale key name would
    // send them to a file that no longer has it.
    concurrentEditorsFrom: "config/membership.yaml: tiers.*.concurrent_editors",
    // Belongs in the banner for the same reason: it is a ceiling whose only
    // symptom, once crossed, is connections dropping. An operator has to be
    // able to read what this process is enforcing without guessing which copy
    // of the config it loaded.
    maxDocumentsPerSocket: cfg.max_documents_per_socket,
  }, "Hocuspocus server configured");

  // Periodic handling-lease sweep (#1569) over the currently-loaded docs,
  // for docs held open long-term (the load sweep above only fires once).
  // Direct doc references via hocuspocus.documents — zero direct
  // connections opened.
  const handlingSweeper = createHandlingSweeper({
    hocuspocus: wsServer.hocuspocus,
    budgets: leaseBudgets,
  });
  handlingSweeper.start();

  // Timed store (#40). Storing is driven from here rather than from "somebody
  // changed something", so a failed write is retried instead of costing the
  // content the moment the last client leaves.
  const storeAlerter = createStoreAlerter({
    to: cfg.store_alert_email,
    windowMs: cfg.store_alert_window_ms,
    timeoutMs: cfg.store_alert_timeout_ms,
    instanceId,
    send: sendMail,
  });
  storeGate.current = createUnloadGate({
    instanceId,
    encode: (document: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(document),
    storeNow: ({ name }) => storeDocumentNow(wsServer.hocuspocus, name),
    writeRescue: ({ documentName, state }) =>
      writeRescueFile({
        dir: resolve(MONOREPO_ROOT, cfg.store_rescue_dir),
        documentName,
        state,
        instanceId,
      }),
    writeRescueNote,
    alert: (failure) => storeAlerter.alert(failure),
  });
  const storeLoop = createStoreLoop({
    intervalMs: cfg.store_interval_ms,
    listDocuments: () =>
      Array.from(wsServer.hocuspocus.documents.keys(), (name) => ({ name })),
    storeNow: ({ name }) => storeDocumentNow(wsServer.hocuspocus, name),
  });
  storeLoop.start();

  return {
    server: wsServer,
    hocuspocus: wsServer.hocuspocus,
    connectionRegistry,
    handlingSweeper,
    storeLoop,
  };
}
