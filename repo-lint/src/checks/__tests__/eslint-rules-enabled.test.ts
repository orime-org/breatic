// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { auditEslintWiring } from "#repo-lint/checks/eslint-rules-enabled";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** A config file body that turns on exactly the named rules. */
function config(names: readonly string[], quote = '"'): string {
  const lines = names.map(
    (name) => `      ${quote}breatic/${name}${quote}: "error",`,
  );
  return `export default [\n  {\n    files: ["packages/{core,server}/src/**"],\n    rules: {\n${lines.join("\n")}\n    },\n  },\n];\n`;
}

/** Both config files, so the check finds what it requires. */
function configs(
  root: readonly string[],
  web: readonly string[],
): Record<string, string> {
  return {
    "eslint.config.ts": config(root),
    "packages/web/eslint.config.mts": config(web, "'"),
  };
}

describe("auditEslintWiring", () => {
  it("passes when every registered rule is switched on somewhere", () => {
    const context = fakeContext(configs(["no-library-logger"], ["hover-pattern"]));
    expect(
      auditEslintWiring(context, ["no-library-logger", "hover-pattern"]),
    ).toEqual([]);
  });

  it("reports a rule that is written, registered and never switched on", () => {
    // The failure this exists for: a rule with a file, an export, a passing
    // unit test and no line in any config says nothing, forever, and looks
    // exactly like a rule with no violations to report.
    const context = fakeContext(configs(["no-library-logger"], ["hover-pattern"]));
    const findings = auditEslintWiring(context, [
      "no-library-logger",
      "hover-pattern",
      "never-turned-on",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/never-turned-on/);
  });

  it("sees a rule that only the single-quoted config enables", () => {
    // web's config is written with single quotes. A scan that assumed double
    // would report every rule it alone enables as dead.
    const context = fakeContext(configs([], ["hover-pattern"]));
    expect(auditEslintWiring(context, ["hover-pattern"])).toEqual([]);
  });

  it("reports a root-config glob that claims the web package", () => {
    // ESLint started in packages/web never reads the root config, so a glob
    // there matching web governs nothing while reading as though it governed
    // everything.
    const context = fakeContext({
      "eslint.config.ts": `export default [\n  {\n    files: ["packages/*/src/**/*.ts"],\n    rules: { "breatic/a": "error" },\n  },\n];\n`,
      "packages/web/eslint.config.mts": config(["a"], "'"),
    });
    const findings = auditEslintWiring(context, ["a"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/cannot reach/);
  });

  it("reports a root-config glob that names the web package outright", () => {
    const context = fakeContext({
      "eslint.config.ts": `export default [\n  {\n    files: ["packages/web/src/**/*.ts"],\n    rules: { "breatic/a": "error" },\n  },\n];\n`,
      "packages/web/eslint.config.mts": config(["a"], "'"),
    });
    expect(auditEslintWiring(context, ["a"])).toHaveLength(1);
  });

  it("accepts a root-config glob that names the packages it can reach", () => {
    const context = fakeContext(configs(["a"], []));
    expect(auditEslintWiring(context, ["a"])).toEqual([]);
  });

  it("fails rather than reports clean when a config file is missing", () => {
    expect(() => auditEslintWiring(fakeContext({ "a.ts": "x" }), ["a"])).toThrow(
      /eslint\.config\.ts/,
    );
  });
});
