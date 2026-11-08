// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";

import { toMarkdown } from "../to-markdown.js";

describe("toMarkdown", () => {
  it("writes headings as ATX headings, links inline and paragraphs apart", () => {
    const html =
      "<h1>Release notes</h1><h2>What changed</h2>" +
      '<p>Read the <a href="https://example.com/docs/start">getting started guide</a> first.</p>' +
      "<p>Second paragraph.</p>";

    expect(toMarkdown(html)).toBe(
      "# Release notes\n\n## What changed\n\n" +
        "Read the [getting started guide](https://example.com/docs/start) first.\n\n" +
        "Second paragraph.",
    );
  });

  // turndown 7.2.0 escapes both parentheses inside a link's destination as
  // `\(` and `\)`; this exact spelling is what the reader hands on, and the
  // domain page-links test reads it back as the plain link (design §6.0).
  it("escapes parentheses inside a link's URL the way turndown 7.2.0 does", () => {
    const html = '<p>See <a href="https://en.wikipedia.org/wiki/Fish_(food)">fish</a>.</p>';

    expect(toMarkdown(html)).toBe("See [fish](https://en.wikipedia.org/wiki/Fish_\\(food\\)).");
  });

  // Plan §9 row Q: the fallback hands turndown the whole body, and turndown
  // keeps the text of elements it has no rule for, so code and styles would
  // reach the Agent as page text.
  it.each([
    ["script", '<script>window.__STATE__ = {"token":"abc"};</script>'],
    ["style", "<style>.hero { color: red; }</style>"],
    ["noscript", "<noscript>Please enable JavaScript to view this site.</noscript>"],
    ["template", "<template><p>Hidden template row</p></template>"],
  ])("drops %s elements and their contents", (_tag, element) => {
    const markdown = toMarkdown(`<p>Before.</p>${element}<p>After.</p>`);

    expect(markdown).toBe("Before.\n\nAfter.");
  });

  it("drops a script inside an article paragraph", () => {
    expect(toMarkdown("<p>Kept<script>var x = 1;</script> text.</p>")).toBe("Kept text.");
  });
});
