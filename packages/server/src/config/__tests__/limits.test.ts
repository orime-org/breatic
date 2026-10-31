// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tests for the business limits config: the schema applies its defaults and
 * rejects non-positive values, and each accessor returns the value of ITS OWN
 * key as shipped in `config/limits.yaml`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";
import {
  limitsConfigSchema,
  getRequestBodyMaxBytes,
  getActivityFeedPageLimits,
  getCanvasReferencePoolCap,
  getNodeHistoryPageSize,
  getDecisionWindowDays,
  getDecisionWindowMs,
  getDecisionWindowSeconds,
  MS_PER_DAY,
} from "@server/config/limits.js";

describe("limits config — schema", () => {
  it("accepts explicit positive integers", () => {
    const cfg = limitsConfigSchema.parse({ activity_feed_page_max: 250 });
    expect(cfg.activity_feed_page_max).toBe(250);
  });

  it("rejects a non-positive value", () => {
    expect(() =>
      limitsConfigSchema.parse({ activity_feed_page_max: 0 }),
    ).toThrow();
  });

  it("defaults the canvas reference-pool cap to 50 and rejects non-positive (#1782)", () => {
    expect(limitsConfigSchema.parse({}).canvas_reference_pool_cap).toBe(50);
    expect(() =>
      limitsConfigSchema.parse({ canvas_reference_pool_cap: 0 }),
    ).toThrow();
  });
});

describe("limits config — accessors read config/limits.yaml", () => {
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

/**
 * T14 (inner#1006 §3.1): the largest request body any public route reads.
 */
describe("request body limit", () => {
  it("(a) defaults to 1 MiB when the key is absent", () => {
    expect(limitsConfigSchema.parse({}).request_body_max_bytes).toBe(1_048_576);
  });

  it("(b) the shipped yaml sets 1 MiB and the getter returns it", () => {
    const shipped = parse(readFileSync(resolve(MONOREPO_ROOT, "config", "limits.yaml"), "utf-8")) as Record<string, unknown>;
    expect(shipped.request_body_max_bytes).toBe(1_048_576);
    expect(getRequestBodyMaxBytes()).toBe(1_048_576);
  });

  it.each([0, 1.5])("(c) refuses %s like every other key here", (value) => {
    expect(() => limitsConfigSchema.parse({ request_body_max_bytes: value })).toThrow(ZodError);
  });
});

/**
 * T16 (inner#1006 §3.3): the repo's nginx must refuse what the server refuses,
 * at the same size, or the two answer the same request differently.
 */
describe("docker/breatic-locations.conf matches request_body_max_bytes", () => {
  /**
   * The body of the `location /api/ { ... }` block.
   * @returns Its lines, braces excluded.
   */
  function apiLocationBlock(): string[] {
    const lines = readFileSync(resolve(MONOREPO_ROOT, "docker", "breatic-locations.conf"), "utf-8").split("\n");
    const start = lines.findIndex((line) => /^\s*location\s+\/api\/\s*\{\s*$/.test(line));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && /^\s*\}\s*$/.test(line));
    expect(end).toBeGreaterThan(start);
    return lines.slice(start + 1, end);
  }

  it("the /api/ block has exactly one client_max_body_size, set to 1m", () => {
    const directives = apiLocationBlock().filter((line) => /^\s*client_max_body_size\b/.test(line));
    expect(directives.map((line) => line.trim())).toEqual(["client_max_body_size 1m;"]);
  });

  it("1m is request_body_max_bytes", () => {
    const shipped = parse(readFileSync(resolve(MONOREPO_ROOT, "config", "limits.yaml"), "utf-8")) as Record<string, unknown>;
    const nginxBytes = 1 * 1024 * 1024;
    expect(nginxBytes).toBe(1_048_576);
    expect(shipped.request_body_max_bytes).toBe(nginxBytes);
  });
});
