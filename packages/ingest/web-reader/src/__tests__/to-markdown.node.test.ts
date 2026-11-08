// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";

import { pageLinksIn } from "@shared/agent/page-links.js";

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
  // `\(` and `\)`; the link set strips that escape before comparing (design
  // §6.0), so this exact spelling is what the reader hands on.
  it("escapes parentheses inside a link's URL the way turndown 7.2.0 does", () => {
    const html = '<p>See <a href="https://en.wikipedia.org/wiki/Fish_(food)">fish</a>.</p>';

    expect(toMarkdown(html)).toBe("See [fish](https://en.wikipedia.org/wiki/Fish_\\(food\\)).");
  });

  it("writes a parenthesised URL so that pageLinksIn recovers it unescaped", () => {
    const html = '<p>See <a href="https://en.wikipedia.org/wiki/Fish_(food)">fish</a>.</p>';

    expect(pageLinksIn(toMarkdown(html))).toEqual(["https://en.wikipedia.org/wiki/Fish_(food)"]);
  });
});
