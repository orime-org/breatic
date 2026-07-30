// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { auditEslintWiring } from "#repo-lint/checks/eslint-rules-enabled";
import type { Severity } from "#repo-lint/eslint-severity";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** A config file body that turns on exactly the named rules. */
function config(names: readonly string[], quote = '"'): string {
  const lines = names.map(
    (name) => `      ${quote}breatic/${name}${quote}: "error",`,
  );
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

describe("auditEslintWiring", () => {
  it("passes when every registered rule reaches source as an error", () => {
    const context = fakeContext({ "eslint.config.ts": config(["a", "b"]) });
    const findings = auditEslintWiring(
      context,
      ["a", "b"],
      resolved({ a: "error", b: "error" }),
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
    const findings = auditEslintWiring(context, ["a"], resolved({ a: "off" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/switched off/);
  });

  it("reports a rule downgraded to a warning", () => {
    // A warning does not fail the build, so the invariant is gone in the way
    // that matters while the config still reads as though it were enforced.
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    const findings = auditEslintWiring(context, ["a"], resolved({ a: "warn" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/only as a warning/);
  });

  it("reports a root-config glob that claims the web package", () => {
    // ESLint started in packages/web never reads the root config, so a glob
    // there matching web governs nothing while reading as though it governed
    // everything.
    const context = fakeContext({
      "eslint.config.ts": `export default [\n  {\n    files: ["packages/*/src/**/*.ts"],\n    rules: { "breatic/a": "error" },\n  },\n];\n`,
    });
    const findings = auditEslintWiring(context, ["a"], resolved({ a: "error" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/cannot reach/);
  });

  it("reports a root-config glob that names the web package outright", () => {
    const context = fakeContext({
      "eslint.config.ts": `export default [\n  {\n    files: ["packages/web/src/**/*.ts"],\n    rules: { "breatic/a": "error" },\n  },\n];\n`,
    });
    expect(
      auditEslintWiring(context, ["a"], resolved({ a: "error" })),
    ).toHaveLength(1);
  });

  it("accepts a root-config glob that names the packages it can reach", () => {
    const context = fakeContext({ "eslint.config.ts": config(["a"]) });
    expect(auditEslintWiring(context, ["a"], resolved({ a: "error" }))).toEqual(
      [],
    );
  });

  it("fails rather than reports clean when the root config is missing", () => {
    expect(() =>
      auditEslintWiring(fakeContext({ "a.ts": "x" }), ["a"], resolved({})),
    ).toThrow(/eslint\.config\.ts/);
  });
});
