// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { skillRoutingMatchesSkills } from "#repo-lint/checks/skill-routing-matches-skills";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** A SKILL.md declaring the given name in its frontmatter. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: "d"\n---\n\n# ${name}\n`;
}

/** A routing file listing the named skills, each fully declared. */
function routing(names: string[]): string {
  const body = names
    .map((n) => `  ${n}:\n    surfaces: [chat]\n    user_invocable: true\n    model_invocable: true\n`)
    .join("\n");
  return `# comment\n\nskills:\n${body}`;
}

describe("skill-routing-matches-skills", () => {
  it("passes when the file names exactly the skills on disk", () => {
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["alpha", "beta"]),
      "skills/alpha/SKILL.md": skillFile("alpha"),
      "skills/beta/SKILL.md": skillFile("beta"),
    });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([]);
  });

  it("reports a routed name with no skill behind it", () => {
    // A rename or a typo. The real name is then absent from the file, and
    // absent means allowed nowhere — 403 for every user, invisible to the
    // model, and nothing logged because a denied unlisted skill looks correct.
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["alhpa"]),
      "skills/alpha/SKILL.md": skillFile("alpha"),
    });
    const findings = skillRoutingMatchesSkills.run(context);
    expect(findings).toHaveLength(2);
    // The unrouted half is reported by the name the skill declares, not by a
    // path — the path is exactly what must not be the identifier here.
    expect(findings.some((f) => f.file === "config/skill-routing.yaml")).toBe(true);
    expect(findings.some((f) => f.file.includes("'alpha'"))).toBe(true);
  });

  it("compares the declared name, not the directory it sits in", () => {
    // The loader keys the registry on frontmatter `name`, and so does every
    // gate. A check that compared directories would call this clean while
    // the skill is denied everywhere — the exact failure it exists to catch.
    // This repo has carried the divergent shape before.
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["alpha"]),
      "skills/some-directory/SKILL.md": skillFile("alpha"),
    });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([]);
  });

  it("reports a directory whose declared name is absent from the config", () => {
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["some-directory"]),
      "skills/some-directory/SKILL.md": skillFile("alpha"),
    });
    expect(skillRoutingMatchesSkills.run(context)).toHaveLength(2);
  });

  it("ignores a SKILL.md that declares no name, as the loader does", () => {
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["alpha"]),
      "skills/alpha/SKILL.md": skillFile("alpha"),
      "skills/nameless/SKILL.md": "# no frontmatter here\n",
    });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([]);
  });

  it("reports a skill with no entry", () => {
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["alpha"]),
      "skills/alpha/SKILL.md": skillFile("alpha"),
      "skills/newcomer/SKILL.md": skillFile("newcomer"),
    });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([
      expect.objectContaining({ file: expect.stringContaining("'newcomer'") }),
    ]);
  });

  it("reports the file being gone rather than passing on an empty comparison", () => {
    const context = fakeContext({ "skills/alpha/SKILL.md": skillFile("alpha") });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([
      expect.objectContaining({ file: "config/skill-routing.yaml" }),
    ]);
  });

  it("refuses to report clean when its own parse finds nothing", () => {
    // The failure mode a text scan dies of: the file's shape changes, the
    // scan matches zero entries, and every skill reads as unrouted — or,
    // with no skills either, as a clean repo. Saying so beats guessing.
    const context = fakeContext({
      "config/skill-routing.yaml": "skills:\n\talpha:\n\t\tsurfaces: [chat]\n",
      "skills/alpha/SKILL.md": skillFile("alpha"),
    });
    const findings = skillRoutingMatchesSkills.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/report clean forever/);
  });

  it("does not mistake a nested key for a skill entry", () => {
    // Only two-space keys are entries; `surfaces:` and friends sit deeper.
    const context = fakeContext({
      "config/skill-routing.yaml": routing(["alpha"]),
      "skills/alpha/SKILL.md": skillFile("alpha"),
    });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([]);
  });

  it("stops reading at the next top-level key", () => {
    const context = fakeContext({
      "config/skill-routing.yaml":
        routing(["alpha"]) + "\nsomething_else:\n  beta:\n",
      "skills/alpha/SKILL.md": skillFile("alpha"),
    });
    expect(skillRoutingMatchesSkills.run(context)).toEqual([]);
  });
});
