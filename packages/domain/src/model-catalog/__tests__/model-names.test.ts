// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Two models one mode offers under the same name each carry a variant, and
 * the variants differ, or the picker would show two lines it cannot tell
 * apart. The catalog refuses to load otherwise.
 */

import { describe, it, expect } from "vitest";

import { assertNamesTellApart } from "../model-names.js";

describe("the names one mode offers", () => {
  it("stand when each name appears once in a mode", () => {
    expect(() =>
      assertNamesTellApart("video", [
        { name: "a-t2v", display_name: "Model A", mode: "t2v" },
        { name: "a-i2v", display_name: "Model A", mode: "i2v" },
      ]),
    ).not.toThrow();
  });

  it("stand when namesakes in one mode carry different variants", () => {
    expect(() =>
      assertNamesTellApart("video", [
        { name: "a-t2v", display_name: "Model A", variant: "Text-to-Video", mode: ["t2v", "multi_shot"] },
        { name: "a-i2v", display_name: "Model A", variant: "Image-to-Video", mode: ["i2v", "multi_shot"] },
      ]),
    ).not.toThrow();
  });

  it("are refused when namesakes in one mode cannot be told apart", () => {
    expect(() =>
      assertNamesTellApart("video", [
        { name: "a-t2v", display_name: "Model A", mode: ["t2v", "multi_shot"] },
        { name: "a-i2v", display_name: "Model A", variant: "Image-to-Video", mode: ["i2v", "multi_shot"] },
      ]),
    ).toThrow(/config\/models\/video.*multi_shot.*"Model A".*a-t2v, a-i2v/s);
    expect(() =>
      assertNamesTellApart("video", [
        { name: "a-t2v", display_name: "Model A", variant: "Pro", mode: "multi_shot" },
        { name: "a-i2v", display_name: "Model A", variant: "Pro", mode: "multi_shot" },
      ]),
    ).toThrow(/multi_shot/);
  });

  it("fall back to the model's id for an entry with no name, as the catalog does", () => {
    expect(() =>
      assertNamesTellApart("video", [
        { name: "same", mode: "t2v" },
        { name: "other", display_name: "same", mode: "t2v" },
      ]),
    ).toThrow(/"same"/);
  });
});
