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
});
