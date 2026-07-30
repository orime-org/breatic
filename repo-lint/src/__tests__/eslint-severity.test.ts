// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  configDirectories,
  loudestSeverities,
  severityOf,
} from "#repo-lint/eslint-severity";

describe("severityOf", () => {
  // ESLint hands back whichever spelling the config used, and wraps the value
  // in an array when the rule carries options. A comparison against one form
  // silently misreads every other, which is how a rule set to 0 reads as on.
  it.each([
    ["error", "error"],
    [2, "error"],
    [["error", { some: "option" }], "error"],
    [[2], "error"],
    ["warn", "warn"],
    [1, "warn"],
    [["warn"], "warn"],
    ["off", "off"],
    [0, "off"],
    [["off"], "off"],
  ])("reads %j as %s", (entry, expected) => {
    expect(severityOf(entry)).toBe(expected);
  });
});

describe("configDirectories", () => {
  it("finds a config at the repository root and in a package", () => {
    expect(
      configDirectories([
        "eslint.config.ts",
        "packages/web/eslint.config.mts",
        "packages/core/src/index.ts",
      ]),
    ).toEqual(["", "packages/web"]);
  });

  it("accepts every extension flat config allows", () => {
    expect(
      configDirectories([
        "a/eslint.config.js",
        "b/eslint.config.mjs",
        "c/eslint.config.cjs",
        "d/eslint.config.ts",
        "e/eslint.config.mts",
      ]),
    ).toHaveLength(5);
  });

  it("is not fooled by a file that merely mentions the name", () => {
    expect(
      configDirectories(["docs/eslint.config.md", "src/eslint.config.test.ts"]),
    ).toEqual([]);
  });
});

describe("loudestSeverities", () => {
  // A real ESLint run against a real config, because the whole point of this
  // module is that it stops guessing at config text — a fake would test the
  // guess again.
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "repo-lint-sev-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "nested"), { recursive: true });
    mkdirSync(join(root, "nested/src"), { recursive: true });
    writeFileSync(
      join(root, "eslint.config.mjs"),
      `export default [
  { files: ["src/**/*.js"], rules: { eqeqeq: "error", curly: "warn", semi: "off" } },
];\n`,
    );
    // A second config root, to prove a file under it is judged by its own
    // config rather than by the one above it.
    writeFileSync(
      join(root, "nested/eslint.config.mjs"),
      `export default [
  { files: ["src/**/*.js"], rules: { "no-var": "error" } },
];\n`,
    );
    writeFileSync(join(root, "src/a.js"), "const a = 1;\n");
    writeFileSync(join(root, "nested/src/b.js"), "const b = 2;\n");
    execFileSync("npm", ["init", "-y"], { cwd: root, stdio: "pipe" });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the severity each rule actually resolves to", async () => {
    const severities = await loudestSeverities(root, ["", "nested"], [
      "src/a.js",
      "nested/src/b.js",
    ]);
    expect(severities.get("eqeqeq")).toBe("error");
    expect(severities.get("curly")).toBe("warn");
    expect(severities.get("semi")).toBe("off");
  });

  it("judges a file by the nearest config, not the one above it", async () => {
    const severities = await loudestSeverities(root, ["", "nested"], [
      "src/a.js",
      "nested/src/b.js",
    ]);
    expect(severities.get("no-var")).toBe("error");
  });

  it("keeps the loudest severity when a rule resolves differently per file", async () => {
    // Two files, one config each, same rule at different severities: the
    // question is "does this rule fail the build anywhere", so the loudest
    // answer is the right one.
    writeFileSync(
      join(root, "nested/eslint.config.mjs"),
      `export default [
  { files: ["src/**/*.js"], rules: { "no-var": "error", eqeqeq: "off" } },
];\n`,
    );
    const severities = await loudestSeverities(root, ["", "nested"], [
      "src/a.js",
      "nested/src/b.js",
    ]);
    expect(severities.get("eqeqeq")).toBe("error");
  });
});
