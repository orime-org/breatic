// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The server decides whose caret is whose (#1886, #1887).
 *
 * A caret shows a name and a colour, and both are derived from one field: the
 * user id on its awareness state. Whoever writes that field decides whose name
 * appears on screen. It is the server, from the credential it validated at the
 * handshake, and it writes it onto every entry a client hands over.
 *
 * ## Every entry, and no judgement about whose it is
 *
 * An inbound frame is a list of entries keyed by Yjs client id, and that key is
 * a number the browser chose for itself — so a hand-built frame can key an
 * entry to somebody else's. This rule used to recognise exactly that case and
 * pass the entry through unchanged, which is what made writing a caret under
 * another member's name possible at all (#1887).
 *
 * It does not ask any more. Asking needs an answer to "whose client id is
 * this", and the server has no trustworthy source for it: the connection
 * registry the library keeps is empty for a reconnecting client, because a
 * connection's client set only grows from `added` and an id the document has
 * seen before never lands there again (`y-protocols/awareness.js` classifies it
 * as `updated`, since a remote client's `meta` is never cleared). y-protocols
 * takes the same position in its own hook for this: `modifyAwarenessUpdate`
 * hands the callback the states and deliberately not the client ids.
 *
 * So every entry is stamped. A frame that names a peer cannot impersonate
 * them — it arrives carrying the sender's identity, exactly like the rest.
 *
 * ## What this rule does not do
 *
 * It never removes an entry. Emptying a frame would cost its sender their
 * presence heartbeat: awareness emits an update only when something changed,
 * the heartbeat hangs off that event, and ninety seconds of silence reads as
 * offline.
 *
 * It never sees a removal, either. A client does forward one kind of frame
 * naming a peer — a removal it decided on its own, on the timeout its copy of
 * the protocol keeps. But the server applies an inbound frame to a scratch
 * awareness first and hands this hook `getStates()`, and a removal deletes the
 * entry from that scratch, so nothing is left to hand over.
 *
 * And it does not really reach an entry whose state is an array. An array is
 * an object, so the identity is written onto it here, but re-encoding runs the
 * state through `JSON.stringify`, which keeps only the indexed elements — that
 * entry leaves exactly as it arrived. Harmless rather than a hole: what leaves
 * carries no identity at all, so it cannot pass for anyone. Only a hand-built
 * frame produces one.
 */

/** Field the identity is written to. Only the server ever writes it. */
const USER_FIELD = "user";

/**
 * Write the connection's authenticated user id onto every entry of one frame.
 *
 * Mutates `states` in place — that is the contract of the hook this serves:
 * whatever the map holds afterwards is what peers receive.
 * @param args - The decoded frame and who sent it.
 * @param args.states - Per-client awareness states from one inbound frame, keyed by Yjs client id. Mutated in place.
 * @param args.userId - The authenticated user behind this frame; undefined when the frame came from another collab instance rather than a client connection, in which case nothing is touched.
 * @returns The client ids that were stamped.
 */
export function stampConnectionIdentity(args: {
  states: Map<number, Record<string, unknown>>;
  userId: string | undefined;
}): number[] {
  // No connection behind this frame: it was relayed from another instance,
  // where it was already stamped. Writing here would replace a real id with
  // nothing at all.
  if (args.userId === undefined) return [];

  const stamped: number[] = [];

  for (const [clientId, state] of args.states) {
    // A state is an object in every frame our own client sends. One that is
    // not cannot carry a field, so it is left exactly as it arrived rather
    // than removed — removing is what would cost the sender their heartbeat.
    if (state === null || typeof state !== "object") continue;

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
