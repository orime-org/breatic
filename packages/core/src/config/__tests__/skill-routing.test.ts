// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which skill may be used where, and by whom.
 *
 * These three answers used to live in each skill's own metadata, which meant
 * a skill declared its own permissions. They now live in one config file the
 * host owns, for two reasons: third-party skills can be dropped in unchanged
 * (nothing is added to their frontmatter), and the answer stops depending on
 * whoever wrote the skill.
 *
 * The default direction is per-axis and that is the load-bearing decision.
 * MCP Apps' rule is "unset means fully open", which is right for a visibility
 * flag -- leaving one on shows an extra entry point. It is wrong for an
 * authorization flag, where leaving one on means anyone may call the thing.
 * This repository has already been bitten: two skills carried the same
 * dangerous tool, one was explicitly gated and the other was not, and the
 * only difference was whether someone remembered to write the line.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getSkillRouting,
  resetSkillRouting,
  skillRoutingSchema,
} from "@core/config/skill-routing.js";

describe("skill routing config", () => {
  it("lets a skill be visible everywhere without saying so", () => {
    // Visibility is the axis where open-by-default is harmless.
    const parsed = skillRoutingSchema.parse({ skills: { some_skill: {} } });
    expect(parsed.skills.some_skill?.surfaces).toEqual(["chat", "canvas"]);
  });

  it("refuses to let a skill be user-invocable by omission", () => {
    // The axis that decides "may an end user fire this directly" has to be
    // said out loud. Silence means no.
    const parsed = skillRoutingSchema.parse({ skills: { some_skill: {} } });
    expect(parsed.skills.some_skill?.user_invocable).toBe(false);
  });

  it("refuses to let the model reach for a skill by omission", () => {
    const parsed = skillRoutingSchema.parse({ skills: { some_skill: {} } });
    expect(parsed.skills.some_skill?.model_invocable).toBe(false);
  });

  it("takes an explicit yes on either authorization axis", () => {
    const parsed = skillRoutingSchema.parse({
      skills: { some_skill: { user_invocable: true, model_invocable: true } },
    });
    expect(parsed.skills.some_skill?.user_invocable).toBe(true);
    expect(parsed.skills.some_skill?.model_invocable).toBe(true);
  });

  it("takes an explicit surface list", () => {
    const parsed = skillRoutingSchema.parse({
      skills: { some_skill: { surfaces: ["canvas"] } },
    });
    expect(parsed.skills.some_skill?.surfaces).toEqual(["canvas"]);
  });

  it("rejects a surface nobody serves", () => {
    // A typo in a surface name would otherwise silently hide a skill
    // everywhere, which reads as "the skill is broken" rather than "the
    // config has a typo".
    expect(() =>
      skillRoutingSchema.parse({
        skills: { some_skill: { surfaces: ["cnavas"] } },
      }),
    ).toThrow();
  });

  it("treats a skill absent from the file as allowed nowhere", () => {
    const parsed = skillRoutingSchema.parse({ skills: {} });
    expect(parsed.skills.unlisted).toBeUndefined();
  });
});

describe("the routing file we actually ship", () => {
  afterEach(() => {
    resetSkillRouting();
  });

  // Everything above parses objects written in this file, which says nothing
  // about the document on disk. The only other place the real file is read
  // is a process entry, where a failure surfaces as a crashed deployment.
  it("parses, and resolves every axis for every skill it lists", () => {
    const routing = getSkillRouting();
    const entries = Object.entries(routing.skills);
    expect(entries.length).toBeGreaterThan(0);

    for (const [name, route] of entries) {
      expect(route.surfaces.length, `${name} serves no surface`).toBeGreaterThan(0);
      expect(typeof route.user_invocable, name).toBe("boolean");
      expect(typeof route.model_invocable, name).toBe("boolean");
    }
  });

  // Which names it lists, and whether they match the skills on disk, is a
  // repo-lint check (`skill-routing-matches-skills`) — it compares two files
  // neither of which imports the other.
  it("gives every listed skill somewhere to be used", () => {
    for (const [name, route] of Object.entries(getSkillRouting().skills)) {
      const reachable = route.user_invocable || route.model_invocable;
      expect(reachable, `${name} is listed but nobody may invoke it`).toBe(true);
    }
  });
});
