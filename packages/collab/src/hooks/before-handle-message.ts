/**
 * Hocuspocus `beforeHandleMessage` hook — client write authorization.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz (breatic-inner-design):
 * client-side writes to certain meta-doc paths must be rejected at the
 * collab process so editor / owner users cannot bypass the stateless
 * RPC layer and tamper with shared state directly.
 *
 * Refused on the meta doc (`project-{pid}/meta`):
 *
 *   - `meta.spaces` — any structural change (create / delete / modify
 *     a Space entry). Must go through `space:*` stateless RPC.
 *   - `meta.projectMessages` — any push / delete. Must go through
 *     `messages:*` RPC (push is collab-only side-effect of space:*
 *     handlers; clear is owner-only RPC).
 *   - `meta.users` — any add / modify / delete. The display-name
 *     lookup map is written exclusively by the `users:upsert-self`
 *     stateless RPC handler (server-side `system` context). Clients
 *     never push directly; the RPC handler enforces caller identity.
 *   - `meta.perUser[X]` where X is not the connected user's id. Each
 *     user may only write their own perUser entry (open tabs +
 *     active tab id).
 *
 * Allowed on the meta doc:
 *
 *   - `meta.projectMeta` (name / description) — write power is gated
 *     by Hocuspocus role-level readOnly (view = readOnly).
 *   - `meta.perUser[<own userId>]` — the client's own UI state.
 *
 * Other docs (`project-{pid}/canvas-{spaceId}` etc.) are not gated
 * here — canvas / document / timeline content authoring runs the
 * full collaborative editing pipeline. The auth hook already refuses
 * connections to deleted Spaces and applies role-level readOnly.
 *
 * `context.user.id === 'system'` is the collab process's own privileged
 * writer (used by `space-rpc` handlers via `openDirectConnection`) and
 * is allowed to bypass this gate.
 */
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/**
 * Hocuspocus protocol message type byte (mirrors
 * `@hocuspocus/server` `MessageType` enum). Only `Sync` carries
 * payloads that mutate the Y.Doc; all other types (Awareness, Auth,
 * QueryAwareness, SyncReply, Stateless, BroadcastStateless, CLOSE,
 * SyncStatus) leave document content untouched and must skip the
 * clone-and-diff gate.
 */
const HOCUSPOCUS_MESSAGE_TYPE_SYNC = 0;

/**
 * Subset of Hocuspocus's `beforeHandleMessagePayload` we actually need.
 * Declared locally so this module does not depend on hocuspocus types.
 *
 * NOTE on `update`: this is the **raw Hocuspocus WebSocket frame**, not
 * a bare Yjs update. The frame is `[messageType varUint][payload]`; for
 * a sync message the payload is `[syncSubType varUint][updateBytes]`.
 * Calling `Y.applyUpdate` directly on the frame throws lib0 binary-
 * decoding errors (`Invalid typed array length` / `Unexpected end of
 * array`) and Hocuspocus then closes the connection — the PR-a bug
 * fixed here. See `checkWriteAuthz` body for the correct envelope
 * unwrap.
 */
export interface CheckWriteAuthzInput {
  documentName: string;
  document: Y.Doc;
  update: Uint8Array;
  context: { user?: { id?: string } };
}

/**
 * Error thrown by {@link checkWriteAuthz} when an incoming meta-doc
 * update touches a forbidden path; Hocuspocus rejects the message and
 * closes the offending connection.
 */
export class WriteAuthzError extends Error {
  /**
   * Build the error, naming the forbidden meta-doc path in the message.
   * @param message - Human-readable reason naming the forbidden path that was written.
   */
  constructor(message: string) {
    super(message);
    this.name = "WriteAuthzError";
  }
}

/**
 * Parse a Hocuspocus WebSocket frame and return the underlying Yjs
 * update bytes — but only when the frame is a sync-update (the only
 * message kind that mutates document content). Returns `null` for:
 *
 *   - non-sync messages (awareness / auth / stateless / etc.) — these
 *     never touch the doc and don't need gating
 *   - sync-step-1 / sync-step-2 — handshake messages, sync-step-2 may
 *     carry remote state diff but it's server-authoritative; client
 *     send of step-2 happens in rare reconnect scenarios and the gate
 *     model would conflict with the bootstrap path
 *   - malformed frames — let Hocuspocus's MessageReceiver handle them
 *     (it will close the connection); returning null here avoids
 *     double-throwing on the same bad bytes
 * @param frame - Raw Hocuspocus WebSocket frame bytes (`[messageType][payload]`).
 * @returns The bare Yjs update bytes when the frame is a sync-update, or null for any non-sync, handshake, or malformed frame.
 */
function unwrapHocuspocusUpdate(frame: Uint8Array): Uint8Array | null {
  try {
    const decoder = decoding.createDecoder(frame);
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== HOCUSPOCUS_MESSAGE_TYPE_SYNC) return null;
    const syncSubType = decoding.readVarUint(decoder);
    if (syncSubType !== syncProtocol.messageYjsUpdate) return null;
    return decoding.readVarUint8Array(decoder);
  } catch {
    return null;
  }
}

/**
 * Throws {@link WriteAuthzError} if the incoming update violates the
 * key-level write rules above. Returns silently otherwise.
 *
 * Implementation: clone the current document, apply the incoming
 * update on the clone, then diff the relevant paths against the
 * original. Reject if any forbidden path changed.
 *
 * Cost note: cloning the meta doc on every meta-doc sync-update costs
 * O(n) in document size. Meta doc is small (a few hundred bytes to
 * ~10 KB for projects with many Spaces + projectMessages history), so
 * the cost is acceptable. For canvas / document / timeline docs we
 * skip this hook entirely — those documents can be megabytes and the
 * field-level gating isn't needed there.
 * @param root0 - The Hocuspocus `beforeHandleMessage` payload subset needed for gating.
 * @param root0.documentName - Name of the doc being written; only `.../meta` docs are gated.
 * @param root0.document - The current (pristine) meta Y.Doc, cloned before applying the update for diffing.
 * @param root0.update - Raw Hocuspocus WebSocket frame carrying the client's pending change.
 * @param root0.context - Connection context; its `user.id` identifies the writer (`system` bypasses the gate).
 * @throws {WriteAuthzError} when the update mutates `meta.spaces`, `meta.projectMessages`, `meta.users`, or another user's `meta.perUser` entry, or when an anonymous context attempts any meta-doc write.
 */
export function checkWriteAuthz({
  documentName,
  document,
  update,
  context,
}: CheckWriteAuthzInput): void {
  // Only gate the meta doc — other docs are content / canvas / etc.
  if (!documentName.endsWith("/meta")) return;

  // Collab's own privileged writer (openDirectConnection) is allowed.
  // The 'system' marker is set by space-rpc handlers (see space-rpc.ts).
  const userId = context.user?.id;
  if (userId === "system") return;

  // Anonymous / no-user contexts must not write to the meta doc.
  // (onAuthenticate normally guarantees user.id, but defensive.)
  if (!userId) {
    throw new WriteAuthzError("Anonymous write to meta doc is not allowed");
  }

  // Unwrap Hocuspocus frame to the bare Yjs update. Non-sync /
  // non-update messages (awareness, auth, stateless, sync-step-1/2)
  // don't carry client document changes — skip the gate.
  const updateBytes = unwrapHocuspocusUpdate(update);
  if (updateBytes === null) return;

  // Clone the doc and apply the incoming update on the clone, so the
  // original document remains pristine if we end up rejecting.
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));

  const beforeSpaces = JSON.stringify(clone.getMap("spaces").toJSON());
  const beforeMessages = JSON.stringify(
    clone.getArray("projectMessages").toJSON(),
  );
  const beforeUsers = JSON.stringify(clone.getMap("users").toJSON());
  const beforePerUser = clone.getMap("perUser").toJSON() as Record<
    string,
    unknown
  >;
  const beforePerUserKeys = new Set(Object.keys(beforePerUser));
  const beforePerUserSnapshot = JSON.stringify(beforePerUser);

  Y.applyUpdate(clone, updateBytes);

  const afterSpaces = JSON.stringify(clone.getMap("spaces").toJSON());
  const afterMessages = JSON.stringify(
    clone.getArray("projectMessages").toJSON(),
  );
  const afterUsers = JSON.stringify(clone.getMap("users").toJSON());
  const afterPerUser = clone.getMap("perUser").toJSON() as Record<
    string,
    unknown
  >;
  const afterPerUserKeys = new Set(Object.keys(afterPerUser));

  if (beforeSpaces !== afterSpaces) {
    throw new WriteAuthzError(
      "Direct write to meta.spaces is not allowed — use space:* stateless RPC",
    );
  }

  if (beforeMessages !== afterMessages) {
    throw new WriteAuthzError(
      "Direct write to meta.projectMessages is not allowed — collab writes via space:* / messages:* RPC handlers only",
    );
  }

  if (beforeUsers !== afterUsers) {
    throw new WriteAuthzError(
      "Direct write to meta.users is not allowed — use users:upsert-self stateless RPC",
    );
  }

  // perUser: client may only mutate their own entry.
  //
  // Check 1: any new key (added by the incoming update) must equal
  // the connected userId.
  for (const k of afterPerUserKeys) {
    if (!beforePerUserKeys.has(k) && k !== userId) {
      throw new WriteAuthzError(
        `Cannot create meta.perUser entry for another user (${k})`,
      );
    }
  }

  // Check 2: any pre-existing key other than the user's must be
  // byte-identical post-update (i.e. the incoming update did not
  // touch it). We re-serialize per-key for a granular diff so the
  // userId entry's freedom to change does not mask sibling tampering.
  for (const k of beforePerUserKeys) {
    if (k === userId) continue;
    if (JSON.stringify(beforePerUser[k]) !== JSON.stringify(afterPerUser[k])) {
      throw new WriteAuthzError(
        `Cannot modify meta.perUser entry for another user (${k})`,
      );
    }
  }

  // The (rare) case where a pre-existing peer entry got removed by
  // the incoming update is also a tamper:
  for (const k of beforePerUserKeys) {
    if (k === userId) continue;
    if (!afterPerUserKeys.has(k)) {
      throw new WriteAuthzError(
        `Cannot delete meta.perUser entry for another user (${k})`,
      );
    }
  }

  // All checks passed — incoming update is allowed.
  // (Note: this snapshot var is kept for future telemetry hooks if
  // we ever want to log "what changed" on accepted writes. Currently
  // unused; suppress unused-var lint locally.)
  void beforePerUserSnapshot;
}
