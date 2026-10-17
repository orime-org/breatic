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
      ["Edit `AGENTS.md` or `SKILL.md` files."],
      ["Rule files: `AGENTS.md`, `CLAUDE.local.md`."],
      ['const names = ["AGENTS.md", "SKILL.md"];'],
      ["file === 'AGENTS.md' || file === 'x'"],
    ])("leaves quoted text beside a bare file name alone: %s", (line) => {
      const files = { ...cleanRepo(), "packages/core/src/q.ts": `// ${line}\nexport const q = 1;\n` };
      expect(run(files)).toEqual([]);
    });

    it("reports an anchor-less path in markdown prose but not in a fenced code sample", () => {
      const files = {
        ...cleanRepo(),
        "docs/prose.md": "The rule is in packages/web/AGENTS.md.\n",
        "docs/sample.md": "```sh\ncat packages/web/AGENTS.md\n```\n",
      };
      expect(run(files)).toEqual([expect.objectContaining({ file: "docs/prose.md", line: 1 })]);
    });

    it("resolves reference-style definitions relative to the file that holds them", () => {
      const files = {
        ...cleanRepo(),
        "docs/ok.md": "See [the rule][r].\n\n[r]: ../AGENTS.md#key-conventions\n",
        "docs/bad.md": "See [the rule][r].\n\n[r]: ../AGENTS.md#gone\n",
      };
      expect(run(files)).toEqual([expect.objectContaining({ file: "docs/bad.md", line: 3 })]);
    });

    it("reads angle-bracket and percent-encoded link targets", () => {
      const files = {
        ...cleanRepo(),
        "packages/web/AGENTS.md": "# Web\n\n## Scroll areas\n\n## \u6eda\u52a8\n",
        "docs/a.md": "See [it](<../packages/web/AGENTS.md#scroll-areas>).\n",
        "docs/b.md": "See [it](../packages/web/AGENTS.md#%E6%BB%9A%E5%8A%A8).\n",
      };
      expect(run(files)).toEqual([]);
    });

    it.each([
      ["LF", "\n"],
      ["CRLF", "\r\n"],
    ])("checks front matter as prose and keeps the body's line numbers (%s)", (_name, eol) => {
      const text = ["---", "name: x", "description: see packages/web/AGENTS.md#nope", "---", "", "See packages/web/AGENTS.md#gone.", ""].join(eol);
      expect(run({ ...cleanRepo(), "docs/fm.md": text })).toEqual([
        expect.objectContaining({ file: "docs/fm.md", line: 3 }),
        expect.objectContaining({ file: "docs/fm.md", line: 6 }),
      ]);
    });

    it("reads a leading thematic break as markdown, not front matter", () => {
      const files = {
        ...cleanRepo(),
        "docs/rule.md": "---\n\nSee packages/web/AGENTS.md#nope.\n\n---\n",
        "docs/empty.md": "---\n---\n# H\n\nSee packages/web/AGENTS.md#gone.\n",
      };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: "docs/rule.md", line: 3 }),
        expect.objectContaining({ file: "docs/empty.md", line: 5 }),
      ]);
    });

    it("checks links and text in raw HTML", () => {
      const files = {
        ...cleanRepo(),
        "docs/ok.md": '<a href="../packages/web/AGENTS.md#scroll-areas">rule</a>\n',
        "docs/bad.md": '<p>\n<a href="../packages/web/AGENTS.md#nope">rule</a>\n</p>\n\n<!-- see packages/web/AGENTS.md#gone -->\n',
      };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: "docs/bad.md", line: 2, message: expect.stringMatching(/#nope/) }),
        expect.objectContaining({ file: "docs/bad.md", line: 5, message: expect.stringMatching(/#gone/) }),
      ]);
    });

    it("reads a link target past its query string", () => {
      const files = { ...cleanRepo(), "docs/q.md": "See [it](../packages/web/AGENTS.md?plain=1#nope).\n" };
      expect(run(files)).toEqual([expect.objectContaining({ file: "docs/q.md", message: expect.stringMatching(/#nope/) })]);
    });

    it("counts lines inside a multi-line paragraph and checks inline code", () => {
      const files = { ...cleanRepo(), "docs/m.md": "First line\nsecond packages/web/AGENTS.md#nope\n\nThen `packages/web/AGENTS.md#gone`.\n" };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: "docs/m.md", line: 2 }),
        expect.objectContaining({ file: "docs/m.md", line: 4 }),
      ]);
    });

    it("leaves URLs alone, in text and as link targets", () => {
      const files = {
        ...cleanRepo(),
        "packages/core/src/u.ts": "// https://example.com/x?path=packages/web/AGENTS.md#nope\nexport const u = 1;\n",
        "docs/u2.md": "See [upstream](https://example.com/AGENTS.md#nope).\n",
      };
      expect(run(files)).toEqual([]);
    });

    it("leaves URLs written without a scheme alone", () => {
      const files = {
        ...cleanRepo(),
        "packages/core/src/s.ts": "// www.example.com/AGENTS.md#x and github.com/o/r/blob/main/AGENTS.md#y\nexport const s = 1;\n",
      };
      expect(run(files)).toEqual([]);
    });

    it("does not read a longer file name as a rules file", () => {
      const files = { ...cleanRepo(), "packages/core/src/bak.ts": "// Copied to packages/web/AGENTS.md.bak first.\nexport const b = 1;\n" };
      expect(run(files)).toEqual([]);
    });

    it("reports a reference that leaves the repository without looking on disk", () => {
      const files = { ...cleanRepo(), "docs/out.md": "See [it](../../AGENTS.md#key-conventions).\n" };
      const context: CheckContext = { ...fakeContext(files), exists: (path) => path.startsWith("../") || fakeContext(files).exists(path) };
      expect(agentRuleFiles.run(context)).toEqual([
        expect.objectContaining({ file: "docs/out.md", message: expect.stringMatching(/outside the repository/) }),
      ]);
    });

    it("resolves a link target starting with / from the repository root", () => {
      const files = { ...cleanRepo(), "docs/root.md": "See [it](/packages/web/AGENTS.md#scroll-areas).\n" };
      expect(run(files)).toEqual([]);
    });

    it("resolves ./ and ../ paths in prose against the file that holds them", () => {
      const files = { ...cleanRepo(), "packages/web/src/rel.ts": "// See ../AGENTS.md#nope.\nexport const r = 1;\n" };
      expect(run(files)).toEqual([
        expect.objectContaining({ file: "packages/web/src/rel.ts", message: expect.stringMatching(/^packages\/web\/AGENTS\.md has no heading/) }),
      ]);
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

  it("keeps the hyphen GitHub leaves where leading or trailing symbols were dropped", () => {
    expect([...headingSlugs("## \u2705 In scope\n\n## Ports \u2192\n")]).toEqual(["-in-scope", "ports-"]);
  });

  it("skips a number already taken by a heading that ends in it", () => {
    expect([...headingSlugs("## Foo\n\n## Foo-1\n\n## Foo\n")]).toEqual(["foo", "foo-1", "foo-2"]);
  });

  it("slugs the visible text of a heading, not its markup", () => {
    expect([...headingSlugs("## See [ports](x.md) here\n")]).toEqual(["see-ports-here"]);
  });

  it("takes no heading from front matter", () => {
    expect([...headingSlugs("---\nname: x\n---\n\n# Real\n")]).toEqual(["real"]);
  });

  it("reads headings between leading thematic breaks that hold no YAML mapping", () => {
    expect([...headingSlugs("---\n\n## Rule\n\n---\n")]).toEqual(["rule"]);
  });

  it("reads setext headings and ignores headings inside HTML comments", () => {
    expect([...headingSlugs("Title\n=====\n\n<!--\n## hidden\n-->\n")]).toEqual(["title"]);
  });
});
