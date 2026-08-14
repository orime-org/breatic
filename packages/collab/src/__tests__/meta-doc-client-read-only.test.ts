// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The meta doc is read-only for every client — measured against a real
 * Hocuspocus instance (design 2026-08-02 §10.4).
 *
 * The gate this replaced was unit-tested and green for its whole life while
 * never once running in production: the frames those tests built had no
 * document-name prefix, a shape no real client sends. So the lesson §10.4
 * draws is that the judgement here does not live in our code at all — it
 * lives in the framework, at each site where it would apply an update — and
 * the only way to assert it is to send real frames at a real server and look
 * at the document afterwards.
 *
 * Every "the write did not land" case is paired with a frame of the same shape
 * sent to a Space CONTENT doc by the same editor, which does land. Without that
 * pair the assertions would also pass if the harness simply could not write
 * anything. Where the PAYLOAD is the thing that could be silently empty, the
 * pair sends that very payload rather than a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { Hocuspocus } from "@hocuspocus/server";

const {
  getSessionMock,
  loadProjectRoleMock,
  fetchDocDataMock,
  activityInsertMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadProjectRoleMock: vi.fn(),
  fetchDocDataMock: vi.fn(),
  activityInsertMock: vi.fn(),
}));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  fetchDocData: fetchDocDataMock,
  softDeleteByName: vi.fn(),
  restoreByName: vi.fn(),
  seedInitialState: vi.fn(),
  countLiveSpaceDocs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    getSession: getSessionMock,
    sessionCookieName: () => "sid",
    projectAuthService: { loadProjectRole: loadProjectRoleMock },
    projectActivitiesRepo: {
      insert: activityInsertMock,
      insertIgnoreDuplicateTask: vi.fn(),
      latestUnrestoredDeleted: vi.fn(),
      consumeRestoreAndAppend: vi.fn(),
      listByProject: vi.fn(),
    },
  };
});

import { createAuthHook } from "@collab/hooks/auth.js";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";
import {
  projectMetaDocName,
  spaceContentDocName,
  SpaceRpcRequestSchema,
  type ProjectRole,
  type SpaceRpcResponse,
} from "@breatic/shared";
import {
  awarenessFrame,
  connectLiveClient,
  createLiveServer,
  statelessFrame,
  syncFrame,
  waitFor,
  SYNC,
  WIRE,
  type LiveClient,
} from "./helpers/live-hocuspocus.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const META_DOC = projectMetaDocName(PID);
const CANVAS_DOC = spaceContentDocName(PID, SID, "canvas");
const COOKIE = "sid=session-token";

let server: Hocuspocus;
let clients: LiveClient[];

/**
 * Build the persisted meta state the auth hook reads to decide whether a
 * Space still exists.
 * @returns Encoded Yjs state holding exactly one Space id.
 */
function persistedMetaState(): Buffer {
  const doc = new Y.Doc();
  const entry = new Y.Map<unknown>();
  entry.set("id", SID);
  entry.set("name", "Main");
  doc.getMap("spaces").set(SID, entry);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

/**
 * A Yjs update that adds a Space nobody asked for — the payload a client
 * would send if it tried to write the directory by hand.
 * @param spaceId - Id of the forged entry.
 * @returns Update bytes.
 */
function forgedSpaceUpdate(spaceId: string): Uint8Array {
  const doc = new Y.Doc();
  const entry = new Y.Map<unknown>();
  entry.set("id", spaceId);
  entry.set("name", "forged");
  entry.set("claimToken", "forged-token");
  doc.getMap("spaces").set(spaceId, entry);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * A Yjs update that rewrites the caller's own open-tab list — the one thing
 * clients used to be allowed to write here.
 * @param userId - Whose record to write.
 * @returns Update bytes.
 */
function ownTabsUpdate(userId: string): Uint8Array {
  const doc = new Y.Doc();
  const userMap = new Y.Map<unknown>();
  const list = new Y.Array<string>();
  list.push(["forged-tab"]);
  userMap.set("openTabIds", list);
  doc.getMap("perUser").set(userId, userMap);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * The largest uint32, handed to the forged presence doc as its client id.
 *
 * Yjs settles two concurrent writes to the SAME map key by client id, and the
 * larger one wins — measured on 13.6.30, symmetric across four orderings. A
 * forged record carrying a random id would therefore sometimes lose that race
 * on its own merits, which would make "the seeded record survived" a much
 * weaker statement than it looks. Client ids come from lib0's
 * `random.uint32()` (`getRandomValues(new Uint32Array(1))[0]`), whose range
 * tops out here, so no drawn id outranks this one.
 *
 * It is a sharpener, not the guard: the case that uses it also asserts the
 * refusal directly, so lowering this number weakens the assertion without
 * silencing it.
 */
const ALWAYS_WINS = 4294967295;

/**
 * A Yjs update that writes one presence record into `users` — the root the
 * collaborator roster lives in (#1886), the one whose whole guarantee is that
 * only the server writes it.
 * @param userId - Whose record to write.
 * @param online - The presence flag to claim.
 * @param lastSeenAt - The timestamp to claim.
 * @returns Update bytes.
 */
function presenceUpdate(
  userId: string,
  online: boolean,
  lastSeenAt: number,
): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = ALWAYS_WINS;
  const entry = new Y.Map<unknown>();
  entry.set("id", userId);
  entry.set("online", online);
  entry.set("lastSeenAt", lastSeenAt);
  doc.getMap("users").set(userId, entry);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * A Yjs update that writes into the content doc's own map, so the control
 * case writes something a content doc really holds.
 * @returns Update bytes.
 */
function contentDocUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("nodes").set("n1", "from the client");
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Live server wired with the real auth hook, plus the stateless dispatcher
 * shaped like `hocuspocus.ts`'s so the RPC case exercises the real handler.
 * @returns The server.
 */
function makeServer(): Hocuspocus {
  const instance = createLiveServer({
    // The real load path, with only its storage read injected. The
    // space-existence check makes sure this process holds the project's list
    // before it answers (#26), so a server with no way to load one would
    // refuse every content doc here.
    extensions: [
      createPersistenceExtension({
        fetch: async ({ documentName }: { documentName: string }) =>
          documentName === META_DOC ? await fetchDocDataMock() : null,
      }),
    ],
    onAuthenticate: createAuthHook({
      // The hook only forwards this to core's session store, which is mocked.
      redis: {} as never,
      // The ceiling is not this suite's subject. It used to say `0`, which
      // meant "unlimited" back when this was a constant; zero is now a real
      // zero (#88), so say the intent with a number nobody reaches.
      resolveConnectionLimit: async (): Promise<number> => 1000,
      countConnections: async (): Promise<number> => 0,
    }),
    onStateless: async ({
      documentName,
      document,
      payload,
      connection,
    }: {
      documentName: string;
      document: { broadcastStateless: (payload: string) => void };
      payload: string;
      connection: { context?: { user?: { id?: string; role?: ProjectRole } } };
    }): Promise<void> => {
      if (documentName !== META_DOC) return;
      const parsed = SpaceRpcRequestSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) return;
      const user = connection.context?.user;
      if (!user?.id || !user.role) return;
      const response = await handleSpaceRpc(
        { hocuspocus: instance },
        PID,
        { userId: user.id, role: user.role },
        parsed.data,
      );
      document.broadcastStateless(
        JSON.stringify(response satisfies SpaceRpcResponse),
      );
    },
  });
  return instance;
}

/**
 * Connect a client and remember it so `afterEach` can clear its ping timer.
 * @param docName - Document to open.
 * @returns The connected client.
 */
async function connect(docName: string): Promise<LiveClient> {
  const client = await connectLiveClient(server, docName, { cookie: COOKIE });
  clients.push(client);
  return client;
}

/**
 * Write into the meta doc through a direct connection — not a client, so no
 * read-only flag applies.
 *
 * Every "the server had already written X" precondition has to come from here,
 * because the client under test cannot put anything there itself. That is the
 * point of the file.
 *
 * This is one of the two ways collab's own writers reach this document, not
 * the only one: the Space RPCs open a direct connection like this, while
 * presence writes straight to the loaded document it was handed
 * (`presence-wiring.ts`). Both are server-side and neither is gated.
 * @param mutate - Applied to the live document inside a transaction.
 */
async function seedMetaDoc(mutate: (live: Y.Doc) => void): Promise<void> {
  const seed = await server.openDirectConnection(META_DOC, {
    context: { user: { id: "system" } },
  });
  await seed.transact(mutate);
  await seed.disconnect();
}

/**
 * The read-only flag the framework put on this document's client connection.
 * @param docName - Document to inspect.
 * @returns The flag, or undefined when no connection exists.
 */
function connectionReadOnly(docName: string): boolean | undefined {
  const doc = server.documents.get(docName);
  const connection = doc?.getConnections()[0] as
    | { readOnly?: boolean }
    | undefined;
  return connection?.readOnly;
}

beforeEach(() => {
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue("user-1");
  loadProjectRoleMock.mockReset();
  loadProjectRoleMock.mockResolvedValue("editor");
  fetchDocDataMock.mockReset();
  fetchDocDataMock.mockResolvedValue(persistedMetaState());
  activityInsertMock.mockReset();
  activityInsertMock.mockResolvedValue("act-1");
  clients = [];
  server = makeServer();
});

afterEach(() => {
  for (const client of clients) client.close();
});

describe("meta doc — the client's connection is read-only", () => {
  it("reports readonly to an editor opening the meta doc", async () => {
    const client = await connect(META_DOC);

    expect(client.authenticated).toBe(true);
    expect(client.authorizedScope).toBe("readonly");
    expect(connectionReadOnly(META_DOC)).toBe(true);
  });

  it("reports readonly to an owner opening the meta doc", async () => {
    loadProjectRoleMock.mockResolvedValue("owner");

    const client = await connect(META_DOC);

    expect(client.authenticated).toBe(true);
    expect(client.authorizedScope).toBe("readonly");
    expect(connectionReadOnly(META_DOC)).toBe(true);
  });

  it("leaves a Space content doc writable for the same editor", async () => {
    const client = await connect(CANVAS_DOC);

    expect(client.authenticated).toBe(true);
    expect(client.authorizedScope).toBe("read-write");
    expect(connectionReadOnly(CANVAS_DOC)).toBe(false);
  });
});

describe("meta doc — a client write never lands", () => {
  /**
   * Send one update frame and read back what the server document holds.
   * @param outerType - `WIRE.sync` or `WIRE.syncReply`.
   * @param syncSubType - `SYNC.update` or `SYNC.step2`.
   * @returns The forged id, the client, and the server's `spaces` map.
   */
  async function attemptSpaceWrite(
    outerType: number,
    syncSubType: number,
  ): Promise<{
    forgedId: string;
    client: LiveClient;
    spaces: Y.Map<unknown>;
  }> {
    const forgedId = "forged-space-id";
    const client = await connect(META_DOC);
    const framesBefore = client.frames().length;
    client.send(
      syncFrame(META_DOC, outerType, syncSubType, forgedSpaceUpdate(forgedId)),
    );
    await waitFor(
      () => client.frames().length > framesBefore,
      "an answer to the write attempt",
    );
    const doc = server.documents.get(META_DOC);
    if (!doc) throw new Error("meta doc not loaded");
    return { forgedId, client, spaces: doc.getMap("spaces") };
  }

  it("refuses Sync + Update — the shape a client sends after the handshake", async () => {
    const { forgedId, client, spaces } = await attemptSpaceWrite(
      WIRE.sync,
      SYNC.update,
    );

    expect(spaces.has(forgedId)).toBe(false);
    // Unchanged, not empty: the server loads this project's seeded list
    // (`persistedMetaState`), so "nothing landed" means the list still reads
    // exactly as it was seeded.
    expect(Array.from(spaces.keys())).toEqual([SID]);
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(false);
  });

  it("refuses SyncReply + Update — the outer type that reaches the same branch", async () => {
    const { forgedId, client, spaces } = await attemptSpaceWrite(
      WIRE.syncReply,
      SYNC.update,
    );

    expect(spaces.has(forgedId)).toBe(false);
    // Unchanged, not empty: the server loads this project's seeded list
    // (`persistedMetaState`), so "nothing landed" means the list still reads
    // exactly as it was seeded.
    expect(Array.from(spaces.keys())).toEqual([SID]);
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(false);
  });

  it("refuses Sync + SyncStep2 — the frame every handshake carries", async () => {
    const { forgedId, client, spaces } = await attemptSpaceWrite(
      WIRE.sync,
      SYNC.step2,
    );

    expect(spaces.has(forgedId)).toBe(false);
    // Unchanged, not empty: the server loads this project's seeded list
    // (`persistedMetaState`), so "nothing landed" means the list still reads
    // exactly as it was seeded.
    expect(Array.from(spaces.keys())).toEqual([SID]);
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(false);
  });

  it("refuses a write to the caller's own perUser record — the old exception is gone", async () => {
    const client = await connect(META_DOC);
    const framesBefore = client.frames().length;

    client.send(
      syncFrame(META_DOC, WIRE.sync, SYNC.update, ownTabsUpdate("user-1")),
    );
    await waitFor(
      () => client.frames().length > framesBefore,
      "an answer to the perUser write attempt",
    );

    const doc = server.documents.get(META_DOC);
    if (!doc) throw new Error("meta doc not loaded");
    expect(Array.from(doc.getMap("perUser").keys())).toEqual([]);
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(false);
  });

  it("refuses a presence record forged for somebody else", async () => {
    const client = await connect(META_DOC);
    const framesBefore = client.frames().length;

    client.send(
      syncFrame(
        META_DOC,
        WIRE.sync,
        SYNC.update,
        presenceUpdate("user-2", true, 1),
      ),
    );
    await waitFor(
      () => client.frames().length > framesBefore,
      "an answer to the forged presence write",
    );

    const doc = server.documents.get(META_DOC);
    if (!doc) throw new Error("meta doc not loaded");
    // Names the forged id rather than asserting the root is empty. Emptiness
    // holds here only because this server omits the presence wiring: in
    // production `connected` runs `recordPresenceOnConnect`, which puts the
    // CONNECTING user in this very map. An empty-root assertion would
    // therefore be true for a reason that has nothing to do with the gate,
    // and could not tell a refused forgery apart from nobody writing here.
    expect(doc.getMap("users").has("user-2")).toBe(false);
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(false);
  });

  it("cannot turn somebody else's presence off — a record already there stands", async () => {
    // The only case in this file that asserts an EXISTING value survived
    // rather than a forged key being absent. A gate that refused new keys but
    // let a client overwrite what is already there would pass every other
    // case here, and it would be the whole of #1886 undone: marking a present
    // collaborator offline drops them off everybody's roster.
    const client = await connect(META_DOC);
    await seedMetaDoc((live: Y.Doc) => {
      const entry = new Y.Map<unknown>();
      entry.set("id", "user-2");
      entry.set("online", true);
      entry.set("lastSeenAt", 1000);
      live.getMap("users").set("user-2", entry);
    });
    const framesBefore = client.frames().length;

    client.send(
      syncFrame(
        META_DOC,
        WIRE.sync,
        SYNC.update,
        presenceUpdate("user-2", false, 1),
      ),
    );
    await waitFor(
      () => client.frames().length > framesBefore,
      "an answer to the presence-off write",
    );

    const doc = server.documents.get(META_DOC);
    if (!doc) throw new Error("meta doc not loaded");
    const entry = doc.getMap("users").get("user-2") as Y.Map<unknown>;
    expect(entry.get("online")).toBe(true);
    expect(entry.get("lastSeenAt")).toBe(1000);
    // The refusal itself, asserted the way its five siblings do. Without it
    // this case would be the one place in the file whose whole detecting
    // power sits in `ALWAYS_WINS`: the surviving value proves a refusal only
    // as long as the forged update WOULD have won had it been applied.
    // Measured — with the constant lowered to 1 and the gate deleted, this
    // was the only REFUSAL case still green. The four controls stayed green
    // too, but they are meant to.
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(false);
  });

  it("applies the very same frame shape to a Space content doc", async () => {
    const client = await connect(CANVAS_DOC);
    const framesBefore = client.frames().length;

    client.send(
      syncFrame(CANVAS_DOC, WIRE.sync, SYNC.update, contentDocUpdate()),
    );
    await waitFor(
      () => client.frames().length > framesBefore,
      "an answer to the content-doc write",
    );

    const doc = server.documents.get(CANVAS_DOC);
    if (!doc) throw new Error("content doc not loaded");
    expect(doc.getMap("nodes").get("n1")).toBe("from the client");
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(true);
  });

  it("applies the presence payload itself to a Space content doc", async () => {
    // The pair the file's own rule demands, for the presence payload rather
    // than a different one. Without it, a `presenceUpdate` that wrote nothing
    // — wrong root, unattached map, empty encoding — would leave both refusal
    // cases green while proving nothing at all. Measured: emptying that
    // function with the gate intact passed all twelve cases; this one is what
    // goes red.
    const client = await connect(CANVAS_DOC);
    const framesBefore = client.frames().length;

    client.send(
      syncFrame(
        CANVAS_DOC,
        WIRE.sync,
        SYNC.update,
        presenceUpdate("user-2", false, 1),
      ),
    );
    await waitFor(
      () => client.frames().length > framesBefore,
      "an answer to the presence-payload write",
    );

    const doc = server.documents.get(CANVAS_DOC);
    if (!doc) throw new Error("content doc not loaded");
    const entry = doc.getMap("users").get("user-2") as Y.Map<unknown>;
    expect(entry.get("online")).toBe(false);
    expect(entry.get("lastSeenAt")).toBe(1);
    const status = client.frames().filter((f) => f.type === WIRE.syncStatus);
    expect(status.at(-1)?.syncStatusOk).toBe(true);
  });
});

describe("meta doc — read-only does not close our own paths", () => {
  it("still runs a space:rename sent on the stateless channel", async () => {
    const client = await connect(META_DOC);
    const doc = server.documents.get(META_DOC);
    if (!doc) throw new Error("meta doc not loaded");
    await seedMetaDoc((live: Y.Doc) => {
      const entry = new Y.Map<unknown>();
      entry.set("id", SID);
      entry.set("name", "Before");
      live.getMap("spaces").set(SID, entry);
    });

    client.send(
      statelessFrame(
        META_DOC,
        JSON.stringify({
          id: "rpc-1",
          type: "space:rename",
          payload: { spaceId: SID, name: "After" },
        }),
      ),
    );
    await waitFor(
      () =>
        client
          .frames()
          .some((f) => f.type === WIRE.stateless && f.stateless?.includes("rpc-1")),
      "the RPC reply",
    );

    const reply = client
      .frames()
      .find((f) => f.type === WIRE.stateless && f.stateless?.includes("rpc-1"));
    expect(JSON.parse(reply?.stateless ?? "{}")).toEqual({
      id: "rpc-1",
      ok: true,
    });
    const entry = doc.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(entry.get("name")).toBe("After");
  });

  it("still relays an awareness update from a read-only client to the others", async () => {
    const listener = await connect(META_DOC);
    const sender = await connect(META_DOC);
    const framesBefore = listener.frames().length;

    const local = new Awareness(new Y.Doc());
    local.setLocalStateField("user", { id: "user-1", name: "Ada" });
    sender.send(
      awarenessFrame(
        META_DOC,
        encodeAwarenessUpdate(local, [local.clientID]),
      ),
    );

    await waitFor(
      () =>
        listener
          .frames()
          .slice(framesBefore)
          .some((f) => f.type === WIRE.awareness),
      "the relayed awareness update",
    );

    const doc = server.documents.get(META_DOC);
    if (!doc) throw new Error("meta doc not loaded");
    const relayed = doc.awareness.getStates().get(local.clientID) as
      | { user?: { name?: string } }
      | undefined;
    expect(relayed?.user?.name).toBe("Ada");
  });
});
