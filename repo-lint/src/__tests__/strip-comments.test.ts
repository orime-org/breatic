// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
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

  it("handles an unterminated block comment by blanking to end of file", () => {
    expect(stripComments("a\n/* never closed\nb\nc\n", "js")).toBe("a\n\n\n\n");
  });

  it("leaves text with no comments untouched", () => {
    const text = "const a = 1;\nconst b = 2;\n";
    expect(stripComments(text, "js")).toBe(text);
  });
});
