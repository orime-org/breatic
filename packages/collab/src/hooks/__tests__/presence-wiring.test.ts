// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The presence rules, driven through a real Hocuspocus rather than by hand.
 *
 * The two modules underneath this are pure and already have their own tests.
 * What those cannot show is whether the framework ever calls them, with what,
 * and at which moment — and that gap is not hypothetical here. The guard this
 * work replaces passed its unit tests for months while never running once in
 * production, because it read the frame from the wrong offset and no test ever
 * fed it a frame the library had actually produced.
 *
 * So these cases connect clients through the real handshake, let the real hooks
 * fire, and read the result out of the real document.
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
  recordAbsenceOnDisconnect,
  sweepPresenceOnLoad,
  stampIdentityOnAwareness,
} from "@collab/hooks/presence-wiring";

const PID = "11111111-1111-4111-8111-111111111111";
const META_DOC = `project-${PID}/meta`;
const ALICE = "u-alice";

/** Clock the wiring reads, so a case can move time without waiting. */
let clock = 1_000_000;

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
    afterLoadDocument: async (payload: unknown): Promise<void> => {
      sweepPresenceOnLoad(payload as never, {
        now: () => clock,
        staleAfterMs: 300_000,
      });
    },
    connected: async (payload: unknown): Promise<void> => {
      recordPresenceOnConnect(payload as never, { now: () => clock });
    },
    onDisconnect: async (payload: unknown): Promise<void> => {
      recordAbsenceOnDisconnect(payload as never, { now: () => clock });
    },
    beforeHandleAwareness: async (payload: unknown): Promise<void> => {
      stampIdentityOnAwareness(payload as never);
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

  it("takes them off the list when their connection closes", async () => {
    // Bob stays connected throughout. Without him the document unloads the
    // moment the last connection goes, and there is nothing left to read —
    // which is the library's behaviour, not a defect, but it does mean this
    // case has to keep somebody in the room to observe from.
    const alice = await connect("alice");
    await connect("bob");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );

    clock += 5_000;
    alice.close();
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === false,
      "alice recorded offline",
    );

    expect(readPresence(metaDoc(), ALICE)?.lastSeenAt).toBe(clock);
  });

  it("keeps them on the list while any of their connections survives", async () => {
    // One person with two tabs open. Closing one must not make them vanish
    // from everyone else's screen while they are still sitting in the other.
    const first = await connect("alice");
    await connect("alice-second");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

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

describe("presence wiring — stale records are cleaned when the document loads", () => {
  it("flips a record left claiming to be online by a server that went away", async () => {
    // Seed the document the way a vanished server would have left it: online,
    // last heard from long ago, and nobody connected as them now.
    await connect("alice");
    const doc = metaDoc();
    doc.transact(() => {
      const ghost = new Y.Map<unknown>();
      ghost.set("id", "u-ghost");
      ghost.set("online", true);
      ghost.set("lastSeenAt", clock - 600_000);
      doc.getMap("users").set("u-ghost", ghost);
    });

    sweepPresenceOnLoad(
      { documentName: META_DOC, document: doc as never },
      { now: () => clock, staleAfterMs: 300_000 },
    );

    expect(readPresence(doc, "u-ghost")?.online).toBe(false);
  });

  it("spares the person whose connection triggered the load", async () => {
    // The load hook fires while somebody is connecting. Sweeping purely on the
    // timestamp would evict them; the live-connection check is what saves them.
    await connect("alice");
    const doc = metaDoc();
    clock += 600_000;

    sweepPresenceOnLoad(
      { documentName: META_DOC, document: doc as never },
      { now: () => clock, staleAfterMs: 300_000 },
    );

    expect(readPresence(doc, ALICE)?.online).toBe(true);
  });
});
