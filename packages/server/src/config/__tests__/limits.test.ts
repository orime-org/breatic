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
  getDecisionWindowDays,
  getDecisionWindowMs,
  getDecisionWindowSeconds,
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

/**
 * The window a person has to answer a studio invite, a project invite, a
 * studio transfer, a project transfer, or a role-upgrade request.
 *
 * One number for all five, settled 2026-06-08 and re-affirmed 2026-08-02.
 * Before this it was the literal `7` written into four services separately,
 * with the fifth flow having no deadline at all.
 */
describe("decision window", () => {
  it("defaults to 7 days when the key is absent", () => {
    expect(limitsConfigSchema.parse({}).decision_window_days).toBe(7);
  });

  it("rejects a non-positive window", () => {
    expect(() => limitsConfigSchema.parse({ decision_window_days: 0 })).toThrow();
    expect(() => limitsConfigSchema.parse({ decision_window_days: -1 })).toThrow();
  });

  it("ships 7 in config/limits.yaml", () => {
    expect(getDecisionWindowDays()).toBe(7);
  });

  it("offers the same window in the three units its callers need", () => {
    // Three shapes, one source. The deadline write sites want milliseconds to
    // add to `Date.now()`; the invite-link Redis keys want seconds; the email
    // copy wants the plain day count to show a person. Deriving each from the
    // same config value is what keeps them from drifting — which is the whole
    // point of the change, so it is asserted rather than assumed.
    const days = getDecisionWindowDays();
    expect(getDecisionWindowSeconds()).toBe(days * 24 * 60 * 60);
    expect(getDecisionWindowMs()).toBe(days * 24 * 60 * 60 * 1000);
  });
});
