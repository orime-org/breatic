// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The server's text-length gate (inner#1825): a text param a model declares a
 * least length for is refused emptied, before anything is queued.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getModelCatalog, violatesTextLengthForModel } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

const VOICE_DESIGN = "qwen3-tts-voice-design";

describe("violatesTextLengthForModel", () => {
  it("is declared on the voice design's description", () => {
    const entry = getModelCatalog().tts.find((model) => model.name === VOICE_DESIGN);
    expect(entry?.params.voice_description?.min_length).toBe(1);
  });

  it("names an emptied voice description, and lets a written one through", () => {
    expect(violatesTextLengthForModel(VOICE_DESIGN, { voice_description: "  " })).toEqual({ param: "voice_description", min: 1 });
    expect(violatesTextLengthForModel(VOICE_DESIGN, { voice_description: "A warm narrator" })).toBeNull();
  });

  it("asks nothing of a model it does not know", () => {
    expect(violatesTextLengthForModel("no-such-model", { voice_description: "" })).toBeNull();
  });
});
