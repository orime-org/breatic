// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The server decides whose caret is whose (#1886).
 *
 * A caret shows a name and a colour, and both are derived from one field: the
 * user id on its awareness state. Whoever writes that field decides whose name
 * appears on screen. Until now the browser wrote it and the server checked it,
 * which meant maintaining a check at all — and the check could only ever be as
 * good as our ability to tell a forged frame from an honest one. The server
 * already resolved this connection's user from its credential at the handshake,
 * so it writes the field and the question disappears.
 *
 * ## Per entry, not per frame
 *
 * One inbound frame carries every client state it happened to decode, not just
 * the sender's own: clients re-broadcast what they have learned about their
 * peers. So a frame from one collaborator routinely contains another's entry,
 * and stamping the frame wholesale would put the sender's identity on somebody
 * else's caret.
 *
 * The Yjs client id decides. Ours, or not yet known to anyone — the sender's,
 * stamp it. Registered against a different connection — a relay, leave it.
 *
 * "Not yet known" is the first frame of a connection: the library registers a
 * connection's client ids while handling the awareness update, so the very
 * first one arrives unregistered. It cannot belong to anyone else, because
 * every id the server already knows about is registered somewhere.
 */

/** Field the identity is written to. Only the server ever writes it. */
const USER_FIELD = "user";

/**
 * Write the connection's authenticated user id onto the entries that belong to
 * it, leaving relayed entries alone.
 *
 * Mutates `states` in place — that is the contract of the hook this serves:
 * whatever the map holds afterwards is what peers receive.
 * @param args - The decoded frame and what is known about its client ids.
 * @param args.states - Per-client awareness states from one inbound frame, keyed by Yjs client id. Mutated in place.
 * @param args.ownClientIds - Client ids the library has registered against this connection.
 * @param args.otherClientIds - Client ids registered against any other connection on this document.
 * @param args.userId - The authenticated user behind this frame; undefined when the frame came from another collab instance rather than a client connection, in which case nothing is touched.
 * @returns The client ids that were stamped.
 */
export function stampConnectionIdentity(args: {
  states: Map<number, Record<string, unknown>>;
  ownClientIds: ReadonlySet<number>;
  otherClientIds: ReadonlySet<number>;
  userId: string | undefined;
}): number[] {
  // No connection behind this frame: it was relayed from another instance,
  // where it was already stamped. Writing here would replace a real id with
  // nothing at all.
  if (args.userId === undefined) return [];

  const stamped: number[] = [];

  for (const [clientId, state] of args.states) {
    // Awareness clears a peer by setting its state to null. Stamping an id
    // onto that would turn a departure into a caret nobody can remove.
    if (state === null || typeof state !== "object") continue;

    // Registered to somebody else — this is the sender relaying what it knows
    // about a peer, which is normal traffic and not ours to rewrite.
    if (args.otherClientIds.has(clientId) && !args.ownClientIds.has(clientId)) {
      continue;
    }

    // The server decides what this field contains, keeping exactly one thing
    // the client sent: whether its window has focus. That is the client's to
    // know — the server has no idea — and it is the reason this field is
    // rewritten rather than replaced outright. Everything else a client puts
    // here is dropped, so smuggling a name or a colour in achieves nothing.
    const previous = state[USER_FIELD];
    const focused =
      typeof previous === "object" &&
      previous !== null &&
      typeof (previous as { focused?: unknown }).focused === "boolean"
        ? { focused: (previous as { focused: boolean }).focused }
        : {};
    state[USER_FIELD] = { id: args.userId, ...focused };
    stamped.push(clientId);
  }

  return stamped;
}
