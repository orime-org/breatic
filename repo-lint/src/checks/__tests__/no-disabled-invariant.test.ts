// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noDisabledInvariant } from "#repo-lint/checks/no-disabled-invariant";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * The directive, assembled rather than written.
 *
 * Spelling it out would make this file the first thing the check reports,
 * and the check would then need an exemption for its own tests — which is an
 * exemption to maintain and a place a real one could hide.
 */
const OFF = ["eslint", "disable"].join("-");

/**
 * The inline-configuration comment's leading word, assembled for the same
 * reason: written out next to a rule name, this file would report itself.
 */
const CONFIG = ["es", "lint"].join("");

describe("no-disabled-invariant", () => {
  it("reports a rule switched off for the next line", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `// ${OFF}-next-line breatic/no-library-logger\nlogger.info("x");\n`,
    });
    const findings = noDisabledInvariant.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.message).toMatch(/no-library-logger/);
  });

  it("reports a rule switched off for a whole file", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${OFF} breatic/no-relative-import */\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports a rule switched off for one line, trailing", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `const a = 1; // ${OFF}-line breatic/no-param-as-string\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports every rule named in one directive", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `// ${OFF}-next-line breatic/a, breatic/b\nx();\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(2);
  });

  // A directive that names no rule switches off EVERY rule for its scope,
  // which includes all of ours. Measured against ESLint 10: the rule stops
  // reporting and the file lints clean. These are the forms that do the most
  // damage with the least typing, and the first version of this check — which
  // required a rule name to be present — saw none of them.
  it("reports a whole-file directive that names no rule", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${OFF} */\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports a next-line directive that names no rule", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `// ${OFF}-next-line\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports a same-line directive that names no rule", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `import x from "./y"; // ${OFF}-line\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports a rule-less directive written as a block comment", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${OFF}-next-line */\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports a rule-less directive carrying a description", () => {
    // ESLint accepts `-- reason` after any directive. The description must not
    // be mistaken for a rule name, and its presence must not hide that the
    // directive names none.
    const context = fakeContext({
      "packages/core/src/a.ts": `// ${OFF}-next-line -- we had a reason\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  // The inline configuration comment is a second, entirely separate syntax
  // that switches a rule off. ESLint reports nothing at all for it — not even
  // through suppressedMessages — so a scan outside ESLint is the only thing
  // that can see it happen.
  it("reports one of our rules turned off by an inline config comment", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${CONFIG} breatic/no-relative-import: "off" */\nimport x from "./y";\n`,
    });
    const findings = noDisabledInvariant.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/no-relative-import/);
  });

  it("reports the numeric spelling of off", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${CONFIG} breatic/no-relative-import: 0 */\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports a downgrade to warn, which is a silencing CI does not fail on", () => {
    // Measured: the rule still fires, at severity 1. A build that fails on
    // errors alone goes green, so the invariant is gone in every way that
    // matters while looking like it is still enforced.
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${CONFIG} breatic/no-relative-import: "warn" */\nimport x from "./y";\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(1);
  });

  it("reports every one of our rules named in one inline config comment", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${CONFIG} breatic/a: "off", breatic/b: 0 */\nx();\n`,
    });
    expect(noDisabledInvariant.run(context)).toHaveLength(2);
  });

  it("leaves a third-party rule configured inline alone", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${CONFIG} @typescript-eslint/no-explicit-any: "off" */\nconst a: any = 1;\n`,
      "packages/core/src/b.ts": "const b = 1;\n",
    });
    expect(noDisabledInvariant.run(context)).toEqual([]);
  });

  it("leaves our rules being switched ON alone", () => {
    // Raising a rule to error is not switching an invariant off, and a check
    // that reported it would be one nobody could satisfy.
    const context = fakeContext({
      "packages/core/src/a.ts": `/* ${CONFIG} breatic/no-relative-import: "error" */\nconst a = 1;\n`,
      "packages/core/src/b.ts": "const b = 1;\n",
    });
    expect(noDisabledInvariant.run(context)).toEqual([]);
  });

  it("leaves third-party rules alone", () => {
    // Turning off a rule from someone else's plugin is an ordinary judgement
    // call. Turning off one of ours is switching off an invariant the
    // repository decided it has, which is a different thing.
    const context = fakeContext({
      "packages/core/src/a.ts": `// ${OFF}-next-line @typescript-eslint/no-explicit-any\nconst a: any = 1;\n`,
      "packages/core/src/b.ts": "const b = 1;\n",
    });
    expect(noDisabledInvariant.run(context)).toEqual([]);
  });

  it("leaves prose that merely mentions the directive alone", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": `const doc = "we do not ${OFF} breatic rules";\nconst b = 1;\n`,
    });
    expect(noDisabledInvariant.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    expect(() => noDisabledInvariant.run(fakeContext({ "a.png": "x" }))).toThrow(
      /matched none/,
    );
  });
});
