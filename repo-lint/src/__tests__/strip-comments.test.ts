// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { stripComments } from "#repo-lint/strip-comments";

describe("stripComments", () => {
  it("keeps the line count identical", () => {
    // The whole reason this exists. The awk version's loop did not execute
    // on an empty line, so blank lines vanished and every reported line
    // number after one was too low.
    const text = "one\n\n// two\n\n/* three */\n\nsix\n";
    expect(stripComments(text, "js").split("\n")).toHaveLength(
      text.split("\n").length,
    );
  });

  it("blanks a line comment but keeps the code before it", () => {
    expect(stripComments("const a = 1; // why\n", "js")).toBe("const a = 1; \n");
  });

  it("blanks a block comment inline", () => {
    expect(stripComments("const a = /* why */ 1;\n", "js")).toBe(
      "const a =  1;\n",
    );
  });

  it("spans a block comment across lines, blanking each", () => {
    const text = "before\n/* one\n   two */after\n";
    expect(stripComments(text, "js")).toBe("before\n\nafter\n");
  });

  it("keeps a line's number when its whole content is a comment", () => {
    const stripped = stripComments("a\n// gone\nb\n", "js").split("\n");
    expect(stripped[1]).toBe("");
    expect(stripped[2]).toBe("b");
  });

  it("does not treat // as a comment in CSS", () => {
    // CSS has no line comments; a `//` there is part of a URL far more
    // often than not.
    expect(stripComments("a { background: url(http://x); }\n", "css")).toBe(
      "a { background: url(http://x); }\n",
    );
  });

  it("blanks CSS block comments", () => {
    expect(stripComments("a { /* why */ color: red; }\n", "css")).toBe(
      "a {  color: red; }\n",
    );
  });

  it("handles several comments on one line", () => {
    expect(stripComments("a /* x */ b /* y */ c\n", "js")).toBe("a  b  c\n");
  });

  it("refuses an unterminated block comment instead of blanking to end of file", () => {
    // This used to return the blanked text. That is the shape of the worst
    // failure this module can have: the caller receives a file that is empty
    // from some line onward and has no way to tell that from a file with
    // nothing in it.
    expect(() => stripComments("a\n/* never closed\nb\nc\n", "js")).toThrow(
      /never closes/,
    );
  });


  it("does not open a block comment from inside a string literal", () => {
    // Live regression: `accept='image/*,video/*'` opened a block that never
    // closed, so every later line in that file became invisible to the
    // checks reading the result — silently, and file-wide.
    const text = `const accept = 'image/*,video/*';\nconst c = "bg-brand-500";\n`;
    expect(stripComments(text, "js")).toBe(text);
  });

  it("does not treat // inside a string as a line comment", () => {
    const text = `const a = <a href="https://x.io" className="bg-brand-500" />;\n`;
    expect(stripComments(text, "js")).toBe(text);
  });

  it("keeps a string open across lines only for a template literal", () => {
    // A single-quoted string cannot span lines, so an unbalanced quote must
    // not swallow the rest of the file.
    const text = `const a = 'unclosed;\nconst b = "bg-brand-500";\n`;
    expect(stripComments(text, "js")).toContain("bg-brand-500");
  });

  it("handles an escaped quote inside a string", () => {
    const text = `const a = "he said \\"/*\\" and left";\nconst b = 1;\n`;
    expect(stripComments(text, "js")).toBe(text);
  });

  it("still strips a comment that follows a string on the same line", () => {
    expect(stripComments(`const a = "x"; // why\n`, "js")).toBe(
      `const a = "x"; \n`,
    );
  });

  it("does not open a block from a string in CSS either", () => {
    const text = `a { background: url("/*not-a-comment*/"); color: red; }\n`;
    expect(stripComments(text, "css")).toBe(text);
  });

  it("leaves text with no comments untouched", () => {
    const text = "const a = 1;\nconst b = 2;\n";
    expect(stripComments(text, "js")).toBe(text);
  });

  it("does not open a block from a slash inside a regex character class", () => {
    // The literal that found this: a class holding both slash and star. The
    // first version read the `/*` in it as a comment opener that never
    // closed, so every following line came back blank and the checks reading
    // the result reported clean on a file they had stopped seeing.
    const text = `const SLASH_OR_STAR = /[/*]/;\nconst brand = "bg-brand-500";\n`;
    expect(stripComments(text, "js")).toBe(text);
  });

  it("does not open a block from an escaped slash in a regex", () => {
    // Stripping a trailing slash is ordinary code, and it spells `/\\/*$/`.
    const text = `const trimmed = path.replace(/\\/*$/, "");\nconst next = 1;\n`;
    expect(stripComments(text, "js")).toBe(text);
  });

  it("still treats division as division", () => {
    const text = `const ratio = width / height / 2;\nconst next = 1;\n`;
    expect(stripComments(text, "js")).toBe(text);
  });

  it("still strips a comment that follows a regex on the same line", () => {
    expect(stripComments(`const re = /a\\/b/; // why\n`, "js")).toBe(
      `const re = /a\\/b/; \n`,
    );
  });

  it("refuses to return a file whose block comment never closes", () => {
    // Whatever the cause — a real unterminated comment, or an opener this
    // stripper misread — the result would be a file that goes blank partway
    // through and says nothing about it. Every check reading that reports
    // clean on text it never saw, which is the failure this whole suite
    // exists to make impossible. Loud beats silent.
    expect(() =>
      stripComments(`const a = 1; /* opened\nconst b = 2;\n`, "js"),
    ).toThrow(/never closes/);
  });

  it("names the source in the refusal, so the bad file can be found", () => {
    // Without this the message says a block comment is unterminated
    // somewhere in the repository and stops there, which leaves whoever
    // hits it grepping for an unclosed comment across every tracked file.
    expect(() => stripComments("/* never closed", "js", "packages/x/a.ts")).toThrow(
      /packages\/x\/a\.ts/,
    );
  });
});
