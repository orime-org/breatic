// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One table maps a stored object's type to its file extension, for generation results and for mini-tool step objects
 * alike, so the two cannot name one type differently.
 */
import { describe, expect, it } from "vitest";
import { videoPresentationWorkKeyFor } from "@breatic/shared";
import { EXTENSION_OF_TYPE } from "@worker/handlers/extension-of-type.js";
import { stepWorkKey } from "@worker/handlers/mini-tool/prepare-model-input.js";

describe("the extension of a stored type", () => {
  it("names a step object's key with the same extension a generation result gets", () => {
    for (const [type, extension] of Object.entries(EXTENSION_OF_TYPE)) {
      expect(stepWorkKey("source.mp4", "job", type)).toBe(`${videoPresentationWorkKeyFor("source.mp4", "job")}${extension}`);
    }
  });

  it("covers the text a lip-sync step writes", () => {
    expect(EXTENSION_OF_TYPE["text/plain"]).toBe(".txt");
  });
});
