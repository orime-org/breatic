// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the unified id helpers.
 *
 * Pins the two contracts callers depend on: `newId` is unique per call,
 * and `deriveId` is deterministic (same input → same id) — the latter
 * is load-bearing for collab's lazy-seed convergence across instances.
 */

import { describe, it, expect } from "vitest";
import { newId, deriveId } from "@shared/ids.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("returns a syntactically valid UUID", () => {
    expect(newId()).toMatch(UUID_RE);
  });

  it("returns a different id on each call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
  });
});

describe("deriveId", () => {
  it("is deterministic — the same name always yields the same id", () => {
    const name = "11111111-1111-4111-8111-111111111111";
    expect(deriveId(name)).toBe(deriveId(name));
  });

  it("returns a syntactically valid v5 UUID", () => {
    const id = deriveId("some-project-id");
    expect(id).toMatch(UUID_RE);
    // v5 → version nibble is '5'.
    expect(id[14]).toBe("5");
  });

  it("maps distinct names to distinct ids", () => {
    expect(deriveId("project-a")).not.toBe(deriveId("project-b"));
  });
});
