// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tests for the member-capacity limits config: the schema applies the
 * default of 100 when a key is absent and rejects non-positive caps,
 * and the accessors return the (positive-integer) values shipped in
 * `config/limits.yaml`.
 */

import { describe, it, expect } from "vitest";
import {
  limitsConfigSchema,
  getStudioMemberCap,
  getProjectCollaboratorCap,
  getCanvasReferencePoolCap,
} from "@server/config/limits.js";

describe("limits config — schema", () => {
  it("defaults both caps to 100 when keys are absent", () => {
    const cfg = limitsConfigSchema.parse({});
    expect(cfg.studio_member_cap).toBe(100);
    expect(cfg.project_collaborator_cap).toBe(100);
  });

  it("accepts explicit positive integers", () => {
    const cfg = limitsConfigSchema.parse({
      studio_member_cap: 250,
      project_collaborator_cap: 50,
    });
    expect(cfg.studio_member_cap).toBe(250);
    expect(cfg.project_collaborator_cap).toBe(50);
  });

  it("rejects a non-positive cap", () => {
    expect(() => limitsConfigSchema.parse({ studio_member_cap: 0 })).toThrow();
  });

  it("defaults the canvas reference-pool cap to 50 and rejects non-positive (#1782)", () => {
    expect(limitsConfigSchema.parse({}).canvas_reference_pool_cap).toBe(50);
    expect(() =>
      limitsConfigSchema.parse({ canvas_reference_pool_cap: 0 }),
    ).toThrow();
  });
});

describe("limits config — accessors read config/limits.yaml", () => {
  it("getStudioMemberCap returns a positive integer", () => {
    const cap = getStudioMemberCap();
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
  });

  it("getProjectCollaboratorCap returns a positive integer", () => {
    const cap = getProjectCollaboratorCap();
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
  });

  it("getCanvasReferencePoolCap returns a positive integer (#1782)", () => {
    const cap = getCanvasReferencePoolCap();
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
  });
});
