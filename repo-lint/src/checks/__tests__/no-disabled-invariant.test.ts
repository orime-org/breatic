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
