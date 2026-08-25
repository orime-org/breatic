// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  configDirectories,
  loudestSeverities,
  severitiesUnderConfig,
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
    // Six names, not five: ESLint's own loader lists eslint.config.cts
    // alongside the rest, and a package carrying its config under that name
    // is one letter from packages/web/eslint.config.mts. Missed here, such a
    // package is invisible to the half of eslint-rules-enabled that catches a
    // root glob claiming a package it cannot govern.
    expect(
      configDirectories([
        "a/eslint.config.js",
        "b/eslint.config.mjs",
        "c/eslint.config.cjs",
        "d/eslint.config.ts",
        "e/eslint.config.mts",
        "f/eslint.config.cts",
      ]),
    ).toHaveLength(6);
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

  it("passes over a file the config globally ignores", async () => {
    // calculateConfigForFile returns undefined for an ignored path — measured
    // against ESLint 10 — and reading .rules off that throws a TypeError that
    // names neither the file nor the check. An ignored file has no severities
    // to contribute, so it is simply not asked.
    writeFileSync(
      join(root, "eslint.config.mjs"),
      `export default [
  { ignores: ["src/generated/**"] },
  { files: ["src/**/*.js"], rules: { eqeqeq: "error" } },
];\n`,
    );
    mkdirSync(join(root, "src/generated"), { recursive: true });
    writeFileSync(join(root, "src/generated/big.js"), "var a = 1;\n");
    const severities = await loudestSeverities(root, [""], [
      "src/a.js",
      "src/generated/big.js",
    ]);
    expect(severities.get("eqeqeq")).toBe("error");
  });
});

describe("severitiesUnderConfig", () => {
  // Its own fixture, written once and never rewritten, because the question
  // here is what one fixed config makes of files it does not govern.
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "repo-lint-claims-"));
    mkdirSync(join(root, "packages/web/src"), { recursive: true });
    mkdirSync(join(root, "packages/core/src"), { recursive: true });
    // A block that is spread in from elsewhere: it exists in the resolved
    // config and appears nowhere in the config file's own text, so no scan of
    // that text can see the glob it carries.
    writeFileSync(
      join(root, "shared.mjs"),
      `export default [
  { files: ["packages/web/**/*.js"], rules: { "no-alert": "error" } },
];\n`,
    );
    writeFileSync(
      join(root, "eslint.config.mjs"),
      `import shared from "./shared.mjs";
export default [
  ...shared,
  { files: ["packages/**/*.js"], rules: { "no-var": "error" } },
  { files: ["packages/core/**/*.js"], rules: { eqeqeq: "error" } },
];\n`,
    );
    writeFileSync(join(root, "packages/web/src/a.js"), "const a = 1;\n");
    writeFileSync(join(root, "packages/core/src/b.js"), "const b = 2;\n");
    // The web package's own config, which is the one a real run resolves for
    // a file inside it — and which this function deliberately does not use.
    writeFileSync(
      join(root, "packages/web/eslint.config.mjs"),
      `export default [{ files: ["src/**/*.js"], rules: { curly: "error" } }];\n`,
    );
    execFileSync("npm", ["init", "-y"], { cwd: root, stdio: "pipe" });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sees a wildcard glob that reaches across every package", async () => {
    // `packages/**` was one of the spellings a scan for glob text walked past,
    // because it looked for `packages/*/` and this is not that.
    const severities = await severitiesUnderConfig(root, "eslint.config.mjs", [
      "packages/web/src/a.js",
    ]);
    expect(severities.get("no-var")).toBe("error");
  });

  it("sees a glob carried by a block the config file spreads in", async () => {
    // The spelling no amount of care with a text scan could have caught: the
    // glob is in another file, and this one only names it.
    const severities = await severitiesUnderConfig(root, "eslint.config.mjs", [
      "packages/web/src/a.js",
    ]);
    expect(severities.get("no-alert")).toBe("error");
  });

  it("leaves out a rule the config aims at some other package", async () => {
    const severities = await severitiesUnderConfig(root, "eslint.config.mjs", [
      "packages/web/src/a.js",
    ]);
    expect(severities.has("eqeqeq")).toBe(false);
  });

  it("answers for the named config, not the one that would really govern", async () => {
    // packages/web carries its own config and that is what a real run reads.
    // Following it here would answer "what governs this file", which is the
    // opposite of the question — a config claiming files it never reaches is
    // exactly what this is for.
    const severities = await severitiesUnderConfig(root, "eslint.config.mjs", [
      "packages/web/src/a.js",
    ]);
    expect(severities.has("curly")).toBe(false);
  });
});
