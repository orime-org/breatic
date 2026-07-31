// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext } from "#repo-lint/context";

let root: string;

/**
 * Runs a git command in the fixture repository.
 * @param args Arguments after `git`.
 */
function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-lint-ctx-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  writeFileSync(join(root, "committed.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "first");

  // Written after the commit and never staged: the state that used to make
  // a check clean locally and dirty the moment it landed.
  writeFileSync(join(root, "uncommitted.ts"), "export const b = 2;\n");
  execFileSync("mkdir", ["-p", join(root, "ignored")]);
  writeFileSync(join(root, "ignored", "junk.ts"), "export const c = 3;\n");
  // Nested, so the repo-relative path arithmetic is exercised at more than
  // one level deep.
  execFileSync("mkdir", ["-p", join(root, "ignored", "nested", "deep")]);
  writeFileSync(
    join(root, "ignored", "nested", "deep", "leaf.ts"),
    "export const d = 4;\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createContext", () => {
  it("sees a file that is written but not committed yet", () => {
    // This is the regression this test exists for. Judging only the tracked
    // set meant a newly added check reported clean until the commit that
    // added it, and failed immediately afterwards.
    const context = createContext(root);
    const files = context.files((path) => path.endsWith(".ts"), "typescript");
    expect(files).toContain("uncommitted.ts");
    expect(files).toContain("committed.ts");
  });

  it("respects .gitignore", () => {
    const context = createContext(root);
    const files = context.files((path) => path.endsWith(".ts"), "typescript");
    expect(files).not.toContain("ignored/junk.ts");
  });

  it("lists each file once", () => {
    const context = createContext(root);
    const files = context.files(() => true, "everything");
    expect(new Set(files).size).toBe(files.length);
  });

  it("throws rather than returning nothing when a selection is empty", () => {
    const context = createContext(root);
    expect(() => context.files((path) => path.endsWith(".rs"), "rust")).toThrow(
      /matched none/,
    );
  });

  it("reads a file's contents", () => {
    expect(createContext(root).read("committed.ts")).toBe(
      "export const a = 1;\n",
    );
  });

  it("reports whether a path exists", () => {
    const context = createContext(root);
    expect(context.exists("committed.ts")).toBe(true);
    expect(context.exists("nope.ts")).toBe(false);
  });

  describe("walk", () => {
    // The only code here that reads a directory rather than asking git, and
    // the only place a repo-relative path is computed by arithmetic on an
    // absolute one. The fake the check tests run against implements a
    // different algorithm, so nothing exercised this until now.

    it("returns repo-relative paths for files at any depth", () => {
      const found = createContext(root).walk(
        "ignored",
        () => true,
        "everything",
      );
      expect(found).toContain("ignored/junk.ts");
      expect(found).toContain("ignored/nested/deep/leaf.ts");
      // Not absolute, and no leading separator: the slice has to land on the
      // character after the root, and one off in either direction shows up
      // here rather than as a mysteriously unreadable path later.
      expect(found.every((path) => path.startsWith("ignored/"))).toBe(true);
    });

    it("reads directories git ignores, because build output is ignored", () => {
      // The difference from `files` that gives this method a reason to
      // exist: the check that reads built output would find nothing if this
      // asked git what it tracks.
      expect(createContext(root).walk("ignored", () => true, "everything"))
        .not.toHaveLength(0);
    });

    it("selects rather than returning everything", () => {
      const found = createContext(root).walk(
        "ignored",
        (path) => path.endsWith("leaf.ts"),
        "leaves",
      );
      expect(found).toEqual(["ignored/nested/deep/leaf.ts"]);
    });

    it("refuses a directory that is not there rather than reporting clean", () => {
      expect(() =>
        createContext(root).walk("never-built", () => true, "everything"),
      ).toThrow(/does not exist/);
    });

    it("refuses a selection that matches nothing under the directory", () => {
      expect(() =>
        createContext(root).walk("ignored", () => false, "nothing at all"),
      ).toThrow(/matched none/);
    });
  });
});
