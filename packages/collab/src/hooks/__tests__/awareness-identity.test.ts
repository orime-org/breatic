// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The server stamps who a caret belongs to; the browser never says (#1886).
 *
 * Every peer derives what it shows from the id on a caret — the display name
 * by looking it up in the project roster, the colour by hashing it. So whoever
 * writes that id decides whose name appears. It is the server, from the
 * credential it validated at the handshake.
 *
 * ## Why this needs more than "fill in the sender's id"
 *
 * The hook this feeds receives every client state decoded from one inbound
 * frame, not just the sender's own. A client re-broadcasts states it learned
 * about other people (their bug, #1887, but ours to live with), so a frame from
 * Alice routinely carries Bob's entry. Stamping the whole frame would put
 * Alice's id on Bob's caret and make Bob's cursor jump into Alice's name.
 *
 * So each entry is judged separately, and the deciding question is whose
 * connection the Yjs client id belongs to:
 *
 *   - ours, or nobody's yet (the first frame of a connection, before the
 *     library has registered it) — the sender's, so stamp it
 *   - somebody else's — a relay, leave it exactly as it is
 *
 * A frame with no connection behind it at all comes from another collab
 * instance over Redis. It was already stamped where it originated, and this
 * instance has no identity to stamp it with; touching it would erase a real id.
 */

import { describe, it, expect } from "vitest";

import { stampConnectionIdentity } from "@collab/hooks/awareness-identity";

const ME = "u-me";
const OWN_CLIENT = 7;
const PEER_CLIENT = 8;
const UNSEEN_CLIENT = 9;

/** An awareness state carrying a cursor and the window-focus flag. */
function cursorState(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { cursor: { anchor: 1, head: 1 }, focused: true, ...extra };
}

describe("stampConnectionIdentity", () => {
  it("stamps the connection's own client id with the authenticated user", () => {
    const states = new Map([[OWN_CLIENT, cursorState()]]);

    const stamped = stampConnectionIdentity({
      states,
      ownClientIds: new Set([OWN_CLIENT]),
      otherClientIds: new Set(),
      userId: ME,
    });

    expect(stamped).toEqual([OWN_CLIENT]);
    expect(states.get(OWN_CLIENT)?.user).toEqual({ id: ME });
  });

  it("stamps a client id the library has not registered yet", () => {
    // A connection's very first awareness frame arrives before the library
    // records which client ids belong to it. That id can only be the
    // sender's — every id the server already knows is accounted for below.
    const states = new Map([[UNSEEN_CLIENT, cursorState()]]);

    const stamped = stampConnectionIdentity({
      states,
      ownClientIds: new Set(),
      otherClientIds: new Set([PEER_CLIENT]),
      userId: ME,
    });

    expect(stamped).toEqual([UNSEEN_CLIENT]);
    expect(states.get(UNSEEN_CLIENT)?.user).toEqual({ id: ME });
  });

  it("leaves another connection's entry untouched", () => {
    // This is the relay case, and it is the common one: a normal frame from
    // one collaborator carries the states it learned about everyone else.
    const peerState = cursorState({ user: { id: "u-peer" } });
    const states = new Map([[PEER_CLIENT, peerState]]);

    const stamped = stampConnectionIdentity({
      states,
      ownClientIds: new Set([OWN_CLIENT]),
      otherClientIds: new Set([PEER_CLIENT]),
      userId: ME,
    });

    expect(stamped).toEqual([]);
    expect(states.get(PEER_CLIENT)?.user).toEqual({ id: "u-peer" });
  });

  it("stamps our entry and relays the peer's in the same frame", () => {
    // The mixed frame is what a real session sends. Getting only one of the
    // two rules right still corrupts every session with two people in it.
    const states = new Map([
      [OWN_CLIENT, cursorState()],
      [PEER_CLIENT, cursorState({ user: { id: "u-peer" } })],
    ]);

    const stamped = stampConnectionIdentity({
      states,
      ownClientIds: new Set([OWN_CLIENT]),
      otherClientIds: new Set([PEER_CLIENT]),
      userId: ME,
    });

    expect(stamped).toEqual([OWN_CLIENT]);
    expect(states.get(OWN_CLIENT)?.user).toEqual({ id: ME });
    expect(states.get(PEER_CLIENT)?.user).toEqual({ id: "u-peer" });
  });

  it("overwrites an id the client put there itself", () => {
    // Nothing in our frontend writes this field, so its presence means either
    // a stale build or someone trying it on. Either way the server's answer
    // wins, because the server is the one that checked the credential.
    const states = new Map([
      [OWN_CLIENT, cursorState({ user: { id: "u-victim", name: "Victim" } })],
    ]);

    stampConnectionIdentity({
      states,
      ownClientIds: new Set([OWN_CLIENT]),
      otherClientIds: new Set(),
      userId: ME,
    });

    expect(states.get(OWN_CLIENT)?.user).toEqual({ id: ME });
  });

  it("keeps the cursor and the focus flag exactly as sent", () => {
    // These are the client's to decide — the server has no idea where a
    // caret sits or whether that window has focus.
    const states = new Map([[OWN_CLIENT, cursorState()]]);

    stampConnectionIdentity({
      states,
      ownClientIds: new Set([OWN_CLIENT]),
      otherClientIds: new Set(),
      userId: ME,
    });

    const state = states.get(OWN_CLIENT);
    expect(state?.cursor).toEqual({ anchor: 1, head: 1 });
    expect(state?.focused).toBe(true);
  });

  it("touches nothing when the frame has no connection behind it", () => {
    // Relayed from another collab instance over Redis. It was stamped at its
    // origin; stamping it here would replace a real id with nothing.
    const states = new Map([
      [OWN_CLIENT, cursorState({ user: { id: "u-elsewhere" } })],
    ]);

    const stamped = stampConnectionIdentity({
      states,
      ownClientIds: new Set(),
      otherClientIds: new Set(),
      userId: undefined,
    });

    expect(stamped).toEqual([]);
    expect(states.get(OWN_CLIENT)?.user).toEqual({ id: "u-elsewhere" });
  });

  it("drops an entry that is being cleared rather than stamping it", () => {
    // Awareness clears a peer by setting its state to null. Stamping an id
    // onto that would turn a departure into a permanent ghost caret.
    const states = new Map<number, Record<string, unknown> | null>([
      [OWN_CLIENT, null],
    ]);

    const stamped = stampConnectionIdentity({
      states: states as Map<number, Record<string, unknown>>,
      ownClientIds: new Set([OWN_CLIENT]),
      otherClientIds: new Set(),
      userId: ME,
    });

    expect(stamped).toEqual([]);
    expect(states.get(OWN_CLIENT)).toBeNull();
  });
});
