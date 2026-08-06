// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pins the one fact the meta-users anti-spoof check rests on: an awareness
 * update relayed from another collab instance reaches `onAwarenessUpdate`
 * with NO connection, and therefore with no context to claim an identity
 * from.
 *
 * Why it needs its own test. The check in `hocuspocus.ts` writes a user into
 * `meta.users` only when the state's declared `user.id` matches the id on the
 * originating connection's context. Its unit tests drive the pure function
 * and cover both answers. What they cannot cover is where the input comes
 * from — and hocuspocus 4 changed exactly that: the payload used to carry a
 * bare `context` and now carries an optional `connection`. If a relayed
 * update ever arrived carrying one, every instance would re-attest every
 * other instance's users, and a forged id relayed through Redis would be
 * written as genuine.
 *
 * Nothing in our own code decides this; the library does, from the
 * transaction origin. So this measures the library rather than reasoning
 * about it — the design note for the upgrade asked for exactly that.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { Hocuspocus } from "@hocuspocus/server";

/** What the hook saw, in arrival order. */
interface SeenUpdate {
  connection: unknown;
  documentName: string;
}

/** Direct connections opened by the current test, closed after it. */
const opened: { disconnect: () => Promise<void> }[] = [];

afterEach(async () => {
  // Leaving them open keeps the documents loaded and their store debouncers
  // alive across cases, which is how one test's timer becomes another's
  // mystery failure.
  while (opened.length > 0) await opened.pop()?.disconnect();
});

/**
 * Start an instance that records every awareness update its hook is given.
 * @returns The instance and the array it records into.
 */
async function instanceRecordingAwareness(): Promise<{
  hocuspocus: Hocuspocus;
  seen: SeenUpdate[];
}> {
  const seen: SeenUpdate[] = [];
  const hocuspocus = new Hocuspocus({
    quiet: true,
    extensions: [
      {
        onLoadDocument: async () => null,
        onStoreDocument: async () => {},
        onAwarenessUpdate: async (payload: SeenUpdate) => {
          seen.push({
            connection: payload.connection,
            documentName: payload.documentName,
          });
        },
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { hocuspocus, seen };
}

/**
 * Encode an awareness update the way a peer instance would publish one.
 * @param userId - The id the state declares itself to belong to.
 * @returns The encoded update, ready to apply to another awareness.
 */
function awarenessUpdateFrom(userId: string): Uint8Array {
  const peerDoc = new Y.Doc();
  const peerAwareness = new Awareness(peerDoc);
  peerAwareness.setLocalStateField("user", { id: userId, name: "Peer" });
  return encodeAwarenessUpdate(peerAwareness, [peerAwareness.clientID]);
}

describe("an awareness update relayed from another instance", () => {
  it("arrives with no connection, so it can claim no identity", async () => {
    const { hocuspocus, seen } = await instanceRecordingAwareness();
    const connection = await hocuspocus.openDirectConnection("project-relay/meta", {});
    opened.push(connection);
    const document = connection.document as unknown as Y.Doc & { awareness: Awareness };

    // `{ source: "redis" }` is verbatim what the Redis extension stamps on
    // everything it receives from a peer instance.
    applyAwarenessUpdate(document.awareness, awarenessUpdateFrom("u-someone-else"), {
      source: "redis",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.documentName).toBe("project-relay/meta");
    expect(seen[0]?.connection).toBeUndefined();
  });

  it("arrives with no connection even when the origin is a bare local write", async () => {
    // The other origin our own server-side code produces. Same requirement:
    // nothing that did not come off a client socket may attest an identity.
    const { hocuspocus, seen } = await instanceRecordingAwareness();
    const connection = await hocuspocus.openDirectConnection("project-local/meta", {});
    opened.push(connection);
    const document = connection.document as unknown as Y.Doc & { awareness: Awareness };

    applyAwarenessUpdate(document.awareness, awarenessUpdateFrom("u-someone-else"), {
      source: "local",
      context: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.connection).toBeUndefined();
  });

  it("does carry the connection when one is genuinely behind the update", async () => {
    // The control the two cases above need. Without it, `connection` being
    // undefined would be consistent with the field simply never being
    // populated, and neither assertion would mean anything.
    const { hocuspocus, seen } = await instanceRecordingAwareness();
    const connection = await hocuspocus.openDirectConnection("project-client/meta", {});
    opened.push(connection);
    const document = connection.document as unknown as Y.Doc & { awareness: Awareness };
    const marker = { context: { user: { id: "u-real" } } };

    applyAwarenessUpdate(document.awareness, awarenessUpdateFrom("u-real"), {
      source: "connection",
      connection: marker,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.connection).toBe(marker);
  });
});
