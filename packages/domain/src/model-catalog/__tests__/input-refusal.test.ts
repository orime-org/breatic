// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * #1521: the application asks provider why no upstream takes a run, with the run laid out the way it is priced and
 * sent, so a refusal names the limit before anything is held. These read the real config files.
 */

import { afterAll, describe, expect, it } from "vitest";

import { inputRefusalFor } from "../model-catalog.js";
import { restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

afterAll(() => {
  restoreProcessEnv();
});

const GEMINI = "gemini-3.8-flash-text-to-speech";
const PAIR = [{ speaker: "Ava", voice: "Kore" }, { speaker: "Leo", voice: "Puck" }];

describe("inputRefusalFor", () => {
  it("names WaveSpeed's 8000 characters for a single voice past them, and refuses nothing at them", async () => {
    useEnvWithKeys(["WAVESPEED_API_KEY"]);
    expect(await inputRefusalFor(GEMINI, { params: { voice_id: "Kore" }, prompt: "x".repeat(8001) })).toMatchObject({
      limit: { field: "prompt", measure: "characters", max: 8000 },
    });
    expect(await inputRefusalFor(GEMINI, { params: { voice_id: "Kore" }, prompt: "x".repeat(8000) })).toBeNull();
  });

  it("names the 100 lines for a longer dialogue", async () => {
    useEnvWithKeys(["WAVESPEED_API_KEY"]);
    const script = Array.from({ length: 101 }, (_, i) => `${i % 2 === 0 ? "Ava" : "Leo"}: line ${i}.`).join("\n");
    expect(await inputRefusalFor(GEMINI, { params: { speakers: PAIR, _stand_in_on: true }, prompt: script })).toMatchObject({
      limit: { field: "prompt", measure: "lines", max: 100 },
    });
  });

  it("refuses nothing for a model it does not know, or one with no key here", async () => {
    useEnvWithKeys(["WAVESPEED_API_KEY"]);
    expect(await inputRefusalFor("no-such-model", { params: {}, prompt: "x" })).toBeNull();
    useEnvWithKeys([]);
    expect(await inputRefusalFor(GEMINI, { params: {}, prompt: "x".repeat(9000) })).toBeNull();
  });
});
