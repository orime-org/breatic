# @breatic/collab

The Hocuspocus process: Yjs document sync, persistence to the yjs Postgres database, cross-instance coordination over Redis, and the consumer that writes task events from Redis Streams onto canvas nodes. It is the only backend package that knows Hocuspocus.

Read [Canvas collaboration in docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#canvas-collaboration) before changing presence, seats, persistence, Space lifecycle or the hook order. Mechanism details live there and in each module's TSDoc; this file holds the rules you would get wrong without being told.

## Layout

**`hooks/` is the route layer (Hocuspocus events in, calls out), `services/` holds the collaboration logic, `infra/` holds supporting plumbing.**

## Imports and configuration

**Import only `@breatic/core`, `@breatic/shared` and npm packages.** Server, worker and domain are off limits (dependency-cruiser and typecheck enforce it).

**Only `bootstrap-config.ts` reads `process.env`; it hands the environment to `initCore`, and everything else reads configuration through `config.ts` or core's `env`.** No lint rule covers collab for this, so a stray `process.env` read would pass CI.

**After `initSentry()`, every exit goes through `exitProcess(code)`.** A bare `process.exit` drops the error events still queued; the only exception is `bootstrap-config.ts`, which fails before Sentry starts. `entry-exits.test.ts` checks `index.ts` only.

**`yjs_documents` queries use core's `yjsDb`, never the business `db`.** The yjs table lives in its own database; lint keeps the queries in `services/yjs-documents.repo.ts` but does not check which handle they use.

**Pick the Redis handle by job: `getRedis()` (DB0) for session reads, `getCollabRedis()` (DB3) for coordination between collab instances, and `createRedisClient` for subscribe, blocking-stream and Hocuspocus pub/sub connections.** Why those stay separate: [packages/core/AGENTS.md#dedicated-redis-connections-stay-separate](../core/AGENTS.md#dedicated-redis-connections-stay-separate).

Cross-service stream keys: [packages/core/AGENTS.md#stream-keys](../core/AGENTS.md#stream-keys).

`pnpm dev` runs collab under `tsx watch`, which restarts on edits to its sources and to a rebuilt `core/dist`; there is no need to kill it by hand.

## Hocuspocus lifecycle

### Hook order

**`onConnect` fires before `onAuthenticate`, so `context.user` is undefined there.** Logic that needs the user goes in `onAuthenticate` or later (`afterLoadDocument`, `connected`). The full order is in [ARCHITECTURE](../../docs/ARCHITECTURE.md#canvas-collaboration).

### Register per-connection resources in connected

**Register any per-connection resource (Redis counter, lock, mapping) in the `connected` hook and release it in `onDisconnect`.** `onDisconnect` fires only for connections whose `Connection` object was created; a connection rejected by auth or failing document load never gets one, so anything registered in `onConnect` or `onAuthenticate` leaks, and with a refresh loop it never expires.

**The two sides ask different questions on purpose: a seat is taken only when the auth hook handed the connection a ceiling (`AuthContext.seatCap` is not null, so writable content documents only), and unregistering checks document type only (`shouldTrackConnection`).** `onDisconnectPayload` carries no `connectionConfig`, and removing a member that was never added is a no-op.

### No direct connection from a load hook

**Never `await openDirectConnection` on the same document from `afterLoadDocument` or `onLoadDocument`.** Document setup is serialized per document, so the call waits on itself and deadlocks. Use the `document` the hook hands you.

### Set read-only on connectionConfig

**Make a connection read-only by mutating `connectionConfig.readOnly` inside `onAuthenticate`.** A returned `{ connection: { readOnly } }` only lands in the context and enforces nothing, and content documents rely on this flag alone for viewer read-only.

### Unload gate never throws

**`hooks/unload-gate.ts` must never throw.** A throw makes Hocuspocus abort the unload, and a document with zero connections then stays in memory forever.

## Identity and presence

### Identity comes from the connection

**Who a connection is comes only from what `onAuthenticate` resolved from its credential; anything the browser says about identity does not count.** Check: did this identity come from the connection's credential, or from the browser? From the browser → ignore it.

### Meta writes are refused by readOnly

**The meta document is read-only for every client through the connection flag (`hooks/auth.ts`); do not add a hook that inspects message types to block writes.** `meta-write-attempt-log.ts` only logs. A guard that must enumerate the framework's message types lets through every type it misses.

### Presence record shape

**A presence record in meta `users` holds only `id`, `online` and `lastSeenAt`, and only the server writes it.** Names and avatars come from the member roster on each client, so a copy here would go stale on rename.

### Liveness follows the transport

**Online is asserted by the socket's own signs of life (a pong, a ping or any message, the events crossws counts before it would close the socket), offline is only inferred by the sweep, and nothing writes offline when a socket closes.** One user may hold other sockets, some on other instances, so a close proves nothing. The same signal drives seats: a seat's score moves only when its own socket shows one of those signs, and nothing else writes it; a narrower signal than the transport's lets a socket the transport keeps open lose its seat while it can still write. Keep presence off browser timers (`refreshPresenceForSocket` is the only refresh entry in `presence-wiring.ts`): a tab hidden for over five minutes has its timers throttled to about once a minute, and the awareness heartbeat drops to about 60 s, so any "silent for N means gone" threshold built on browser timing must exceed that. Pongs come from the browser's network stack and are not throttled, so a hidden tab that sends nothing still refreshes.

### One pong handler

**When a pong must refresh something new, add it to the handler `createPongHandler` builds in `services/socket-liveness.ts`, not as another call in the per-socket callback.** A second call can go missing unnoticed, because each module's own tests call it directly and still pass.

### One ping interval

**`connection_ping_interval_ms` in `config/collab.yaml` is the only timing setting; seat and presence expiry are derived from it as twice the interval by `getConnectionTimings()`.** Do not add a separate expiry setting; `connection-timing-config.test.ts` pins the derivation.

### No carets on meta awareness

**Carets travel only on space documents (canvas, document); publishing a caret on the meta document's awareness is a bug.**

### Stamp every awareness entry

**`hooks/awareness-identity.ts` stamps the connection's user onto every entry of an inbound awareness frame, through `beforeHandleAwareness`, and never asks whose entry it is.** Entry keys are client ids the browser picks, so any branch that passes an entry through unchanged lets one member draw a caret under another's name. The server owns the whole `user` field and keeps only the client's `focused` flag.

**Never remove an entry from a frame.** An emptied frame applies nothing, emits no `update`, and freezes that person's caret for every peer; `update` fires even when the state did not change.

### Only presence-wiring reads hook payloads

**New code that reads a hook payload for presence or identity goes in `hooks/presence-wiring.ts`.** Its tests drive the same functions production wires in; a second copy of the extraction logic can pass its tests while doing nothing in production.

### Attach a Y.Map before using it

**Attach a new `Y.Map` to its parent (`parent.set(key, map)`) before writing to it or reading it.** Before attachment its writes sit in a holding area its own `keys()` does not see, and yjs prints an `Invalid access` warning straight to stderr, outside our logger. To guard it, spy on `console.warn` and assert no `Invalid access`.

### Socket versus client id

**One browser tab shares one WebSocket across all its documents, so a socket id covers several Yjs client ids.** Judge whether a connection is alive from the seat registry (`services/connection-registry.ts`), not from awareness (transient states cause false kills) and not from this instance's own connection list (it cannot see other instances).

## Space lifecycle

### Space count lock

**Every RPC in `services/space-rpc.ts` that changes the number of live Spaces (create, restore, delete) must run under `withSpaceCountLock` and read the live count from Postgres (`countLiveSpaceDocs`), which guards both the one-Space floor and the `MAX_SPACES_PER_PROJECT` ceiling.** `conn.transact` is atomic within one instance only; two collaborators on different instances both read the old meta and both pass the guard.
