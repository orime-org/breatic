// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tests for the membership-quota config: the shape every tier must have,
 * and the fact that a missing number is a load failure rather than a
 * silently-substituted default.
 *
 * The schema is exercised directly rather than through the file, so a case
 * can hand it a malformed tier. One case does read the real
 * `config/membership.yaml`, because a schema nobody's actual config
 * satisfies would pass every other test here.
 */

import { describe, it, expect } from "vitest";
import { CONFIGURED_MEMBERSHIP_TIERS } from "@breatic/shared";
import {
  membershipConfigSchema,
  getMembershipConfig,
  getMembershipLimits,
} from "@core/config/membership.js";

/** Every quota field a tier must carry. */
const FIELDS = [
  "team_studios",
  "projects_per_studio",
  "concurrent_editors",
  "studio_members",
  "project_members",
  "storage_bytes",
] as const;

/**
 * One tier's limits, all fields present.
 * @param over - Fields to override.
 * @returns A complete tier block.
 */
function tier(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    team_studios: 1,
    projects_per_studio: 10,
    concurrent_editors: 2,
    studio_members: 5,
    project_members: 4,
    storage_bytes: 1024,
    ...over,
  };
}

/**
 * A whole config with all four tiers.
 * @param over - Top-level fields to override.
 * @returns A complete config object.
 */
function config(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    default_tier: "base",
    tiers: {
      base: tier(),
      pro: tier(),
      team: tier(),
      self_hosted: tier(),
    },
    ...over,
  };
}

describe("membershipConfigSchema — every number is required", () => {
  it("accepts a complete config", () => {
    expect(() => membershipConfigSchema.parse(config())).not.toThrow();
  });

  for (const field of FIELDS) {
    it(`rejects a tier missing ${field}`, () => {
      // No `.default()` anywhere in this schema, deliberately. A quota that
      // silently falls back to a number we invented is worse than a service
      // that refuses to start: the operator would believe the value they
      // wrote in the file is the one being enforced.
      const incomplete = tier();
      delete incomplete[field];
      expect(() =>
        membershipConfigSchema.parse(
          config({ tiers: { base: incomplete, pro: tier(), team: tier(), self_hosted: tier() } }),
        ),
      ).toThrow();
    });
  }

  it("rejects a config missing a whole tier", () => {
    expect(() =>
      membershipConfigSchema.parse(
        config({ tiers: { base: tier(), pro: tier(), team: tier() } }),
      ),
    ).toThrow();
  });
});

describe("membershipConfigSchema — what counts as a limit", () => {
  it("accepts zero", () => {
    // Zero is an ordinary limit, not a marker: base.team_studios is 0 because
    // that tier genuinely cannot create a team studio, and `count >= 0` is
    // true for every count, which is exactly the intended refusal.
    expect(() =>
      membershipConfigSchema.parse(
        config({ tiers: { base: tier({ team_studios: 0 }), pro: tier(), team: tier(), self_hosted: tier() } }),
      ),
    ).not.toThrow();
  });

  it("accepts a number nobody reaches", () => {
    // How a deployment says "effectively no cap" — a real number, no marker,
    // so the comparison stays `count >= limit` with no branch anywhere.
    expect(() =>
      membershipConfigSchema.parse(
        config({ tiers: { base: tier(), pro: tier(), team: tier(), self_hosted: tier({ team_studios: 9999 }) } }),
      ),
    ).not.toThrow();
  });

  it("rejects a negative limit", () => {
    expect(() =>
      membershipConfigSchema.parse(
        config({ tiers: { base: tier({ projects_per_studio: -1 }), pro: tier(), team: tier(), self_hosted: tier() } }),
      ),
    ).toThrow();
  });

  it("rejects a fractional limit", () => {
    expect(() =>
      membershipConfigSchema.parse(
        config({ tiers: { base: tier({ concurrent_editors: 2.5 }), pro: tier(), team: tier(), self_hosted: tier() } }),
      ),
    ).toThrow();
  });
});

describe("membershipConfigSchema — default_tier", () => {
  it("accepts each of the four tiers whose ceilings are in the file", () => {
    for (const name of CONFIGURED_MEMBERSHIP_TIERS) {
      expect(() =>
        membershipConfigSchema.parse(config({ default_tier: name })),
      ).not.toThrow();
    }
  });

  it("rejects enterprise, which an account can be on but cannot start on", () => {
    // Enterprise is a legal tier for an account; its ceilings are negotiated
    // per customer and are not in this file. A deployment naming it here would
    // land every new account on a tier with no ceilings to read, so every
    // quota check would throw. Refusing it while loading says so once, at the
    // point somebody can still fix the file.
    expect(() =>
      membershipConfigSchema.parse(config({ default_tier: "enterprise" })),
    ).toThrow();
  });

  it("rejects a tier name that does not exist", () => {
    expect(() =>
      membershipConfigSchema.parse(config({ default_tier: "gold" })),
    ).toThrow();
  });

  it("rejects a missing default_tier", () => {
    // Which tier a new account lands in is what makes a deployment
    // self-hosted or ours. There is no sane fallback for it.
    const c = config();
    delete c.default_tier;
    expect(() => membershipConfigSchema.parse(c)).toThrow();
  });
});

describe("the real config/membership.yaml", () => {
  it("satisfies the schema", () => {
    // A schema that nothing in the repo actually satisfies would pass every
    // case above and still break the moment a service boots.
    expect(() => getMembershipConfig()).not.toThrow();
  });

  it("carries all four configured tiers with every field", () => {
    const cfg = getMembershipConfig();
    for (const name of CONFIGURED_MEMBERSHIP_TIERS) {
      const limits = cfg.tiers[name];
      expect(limits, `tier ${name} is missing`).toBeDefined();
      for (const field of FIELDS) {
        expect(typeof limits?.[field], `${name}.${field}`).toBe("number");
      }
    }
  });

  it("gives base the numbers the ratified decision states", () => {
    // Straight from the 2026-07-30 tiers decision. If someone edits the
    // shipped config, this is what tells them they changed a ratified value.
    const base = getMembershipLimits("base");
    expect(base.team_studios).toBe(0);
    expect(base.projects_per_studio).toBe(10);
    expect(base.concurrent_editors).toBe(2);
    expect(base.project_members).toBe(4);
    expect(base.storage_bytes).toBe(5 * 1024 ** 3);
  });

  it("gives team the numbers the ratified decision states", () => {
    const team = getMembershipLimits("team");
    expect(team.team_studios).toBe(3);
    expect(team.projects_per_studio).toBe(300);
    expect(team.concurrent_editors).toBe(20);
    expect(team.studio_members).toBe(100);
    expect(team.project_members).toBe(40);
    expect(team.storage_bytes).toBe(500 * 1024 ** 3);
  });
});
