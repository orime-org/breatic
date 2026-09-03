// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the shared AIGC prompt sanitizer keeps and what it removes.
 *
 * Every prompt reaching a provider goes through this one function, so its
 * whitespace rule is a product decision, not a formatting detail: for a
 * voiceover the line breaks ARE the pacing, and flattening them changes what
 * the vendor speaks. Horizontal runs still collapse — a stray double space is
 * noise in every modality — and so do runs of blank lines beyond one.
 */

import { describe, it, expect } from "vitest";

import { extractPromptText } from "@shared/agent/extract-prompt.js";

describe("extractPromptText — what it strips", () => {
  it("removes HTML tags", () => {
    expect(extractPromptText("<b>hello</b> world")).toBe("hello world");
  });

  it("removes HTML comments", () => {
    expect(extractPromptText("a <!-- hidden --> b")).toBe("a b");
  });

  it("decodes the common entities", () => {
    expect(extractPromptText("a &amp; b &quot;c&quot;")).toBe('a & b "c"');
  });

  it("keeps a stage direction, which is not a tag", () => {
    // A voiceover script is read out word for word, so anything removed from
    // it is a word the listener does not hear. Angle brackets around prose are
    // ordinary punctuation — neither tts vendor treats them as markup, both
    // use square brackets.
    expect(extractPromptText("他喊了一声 <停!> 然后离开")).toBe(
      "他喊了一声 <停!> 然后离开",
    );
  });

  it("keeps a comparison, and the line under it", () => {
    // The two brackets need not be near each other: what sits between them is
    // a clause, a line break, or a whole paragraph.
    expect(extractPromptText("价格<100元，库存>50件")).toBe("价格<100元，库存>50件");
    expect(extractPromptText("5 < 6\n\n然后 7 > 3")).toBe("5 < 6\n\n然后 7 > 3");
  });

  it("removes a tag whose attributes run onto the next line", () => {
    expect(extractPromptText('<div\nclass="x">y</div>')).toBe("y");
  });

  it("removes zero-width and invisible characters", () => {
    // Escaped, not literal: a source file carrying the characters themselves
    // is the thing `no-trojan-source` exists to catch.
    expect(extractPromptText("a\u200Bb\uFEFFc")).toBe("abc");
  });
});

describe("extractPromptText — what it does to whitespace", () => {
  it("keeps a line break, because for speech it is a pause", () => {
    expect(extractPromptText("Good evening.\nWelcome back.")).toBe(
      "Good evening.\nWelcome back.",
    );
  });

  it("keeps one blank line between paragraphs", () => {
    expect(extractPromptText("First para.\n\nSecond para.")).toBe(
      "First para.\n\nSecond para.",
    );
  });

  it("collapses a longer run of blank lines to one", () => {
    expect(extractPromptText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("collapses horizontal runs to a single space", () => {
    expect(extractPromptText("a   \t b")).toBe("a b");
  });

  it("normalizes CRLF, so a Windows paste reads as one break", () => {
    expect(extractPromptText("a\r\nb")).toBe("a\nb");
  });

  it("drops the spaces that sit around a break", () => {
    expect(extractPromptText("a  \n  b")).toBe("a\nb");
  });

  it("trims the ends", () => {
    expect(extractPromptText("\n  hello  \n")).toBe("hello");
  });

  it("turns a stripped tag into a space, never into a break", () => {
    // Tag removal substitutes a space, so a single line stays a single line
    // however many tags it carried.
    expect(extractPromptText("<p>a</p><p>b</p>")).toBe("a b");
  });
});
