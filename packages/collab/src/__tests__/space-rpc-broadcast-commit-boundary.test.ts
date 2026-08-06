// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The broadcast is the commit boundary — measured against a real Hocuspocus
 * instance (design 2026-08-02 §10.2).
 *
 * The fake connection the other space-rpc tests use is
 * `async (fn) => fn(doc)`. It does not broadcast, does not persist, and cannot
 * reject, so the three claims below are all invisible to it:
 *
 *   1. a store failure AFTER the change went out does not undo it, and the
 *      caller is still told it worked;
 *   2. a failure BEFORE it goes out produces no broadcast at all;
 *   3. the activity signal leaves after the meta change, never before.
 *
 * Each is about something that happens on the wire or inside the framework, so
 * each needs the framework. A real client connection is attached to the meta
 * doc and everything the server sends it is recorded: `Document.handleUpdate`
 * is bound to the Y.Doc "update" event and sends to every connection
 * synchronously, so a recorded Sync/Update frame IS the broadcast, with a
 * position other frames can be ordered against.
 *
 * Every case gets its own project id. This used to be load-bearing: a failed
 * store poisoned its document, so a shared id made the second case fail for
 * the first case's reason. Since hocuspocus 4 the library swallows store
 * errors and that cannot happen, so it is now ordinary test isolation.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "vitest";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";

const {
  seedInitialStateMock,
  softDeleteByNameMock,
  restoreByNameMock,
  countLiveSpaceDocsMock,
  withSpaceDeleteLockMock,
  FakeLockBusyError,
  activityInsertMock,
} = vi.hoisted(() => ({
  seedInitialStateMock: vi.fn(),
  softDeleteByNameMock: vi.fn(),
  restoreByNameMock: vi.fn(),
  countLiveSpaceDocsMock: vi.fn(),
  withSpaceDeleteLockMock: vi.fn(),
  FakeLockBusyError: class FakeLockBusyError extends Error {},
  activityInsertMock: vi.fn(),
}));

vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  seedInitialState: seedInitialStateMock,
  softDeleteByName: softDeleteByNameMock,
  restoreByName: restoreByNameMock,
  countLiveSpaceDocs: countLiveSpaceDocsMock,
  fetchDocData: vi.fn(),
}));

vi.mock("@collab/services/space-delete-lock.js", () => ({
  withSpaceDeleteLock: withSpaceDeleteLockMock,
  SpaceDeleteLockBusyError: FakeLockBusyError,
}));

// Real `writeSpaceEntry` / `encodeInitialSpaceContentState` — the entry shape
// is part of what the broadcast carries, so it must not be stubbed.
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
    projectActivitiesRepo: {
      insert: activityInsertMock,
      insertIgnoreDuplicateTask: vi.fn(),
      latestUnrestoredDeleted: vi.fn(),
      consumeRestoreAndAppend: vi.fn(),
      listByProject: vi.fn(),
    },
  };
});

import { handleSpaceRpc, type SpaceRpcCaller } from "@collab/services/space-rpc.js";
import {
  projectMetaDocName,
  ACTIVITY_NEW_SIGNAL,
  type SpaceRpcRequest,
  type SpaceRpcResponse,
} from "@breatic/shared";
import {
  captureUnhandledRejections,
  connectLiveClient,
  createLiveServer,
  SYNC,
  WIRE,
  type LiveClient,
  type RejectionTrap,
  type ServerFrame,
} from "./helpers/live-hocuspocus.js";

const CALLER: SpaceRpcCaller = { userId: "user-1", role: "editor" };
const CLAIM_TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const STORE_FAILURE = "armed store failure";

let server: Hocuspocus;
let clients: LiveClient[];
let trap: RejectionTrap;
/** Document names armed to fail their next persistence attempt. */
let failStoreFor: Set<string>;
/** Every document name `onStoreDocument` was called for, in order. */
let storeCalls: string[];
/** Every document name whose store actually threw, in order. */
let storeFailures: string[];

/**
 * A stand-in for the persistence extension whose store can be made to fail for
 * one named document.
 * @returns The extension object.
 */
function armablePersistence(): Record<string, unknown> {
  return {
    /**
     * Records the attempt and throws when this document is armed.
     * @param payload - Hocuspocus store payload.
     * @param payload.documentName - Document being stored.
     * @returns Nothing.
     * @throws {Error} When the document was armed to fail.
     */
    async onStoreDocument({
      documentName,
    }: {
      documentName: string;
    }): Promise<void> {
      storeCalls.push(documentName);
      if (failStoreFor.has(documentName)) {
        failStoreFor.delete(documentName);
        storeFailures.push(documentName);
        throw new Error(STORE_FAILURE);
      }
    },
  };
}

/**
 * Attach an observer to a project's meta doc. Read-only, exactly as a browser
 * connection to that doc is; it is here to record what the server sends.
 * @param projectId - Project whose meta doc to watch.
 * @returns The connected client.
 */
async function watchMeta(projectId: string): Promise<LiveClient> {
  const client = await connectLiveClient(server, projectMetaDocName(projectId));
  clients.push(client);
  return client;
}

/**
 * The frames recorded after a given point, so setup traffic is excluded.
 * @param client - The observer.
 * @param from - Index recorded before the operation under test.
 * @returns The frames from `from` onwards.
 */
function framesSince(client: LiveClient, from: number): ServerFrame[] {
  return client.frames().slice(from);
}

/**
 * The Yjs-update broadcasts among a set of frames — each one is a moment the
 * meta document changed for every connected client.
 * @param frames - Frames to filter.
 * @returns Only the broadcast frames.
 */
function broadcasts(frames: ServerFrame[]): ServerFrame[] {
  return frames.filter(
    (f) => f.type === WIRE.sync && f.syncSubType === SYNC.update,
  );
}

/**
 * The `activity:new` signals among a set of frames.
 * @param frames - Frames to filter.
 * @returns Only the activity-signal frames.
 */
function activitySignals(frames: ServerFrame[]): ServerFrame[] {
  return frames.filter(
    (f) =>
      f.type === WIRE.stateless &&
      f.stateless !== undefined &&
      (JSON.parse(f.stateless) as { t?: string }).t === ACTIVITY_NEW_SIGNAL,
  );
}

/**
 * Seed a Space straight into a live meta doc, the way collab's own writers
 * reach it. Used for setup so the operation under test starts from a real
 * document rather than an empty one.
 * @param projectId - Project to seed.
 * @param spaceId - Space id to write.
 * @param name - Space name to write.
 * @returns Nothing.
 */
async function seedSpace(
  projectId: string,
  spaceId: string,
  name: string,
): Promise<void> {
  const conn = await server.openDirectConnection(
    projectMetaDocName(projectId),
    { context: { user: { id: "system" } } },
  );
  await conn.transact((doc: Y.Doc) => {
    const entry = new Y.Map<unknown>();
    entry.set("id", spaceId);
    entry.set("name", name);
    doc.getMap("spaces").set(spaceId, entry);
  });
  await conn.disconnect();
}

/**
 * Run one RPC against the live server.
 * @param projectId - Project the RPC operates on.
 * @param request - The request.
 * @returns The handler's response.
 */
async function rpc(
  projectId: string,
  request: SpaceRpcRequest,
): Promise<SpaceRpcResponse> {
  return await handleSpaceRpc({ hocuspocus: server }, projectId, CALLER, request);
}

/**
 * The `spaces` map of a live meta document.
 * @param projectId - Project to read.
 * @returns The map.
 * @throws {Error} When the document is not loaded.
 */
function liveSpaces(projectId: string): Y.Map<unknown> {
  const doc = server.documents.get(projectMetaDocName(projectId));
  if (!doc) throw new Error(`meta doc for ${projectId} is not loaded`);
  return doc.getMap("spaces");
}

/**
 * A guard, not a behavioural claim: nothing unexpected escaped as an unhandled
 * rejection.
 *
 * Measured: with a client attached to the meta doc, nothing escapes at all —
 * `storeDocumentHooks` only schedules `unloadDocument` (the unowned promise the
 * 2026-08-01 probe saw reject) for a document with no connections left, and
 * these tests always hold one. So this currently passes on an empty list. It
 * stays because the alternative failure mode is the whole file dying on a
 * rejection that is not what any test is about.
 * @returns Nothing.
 */
function expectNoUnexpectedUnhandledRejection(): void {
  expect(
    trap.escaped.filter((message) => !message.includes(STORE_FAILURE)),
  ).toEqual([]);
}

// Installed once for the whole file rather than per test: restoring between
// tests would leave a window in which a late rejection reaches vitest's own
// handler and fails the run for something that is not under test.
beforeAll(() => {
  trap = captureUnhandledRejections();
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  trap.restore();
});

beforeEach(() => {
  seedInitialStateMock.mockReset();
  seedInitialStateMock.mockResolvedValue(true);
  softDeleteByNameMock.mockReset();
  restoreByNameMock.mockReset();
  countLiveSpaceDocsMock.mockReset();
  countLiveSpaceDocsMock.mockResolvedValue(2);
  withSpaceDeleteLockMock.mockReset();
  withSpaceDeleteLockMock.mockImplementation(
    async (_projectId: string, fn: () => Promise<unknown>) => fn(),
  );
  activityInsertMock.mockReset();
  activityInsertMock.mockResolvedValue("act-1");

  clients = [];
  failStoreFor = new Set();
  storeCalls = [];
  storeFailures = [];
  server = createLiveServer({
    extensions: [armablePersistence()],
    onAuthenticate: async ({
      connectionConfig,
    }: {
      connectionConfig: { readOnly: boolean };
    }): Promise<{ user: { id: string; role: string } }> => {
      // Same shape production gives a browser on the meta doc.
      connectionConfig.readOnly = true;
      return { user: { id: "observer", role: "editor" } };
    },
  });
});

afterEach(() => {
  for (const client of clients) client.close();
});

describe("a store failure AFTER the broadcast", () => {
  // Two ids for isolation. Before hocuspocus 4 this was required — a failed
  // store poisoned its document for the rest of the process — and it is kept
  // because a case that starts from a document another case wrote is a case
  // whose failures are not its own.
  const PID_KEPT = "aaaaaaaa-1111-4111-8111-111111111111";
  const PID_REPLY = "aaaaaaaa-1111-4111-8111-222222222222";

  it("does not undo the change that already went out", async () => {
    const client = await watchMeta(PID_KEPT);
    const before = client.frames().length;
    failStoreFor.add(projectMetaDocName(PID_KEPT));

    await rpc(PID_KEPT, {
      id: "rpc-create",
      type: "space:create",
      payload: { type: "canvas", name: "Storyboard", claimToken: CLAIM_TOKEN },
    } satisfies SpaceRpcRequest);

    // The store really did run and really did throw — otherwise this case is
    // measuring nothing.
    expect(storeCalls).toContain(projectMetaDocName(PID_KEPT));
    expect(storeFailures).toEqual([projectMetaDocName(PID_KEPT)]);

    // It went out before the store was even attempted, and it is still there.
    const sent = broadcasts(framesSince(client, before));
    expect(sent).toHaveLength(1);
    const keys = Array.from(liveSpaces(PID_KEPT).keys());
    expect(keys).toHaveLength(1);
    const entry = liveSpaces(PID_KEPT).get(keys[0] as string) as Y.Map<unknown>;
    expect(entry.get("name")).toBe("Storyboard");
    expect(entry.get("claimToken")).toBe(CLAIM_TOKEN);

    // Nothing was undone: the content row created in step 3 stays live. A
    // compensating soft-delete here would take the Space's content away from
    // under an entry every client can already see.
    expect(seedInitialStateMock).toHaveBeenCalledTimes(1);
    expect(softDeleteByNameMock).not.toHaveBeenCalled();

    expectNoUnexpectedUnhandledRejection();
  });

  it("still answers the caller with success", async () => {
    const client = await watchMeta(PID_REPLY);
    const before = client.frames().length;
    failStoreFor.add(projectMetaDocName(PID_REPLY));

    const response = await rpc(PID_REPLY, {
      id: "rpc-create",
      type: "space:create",
      payload: { type: "canvas", name: "Storyboard", claimToken: CLAIM_TOKEN },
    } satisfies SpaceRpcRequest);

    // Everyone connected has already been told this Space exists, and the
    // store that failed did so afterwards.
    expect(broadcasts(framesSince(client, before))).toHaveLength(1);
    expect(storeFailures).toEqual([projectMetaDocName(PID_REPLY)]);
    const keys = Array.from(liveSpaces(PID_REPLY).keys());
    expect(keys).toHaveLength(1);

    expect(response).toEqual({
      id: "rpc-create",
      ok: true,
      result: { spaceId: keys[0], type: "canvas", name: "Storyboard" },
    });
  });
});

describe("a failure BEFORE the broadcast", () => {
  const PID = "bbbbbbbb-2222-4222-9222-222222222222";

  it("produces no broadcast at all when the content row cannot be created", async () => {
    const client = await watchMeta(PID);
    const before = client.frames().length;
    seedInitialStateMock.mockRejectedValue(new Error("content row insert failed"));

    const response = await rpc(PID, {
      id: "rpc-create",
      type: "space:create",
      payload: { type: "canvas", name: "Storyboard", claimToken: CLAIM_TOKEN },
    } satisfies SpaceRpcRequest);

    const since = framesSince(client, before);
    expect(broadcasts(since)).toEqual([]);
    expect(activitySignals(since)).toEqual([]);
    expect(Array.from(liveSpaces(PID).keys())).toEqual([]);
    expect(activityInsertMock).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expectNoUnexpectedUnhandledRejection();
  });
});

describe("the activity signal", () => {
  const PID = "cccccccc-3333-4333-8333-333333333333";
  const SID = "dddddddd-4444-4444-9444-444444444444";

  it("leaves after the meta change, and carries the change with it", async () => {
    const client = await watchMeta(PID);
    await seedSpace(PID, SID, "Before");
    const before = client.frames().length;

    const response = await rpc(PID, {
      id: "rpc-rename",
      type: "space:rename",
      payload: { spaceId: SID, name: "After" },
    } satisfies SpaceRpcRequest);

    expect(response).toEqual({ id: "rpc-rename", ok: true, result: undefined });

    const since = framesSince(client, before);
    const metaUpdates = broadcasts(since);
    const signals = activitySignals(since);
    expect(metaUpdates).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(since.indexOf(metaUpdates[0] as ServerFrame)).toBeLessThan(
      since.indexOf(signals[0] as ServerFrame),
    );

    // The broadcast that went out first is the rename itself, not some other
    // traffic that happened to precede the signal. Yjs sends increments, so
    // the replay starts from this client's whole history — which for a client
    // that connected before the seed is every broadcast it has ever had.
    const replayed = new Y.Doc();
    for (const frame of broadcasts(client.frames())) {
      Y.applyUpdate(replayed, frame.update as Uint8Array);
    }
    const replayedEntry = replayed.getMap("spaces").get(SID) as Y.Map<unknown>;
    expect(replayedEntry.get("name")).toBe("After");

    // And the row the signal tells clients to refetch was written before it.
    expect(activityInsertMock).toHaveBeenCalledTimes(1);
    expect(activityInsertMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: PID,
      actorUserId: CALLER.userId,
      type: "space:renamed",
      spaceId: SID,
      payload: { spaceName: "After", oldSpaceName: "Before" },
    });
    expect(JSON.parse(signals[0]?.stateless ?? "{}")).toEqual({
      t: ACTIVITY_NEW_SIGNAL,
      projectId: PID,
    });
    expectNoUnexpectedUnhandledRejection();
  });
});
