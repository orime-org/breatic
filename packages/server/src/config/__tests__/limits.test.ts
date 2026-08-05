// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tests for the business limits config: the schema applies its defaults and
 * rejects non-positive values, and each accessor returns the value of ITS OWN
 * key as shipped in `config/limits.yaml`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import {
  limitsConfigSchema,
  getStudioMemberCap,
  getProjectCollaboratorCap,
  getActivityFeedPageLimits,
  getCanvasReferencePoolCap,
  getNodeHistoryPageSize,
  getDecisionWindowDays,
  getDecisionWindowMs,
  getDecisionWindowSeconds,
  MS_PER_DAY,
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
 * Each accessor reads its own key, and every key the schema knows is really in
 * the file.
 *
 * The per-accessor tests above only prove a function returns *a* positive
 * integer — which every other key in the same file also satisfies. Measured:
 * pointing `getDecisionWindowDays` at `node_history_page_size` left every unit
 * test in this repo green. A knob nothing binds to its key can silently stop
 * working, and — worse — a different knob starts moving what it was meant to
 * move.
 *
 * HOW FAR THIS REACHES: a value can only identify a key when it is unique in
 * the file, and today three keys ship 100 while two ship 50. So this pins
 * `decision_window_days` (7) and `node_history_page_size` (20); pointing one
 * of the five colliding accessors at its twin still passes. Giving the other
 * five the same protection needs distinct fixture values, which needs a cache
 * reset this module does not export — out of scope here, where the window is
 * the key being added.
 *
 * The key-presence half matters because zod substitutes a default for a key
 * that is absent: rename or drop one in the yaml and the accessor keeps
 * answering with the schema's fallback while the operator believes the file is
 * in charge.
 */
describe("accessors are bound to their keys", () => {
  /** The shipped yaml, parsed independently of the module under test. */
  function readShippedYaml(): Record<string, unknown> {
    const raw = readFileSync(
      resolve(MONOREPO_ROOT, "config", "limits.yaml"),
      "utf-8",
    );
    return parse(raw) as Record<string, unknown>;
  }

  it("config/limits.yaml really carries every key the schema knows", () => {
    const present = Object.keys(readShippedYaml());
    for (const key of Object.keys(limitsConfigSchema.shape)) {
      expect(present).toContain(key);
    }
  });

  it("each accessor returns the value of its own key", () => {
    const shipped = limitsConfigSchema.parse(readShippedYaml());

    expect(getStudioMemberCap()).toBe(shipped.studio_member_cap);
    expect(getProjectCollaboratorCap()).toBe(shipped.project_collaborator_cap);
    expect(getCanvasReferencePoolCap()).toBe(shipped.canvas_reference_pool_cap);
    expect(getNodeHistoryPageSize()).toBe(shipped.node_history_page_size);
    expect(getDecisionWindowDays()).toBe(shipped.decision_window_days);
    expect(getActivityFeedPageLimits()).toEqual({
      default: shipped.activity_feed_page_default,
      max: shipped.activity_feed_page_max,
    });
  });
});

/**
 * The window a person has to answer a studio invite, a project invite, a
 * studio transfer, a project transfer, or a role-upgrade request — one number
 * for all five, where four services each carried their own copy of `7` and the
 * fifth flow had no deadline at all.
 */
describe("decision window", () => {
  it("defaults to 7 days when the key is absent", () => {
    expect(limitsConfigSchema.parse({}).decision_window_days).toBe(7);
  });

  it("rejects a non-positive window", () => {
    expect(() => limitsConfigSchema.parse({ decision_window_days: 0 })).toThrow();
    expect(() => limitsConfigSchema.parse({ decision_window_days: -1 })).toThrow();
  });

  it("getDecisionWindowDays returns a positive integer", () => {
    // Deliberately not pinned to the shipped seven: this is an operator knob,
    // and a test that names its current value turns every turn of the dial
    // into a red build. Same shape as the cap accessors above.
    const days = getDecisionWindowDays();
    expect(Number.isInteger(days)).toBe(true);
    expect(days).toBeGreaterThan(0);
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

  it("exports a day as a unit, which is not the window and does not move", () => {
    // The landing page divides `expires_at - created_at` by this to say how
    // long a request had. That is a question about a row, so it must not
    // follow the knob: turning the window to 3 leaves a day 24 hours long.
    // Written out rather than derived: deriving it from the same call the
    // implementation makes would pass no matter what that call returned.
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
