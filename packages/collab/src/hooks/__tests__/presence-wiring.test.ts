// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The presence rules, driven through a real Hocuspocus rather than by hand.
 *
 * The two modules underneath this are pure and already have their own tests.
 * What those cannot show is whether the framework ever calls them, with what,
 * and at which moment — and that gap is not hypothetical here. TWICE now: the
 * guard this work replaces passed its unit tests for months while never running
 * once in production because it read the frame from the wrong offset, and then
 * the first version of this very module wired its sweep to a hook that fires
 * before any connection exists, so the guard inside it could never run and the
 * case that "proved" it called the function by hand.
 *
 * So these cases connect clients through the real handshake, let the real hooks
 * fire, and read the result out of the real document. Where a case does reach
 * for a function directly, it is testing that function's rule, not its wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import {
  awarenessFrame,
  connectLiveClient,
  createLiveServer,
  waitFor,
  type LiveClient,
} from "@collab/__tests__/helpers/live-hocuspocus.js";
import { readPresence, __resetPresenceThrottle } from "@collab/hooks/presence";
import {
  recordPresenceOnConnect,
  recordHeartbeat,
  stampIdentityOnAwareness,
} from "@collab/hooks/presence-wiring";

const PID = "11111111-1111-4111-8111-111111111111";
const META_DOC = `project-${PID}/meta`;
const ALICE = "u-alice";

/** Clock the wiring reads, so a case can move time without waiting. */
let clock = 1_000_000;

/** Presence policy these cases run under; production reads it from config. */
const POLICY = { staleAfterMs: 90_000, throttleMs: 30_000 };

/** Who each fake connection authenticates as, by cookie. */
const USER_BY_COOKIE: Record<string, string> = {
  alice: ALICE,
  "alice-second": ALICE,
  bob: "u-bob",
};

let server: Hocuspocus;
const clients: LiveClient[] = [];

/**
 * A live server wired exactly the way production wires these hooks.
 *
 * Note what is NOT here: `onDisconnect` writes no presence at all. A socket
 * closing is not evidence the person left — they may hold another one, on this
 * machine or another — so absence is left entirely to the sweep.
 * @returns The server.
 */
function makeServer(): Hocuspocus {
  const instance = createLiveServer({
    onAuthenticate: async ({
      requestHeaders,
    }: {
      requestHeaders: Headers;
    }): Promise<{ user: { id: string } }> => {
      const cookie = requestHeaders.get("cookie") ?? "";
      const userId = USER_BY_COOKIE[cookie];
      if (!userId) throw new Error("Not authenticated");
      return { user: { id: userId } };
    },
    connected: async (payload: unknown): Promise<void> => {
      recordPresenceOnConnect(payload as never, { now: () => clock, ...POLICY });
    },
    beforeHandleAwareness: async (payload: unknown): Promise<void> => {
      stampIdentityOnAwareness(payload as never);
    },
    onAwarenessUpdate: async (payload: unknown): Promise<void> => {
      recordHeartbeat(payload as never, { now: () => clock, ...POLICY });
    },
  });
  return instance;
}

/**
 * Connect a client and remember it so its ping timer gets cleared.
 * @param cookie - Identifies who is connecting.
 * @param docName - Document to open.
 * @returns The connected client.
 */
async function connect(
  cookie: string,
  docName: string = META_DOC,
): Promise<LiveClient> {
  const client = await connectLiveClient(server, docName, { cookie });
  clients.push(client);
  return client;
}

/** The live meta document the server is holding. */
function metaDoc(): Y.Doc {
  const doc = server.documents.get(META_DOC);
  if (!doc) throw new Error("meta document not loaded");
  return doc as unknown as Y.Doc;
}

/**
 * Send one awareness frame from a client, the way its heartbeat does.
 * @param client - Who is beating.
 * @param clientId - Yjs client id to attribute the state to.
 */
async function beat(client: LiveClient, clientId: number): Promise<void> {
  const scratch = new Y.Doc();
  scratch.clientID = clientId;
  const awareness = new awarenessProtocol.Awareness(scratch);
  awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
  client.send(
    awarenessFrame(
      META_DOC,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  awareness.destroy();
  scratch.destroy();
}

/**
 * Seed the record a vanished server would have left: online, last heard from
 * long ago, with nobody connected as them now.
 * @param doc - The meta document.
 * @param userId - Who to leave behind.
 * @param lastSeenAt - When they were last heard from.
 */
function seedGhost(doc: Y.Doc, userId: string, lastSeenAt: number): void {
  doc.transact(() => {
    const ghost = new Y.Map<unknown>();
    ghost.set("id", userId);
    ghost.set("online", true);
    ghost.set("lastSeenAt", lastSeenAt);
    doc.getMap("users").set(userId, ghost);
  });
}

beforeEach(() => {
  clock = 1_000_000;
  __resetPresenceThrottle();
  server = makeServer();
});

afterEach(() => {
  while (clients.length > 0) clients.pop()?.close();
});

describe("presence wiring — a connection puts you on the list", () => {
  it("records the authenticated user when their connection is established", async () => {
    await connect("alice");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );

    expect(readPresence(metaDoc(), ALICE)).toEqual({
      id: ALICE,
      online: true,
      lastSeenAt: clock,
    });
  });

  it("leaves them on the list when a connection closes", async () => {
    // The heart of the design. This machine knows one socket ended; it does not
    // know whether the person still holds another, here or on another instance.
    // So it says nothing, and the sweep decides once nobody is refreshing them.
    //
    // Bob stays connected throughout: without him the document unloads the
    // moment the last connection goes and there is nothing left to read.
    const alice = await connect("alice");
    await connect("bob");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );

    alice.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readPresence(metaDoc(), ALICE)?.online).toBe(true);
  });
});

describe("presence wiring — a heartbeat refreshes and sweeps", () => {
  it("clears a record nobody is refreshing when a heartbeat arrives", async () => {
    // The sweep runs off other people's traffic, which is what makes it able to
    // clean up after a crashed server: the first person back starts the beats
    // that clear whoever that server left behind.
    const alice = await connect("alice");
    seedGhost(metaDoc(), "u-ghost", clock - 600_000);

    clock += POLICY.throttleMs;
    await beat(alice, 4242);

    expect(readPresence(metaDoc(), "u-ghost")?.online).toBe(false);
  });

  it("puts a swept user back when their own heartbeat arrives", async () => {
    // A browser throttles a hidden tab's timers to once a minute while the
    // socket stays open, so a connected person can drift into the sweep. Their
    // beat is proof they are here, and it has to outrank that inference — or
    // the mistake would be permanent.
    const alice = await connect("alice");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );
    metaDoc().transact(() => {
      (metaDoc().getMap("users").get(ALICE) as Y.Map<unknown>).set(
        "online",
        false,
      );
    });

    clock += POLICY.throttleMs;
    await beat(alice, 4243);

    expect(readPresence(metaDoc(), ALICE)?.online).toBe(true);
  });
});

describe("presence wiring — the server decides whose caret is whose", () => {
  it("replaces an identity the client put on its own caret", async () => {
    const alice = await connect("alice");

    // A frame claiming to be somebody else, built the way a client builds one.
    const scratch = new Y.Doc();
    scratch.clientID = 4242;
    const awareness = new awarenessProtocol.Awareness(scratch);
    awareness.setLocalState({
      cursor: { anchor: 1, head: 1 },
      user: { id: "u-victim" },
    });
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [4242]);

    alice.send(awarenessFrame(META_DOC, update));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = (
      server.documents.get(META_DOC) as unknown as { awareness: { getStates: () => Map<number, Record<string, unknown>> } }
    ).awareness
      .getStates()
      .get(4242);

    expect(state?.user).toEqual({ id: ALICE });
    awareness.destroy();
    scratch.destroy();
  });
});
