// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { extFromUrl } from "@server/modules/asset/sourceUrl.js";

describe("extFromUrl", () => {
  it("takes the extension off the last path segment", () => {
    expect(extFromUrl("https://cdn.example/a/b/clip.mp4")).toBe(".mp4");
    expect(extFromUrl("https://cdn.example/photo.JPEG")).toBe(".jpeg");
  });

  it("ignores the query string and the fragment", () => {
    // The commonest shape of a real external link is a signed direct URL, and
    // splitting the whole address on "." carries the signature into the key.
    expect(
      extFromUrl("https://cdn.example/clip.mp4?Expires=1757&Signature=abc"),
    ).toBe(".mp4");
    expect(extFromUrl("https://cdn.example/clip.mp4#t=10")).toBe(".mp4");
  });

  it("falls back when the last segment carries no extension", () => {
    expect(extFromUrl("https://cdn.example/clip")).toBe(".bin");
    expect(extFromUrl("https://cdn.example/")).toBe(".bin");
    expect(extFromUrl("https://cdn.example")).toBe(".bin");
    expect(extFromUrl("https://cdn.example/a.b/clip")).toBe(".bin");
  });

  it("falls back rather than let anything but letters and digits through", () => {
    // The extension is spliced into the storage key, which is then used as a
    // path: a separator in it invents a segment, and a query character in it
    // makes the public url point at a key that is not the one R2 holds.
    expect(extFromUrl("https://cdn.example/a.b%2Fc")).toBe(".bin");
    expect(extFromUrl("https://cdn.example/a.mp4%3Fx")).toBe(".bin");
    expect(extFromUrl("https://cdn.example/a.mp 4")).toBe(".bin");
    expect(extFromUrl("https://cdn.example/a.")).toBe(".bin");
  });

  it("falls back on an extension longer than any real one", () => {
    expect(extFromUrl(`https://cdn.example/a.${"x".repeat(11)}`)).toBe(".bin");
    expect(extFromUrl(`https://cdn.example/a.${"x".repeat(10)}`)).toBe(
      `.${"x".repeat(10)}`,
    );
  });

  it("falls back on an address it cannot parse", () => {
    expect(extFromUrl("not a url")).toBe(".bin");
  });
});
