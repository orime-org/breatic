// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { readPresence } from "@collab/hooks/presence";
import {
  recordPresenceOnConnect,
  recordHeartbeat,
  stampIdentityOnAwareness,
} from "@collab/hooks/presence-wiring";

const PID = "11111111-1111-4111-8111-111111111111";
const META_DOC = `project-${PID}/meta`;
/** A space document — where carets actually live. */
const CANVAS_DOC = `project-${PID}/canvas-22222222-2222-4222-8222-222222222222`;
const ALICE = "u-alice";

/** Clock the wiring reads, so a case can move time without waiting. */
let clock = 1_000_000;

/** Presence policy these cases run under; production reads it from config. */
const POLICY = { staleAfterMs: 90_000 };

/** How often an awake browser renews its awareness clock. */
const BEAT_MS = 15_000;

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
  return doc;
}

/**
 * Send one awareness frame from a client, keyed to any client id.
 *
 * Built the way a browser builds one, so what arrives at the server is
 * indistinguishable from real traffic — including when the client id names
 * somebody else, which is the whole point of the impersonation cases.
 * @param client - Connection to send it on.
 * @param clientId - Yjs client id to key the entry to.
 * @param state - Awareness state to put in that entry.
 * @param options - Everything a case may need to vary.
 * @param options.revisions - How many state writes the sender has made. The awareness clock counts exactly these, and a frame is applied only when its clock beats the one the document already holds for that entry — so a frame keyed to a client id somebody else has already used needs more revisions than they have made, or it is dropped before this rule's work can be seen at all.
 * @param options.docName - Document to address the frame to. Carets live on space documents, so the cases that matter most are not on the meta one.
 */
async function sendCaret(
  client: LiveClient,
  clientId: number,
  state: Record<string, unknown>,
  options: { revisions?: number; docName?: string } = {},
): Promise<void> {
  const { revisions = 1, docName = META_DOC } = options;
  const scratch = new Y.Doc();
  scratch.clientID = clientId;
  const awareness = new awarenessProtocol.Awareness(scratch);
  for (let i = 0; i < revisions; i += 1) awareness.setLocalState(state);
  client.send(
    awarenessFrame(
      docName,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  awareness.destroy();
  scratch.destroy();
}

/**
 * Read one awareness entry back out of a live document.
 * @param clientId - Entry to read.
 * @param docName - Document holding it.
 * @returns The stored state, or undefined when the document has none.
 * @throws {Error} When the server is not holding that document.
 */
function caretState(
  clientId: number,
  docName: string = META_DOC,
): Record<string, unknown> | undefined {
  const doc = server.documents.get(docName);
  if (!doc) throw new Error(`document not loaded: ${docName}`);
  return (
    doc as unknown as {
      awareness: { getStates: () => Map<number, Record<string, unknown>> };
    }
  ).awareness
    .getStates()
    .get(clientId);
}

/**
 * Send one awareness frame from a client, the way its heartbeat does.
 * @param client - Who is beating.
 * @param clientId - Yjs client id to attribute the state to.
 */
async function beat(client: LiveClient, clientId: number): Promise<void> {
  await sendCaret(client, clientId, { cursor: { anchor: 1, head: 1 } });
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

    clock += BEAT_MS;
    await beat(alice, 4242);

    expect(readPresence(metaDoc(), "u-ghost")?.online).toBe(false);
  });

  it("only clears what is older than the configured threshold", () => {
    // Without this, the sweep cases above cannot tell the threshold from any
    // other positive number: their ghost is 600 seconds old and the only live
    // record has an age of zero, so every value in between reads the same.
    // Measured: with `staleAfterMs` swapped for a tenth of it, every other case
    // in this file stayed green. These two ages sit either side of 90 seconds.
    const doc = new Y.Doc();
    seedGhost(doc, "u-old", clock - (POLICY.staleAfterMs + 1));
    seedGhost(doc, "u-recent", clock - (POLICY.staleAfterMs - 1));

    recordPresenceOnConnect(
      {
        documentName: META_DOC,
        instance: { documents: new Map([[META_DOC, doc]]) },
        context: { user: { id: ALICE } },
      },
      { now: () => clock, ...POLICY },
    );

    expect(readPresence(doc, "u-old")?.online).toBe(false);
    expect(readPresence(doc, "u-recent")?.online).toBe(true);
    doc.destroy();
  });

  it("clears a ghost the moment somebody arrives, before any heartbeat", async () => {
    // The first person back after a crash should not have to wait for their own
    // first heartbeat to see a clean list, so connecting sweeps too. Without
    // this case the connect-time sweep could be deleted and every other case
    // here would stay green — it is the only one that arrives and looks.
    const alice = await connect("alice");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );
    seedGhost(metaDoc(), "u-ghost", clock - 600_000);

    // Bob connecting is the only thing that happens. No frames are sent.
    await connect("bob");
    await waitFor(
      () => readPresence(metaDoc(), "u-ghost")?.online === false,
      "ghost cleared by the arrival itself",
    );

    expect(readPresence(metaDoc(), "u-ghost")?.online).toBe(false);
    expect(readPresence(metaDoc(), ALICE)?.online).toBe(true);
    alice.close();
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

    clock += BEAT_MS;
    await beat(alice, 4243);

    expect(readPresence(metaDoc(), ALICE)?.online).toBe(true);
  });
});

describe("presence wiring — the server decides whose caret is whose", () => {
  it("replaces an identity the client put on its own caret", async () => {
    const alice = await connect("alice");

    await sendCaret(alice, 4242, {
      cursor: { anchor: 1, head: 1 },
      user: { id: "u-victim" },
    });

    expect(caretState(4242)?.user).toEqual({ id: ALICE });
  });

  it("stamps a frame keyed to somebody else's caret with the sender", async () => {
    // The impersonation attempt, end to end: Alice's client id is public —
    // every peer is told it so it can draw her caret — so Bob can key an entry
    // to it. What comes out the other side is Bob.
    const alice = await connect("alice");
    await beat(alice, 5150);

    const bob = await connect("bob");
    await sendCaret(
      bob,
      5150,
      { cursor: { anchor: 9, head: 9 }, user: { id: ALICE } },
      // Past Alice's clock, or the frame is dropped before it is applied and
      // this case would pass on her leftover entry without proving anything.
      { revisions: 2 },
    );

    expect(caretState(5150)?.user).toEqual({ id: "u-bob" });
    expect(caretState(5150)?.cursor).toEqual({ anchor: 9, head: 9 });
  });

  it("stamps a caret arriving on a second connection with the same client id", async () => {
    // What a reconnect looks like from here: the browser keeps its Y.Doc, so
    // the client id survives, while the old socket has not been reaped yet.
    // The id stays registered against that old connection and never joins the
    // new one — a connection's client set only grows from `added`, and an id
    // the document already knows is `updated` from then on. Judging ownership
    // therefore used to leave this entry unstamped, and with the browser no
    // longer naming itself that meant a caret with no identity at all.
    const first = await connect("alice");
    await beat(first, 6060);

    const second = await connect("alice-second");
    await sendCaret(
      second,
      6060,
      { cursor: { anchor: 2, head: 2 }, user: { id: "u-never-stamped" } },
      // Past the first connection's clock, for the same reason as above.
      { revisions: 2 },
    );

    // The sentinel is what makes this case sharp: an unstamped entry keeps it,
    // and the entry the first connection left behind carries a different
    // cursor, so neither outcome can be mistaken for a pass.
    expect(caretState(6060)?.user).toEqual({ id: ALICE });
    expect(caretState(6060)?.cursor).toEqual({ anchor: 2, head: 2 });
  });

  it("stamps a caret on a space document, not only on the meta one", async () => {
    // Every other case here runs on the meta document, which is the one place
    // a caret can never appear — meta carries heartbeats and nothing else.
    // So without this case the rule could be gated to meta only and the whole
    // suite would still pass, while every real caret went out unstamped and
    // therefore nameless, the browser having stopped naming itself in #1886.
    const alice = await connect("alice", CANVAS_DOC);

    await sendCaret(
      alice,
      7070,
      { cursor: { anchor: 3, head: 3 }, user: { id: "u-victim" } },
      { docName: CANVAS_DOC },
    );

    expect(caretState(7070, CANVAS_DOC)?.user).toEqual({ id: ALICE });
  });
});
