/**
 * Property-based tests for client-generated spaceId collision tolerance.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz §B1.1:
 *
 *   "Space ID is generated client-side (nanoid). Collab uses
 *    set-if-not-exists semantics so a nanoid collision is reported
 *    as CONFLICT and the client retries with a fresh id."
 *
 * These properties verify the invariant holds under randomized input:
 *
 *   - INVARIANT 1: creating distinct spaceIds always succeeds; the
 *     resulting meta.spaces contains all of them.
 *   - INVARIANT 2: creating the same spaceId twice — second call
 *     returns CONFLICT and the first entry is unchanged.
 *   - INVARIANT 3: any sequence of create-then-delete-then-restore
 *     on a single id ends with the original entry restored intact.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fc from "fast-check";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import type postgres from "postgres";

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

function makeSql(): ReturnType<typeof postgres> {
  return vi.fn(async () => []) as unknown as ReturnType<typeof postgres>;
}

beforeEach(() => {
  fakeDoc = new Y.Doc();
});

// nanoid-shaped string arbitrary: alphanumeric, 8-32 chars.
const spaceIdArb = fc
  .string({ minLength: 8, maxLength: 32, unit: "grapheme-ascii" })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

describe("space:create collision property", () => {
  it("INVARIANT 1: distinct ids always succeed and end up in meta.spaces", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(spaceIdArb, { minLength: 1, maxLength: 20 }),
        async (ids) => {
          fakeDoc = new Y.Doc();
          const ctx = { hocuspocus: makeHocuspocus(), sql: makeSql() };
          for (const id of ids) {
            const r = await handleSpaceRpc(
              ctx,
              PID,
              { userId: "u", role: "edit" },
              {
                id: `req-${id}`,
                type: "space:create",
                payload: { spaceId: id, type: "canvas", name: "X" },
              },
            );
            expect(r.ok).toBe(true);
          }
          const spaces = fakeDoc.getMap("spaces");
          for (const id of ids) expect(spaces.has(id)).toBe(true);
          expect(spaces.size).toBe(ids.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("INVARIANT 2: same id created twice -> second is CONFLICT, first unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        spaceIdArb,
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (id, name1, name2) => {
          fakeDoc = new Y.Doc();
          const ctx = { hocuspocus: makeHocuspocus(), sql: makeSql() };
          const r1 = await handleSpaceRpc(
            ctx,
            PID,
            { userId: "u", role: "edit" },
            {
              id: "r1",
              type: "space:create",
              payload: { spaceId: id, type: "canvas", name: name1 },
            },
          );
          expect(r1.ok).toBe(true);

          const r2 = await handleSpaceRpc(
            ctx,
            PID,
            { userId: "u", role: "edit" },
            {
              id: "r2",
              type: "space:create",
              payload: { spaceId: id, type: "canvas", name: name2 },
            },
          );
          expect(r2.ok).toBe(false);
          if (!r2.ok) expect(r2.error.code).toBe("CONFLICT");

          // First entry unchanged
          const entry = fakeDoc.getMap("spaces").get(id) as Y.Map<unknown>;
          expect(entry.get("name")).toBe(name1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("INVARIANT 3: create -> delete -> restore (owner) returns to original entry", async () => {
    await fc.assert(
      fc.asyncProperty(
        spaceIdArb,
        fc.string({ minLength: 1, maxLength: 40 }),
        async (id, name) => {
          fakeDoc = new Y.Doc();
          const ctx = { hocuspocus: makeHocuspocus(), sql: makeSql() };

          await handleSpaceRpc(
            ctx,
            PID,
            { userId: "u", role: "edit" },
            {
              id: "r1",
              type: "space:create",
              payload: { spaceId: id, type: "canvas", name },
            },
          );
          await handleSpaceRpc(
            ctx,
            PID,
            { userId: "u", role: "edit" },
            { id: "r2", type: "space:delete", payload: { spaceId: id } },
          );
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
