// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The server-kept "who follows whom" table in the project meta document (#920).
 *
 * Expected exports, from the shared main entry (`src/index.ts`), because collab
 * writes the table and web reads it:
 *
 *   - `FOLLOWING_TABLE` — the root Y.Map name, `"following"`.
 *   - `followingEntrySchema` — zod schema of one entry,
 *     `{ userId: string (non-empty), target: string (non-empty), at: number, lastSeenAt: number }`.
 *   - `type FollowingEntry` — its inferred type.
 *
 * The table is keyed by the connection's socket id; each entry is what one
 * connection last declared. A reader treats an entry that fails the schema as
 * absent.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { FOLLOWING_TABLE, followingDeclarationSchema, followingEntrySchema } from "@shared/index.js";

const GOOD = { userId: "u-li", target: "u-wang", at: 1_700_000_000_000, lastSeenAt: 1_700_000_005_000 };

describe("following table contract", () => {
  it("names the meta document root the server writes and the browser reads", () => {
    expect(FOLLOWING_TABLE).toBe("following");
  });

  it("accepts an entry the server writes", () => {
    expect(followingEntrySchema.safeParse(GOOD)).toEqual({ success: true, data: GOOD });
  });

  it("accepts every well-formed entry unchanged", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0 }),
        fc.integer({ min: 0 }),
        (userId, target, at, lastSeenAt) => {
          const entry = { userId, target, at, lastSeenAt };
          expect(followingEntrySchema.parse(entry)).toEqual(entry);
        },
      ),
      { seed: 920, numRuns: 100 },
    );
  });

  it.each([
    { input: null },
    { input: [] },
    { input: "u-wang" },
    { input: {} },
    { input: { ...GOOD, userId: "" } },
    { input: { ...GOOD, target: "" } },
    { input: { ...GOOD, userId: 7 } },
    { input: { ...GOOD, target: null } },
    { input: { ...GOOD, at: "1700000000000" } },
    { input: { ...GOOD, at: Number.NaN } },
    { input: { ...GOOD, lastSeenAt: null } },
    { input: { userId: GOOD.userId, at: GOOD.at, lastSeenAt: GOOD.lastSeenAt } },
    { input: { userId: GOOD.userId, target: GOOD.target, lastSeenAt: GOOD.lastSeenAt } },
    { input: { userId: GOOD.userId, target: GOOD.target, at: GOOD.at } },
  ])("rejects a malformed entry: $input", ({ input }) => {
    expect(followingEntrySchema.safeParse(input).success).toBe(false);
  });
});

// The browser declares `following {id, at}` in meta awareness; collab reads that
// declaration and web types its writer from the same schema.
describe("following declaration contract", () => {
  it("accepts the declaration a tab publishes", () => {
    const declared = { id: "u-wang", at: 1_700_000_000_000 };
    expect(followingDeclarationSchema.safeParse(declared)).toEqual({ success: true, data: declared });
  });

  it.each([
    ["an empty target", { id: "", at: 1 }],
    ["a non-string target", { id: 7, at: 1 }],
    ["a missing start time", { id: "u-wang" }],
    ["an infinite start time", { id: "u-wang", at: Number.POSITIVE_INFINITY }],
    ["a NaN start time", { id: "u-wang", at: Number.NaN }],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(followingDeclarationSchema.safeParse(value).success).toBe(false);
  });
});
