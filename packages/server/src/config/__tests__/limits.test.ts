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
  getDeferredRequestTtlDays,
  deferredRequestExpiry,
  deferredRequestTtlSeconds,
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
 * One TTL for every deferred decision (#28): studio invite, project invite,
 * studio transfer, project transfer, role upgrade. Five flows used to carry
 * four copies of a hardcoded 7 and the fifth had no expiry at all, so a
 * request could hang forever. One knob, and one place where it becomes a
 * Date — five call sites each doing their own `Date.now() + n * 86400_000`
 * is five chances to drift.
 */
describe("deferred-request TTL (#28)", () => {
  it("defaults to 7 days and rejects a non-positive value", () => {
    expect(limitsConfigSchema.parse({}).deferred_request_ttl_days).toBe(7);
    expect(() =>
      limitsConfigSchema.parse({ deferred_request_ttl_days: 0 }),
    ).toThrow();
    expect(() =>
      limitsConfigSchema.parse({ deferred_request_ttl_days: 1.5 }),
    ).toThrow();
  });

  it("getDeferredRequestTtlDays returns a positive integer", () => {
    const days = getDeferredRequestTtlDays();
    expect(Number.isInteger(days)).toBe(true);
    expect(days).toBeGreaterThan(0);
  });

  it("deferredRequestExpiry lands that many days out", () => {
    const before = Date.now();
    const at = deferredRequestExpiry();
    const daysOut = (at.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeCloseTo(getDeferredRequestTtlDays(), 3);
  });

  it("deferredRequestTtlSeconds matches the same TTL", () => {
    expect(deferredRequestTtlSeconds()).toBe(
      getDeferredRequestTtlDays() * 24 * 60 * 60,
    );
  });
});
