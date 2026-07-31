// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noBrandUsage } from "#repo-lint/checks/no-brand-usage";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const src = "packages/web/src";

describe("no-brand-usage", () => {
  it("passes neutral and semantic tokens", () => {
    const context = fakeContext({
      [`${src}/a.tsx`]: 'const c = "bg-muted text-foreground border-border";',
      [`${src}/b.css`]: "a { color: var(--color-status-error); }",
    });
    expect(noBrandUsage.run(context)).toEqual([]);
  });

  it("catches each Tailwind arm", () => {
    const context = fakeContext({
      [`${src}/a.tsx`]: "bg-brand-500",
      [`${src}/b.tsx`]: "text-brand-700",
      [`${src}/c.tsx`]: "border-brand-200",
      [`${src}/d.tsx`]: "ring-brand-900",
    });
    expect(noBrandUsage.run(context)).toHaveLength(4);
  });

  it("catches a custom-property reference in CSS", () => {
    const context = fakeContext({
      [`${src}/a.css`]: "a { color: var(--brand-500); }",
    });
    expect(noBrandUsage.run(context)).toHaveLength(1);
  });

  it("catches a semantic brand alias but not a palette step", () => {
    // The token arm wants a letter: `--color-brand-accent` is someone
    // inventing a brand-flavoured semantic token, which is the drift. A
    // numbered step is the palette itself.
    const withLetter = fakeContext({
      [`${src}/a.css`]: "a { --color-brand-accent: red; }",
    });
    const withDigit = fakeContext({
      [`${src}/a.css`]: "a { --color-brand-500: red; }",
    });
    expect(noBrandUsage.run(withLetter)).toHaveLength(1);
    expect(noBrandUsage.run(withDigit)).toEqual([]);
  });

  it("leaves the palette definitions alone — defining is not using", () => {
    const context = fakeContext({
      [`${src}/theme/tokens.css`]: "--brand-500: hsl(8, 58%, 52%);",
    });
    expect(noBrandUsage.run(context)).toEqual([]);
  });

  it("permits the logo token, in the definitions and at a call site", () => {
    const context = fakeContext({
      [`${src}/theme/tokens.css`]: "--brand-logo-primary: var(--brand-500);",
      [`${src}/ui/BrandMark.tsx`]: 'const c = "bg-[var(--brand-logo-primary)]";',
    });
    expect(noBrandUsage.run(context)).toEqual([]);
  });

  it("honours the per-line escape", () => {
    const context = fakeContext({
      [`${src}/a.tsx`]: 'const c = "bg-brand-500"; // brand-guard: allow — the marketing badge',
    });
    expect(noBrandUsage.run(context)).toEqual([]);
  });

  it("does not flag a brand token named in a comment", () => {
    // The invariant is about what renders. A token named in prose does not
    // make chrome un-neutral, so the guard's text scan flagged a false
    // positive here.
    const context = fakeContext({
      [`${src}/a.tsx`]: "// Do not use var(--brand-500) outside the logo.\nconst c = 1;",
      [`${src}/b.css`]: "/* was: var(--brand-500) */\na { color: red; }",
    });
    expect(noBrandUsage.run(context)).toEqual([]);
  });

  it("still flags code on the same line as a comment", () => {
    const context = fakeContext({
      [`${src}/a.tsx`]: 'const c = "bg-brand-500"; // neutral please',
    });
    expect(noBrandUsage.run(context)).toHaveLength(1);
  });

  it("does not treat // in a CSS url as a comment", () => {
    const context = fakeContext({
      [`${src}/a.css`]: "a { background: url(http://x/y); color: var(--brand-500); }",
    });
    expect(noBrandUsage.run(context)).toHaveLength(1);
  });

  it("names the right line after a multi-line comment", () => {
    const context = fakeContext({
      [`${src}/a.tsx`]: "/* one\n   two */\nconst c = \"bg-brand-500\";",
    });
    expect(noBrandUsage.run(context)[0]?.line).toBe(3);
  });

  it("ignores files outside web source", () => {
    const context = fakeContext({
      "packages/web/public/logo.css": "a { color: var(--brand-500); }",
      "packages/core/src/a.ts": 'const c = "bg-brand-500";',
      [`${src}/ok.tsx`]: "const c = 1;",
    });
    expect(noBrandUsage.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    expect(() => noBrandUsage.run(fakeContext({ "a.md": "x" }))).toThrow(
      /matched none/,
    );
  });
});
