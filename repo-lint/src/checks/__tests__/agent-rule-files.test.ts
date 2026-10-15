// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentRuleFiles, headingSlugs } from "#repo-lint/checks/agent-rule-files";
import { fakeContext } from "#repo-lint/__tests__/fake-context";
import type { CheckContext } from "#repo-lint/check";

// The pointer file's name, assembled so this file does not itself trip the
// "no references to the pointer file" rule it is testing.
const POINTER = ["CLAUDE", "md"].join(".");

const ROOT_RULES = [
  "# Breatic",
  "",
  `Rules live only in \`AGENTS.md\`; every \`${POINTER}\` holds the single line \`@AGENTS.md\`.`,
  "Call `/editing-agent-rules` before editing a rule file.",
  "",
  "## Key conventions",
  "",
  "**Times are stored in UTC.** The wire carries absolute instants.",
  "",
].join("\n");

/** A repository that satisfies every rule; tests break one thing at a time. */
function cleanRepo(): Record<string, string> {
  return {
    "AGENTS.md": ROOT_RULES,
    [POINTER]: "@AGENTS.md\n",
    "packages/web/AGENTS.md": "# Web\n\n## Scroll areas\n\nUse `ScrollArea`.\n",
    [`packages/web/${POINTER}`]: "@AGENTS.md\n",
    ".claude/skills/build-tooling/SKILL.md":
      "---\nname: build-tooling\n---\n\n# Build tooling\n\n## Shared dist\n\nRebuild it.\n",
    "packages/web/src/a.ts":
      "// Every scroller is a ScrollArea (packages/web/AGENTS.md#scroll-areas).\nexport const a = 1;\n",
    "packages/core/src/b.ts":
      "// Stored in UTC, see AGENTS.md#key-conventions.\nexport const b = 1;\n",
    ".dockerignore": `README.md\n${POINTER}\n**/AGENTS.md\n`,
  };
}

const run = (files: Record<string, string>) => agentRuleFiles.run(fakeContext(files));

describe("agent-rule-files", () => {
  it("passes a repository laid out as the rules require", () => {
    expect(run(cleanRepo())).toEqual([]);
  });

  describe("rule 1: the pointer file only imports AGENTS.md", () => {
    it("reports a pointer file with rules written into it", () => {
      const files = { ...cleanRepo(), [POINTER]: "@AGENTS.md\n\nAlways use pnpm.\n" };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: POINTER, message: expect.stringMatching(/only the line `@AGENTS\.md`/) }),
      ]);
    });

    it("reports a pointer file that is missing the import", () => {
      const files = { ...cleanRepo(), [`packages/web/${POINTER}`]: "See AGENTS.md\n" };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: `packages/web/${POINTER}` }),
      ]);
    });
  });

  describe("rule 2: every AGENTS.md has a pointer beside it", () => {
    it("reports an AGENTS.md that Claude Code would never load", () => {
      const files = cleanRepo();
      delete files[`packages/web/${POINTER}`];
      expect(run(files)).toEqual([
        expect.objectContaining({
          file: "packages/web/AGENTS.md",
          message: expect.stringMatching(/not loaded/),
        }),
      ]);
    });

    it("does not count a pointer that exists on disk but is not part of the repository", () => {
      // An ignored or wrongly cased CLAUDE.md passes a filesystem lookup but
      // never reaches the commit; rule 2 judges the same file set as rule 1.
      const files = cleanRepo();
      delete files[`packages/web/${POINTER}`];
      const context: CheckContext = { ...fakeContext(files), exists: () => true };
      expect(agentRuleFiles.run(context)).toEqual([
        expect.objectContaining({ file: "packages/web/AGENTS.md", message: expect.stringMatching(/not loaded/) }),
      ]);
    });
  });

  describe("rule 3: AGENTS.md stays within 200 lines", () => {
    // Keeps the heading cleanRepo's code comment points at, so only the
    // length rule can fire.
    const rulesOfLength = (n: number): string =>
      ["## Scroll areas", ...Array.from({ length: n - 1 }, (_, i) => `line ${i}`)].join("\n") + "\n";

    it("passes exactly 200 lines", () => {
      const body = rulesOfLength(200);
      expect(run({ ...cleanRepo(), "packages/web/AGENTS.md": body })).toEqual([]);
    });

    it("reports 201 lines", () => {
      const body = rulesOfLength(201);
      expect(run({ ...cleanRepo(), "packages/web/AGENTS.md": body })).toEqual([
        expect.objectContaining({
          file: "packages/web/AGENTS.md",
          line: 201,
          message: expect.stringMatching(/201 lines/),
        }),
      ]);
    });
  });

  describe("rule 4: nothing points at the pointer file", () => {
    it("reports a code comment that cites the old rule file", () => {
      const files = {
        ...cleanRepo(),
        "packages/core/src/c.ts": `// See ${POINTER} "core must not log".\nexport const c = 1;\n`,
      };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: "packages/core/src/c.ts", line: 1 }),
      ]);
    });

    it("allows the name where it is the subject: rule files, the editing skill, .dockerignore", () => {
      const files = {
        ...cleanRepo(),
        ".claude/skills/editing-agent-rules/SKILL.md": `---\nname: editing-agent-rules\n---\n\n# Editing agent rules\n\nNever write rules into \`${POINTER}\`.\n`,
      };
      expect(run(files)).toEqual([]);
    });

    it("does not allow the name in an ordinary skill", () => {
      const files = {
        ...cleanRepo(),
        ".claude/skills/build-tooling/SKILL.md": `---\nname: build-tooling\n---\n\n# Build tooling\n\nSee ${POINTER}.\n`,
      };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: ".claude/skills/build-tooling/SKILL.md" }),
      ]);
    });
  });

  describe("rule 5: references into rule files carry a resolvable anchor", () => {
    it("reports a path-only reference to a package's rules", () => {
      const files = {
        ...cleanRepo(),
        "packages/web/src/d.ts": "// Mandatory per packages/web/AGENTS.md.\nexport const d = 1;\n",
      };
      expect(run(files)).toEqual([
        expect.objectContaining({
          file: "packages/web/src/d.ts",
          line: 1,
          message: expect.stringMatching(/#anchor/),
        }),
      ]);
    });

    it("reports a quoted section name without an anchor", () => {
      const files = {
        ...cleanRepo(),
        "packages/core/src/e.ts": '// AGENTS.md "Key conventions" applies.\nexport const e = 1;\n',
      };
      expect(run(files)).toEqual([expect.objectContaining({ file: "packages/core/src/e.ts" })]);
    });

    it("reports an anchor that names no heading in the target", () => {
      const files = {
        ...cleanRepo(),
        "packages/core/src/f.ts": "// See AGENTS.md#no-such-rule.\nexport const f = 1;\n",
      };
      expect(run(files)).toEqual([
        expect.objectContaining({
          file: "packages/core/src/f.ts",
          message: expect.stringMatching(/no heading/),
        }),
      ]);
    });

    it("resolves a bare AGENTS.md#anchor against the root file, not the package's", () => {
      // The anchor exists only in packages/web/AGENTS.md; written without
      // the path it means the root file, which has no such heading.
      const files = {
        ...cleanRepo(),
        "packages/web/src/g.ts": "// See AGENTS.md#scroll-areas.\nexport const g = 1;\n",
      };
      expect(run(files)).toEqual([expect.objectContaining({ file: "packages/web/src/g.ts" })]);
    });

    it("reports a reference to a rule file that does not exist", () => {
      const files = {
        ...cleanRepo(),
        "packages/core/src/h.ts": "// See packages/core/AGENTS.md#x.\nexport const h = 1;\n",
      };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: "packages/core/src/h.ts", message: expect.stringMatching(/does not exist/) }),
      ]);
    });

    it("checks skill references the same way", () => {
      const files = {
        ...cleanRepo(),
        "docs/x.md": "Read [it](../.claude/skills/build-tooling/SKILL.md#shared-dist).\n",
        "docs/y.md": "Read [it](../.claude/skills/build-tooling/SKILL.md#gone).\n",
      };
      expect(run(files)).toEqual([expect.objectContaining({ file: "docs/y.md" })]);
    });

    it("resolves markdown links relative to the file that holds them", () => {
      const files = {
        ...cleanRepo(),
        "docs/z.md": "See [conventions](../AGENTS.md#key-conventions).\n",
      };
      expect(run(files)).toEqual([]);
    });

    it("leaves the bare word in prose alone", () => {
      const files = {
        ...cleanRepo(),
        "packages/web/src/i.ts": "// Each package keeps its own AGENTS.md beside its pointer.\nexport const i = 1;\n",
      };
      expect(run(files)).toEqual([]);
    });

    it("does not check references made inside rule files", () => {
      const files = {
        ...cleanRepo(),
        "packages/web/AGENTS.md": "# Web\n\n## Scroll areas\n\nSee packages/core/AGENTS.md for the core rules.\n",
      };
      expect(run(files)).toEqual([]);
    });

    it("checks references made inside an ordinary project skill", () => {
      const files = {
        ...cleanRepo(),
        ".claude/skills/build-tooling/SKILL.md":
          "---\nname: build-tooling\n---\n\n# Build tooling\n\n## Shared dist\n\nThe rule is in packages/web/AGENTS.md.\n",
      };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: ".claude/skills/build-tooling/SKILL.md", message: expect.stringMatching(/#anchor/) }),
      ]);
    });

    it("leaves the editing skill's own examples alone", () => {
      const files = {
        ...cleanRepo(),
        ".claude/skills/editing-agent-rules/SKILL.md":
          "---\nname: editing-agent-rules\n---\n\n# Editing\n\nA reference reads like packages/<pkg>/AGENTS.md#<heading>.\n",
      };
      expect(run(files)).toEqual([]);
    });

    it.each([
      ['AGENTS.md: "Key conventions" applies.'],
      ["root AGENTS.md's \"Key conventions\" rule."],
      ["AGENTS.md, \"Key conventions\"."],
      ["AGENTS.md 'Key conventions'."],
      ["AGENTS.md `Key conventions`."],
    ])("reports a quoted section name written as %s", (comment) => {
      const files = { ...cleanRepo(), "packages/core/src/q.ts": `// ${comment}\nexport const q = 1;\n` };
      expect(run(files)).toEqual([expect.objectContaining({ file: "packages/core/src/q.ts" })]);
    });

    it("accepts an anchored link whose visible text is the file path", () => {
      const files = { ...cleanRepo(), "docs/p.md": "See [packages/web/AGENTS.md](../packages/web/AGENTS.md#scroll-areas).\n" };
      expect(run(files)).toEqual([]);
    });

    it("resolves a link target without ./ relative to the linking file", () => {
      const files = {
        ...cleanRepo(),
        "docs/sub/AGENTS.md": "# Sub\n\n## Here\n",
        "docs/sub/CLAUDE.md": "@AGENTS.md\n",
        "docs/r.md": "See [the rule](sub/AGENTS.md#here).\n",
      };
      expect(run(files)).toEqual([]);
    });

    it("leaves absolute URLs alone", () => {
      const files = { ...cleanRepo(), "docs/u.md": "Upstream: https://github.com/example/repo/blob/main/AGENTS.md#x\n" };
      expect(run(files)).toEqual([]);
    });

    it("checks repo-lint sources but not repo-lint tests", () => {
      const files = {
        ...cleanRepo(),
        "repo-lint/src/checks/other.ts": "// See AGENTS.md#gone.\nexport const o = 1;\n",
        "repo-lint/src/checks/__tests__/other.test.ts": "// Fixture: AGENTS.md#gone.\nexport const t = 1;\n",
      };
      expect(run(files)).toEqual([expect.objectContaining({ file: "repo-lint/src/checks/other.ts" })]);
    });

    it("accepts the real opening of the root AGENTS.md", () => {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../AGENTS.md");
      const opening = readFileSync(root, "utf8").split("\n").slice(0, 6).join("\n") + "\n";
      const files = {
        ...cleanRepo(),
        "AGENTS.md": `${opening}\n## Key conventions\n`,
        ".claude/skills/editing-agent-rules/SKILL.md": "---\nname: editing-agent-rules\n---\n\n# Editing\n",
      };
      expect(run(files)).toEqual([]);
    });
  });

  it("fails rather than reports clean when the repository has no AGENTS.md", () => {
    expect(() => run({ "a.ts": "x\n" })).toThrow(/matched none/);
  });
});

describe("headingSlugs", () => {
  it("follows GitHub: lower case, punctuation dropped, spaces to hyphens", () => {
    expect([...headingSlugs("# A `Button` primitive, always!\n")]).toEqual(["a-button-primitive-always"]);
  });

  it("numbers repeated headings the way GitHub does", () => {
    expect([...headingSlugs("## Setup\n\n## Setup\n\n## Setup\n")]).toEqual(["setup", "setup-1", "setup-2"]);
  });

  it("ignores heading-shaped lines inside code fences", () => {
    expect([...headingSlugs("## Real\n\n```sh\n# not a heading\n```\n")]).toEqual(["real"]);
  });

  it("closes a fence only with a fence at least as long as the one that opened it", () => {
    expect([...headingSlugs("````md\n```\n## inside\n````\n## after\n")]).toEqual(["after"]);
  });
});
