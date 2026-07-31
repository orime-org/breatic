// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import {
  auditEslintWiring,
  packagesOutOfRootReach,
} from "#repo-lint/checks/eslint-rules-enabled";
import type { Severity } from "#repo-lint/eslint-severity";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** A config file body that turns on exactly the named rules. */
function config(names: readonly string[]): string {
  const lines = names.map((name) => `      "breatic/${name}": "error",`);
  return `export default [\n  {\n    files: ["packages/{core,server}/src/**"],\n    rules: {\n${lines.join("\n")}\n    },\n  },\n];\n`;
}

/**
 * The severities ESLint resolves, as this audit receives them.
 *
 * Passed in rather than read from config text: which rules actually run is a
 * question only ESLint can answer, and this half of the check is only about
 * what to do with the answer.
 * @param map Rule short names to the severity they reach.
 * @returns The map keyed the way the plugin names its rules.
 */
function resolved(map: Record<string, Severity>): Map<string, Severity> {
  return new Map(
    Object.entries(map).map(([name, severity]) => [`breatic/${name}`, severity]),
  );
}

/**
 * What the root config alone makes of one package that carries its own.
 * @param directory The package directory, as the check derives it.
 * @param map Rule short names to the severity the root config gives them.
 * @returns The shape the audit receives.
 */
function underRoot(
  directory: string,
  map: Record<string, Severity>,
): Map<string, Map<string, Severity>> {
  return new Map([[directory, resolved(map)]]);
}

describe("packagesOutOfRootReach", () => {
  // Which packages the root config cannot govern is derivable from the tree —
  // every directory that carries a config of its own — and the check already
  // derives that list for another purpose two lines earlier. Naming one of
  // them instead means the second package to gain its own config is never
  // asked what the root config claims about it, and nothing says so.
  it("names every directory carrying its own config", () => {
    expect(
      packagesOutOfRootReach([
        "eslint.config.ts",
        "packages/web/eslint.config.mts",
        "packages/studio/eslint.config.ts",
        "packages/core/src/index.ts",
      ]),
    ).toEqual(["packages/web", "packages/studio"]);
  });

  it("leaves the repository root out, since that is the config in question", () => {
    expect(packagesOutOfRootReach(["eslint.config.ts", "a/src/b.ts"])).toEqual(
      [],
    );
  });
});

describe("auditEslintWiring", () => {
  it("passes when every registered rule reaches source as an error", () => {
    const context = fakeContext({ "eslint.config.ts": config(["a", "b"]) });
    const findings = auditEslintWiring(
      context,
      ["a", "b"],
      resolved({ a: "error", b: "error" }),
      new Map(),
    );
    expect(findings).toEqual([]);
  });

  it("reports a rule that is written, registered and reaches nothing", () => {
    // The failure this exists for: a rule with a file, an export, a passing
    // unit test and no line in any config says nothing, forever, and looks
    // exactly like a rule with no violations to report.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    const findings = auditEslintWiring(
      context,
      ["a", "never-turned-on"],
      resolved({ a: "error" }),
      new Map(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/never-turned-on/);
    expect(findings[0]?.message).toMatch(/reaches no file/);
  });

  it("reports a rule that reaches source switched off", () => {
    // Measured against ESLint 10: setting a rule to "off" and deleting its
    // line produce identical silence. The check that read config text saw the
    // second and not the first, because it only looked for the rule's name.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    const findings = auditEslintWiring(
      context,
      ["a"],
      resolved({ a: "off" }),
      new Map(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/switched off/);
  });

  it("reports a rule downgraded to a warning", () => {
    // A warning does not fail the build, so the invariant is gone in the way
    // that matters while the config still reads as though it were enforced.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    const findings = auditEslintWiring(
      context,
      ["a"],
      resolved({ a: "warn" }),
      new Map(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/only as a warning/);
  });

  it("reports one of our rules the root config declares for a web file", () => {
    // The root config is never the one ESLint resolves for a file in
    // packages/web — that package carries its own — so a rule declared here
    // for web governs nothing there while reading as though it governed
    // everything. Which globs did that is ESLint's question to answer, so the
    // answer arrives already resolved rather than parsed out of config text.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    const findings = auditEslintWiring(
      context,
      ["a"],
      resolved({ a: "error" }),
      underRoot("packages/web", { a: "error" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/never governs/);
    expect(findings[0]?.message).toMatch(/packages\/web/);
    expect(findings[0]?.message).toMatch(/breatic\/a/);
  });

  it("reports a rule the root config downgrades to a warning over web", () => {
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    expect(
      auditEslintWiring(
        context,
        ["a"],
        resolved({ a: "error" }),
        underRoot("packages/web", { a: "warn" }),
      ),
    ).toHaveLength(1);
  });

  it("leaves a rule the root config switches off over web alone", () => {
    // Set to "off" for web it claims nothing, so nobody is misled about it.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    expect(
      auditEslintWiring(
        context,
        ["a"],
        resolved({ a: "error" }),
        underRoot("packages/web", { a: "off" }),
      ),
    ).toEqual([]);
  });

  it("leaves someone else's rule reaching web alone", () => {
    // The root config's other blocks come from presets we do not write, and
    // whether those reach web is not this check's subject.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    const reaching = new Map([
      ["packages/web", new Map<string, Severity>([["no-undef", "error"]])],
    ]);
    expect(
      auditEslintWiring(context, ["a"], resolved({ a: "error" }), reaching),
    ).toEqual([]);
  });

  it("accepts a root config that reaches nothing in web", () => {
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    expect(
      auditEslintWiring(context, ["a"], resolved({ a: "error" }), new Map()),
    ).toEqual([]);
  });

  it("fails rather than reports clean when the root config is missing", () => {
    expect(() =>
      auditEslintWiring(
        fakeContext({ "a.ts": "x" }),
        ["a"],
        resolved({}),
        new Map(),
      ),
    ).toThrow(/eslint\.config\.ts/);
  });
});
