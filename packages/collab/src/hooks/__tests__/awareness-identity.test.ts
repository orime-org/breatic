// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The server stamps who a caret belongs to; the browser never says (#1886).
 *
 * Every peer derives what it shows from the id on a caret — the display name by
 * looking it up in the project roster, the colour by hashing it. So whoever
 * writes that id decides whose name appears. It is the server, from the
 * credential it validated at the handshake.
 *
 * ## Why every entry, with no question asked about whose it is
 *
 * A frame is a list of entries keyed by Yjs client id, and that key is a number
 * the browser chose for itself, so a hand-built frame can key an entry to
 * somebody else's. The rule used to recognise that case and pass the entry
 * through unchanged, which is what made writing a caret under another member's
 * name possible at all (#1887).
 *
 * It stamps instead, because there is no trustworthy answer to "whose client id
 * is this". The library's own connection registry is empty for a reconnecting
 * client: a connection's client set only grows from `added`, and an id the
 * document has already seen is classified `updated` forever after, since a
 * remote client's `meta` is never cleared. y-protocols takes the same position
 * in the hook it offers for this — `modifyAwarenessUpdate` passes the states
 * and deliberately not the client ids.
 *
 * The cases below therefore fall into two groups: every entry gets the sender's
 * identity, and the identity is the only thing the server writes.
 */

import { describe, it, expect } from "vitest";

import { stampConnectionIdentity } from "@collab/hooks/awareness-identity";

const ME = "u-me";
const MY_CLIENT = 7;
/** A client id that is somebody else's — the impersonation case. */
const PEER_CLIENT = 8;
const THIRD_CLIENT = 9;

/** An awareness state carrying a cursor and the window-focus flag. */
function cursorState(
  user: Record<string, unknown> = {},
): Record<string, unknown> {
  return { cursor: { anchor: 1, head: 1 }, user: { focused: true, ...user } };
}

describe("stampConnectionIdentity", () => {
  it("stamps the sender's own entry with the authenticated user", () => {
    const states = new Map([[MY_CLIENT, cursorState()]]);

    const stamped = stampConnectionIdentity({ states, userId: ME });

    expect(stamped).toEqual([MY_CLIENT]);
    expect(states.get(MY_CLIENT)?.user).toEqual({ id: ME, focused: true });
  });

  it("stamps an entry that names somebody else with the sender's id", () => {
    // The only frame our frontend sends that names a peer is a timeout
    // removal, which carries a null state and so never reaches this map — a
    // live entry keyed to somebody else's client id was built by hand. It is
    // not passed through and it is
    // not judged: it gets the sender's identity like every other entry, which
    // is what makes impersonation impossible rather than merely detectable.
    const states = new Map([[PEER_CLIENT, cursorState({ id: "u-peer" })]]);

    const stamped = stampConnectionIdentity({ states, userId: ME });

    expect(stamped).toEqual([PEER_CLIENT]);
    expect(states.get(PEER_CLIENT)?.user).toEqual({ id: ME, focused: true });
  });

  it("stamps every entry when a frame names more than one client", () => {
    // A frame is not one decision. Stamping only the first entry would leave
    // the rest carrying whatever the sender wrote.
    const states = new Map([
      [MY_CLIENT, cursorState()],
      [PEER_CLIENT, cursorState({ id: "u-peer" })],
      [THIRD_CLIENT, cursorState()],
    ]);

    const stamped = stampConnectionIdentity({ states, userId: ME });

    expect(stamped).toEqual([MY_CLIENT, PEER_CLIENT, THIRD_CLIENT]);
    for (const clientId of [MY_CLIENT, PEER_CLIENT, THIRD_CLIENT]) {
      expect(states.get(clientId)?.user).toEqual({ id: ME, focused: true });
    }
  });

  it("never removes an entry, so a frame is never emptied", () => {
    // Emptying a frame would cost the sender their heartbeat: a frame naming
    // nobody applies nothing, so awareness emits no update event, and that
    // event is the one the presence heartbeat hangs off — ninety seconds of
    // silence reads as offline. Nothing here deletes, which is what keeps that
    // coupling out of reach.
    const states = new Map<number, Record<string, unknown>>([
      [MY_CLIENT, cursorState()],
      [PEER_CLIENT, cursorState({ id: "u-peer" })],
    ]);

    stampConnectionIdentity({ states, userId: ME });

    expect([...states.keys()]).toEqual([MY_CLIENT, PEER_CLIENT]);
  });

  it("overwrites an id the client put there itself", () => {
    // Nothing in our frontend writes this field, so its presence means either
    // a stale build or someone trying it on. Either way the server's answer
    // wins, because the server is the one that checked the credential.
    const states = new Map([
      [MY_CLIENT, cursorState({ id: "u-victim", name: "Victim" })],
    ]);

    stampConnectionIdentity({ states, userId: ME });

    // The forged id is replaced and the smuggled name is dropped entirely:
    // the server decides what this field contains, and it keeps exactly one
    // thing from the client — the focus flag, which is the client's to know.
    expect(states.get(MY_CLIENT)?.user).toEqual({ id: ME, focused: true });
  });

  it("keeps the cursor and the focus flag exactly as sent", () => {
    // These are the client's to decide — the server has no idea where a
    // caret sits or whether that window has focus.
    const states = new Map([[MY_CLIENT, cursorState()]]);

    stampConnectionIdentity({ states, userId: ME });

    const state = states.get(MY_CLIENT);
    expect(state?.cursor).toEqual({ anchor: 1, head: 1 });
    expect((state?.user as { focused?: boolean }).focused).toBe(true);
  });

  it("keeps the focus flag when the client says its window lost focus", () => {
    // The false value carries as much as the true one: a peer who switched
    // away is drawn dimmer, and a rule that only forwarded `true` would leave
    // their caret looking active for everybody else. This field is the one
    // thing the server takes from the client, so both its values are the
    // contract, and only asserting `true` leaves half of it unguarded.
    const states = new Map([[MY_CLIENT, cursorState({ focused: false })]]);

    stampConnectionIdentity({ states, userId: ME });

    expect(states.get(MY_CLIENT)?.user).toEqual({ id: ME, focused: false });
  });

  it("omits the focus flag when the client did not send one", () => {
    const states = new Map([
      [MY_CLIENT, { cursor: { anchor: 1, head: 1 }, user: {} }],
    ]);

    stampConnectionIdentity({ states, userId: ME });

    expect(states.get(MY_CLIENT)?.user).toEqual({ id: ME });
  });

  it("stamps a state that has no user field at all", () => {
    // A cursor with nothing else attached still belongs to somebody.
    const states = new Map<number, Record<string, unknown>>([
      [MY_CLIENT, { cursor: { anchor: 1, head: 1 } }],
    ]);

    stampConnectionIdentity({ states, userId: ME });

    expect(states.get(MY_CLIENT)?.user).toEqual({ id: ME });
  });

  it("touches nothing when the frame has no connection behind it", () => {
    // Relayed from another collab instance over Redis. It was stamped at its
    // origin; stamping it here would replace a real id with nothing.
    const states = new Map([[MY_CLIENT, cursorState({ id: "u-elsewhere" })]]);

    const stamped = stampConnectionIdentity({ states, userId: undefined });

    expect(stamped).toEqual([]);
    expect(states.get(MY_CLIENT)?.user).toEqual({
      id: "u-elsewhere",
      focused: true,
    });
  });

  it("leaves an entry whose state is not an object exactly as it arrived", () => {
    // A field cannot be written onto a number, and removing the entry instead
    // is what would cost the sender their heartbeat. Nothing our client sends
    // looks like this; a hand-built frame can.
    const states = new Map<number, Record<string, unknown>>([
      [MY_CLIENT, 0 as unknown as Record<string, unknown>],
      [PEER_CLIENT, cursorState()],
    ]);

    const stamped = stampConnectionIdentity({ states, userId: ME });

    expect(stamped).toEqual([PEER_CLIENT]);
    expect(states.get(MY_CLIENT)).toBe(0);
    expect([...states.keys()]).toEqual([MY_CLIENT, PEER_CLIENT]);
  });
});
