// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The studio slug rule, pinned once for every path that writes a slug.
 *
 * A studio slug is a namespace claim: it becomes `/studio/{slug}`, and for a
 * personal studio it is also the user's @handle. Reserved words therefore
 * cannot be a frontend courtesy — a request sent straight to the API must be
 * refused too. Rather than repeat the check in each service, the rule lives on
 * the schema every write path already validates against, so a new write path
 * cannot forget it.
 */

import { describe, it, expect } from "vitest";

import {
  RESERVED_STUDIO_SLUGS,
  setupStudioSchema,
  createTeamStudioSchema,
  updateStudioSchema,
} from "@shared/schemas/api.js";

/** Every schema that accepts a studio slug, so none can drift from the rule. */
const SLUG_WRITERS = [
  { name: "setupStudioSchema", parse: (slug: string) => setupStudioSchema.parse({ slug }) },
  {
    name: "createTeamStudioSchema",
    parse: (slug: string) => createTeamStudioSchema.parse({ name: "Team", slug }),
  },
  { name: "updateStudioSchema", parse: (slug: string) => updateStudioSchema.parse({ slug }) },
] as const;

describe("studio slug rule — applied by every write path", () => {
  for (const writer of SLUG_WRITERS) {
    describe(writer.name, () => {
      it("accepts a well-formed slug", () => {
        expect(() => writer.parse("my-studio")).not.toThrow();
      });

      it("rejects a reserved word", () => {
        // 'settings' is long enough to reach the reserved check; several
        // entries are shorter than the 6-character minimum and are refused by
        // the length rule first, which is why this test names a long one.
        expect(() => writer.parse("settings")).toThrow(/slug_reserved/);
      });

      it("rejects a malformed slug", () => {
        expect(() => writer.parse("Has-Capitals")).toThrow(/slug_invalid_format/);
      });

      it("rejects a slug below the minimum length", () => {
        expect(() => writer.parse("short")).toThrow();
      });

      it("rejects a slug above the maximum length", () => {
        expect(() => writer.parse("a".repeat(40))).toThrow();
      });
    });
  }

  it("keeps the reserved list non-empty and lowercase", () => {
    expect(RESERVED_STUDIO_SLUGS.size).toBeGreaterThan(0);
    for (const word of RESERVED_STUDIO_SLUGS) {
      expect(word).toBe(word.toLowerCase());
    }
  });
});

describe("updateStudioSchema — every field optional, but not all absent", () => {
  it("accepts a name-only edit", () => {
    expect(updateStudioSchema.parse({ name: "New name" })).toEqual({ name: "New name" });
  });

  it("accepts a bio-only edit", () => {
    expect(updateStudioSchema.parse({ bio: "About us" })).toEqual({ bio: "About us" });
  });

  it("accepts clearing the bio", () => {
    expect(updateStudioSchema.parse({ bio: "" })).toEqual({ bio: "" });
  });

  it("rejects an empty patch — nothing to apply is a client error, not a no-op", () => {
    expect(() => updateStudioSchema.parse({})).toThrow();
  });

  it("rejects an empty name (a studio always has a display name)", () => {
    expect(() => updateStudioSchema.parse({ name: "" })).toThrow();
  });

  it("rejects a bio beyond the column's length", () => {
    expect(() => updateStudioSchema.parse({ bio: "x".repeat(501) })).toThrow();
  });
});
