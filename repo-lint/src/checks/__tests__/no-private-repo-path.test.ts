// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noPrivateRepoPath } from "#repo-lint/checks/no-private-repo-path";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

// Assembled, not written, for the same reason the check assembles them: a
// fixture spelling one out would make this file a violation, and the rule
// would need an exemption for its own test.
const PRIVATE_REPO = ["breatic", "inner"].join("-");

/**
 * Builds a private-repo directory path without writing it literally.
 * @param parts Path segments, e.g. ("engineering", "specs").
 * @returns The joined path with a trailing slash.
 */
const dir = (...parts: string[]): string => `${parts.join("/")}/`;

describe("no-private-repo-path", () => {
  it("passes source that does not cite the private repo", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": "// see the internal design record\n",
    });
    expect(noPrivateRepoPath.run(context)).toEqual([]);
  });

  it("catches the private repo by name", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `// see ${PRIVATE_REPO} for the rationale\n`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(1);
  });

  it("catches a spec path even without the repo name", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `// see ${dir("engineering", "specs")}2026-01-01-x.md\n`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(1);
  });

  it("catches each of the private directories", () => {
    const context = fakeContext({
      "a.md": `${dir("engineering", "specs")}x.md`,
      "b.md": `${dir("engineering", "decisions")}x.md`,
      "c.md": `${dir("engineering", "audit")}x.md`,
      "d.md": `${dir("engineering", "plans")}x.md`,
      "e.md": `${dir("design", "decisions")}x.md`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(5);
  });

  it("names the right line", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `one\ntwo\n// ${dir("engineering", "specs")}x.md\n`,
    });
    expect(noPrivateRepoPath.run(context)[0]?.line).toBe(3);
  });

  it("covers the repository root, which the old scan list did not", () => {
    // The shell version scanned packages, docs, scripts, config and
    // .github. The root README and CLAUDE.md are public artifacts too.
    const context = fakeContext({
      "README.md": `see ${dir("engineering", "plans")}x.md`,
      "CLAUDE.md": `see ${PRIVATE_REPO}`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(2);
  });

  it("leaves a public directory of a similar name alone", () => {
    // `docs/` and `packages/` may legitimately contain the word design or
    // engineering; only the private layout is a violation.
    const context = fakeContext({
      "docs/a.md": "the engineering team decided; see docs/decisions.md",
      "packages/core/src/design.ts": "// design tokens live here",
    });
    expect(noPrivateRepoPath.run(context)).toEqual([]);
  });

  it("skips bytes that are not text", () => {
    const context = fakeContext({
      "logo.png": `${PRIVATE_REPO}`,
      "a.md": "clean",
    });
    expect(noPrivateRepoPath.run(context)).toEqual([]);
  });

  it("reads the lockfile, where a git dependency would name the private repo", () => {
    // Machine-authored is not the same as harmless. A dependency resolved
    // from the private repository writes its URL here, and that publishes
    // the repository's existence exactly as a comment would.
    const context = fakeContext({
      "pnpm-lock.yaml": `  resolution: {tarball: https://github.com/orime-org/${PRIVATE_REPO}}`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(1);
  });

  it("reads the files that carry no extension, where the old list did not reach", () => {
    // Three of the four residues that motivated the sibling bypass check
    // lived in exactly these: a Dockerfile with no extension, and both env
    // templates.
    const context = fakeContext({
      Dockerfile: `# see ${dir("engineering", "specs")}x.md`,
      ".env.docker": `# documented in ${PRIVATE_REPO}`,
      ".husky/pre-commit": `# rationale: ${dir("design", "decisions")}y.md`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(3);
  });

  it("fails rather than reports clean when it selects no files", () => {
    expect(() => noPrivateRepoPath.run(fakeContext({ "a.png": "x" }))).toThrow(
      /matched none/,
    );
  });

  // The word alone is safe to write here: a violation needs it adjacent to a
  // slash or to a repo-pointing word, and nothing in this file puts it there.
  // If an edit ever does, this check reads its own source and says so.
  const MARKER = "inner";

  it("catches a path under the private repo, which is how it actually gets written", () => {
    // The form that was live in four tracked files while this check reported
    // clean: a probe script cited by path. It carries no trailing-slash
    // directory the old list knew, and no repo name — only the prefix.
    const context = fakeContext({
      "packages/collab/src/a.ts": `// see ${MARKER}/engineering/demo/2026-01-01-probe.mjs\n`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(1);
  });

  it("catches a directory named in prose, without the trailing slash", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `// per ${MARKER} engineering/specs 2026-01-01 access design\n`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(1);
  });

  it("catches a reference that names no path at all", () => {
    // An id is as much a pointer as a path: it says the repo exists and that
    // this decision lives in it, and the reader still cannot follow it.
    const context = fakeContext({
      "a.md": `per ${MARKER} ADR 2026-01-01`,
      "b.md": `spec = ${MARKER} #409`,
      "c.md": `written up in the ${MARKER} spec`,
      "d.ts": `// 详见 ${MARKER} 仓`,
    });
    expect(noPrivateRepoPath.run(context)).toHaveLength(4);
  });

  it("leaves the word alone when it points at nothing", () => {
    // Measured before widening: the bare word appears 77 times in the tree,
    // all of them ordinary code. Matching it would switch this check off.
    const context = fakeContext({
      "packages/core/src/a.ts": [
        `function ${MARKER}(): void {}`,
        `// the ${MARKER} loop runs twice`,
        `const x = { ${MARKER}: 1 };`,
      ].join("\n"),
    });
    expect(noPrivateRepoPath.run(context)).toEqual([]);
  });

  it("leaves a path that does not name the private repo alone", () => {
    // The red line's boundary, ratified 2026-08-06: it covers naming the
    // private repository, not every path fragment that happens to live
    // there. These three forms were all live in the tree when the boundary
    // was set and are deliberately not violations — a filename saying a
    // design document exists reveals nothing that matters, and the private
    // repository answers 404 to anyone who is not a member.
    //
    // This case is what stops the criterion from being quietly re-widened:
    // widen it and this goes red.
    const context = fakeContext({
      "packages/worker/src/a.ts": "// per design/project/02-mini-tool.md § 2",
      "packages/web/src/b.css": "/* mirrors design/tokens.css */",
      "docs/c.md": "audit writes bugs/audit/round-N-found.md",
    });
    expect(noPrivateRepoPath.run(context)).toEqual([]);
  });
});
