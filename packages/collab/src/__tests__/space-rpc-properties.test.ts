// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Property-based tests for Space lifecycle invariants under random input.
 *
 * This file used to test tolerance of collisions between client-generated
 * ids: a client picked the id, so two clients could pick the same one, and
 * the server had to report CONFLICT and let the loser retry. That whole
 * shape is gone — the server mints the id (task #27), because a client
 * that picks the id can also re-submit the id of a Space that had been
 * deleted, and the "is this id taken" check reads meta.spaces, where a
 * deleted Space no longer is.
 *
 * The properties that survive that change, and one that replaces it:
 *
 *   - INVARIANT 1: N creates produce N distinct ids and N entries. This
 *     replaces "distinct client ids all succeed" — the server is the one
 *     choosing now, so what needs pinning is that it never repeats.
 *   - INVARIANT 2 is retired with the client-chosen id. Reaching the
 *     duplicate branch would take a uuid v4 collision, so there is no
 *     input that exercises it. The guard itself stays in the handler
 *     (one line, and the alternative is overwriting someone's Space).
 *   - INVARIANT 3: create-then-delete-then-restore ends with the original
 *     entry intact. Unchanged in substance; it just reads the id off the
 *     create reply instead of choosing it.
 *
 * The canvas-row soft-delete / restore route through the shared core
 * `yjsDocumentsRepo`; it is mocked to no-ops here so the Yjs-mutation
 * invariants are exercised without a real PG (and so importing the
 * handler doesn't pull the real core barrel into vitest's ESM resolver).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fc from "fast-check";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";

const {
  countLiveSpaceDocsMock,
  withSpaceDeleteLockMock,
  FakeLockBusyError,
  activityInsertMock,
  activityLatestUnrestoredMock,
} = vi.hoisted(() => ({
  countLiveSpaceDocsMock: vi.fn(),
  withSpaceDeleteLockMock: vi.fn(),
  FakeLockBusyError: class FakeLockBusyError extends Error {},
  activityInsertMock: vi.fn(),
  activityLatestUnrestoredMock: vi.fn(),
}));

// The yjs-store repo moved to collab; space-rpc imports it locally.
//
// `countLiveSpaceDocs` is the authoritative "how many Spaces are left"
// read that the delete guard uses. It was missing from this mock, so
// every delete in this file threw and was swallowed into an INTERNAL
// response — and the round-trip invariant below, which asserted the
// entry was present at the end, passed because the entry had never been
// removed. Adding a "the entry is gone after delete" probe turns that
// version red, which is how it was caught.
vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  softDeleteByName: vi.fn(),
  restoreByName: vi.fn(),
  seedInitialState: vi.fn(),
  countLiveSpaceDocs: countLiveSpaceDocsMock,
}));

// Bypass the cross-instance lock: it has its own unit tests, and here it
// would just be a no-op wrapper around the critical section.
vi.mock("@collab/services/space-delete-lock.js", () => ({
  withSpaceDeleteLock: withSpaceDeleteLockMock,
  SpaceDeleteLockBusyError: FakeLockBusyError,
}));

// `createLogger` now comes from `@breatic/core` (the unified logger), which
// reads the injected config at call time. Spread the real core barrel (so
// `encodeInitialSpaceContentState` / `writeSpaceEntry` keep their real impls
// the invariants depend on) and override only `createLogger` with a no-op
// stub so the module-level `createLogger("space-rpc")` doesn't require
// initCore under test.
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
      latestUnrestoredDeleted: activityLatestUnrestoredMock,
      consumeRestoreAndAppend: vi.fn(async () => true),
      listByProject: vi.fn(),
    },
  };
});

import { handleSpaceRpc } from "../services/space-rpc.js";

const PID = "11111111-1111-4111-8111-111111111111";

let fakeDoc: Y.Doc;

function makeHocuspocus(): Hocuspocus {
  return {
    openDirectConnection: vi.fn(async () => ({
      transact: async (fn: (doc: Y.Doc) => void) => {
        fn(fakeDoc);
      },
      disconnect: vi.fn(async () => {}),
    })),
  } as unknown as Hocuspocus;
}

beforeEach(() => {
  fakeDoc = new Y.Doc();
  countLiveSpaceDocsMock.mockReset();
  // Two live Spaces, so the "a project keeps at least one" guard lets the
  // delete through. The guard itself is covered in space-rpc.test.ts.
  countLiveSpaceDocsMock.mockResolvedValue(2);
  withSpaceDeleteLockMock.mockReset();
  withSpaceDeleteLockMock.mockImplementation(
    async (_projectId: string, fn: () => Promise<unknown>) => fn(),
  );
  // The activity feed is where a deleted Space's snapshot lives, and
  // restore reads it back from there. These two mocks carry that one
  // value across the round trip so the invariant exercises the real
  // path instead of a stub that always says "nothing was deleted".
  let deletedPayload: Record<string, unknown> | null = null;
  activityInsertMock.mockReset();
  activityInsertMock.mockImplementation(
    async (row: { type: string; payload?: Record<string, unknown> }) => {
      if (row.type === "space:deleted") deletedPayload = row.payload ?? null;
      return "act-1";
    },
  );
  activityLatestUnrestoredMock.mockReset();
  activityLatestUnrestoredMock.mockImplementation(async () =>
    deletedPayload ? { id: "act-1", payload: deletedPayload } : null,
  );
});

/**
 * A well-formed uuid v4, standing in for the token a client sends with
 * each create. Its value never matters to the server, which stores and
 * echoes it without looking at it.
 */
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/**
 * Create one Space and return the id the server minted for it.
 * @param ctx - The fake collab context.
 * @param name - Space name to create it under.
 * @returns The minted id.
 */
async function createSpace(
  ctx: { hocuspocus: Hocuspocus },
  name: string,
): Promise<string> {
  const r = await handleSpaceRpc(
    ctx,
    PID,
    { userId: "u", role: "editor" },
    {
      id: `req-${name}`,
      type: "space:create",
      payload: { type: "canvas", name, claimToken: TOKEN },
    },
  );
  expect(r.ok).toBe(true);
  const id = r.ok ? r.result?.spaceId : undefined;
  expect(id).toBeTruthy();
  return id as string;
}

describe("space:create — the server mints the id", () => {
  it("INVARIANT 1: N creates produce N distinct ids and N entries", async () => {
    // Replaces the old "distinct client-chosen ids all succeed". The
    // client cannot choose any more, so what needs pinning is that the
    // server never hands out the same id twice.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (n, name) => {
          fakeDoc = new Y.Doc();
          const ctx = { hocuspocus: makeHocuspocus() };
          const ids: string[] = [];
          for (let i = 0; i < n; i += 1) {
            ids.push(await createSpace(ctx, `${name}-${i}`));
          }
          expect(new Set(ids).size).toBe(n);
          const spaces = fakeDoc.getMap("spaces");
          expect(spaces.size).toBe(n);
          for (const id of ids) expect(spaces.has(id)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("INVARIANT 3: create -> delete -> restore (owner) returns to original entry", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        async (name) => {
          fakeDoc = new Y.Doc();
          const ctx = { hocuspocus: makeHocuspocus() };

          const id = await createSpace(ctx, name);
          await handleSpaceRpc(
            ctx,
            PID,
            { userId: "u", role: "editor" },
            { id: "r2", type: "space:delete", payload: { spaceId: id } },
          );
          // Without this line the invariant passes even when the delete
          // silently fails — the final "entry is present" assertion is
          // then satisfied by an entry that was never removed.
          expect(fakeDoc.getMap("spaces").has(id)).toBe(false);
          await handleSpaceRpc(
            ctx,
            PID,
            { userId: "owner-1", role: "owner" },
            { id: "r3", type: "space:restore", payload: { spaceId: id } },
          );

          const entry = fakeDoc.getMap("spaces").get(id);
          expect(entry).toBeDefined();
          const restored = entry as Y.Map<unknown>;
          expect(restored.get("id")).toBe(id);
          expect(restored.get("name")).toBe(name);
          expect(restored.get("type")).toBe("canvas");
        },
      ),
      { numRuns: 50 },
    );
  });
});
