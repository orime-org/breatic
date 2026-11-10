// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Plan §9 row R: what the rendered page hands back is whatever its scripts
 * left behind (a page can replace `document.title`, and Readability's fields
 * can be null), so the Node side reads it as untrusted and turns anything but
 * a string into the empty string.
 */

import { describe, expect, it } from "vitest";

import { articleOf } from "../article.js";

describe("articleOf", () => {
  it("keeps a string title and html", () => {
    expect(articleOf({ title: "Harbour notes", html: "<p>Body</p>" })).toEqual({ title: "Harbour notes", html: "<p>Body</p>" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { text: "x" }],
    ["an array", ["a"]],
    ["a boolean", true],
  ])("reads a title or html that is %s as the empty string", (_label, value) => {
    expect(articleOf({ title: value, html: "<p>Body</p>" })).toEqual({ title: "", html: "<p>Body</p>" });
    expect(articleOf({ title: "T", html: value })).toEqual({ title: "T", html: "" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "<p>x</p>"],
    ["a number", 7],
  ])("reads an evaluation result that is %s as an empty article", (_label, value) => {
    expect(articleOf(value)).toEqual({ title: "", html: "" });
  });
});
