// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A client may only announce itself.
 *
 * Awareness now carries a user id and nothing else, and every peer DERIVES
 * what it shows from that id — the display name by looking it up in the
 * project roster, the caret colour by hashing it. So the id is not an inert
 * label: it is the whole of a collaborator's on-screen identity. A client
 * publishing somebody else's id wears that person's name and colour.
 *
 * There is exactly one place to stop that, and it is here. Awareness frames
 * are broadcast to every other connection the moment the document handles
 * them (`handleAwarenessUpdate` sends first and has no reject path), and the
 * `onAwarenessUpdate` hook is a notification that runs afterwards. Rejecting
 * has to happen while the frame is still an inbound message.
 *
 * This is the "one rigid check at the door" that a spoofing attempt gets —
 * not an attempt to make impersonation impossible everywhere downstream.
 */

import { describe, it, expect } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import { checkWriteAuthz, WriteAuthzError } from "@collab/hooks/before-handle-message";

/** Hocuspocus frame type byte for an awareness update. */
const AWARENESS = 1;

/**
 * Build the frame a client sends when it publishes an awareness state.
 * @param clientId - The Yjs client id publishing the state.
 * @param state - The awareness state payload.
 * @returns The raw Hocuspocus frame bytes.
 */
function awarenessFrame(clientId: number, state: unknown): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(state as Record<string, unknown>);
  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Run the gate over one frame from a connection authenticated as `userId`. */
function gate(frame: Uint8Array, userId: string | undefined): void {
  checkWriteAuthz({
    documentName: "project-p1/canvas-s1",
    document: new Y.Doc(),
    update: frame,
    context: { user: userId === undefined ? undefined : { id: userId } },
  });
}

describe("awareness identity gate", () => {
  it("accepts a client announcing its own id", () => {
    expect(() => gate(awarenessFrame(7, { user: { id: "u-me" } }), "u-me")).not.toThrow();
  });

  it("rejects a client announcing somebody else's id", () => {
    // The whole point: this frame would paint the victim's name and colour on
    // the attacker's caret for everyone in the document.
    expect(() => gate(awarenessFrame(7, { user: { id: "u-victim" } }), "u-me")).toThrow(
      WriteAuthzError,
    );
  });

  it("accepts a frame that carries no identity at all", () => {
    // Cursor positions and the focus flag travel the same way. They say
    // nothing about who the client is, so there is nothing to check.
    expect(() =>
      gate(awarenessFrame(7, { cursor: { anchor: 1, head: 1 } }), "u-me"),
    ).not.toThrow();
  });

  it("rejects an anonymous connection that announces any identity", () => {
    // onAuthenticate normally guarantees a user, so this is defence in depth
    // rather than a reachable path — but "no authenticated identity" can
    // never be allowed to publish one.
    expect(() => gate(awarenessFrame(7, { user: { id: "u-anyone" } }), undefined)).toThrow(
      WriteAuthzError,
    );
  });

  it("lets the collab process publish on its own behalf", () => {
    // `system` is the privileged writer used by the stateless RPC handlers.
    expect(() => gate(awarenessFrame(7, { user: { id: "anything" } }), "system")).not.toThrow();
  });

  it("rejects a frame carrying one honest state and one forged one", () => {
    // A single frame can encode several clients. Checking only the first
    // would let an attacker hide the forgery behind their own entry.
    const doc = new Y.Doc();
    doc.clientID = 7;
    const mine = new awarenessProtocol.Awareness(doc);
    mine.setLocalState({ user: { id: "u-me" } });
    const other = new Y.Doc();
    other.clientID = 8;
    const theirs = new awarenessProtocol.Awareness(other);
    theirs.setLocalState({ user: { id: "u-victim" } });

    // Merge both into one update, the way a batched frame would arrive.
    const merged = new Y.Doc();
    merged.clientID = 99;
    const combined = new awarenessProtocol.Awareness(merged);
    awarenessProtocol.applyAwarenessUpdate(
      combined,
      awarenessProtocol.encodeAwarenessUpdate(mine, [7]),
      null,
    );
    awarenessProtocol.applyAwarenessUpdate(
      combined,
      awarenessProtocol.encodeAwarenessUpdate(theirs, [8]),
      null,
    );
    const update = awarenessProtocol.encodeAwarenessUpdate(combined, [7, 8]);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, AWARENESS);
    encoding.writeVarUint8Array(encoder, update);

    expect(() =>
      checkWriteAuthz({
        documentName: "project-p1/canvas-s1",
        document: new Y.Doc(),
        update: encoding.toUint8Array(encoder),
        context: { user: { id: "u-me" } },
      }),
    ).toThrow(WriteAuthzError);
  });
});
