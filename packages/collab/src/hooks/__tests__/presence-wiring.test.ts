// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { listAgentPresence, markAgentActive, markOnline, readFollowing, readPresence, writeFollowing } from "@collab/hooks/presence";
import {
  forgetFollowingOnDisconnect,
  lastViewOfAwareness,
  recordFollowingFromAwareness,
  recordPresenceOnConnect,
  refreshPresenceForSocket,
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
const POLICY = { staleAfterMs: 90_000, agentIdleMs: 300_000, agentOnlineMs: 1_800_000 };

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
 * machine or another — so absence is left entirely to the sweep. With
 * `following`, it also records whom each connection follows (#920) and drops
 * a connection's entry when it closes: that entry is per socket, not per person.
 * @param options - What else to wire.
 * @param options.following - Wire the following table the way production does.
 * @returns The server.
 */
function makeServer(options: { following?: boolean } = {}): Hocuspocus {
  const following = options.following
    ? {
      // Production order: the identity is stamped first, then whom the
      // sender follows is recorded from the same frame.
      beforeHandleAwareness: async (payload: unknown): Promise<void> => {
        stampIdentityOnAwareness(payload as never);
        recordFollowingFromAwareness(payload as never, { now: () => clock, ...POLICY });
      },
      onDisconnect: async (payload: unknown): Promise<void> => {
        forgetFollowingOnDisconnect(payload as never);
      },
    }
    : {};
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
    ...following,
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
 * Send one awareness frame from a client, the way its caret timer does.
 * @param client - Who is sending.
 * @param clientId - Yjs client id to attribute the state to.
 */
async function beat(client: LiveClient, clientId: number): Promise<void> {
  await sendCaret(client, clientId, { cursor: { anchor: 1, head: 1 } });
}

/**
 * A sign of life (a pong, a ping or any message) on a socket that carries the
 * meta document.
 *
 * This is what refreshes presence now. The socket's connections are what the
 * per-socket table hands the liveness callback, so the shape here is that map
 * with the two fields presence reads off each connection.
 * @param userId - Whose socket answered.
 * @param options - What that socket carries.
 * @param options.document - The meta document on it, defaulting to the live one.
 * @param options.extraDocs - Further documents on the same socket.
 * @param options.heardAt - When the socket was heard, defaulting to now.
 */
function alive(
  userId: string,
  options: { document?: Y.Doc; extraDocs?: [string, Y.Doc][]; heardAt?: number } = {},
): void {
  const { document = metaDoc(), extraDocs = [], heardAt = clock } = options;
  const connections = new Map(
    [
      ...extraDocs,
      [META_DOC, document] as [string, Y.Doc],
    ].map(([name, doc]) => [
      name,
      { context: { user: { id: userId } }, document: doc },
    ]),
  );
  refreshPresenceForSocket(connections, { now: () => clock, ...POLICY }, heardAt, `sock-${userId}`);
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

describe("presence wiring — a sign of life refreshes and sweeps", () => {
  it("clears a record nobody is refreshing when a pong arrives", async () => {
    // The sweep runs off other people's sockets answering, which is what makes
    // it able to clean up after a crashed server: the first person back starts
    // the pongs that clear whoever that server left behind.
    await connect("alice");
    seedGhost(metaDoc(), "u-ghost", clock - 600_000);

    clock += BEAT_MS;
    alive(ALICE);

    expect(readPresence(metaDoc(), "u-ghost")?.online).toBe(false);
  });

  it("moves the owner of the socket's meta connection forward", async () => {
    await connect("alice");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );

    clock += BEAT_MS;
    alive(ALICE);

    expect(readPresence(metaDoc(), ALICE)?.lastSeenAt).toBe(clock);
  });

  it("stamps the time the socket was last heard, and sweeps by the time the refresh runs", async () => {
    // A refresh held back behind an earlier one runs up to half a ping period
    // after the socket was heard. Stamping the run time would keep a person
    // whose network just died online that much longer.
    await connect("alice");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );
    seedGhost(metaDoc(), "u-ghost", clock + BEAT_MS - POLICY.staleAfterMs);

    clock += BEAT_MS;
    alive(ALICE, { heardAt: clock - 14_950 });

    expect(readPresence(metaDoc(), ALICE)?.lastSeenAt).toBe(clock - 14_950);
    expect(readPresence(metaDoc(), "u-ghost")?.online).toBe(false);
  });

  it("refreshes from the meta connection even when the socket carries space documents too", async () => {
    // A socket carries the meta document plus whatever Spaces the member has
    // open. Presence hangs off the meta one, so the others must not decide
    // whether anything is written.
    await connect("alice");
    const space = new Y.Doc();

    clock += BEAT_MS;
    alive(ALICE, { extraDocs: [[`project-${PID}/canvas-s1`, space]] });

    expect(readPresence(metaDoc(), ALICE)?.lastSeenAt).toBe(clock);
    space.destroy();
  });

  it("writes nothing for a socket carrying no meta document", () => {
    // Every socket pongs, including one that is only carrying Space documents
    // while its meta connection is still being set up. Presence lives in the
    // meta document, so there is nothing to refresh and nothing to sweep — and
    // in particular a Space document must not be given a `users` map.
    const space = new Y.Doc();
    seedGhost(space, "u-ghost", clock - 600_000);

    refreshPresenceForSocket(
      new Map([
        [
          `project-${PID}/canvas-s1`,
          { context: { user: { id: ALICE } }, document: space },
        ],
      ]),
      { now: () => clock, ...POLICY },
      clock,
      "sock-1",
    );

    expect(readPresence(space, ALICE)).toBeNull();
    expect(readPresence(space, "u-ghost")?.online).toBe(true);
    space.destroy();
  });

  it("leaves the roster alone when an awareness frame arrives", async () => {
    // Awareness frames still reach the server and still get their carets
    // stamped. What they no longer do is touch the roster: the module exports
    // one refresh and it takes a socket's connections, so the caret path
    // cannot reach a presence record even by accident.
    const alice = await connect("alice");
    await waitFor(
      () => readPresence(metaDoc(), ALICE)?.online === true,
      "alice recorded online",
    );
    const seenAtConnect = readPresence(metaDoc(), ALICE)?.lastSeenAt;

    clock += BEAT_MS;
    await beat(alice, 4242);

    expect(readPresence(metaDoc(), ALICE)?.lastSeenAt).toBe(seenAtConnect);
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

  it("ages external agents by their own spans when somebody arrives or a pong arrives", () => {
    const doc = new Y.Doc();
    markAgentActive({ document: doc, userId: "u-bob", connectionId: "gone", spaceId: null, focus: undefined, now: clock - POLICY.agentOnlineMs });
    markAgentActive({ document: doc, userId: "u-bob", connectionId: "quiet", spaceId: null, focus: undefined, now: clock - POLICY.agentIdleMs });
    markAgentActive({ document: doc, userId: "u-bob", connectionId: "busy", spaceId: null, focus: undefined, now: clock - POLICY.staleAfterMs * 2 });
    recordPresenceOnConnect(
      { documentName: META_DOC, instance: { documents: new Map([[META_DOC, doc]]) }, context: { user: { id: ALICE } } },
      { now: () => clock, ...POLICY },
    );
    const byId = new Map(listAgentPresence(doc).map((a) => [a.connectionId, a]));
    expect(byId.get("gone")?.online).toBe(false);
    expect(byId.get("quiet")?.online).toBe(true);
    expect((doc.getMap("users").get(byId.get("quiet")!.key) as Y.Map<unknown>).get("idle")).toBe(true);
    expect(byId.get("busy")?.online).toBe(true);

    markAgentActive({ document: doc, userId: "u-bob", connectionId: "busy", spaceId: null, focus: undefined, now: clock - POLICY.agentOnlineMs });
    alive(ALICE, { document: doc });
    expect(listAgentPresence(doc).find((a) => a.connectionId === "busy")?.online).toBe(false);
    doc.destroy();
  });

  it("clears a ghost the moment somebody arrives, before any pong", async () => {
    // The first person back after a crash should not have to wait a whole ping
    // period to see a clean list, so connecting sweeps too. Without
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

  it("puts a swept user back when their own socket answers", async () => {
    // The sweep keeps running and can flip somebody who is still connected —
    // a record left behind by one instance while another holds the socket, say.
    // The pong is proof they are here, and it has to outrank that inference, or
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
    alive(ALICE);

    expect(readPresence(metaDoc(), ALICE)?.online).toBe(true);
    alice.close();
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

/*
 * Whom each connection follows (#920, design 4.2.1). Expected from
 * `hooks/presence-wiring.ts`:
 *
 *   recordFollowingFromAwareness(payload, policy): void
 *     payload = the meta document's `beforeHandleAwareness` payload
 *     `{ states, connection?, context?, socketId, documentName, document }`.
 *     Only a meta document and only a frame with a `connection`; skips the
 *     scratch awareness's own (empty, or after stamping only `user`) entry;
 *     the sender's `following: { id, at }` → `writeFollowing` for `socketId`
 *     (userId from the connection context, lastSeenAt `policy.now()`);
 *     `following` null or absent → `deleteFollowing` for `socketId`.
 *   forgetFollowingOnDisconnect(payload): void
 *     payload = `{ documentName, socketId, document }` from `onDisconnect`;
 *     deletes that socket's entry on a meta document. The refused-duplicate
 *     check stays in `hocuspocus.ts`, before this call.
 *   refreshPresenceForSocket(connections, policy, heardAt, socketId): void
 *     also moves that socket's entry `lastSeenAt` to `heardAt`, whether or
 *     not the owner has a presence record.
 */

/** Where the following table lives in the meta document. */
const FOLLOWING = "following";

/**
 * The socket ids of the connections the meta document holds now.
 * @returns The ids.
 */
function metaSocketIds(): Set<string> {
  const doc = metaDoc() as unknown as { getConnections: () => Array<{ socketId: string }> };
  return new Set(doc.getConnections().map((c) => c.socketId));
}

/**
 * Connect to the meta document and learn the socket id the server gave it.
 * @param cookie - Who connects.
 * @returns The client and its socket id.
 * @throws {Error} When no new connection appeared.
 */
async function connectWithSocket(cookie: string): Promise<{ client: LiveClient; socketId: string }> {
  const before = server.documents.has(META_DOC) ? metaSocketIds() : new Set<string>();
  const client = await connect(cookie);
  const socketId = [...metaSocketIds()].find((id) => !before.has(id));
  if (socketId === undefined) throw new Error(`no new meta connection for ${cookie}`);
  return { client, socketId };
}

/**
 * Count the Yjs updates the meta document emits while `fn` runs.
 * @param fn - What to run.
 * @returns How many updates it emitted.
 */
async function metaUpdatesDuring(fn: () => Promise<void>): Promise<number> {
  let count = 0;
  const onUpdate = (): void => {
    count += 1;
  };
  const doc = metaDoc();
  doc.on("update", onUpdate);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    doc.off("update", onUpdate);
  }
  return count;
}

describe("presence wiring — the server keeps whom each connection follows", () => {
  beforeEach(() => {
    server = makeServer({ following: true });
  });

  it("records whom a tab follows when it declares it, with the start time the tab sent", async () => {
    const { client, socketId } = await connectWithSocket("alice");

    await sendCaret(client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), socketId) !== null, "alice's following recorded");

    expect(readFollowing(metaDoc(), socketId)).toEqual({ userId: ALICE, target: "u-bob", at: 500, lastSeenAt: clock });
  });

  it("writes nothing when a beat or a focus change resends the same following", async () => {
    const { client, socketId } = await connectWithSocket("alice");
    await sendCaret(client, 8080, { view: { spaceId: "s1", at: 400, focused: true }, following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), socketId) !== null, "alice's following recorded");
    const recorded = readFollowing(metaDoc(), socketId);

    clock += BEAT_MS;
    const updates = await metaUpdatesDuring(async () => {
      await sendCaret(client, 8080, { view: { spaceId: "s1", at: 400, focused: true }, following: { id: "u-bob", at: 500 } }, { revisions: 2 });
      await sendCaret(client, 8080, { view: { spaceId: "s1", at: 400, focused: false }, following: { id: "u-bob", at: 500 } }, { revisions: 3 });
    });

    expect(updates).toBe(0);
    expect(readFollowing(metaDoc(), socketId)).toEqual(recorded);
  });

  it("rewrites the entry when the tab follows somebody else", async () => {
    const { client, socketId } = await connectWithSocket("alice");
    await sendCaret(client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), socketId) !== null, "alice's following recorded");

    clock += BEAT_MS;
    await sendCaret(client, 8080, { following: { id: "u-carol", at: 900 } }, { revisions: 2 });
    await waitFor(() => readFollowing(metaDoc(), socketId)?.target === "u-carol", "alice's new target recorded");

    expect(readFollowing(metaDoc(), socketId)).toEqual({ userId: ALICE, target: "u-carol", at: 900, lastSeenAt: clock });
  });

  it("deletes the entry when the tab stops following", async () => {
    const { client, socketId } = await connectWithSocket("alice");
    await sendCaret(client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), socketId) !== null, "alice's following recorded");

    await sendCaret(client, 8080, { following: null }, { revisions: 2 });
    await waitFor(() => readFollowing(metaDoc(), socketId) === null, "alice's following deleted");

    expect(metaDoc().getMap(FOLLOWING).has(socketId)).toBe(false);
  });

  it("deletes the entry when the tab's state no longer carries following at all", async () => {
    const { client, socketId } = await connectWithSocket("alice");
    await sendCaret(client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), socketId) !== null, "alice's following recorded");

    await sendCaret(client, 8080, { view: { spaceId: "s1", at: 600, focused: true } }, { revisions: 2 });
    await waitFor(() => readFollowing(metaDoc(), socketId) === null, "alice's following deleted");

    expect(metaDoc().getMap(FOLLOWING).has(socketId)).toBe(false);
  });

  it("deletes a connection's entry when it closes, and leaves other connections' entries", async () => {
    const alice = await connectWithSocket("alice");
    const bob = await connectWithSocket("bob");
    await sendCaret(alice.client, 8080, { following: { id: "u-bob", at: 500 } });
    await sendCaret(bob.client, 9090, { following: { id: ALICE, at: 600 } });
    await waitFor(
      () => readFollowing(metaDoc(), alice.socketId) !== null && readFollowing(metaDoc(), bob.socketId) !== null,
      "both followings recorded",
    );

    alice.client.close();
    await waitFor(() => readFollowing(metaDoc(), alice.socketId) === null, "alice's entry deleted on close");

    expect(readFollowing(metaDoc(), bob.socketId)?.target).toBe(ALICE);
  });

  it("records the frame a reconnecting tab resends with an unchanged awareness clock", async () => {
    // The browser keeps its Y.Doc across a reconnect, so it resends its state
    // under the same client id and clock. The document's awareness already
    // saw that clock and drops the frame, so a reader of applied awareness
    // updates never sees it; the hook before that filter does.
    await connectWithSocket("bob");
    const first = await connectWithSocket("alice");
    await sendCaret(first.client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), first.socketId) !== null, "alice's following recorded");
    first.client.close();
    await waitFor(() => readFollowing(metaDoc(), first.socketId) === null, "alice's entry deleted on close");

    const again = await connectWithSocket("alice");
    await sendCaret(again.client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), again.socketId) !== null, "the resent following recorded");

    expect(readFollowing(metaDoc(), again.socketId)).toEqual({ userId: ALICE, target: "u-bob", at: 500, lastSeenAt: clock });
    // Proof the frame was one the awareness clock filtered out.
    expect(caretState(8080)).toBeUndefined();
  });

  it("writes nothing for a frame relayed from another instance", async () => {
    // A relayed frame has no connection, and its socket id is the empty string.
    await connectWithSocket("bob");
    const states = new Map<number, Record<string, unknown>>([
      [8080, { user: { id: ALICE }, following: { id: "u-bob", at: 500 } }],
    ]);

    const updates = await metaUpdatesDuring(async () => {
      recordFollowingFromAwareness(
        { states, socketId: "", context: undefined, documentName: META_DOC, document: metaDoc() },
        { now: () => clock, ...POLICY },
      );
    });

    expect(updates).toBe(0);
    expect(metaDoc().getMap(FOLLOWING).size).toBe(0);
  });

  it("does not read the scratch awareness's own empty entry as a tab that stopped following", async () => {
    // Every frame the hook sees also holds the scratch awareness's local
    // entry, `{}` at clock zero, stamped with the sender like any other.
    // Whichever order the two come in, the declaration stands and a repeat
    // of it writes nothing.
    const { socketId } = await connectWithSocket("alice");
    const connection = { context: { user: { id: ALICE } }, socketId };
    /**
     * Run the hook pair the way production does, on one frame.
     * @param states - The frame's entries, in order.
     */
    const frame = (states: Array<[number, Record<string, unknown>]>): void => {
      const payload = {
        states: new Map(states),
        connection,
        context: connection.context,
        socketId,
        documentName: META_DOC,
        document: metaDoc(),
      };
      stampIdentityOnAwareness(payload);
      recordFollowingFromAwareness(payload, { now: () => clock, ...POLICY });
    };

    frame([[1, {}], [8080, { following: { id: "u-bob", at: 500 } }]]);
    expect(readFollowing(metaDoc(), socketId)?.target).toBe("u-bob");

    clock += BEAT_MS;
    const updates = await metaUpdatesDuring(async () => {
      frame([[1, {}], [8080, { following: { id: "u-bob", at: 500 } }]]);
      frame([[8080, { following: { id: "u-bob", at: 500 } }], [1, {}]]);
    });

    expect(updates).toBe(0);
    expect(readFollowing(metaDoc(), socketId)).toEqual({ userId: ALICE, target: "u-bob", at: 500, lastSeenAt: clock - BEAT_MS });
  });

  it("moves a socket's entry forward on its sign of life, even for an owner with no presence record", () => {
    // `touchLastSeen` refuses to create a record and returns early; whom the
    // socket follows is refreshed regardless.
    const doc = new Y.Doc();
    writeFollowing({ document: doc, socketId: "sock-1", userId: ALICE, target: "u-bob", at: 500, now: 1_000 });
    writeFollowing({ document: doc, socketId: "sock-2", userId: ALICE, target: "u-bob", at: 500, now: 1_000 });

    refreshPresenceForSocket(
      new Map([[META_DOC, { context: { user: { id: ALICE } }, document: doc }]]),
      { now: () => clock, ...POLICY },
      7_000,
      "sock-1",
    );

    expect(readPresence(doc, ALICE)).toBeNull();
    expect(readFollowing(doc, "sock-1")?.lastSeenAt).toBe(7_000);
    expect(readFollowing(doc, "sock-2")?.lastSeenAt).toBe(1_000);
    doc.destroy();
  });

  it("sends one meta update per sign of life for a socket that follows someone and has a presence record", () => {
    // Every update is broadcast to the whole project; the entry and the record
    // move together in one transaction.
    const doc = new Y.Doc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });
    writeFollowing({ document: doc, socketId: "sock-1", userId: ALICE, target: "u-bob", at: 500, now: 1_000 });
    let updates = 0;
    doc.on("update", () => { updates += 1; });

    refreshPresenceForSocket(
      new Map([[META_DOC, { context: { user: { id: ALICE } }, document: doc }]]),
      { now: () => 7_000, ...POLICY },
      7_000,
      "sock-1",
    );

    expect(updates).toBe(1);
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(7_000);
    expect(readFollowing(doc, "sock-1")?.lastSeenAt).toBe(7_000);
    doc.destroy();
  });

  it("moves the entry forward alongside the presence record when there is one", async () => {
    const { client, socketId } = await connectWithSocket("alice");
    await sendCaret(client, 8080, { following: { id: "u-bob", at: 500 } });
    await waitFor(() => readFollowing(metaDoc(), socketId) !== null, "alice's following recorded");

    clock += BEAT_MS;
    refreshPresenceForSocket(
      new Map([[META_DOC, { context: { user: { id: ALICE } }, document: metaDoc() }]]),
      { now: () => clock, ...POLICY },
      clock,
      socketId,
    );

    expect(readPresence(metaDoc(), ALICE)?.lastSeenAt).toBe(clock);
    expect(readFollowing(metaDoc(), socketId)?.lastSeenAt).toBe(clock);
  });
});

describe("presence wiring — what a member has on screen (#1488)", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const SPACE = "22222222-2222-4222-8222-222222222222";
  const CANVAS = `project-${PROJECT}/canvas-${SPACE}`;

  it("takes the view a member's frame publishes on a Space document, with the Space it is of", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, {}],
      [7, { user: { id: ALICE }, activeNodeIds: ["n1"], pointer: { x: 1, y: 2 } }],
    ]);
    expect(lastViewOfAwareness({ states, context: { user: { id: ALICE } }, documentName: CANVAS })).toEqual({
      projectId: PROJECT,
      userId: ALICE,
      spaceId: SPACE,
      view: { activeNodeIds: ["n1"], pointer: { x: 1, y: 2 }, camera: null, cursor: null },
    });
  });

  it("takes nothing from the meta document, a relayed frame, or a frame with no view", () => {
    const states = new Map<number, Record<string, unknown>>([[7, { activeNodeIds: ["n1"] }]]);
    expect(lastViewOfAwareness({ states, context: { user: { id: ALICE } }, documentName: `project-${PROJECT}/meta` })).toBeNull();
    expect(lastViewOfAwareness({ states, context: undefined, documentName: CANVAS })).toBeNull();
    expect(lastViewOfAwareness({ states: new Map([[7, { user: { id: ALICE } }]]), context: { user: { id: ALICE } }, documentName: CANVAS })).toBeNull();
  });
});
