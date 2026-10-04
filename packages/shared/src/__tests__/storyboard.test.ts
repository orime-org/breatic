// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The multi-shot mode's storyboard: which models take shots in
 * which mode, how many, and what a run sends for them.
 */

import { describe, it, expect } from "vitest";
import { paramsForMode } from "@shared/param-modes.js";
import {
  MULTI_SHOT_MAX_SHOTS,
  storyboardSend,
  storyboardSpec,
} from "@shared/storyboard.js";
import type { ParamDescriptor } from "@shared/types/model-catalog.js";

const kling: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, values: [3, 4, 5], fill: "panel" },
  multi_prompt: {
    description: "",
    default: null,
    type: "items",
    max_items: 6,
    modes: ["multi_shot"],
    fill: "storyboard",
    fields: { prompt: { type: "text", max_chars: 512 }, duration: { values: [1, 2, 3] } },
  },
  shot_type: { description: "", default: null, values: ["customize"], modes: ["multi_shot"], fill: "storyboard" },
  auto_shots: {
    description: "",
    default: false,
    values: [true, false],
    modes: ["t2v", "i2v"],
    fill: "panel",
    upstream: "shot_type",
    upstream_values: { true: "intelligence" },
  },
};
const seedance: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, min: 4, max: 30, fill: "panel" },
  shots: {
    description: "",
    default: null,
    type: "items",
    modes: ["multi_shot"],
    fill: "storyboard",
    into_prompt: "Shot {n} [{start}-{end}s]: {prompt}",
    fields: { prompt: { type: "text" }, duration: { values: [1, 2, 3, 4, 5, 6] } },
  },
};
const other: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, values: [5, 10], fill: "panel" },
};

describe("what a model says about its storyboard", () => {
  it("gives Kling's shots, the value it always sends beside them and seconds in the multi-shot mode", () => {
    expect(storyboardSpec(kling, "multi_shot")).toEqual({
      shotsParam: "multi_prompt",
      fixed: { shot_type: "customize" },
      secondsField: "duration",
      totalParam: "duration",
      maxShots: 6,
      maxChars: 512,
      intoPrompt: undefined,
    });
  });

  it("gives nothing outside the multi-shot mode, even for a model that takes shots", () => {
    expect(storyboardSpec(kling, "t2v")).toBeUndefined();
    expect(storyboardSpec(seedance, "i2v")).toBeUndefined();
  });

  it("gives nothing for a model with no shots param", () => {
    expect(storyboardSpec(other, "multi_shot")).toBeUndefined();
  });

  it("caps a model that declares no shot limit at the mode's six shots", () => {
    expect(MULTI_SHOT_MAX_SHOTS).toBe(6);
    expect(storyboardSpec(seedance, "multi_shot")?.maxShots).toBe(6);
  });

  it("keeps a model's own limit when it is below the mode's", () => {
    const tight = { ...kling, multi_prompt: { ...kling.multi_prompt!, max_items: 4 } };
    expect(storyboardSpec(tight, "multi_shot")?.maxShots).toBe(4);
  });

  it("carries the prompt template of a model that takes its shots in the prompt", () => {
    expect(storyboardSpec(seedance, "multi_shot")).toMatchObject({
      shotsParam: "shots",
      fixed: {},
      secondsField: "duration",
      totalParam: "duration",
      intoPrompt: "Shot {n} [{start}-{end}s]: {prompt}",
    });
  });
});

describe("what a multi-shot run sends", () => {
  const shots = [
    { prompt: "a paper boat", duration: 2 },
    { prompt: "the pond at dusk", duration: 3 },
  ];

  it("sends Kling its tier and each shot as a field, with no main prompt", () => {
    expect(storyboardSend(storyboardSpec(kling, "multi_shot")!, shots)).toEqual({
      params: {
        shot_type: "customize",
        multi_prompt: [
          { prompt: "a paper boat", duration: 2 },
          { prompt: "the pond at dusk", duration: 3 },
        ],
      },
      prompt: undefined,
    });
  });

  it("writes the shots into one prompt with their running seconds for a prompt-only model", () => {
    expect(storyboardSend(storyboardSpec(seedance, "multi_shot")!, shots)).toEqual({
      params: {},
      prompt: "Shot 1 [0-2s]: a paper boat\nShot 2 [2-5s]: the pond at dusk",
    });
  });
});

describe("the words a shot carries into the prompt", () => {
  it("are written as typed, whatever dollar signs they hold", () => {
    const spec = storyboardSpec(seedance, "multi_shot")!;
    const sent = storyboardSend(spec, [
      { prompt: "a sign reads $$9.99", duration: 2 },
      { prompt: "price tag $& and $` and $'", duration: 3 },
    ]);
    expect(sent.prompt).toBe("Shot 1 [0-2s]: a sign reads $$9.99\nShot 2 [2-5s]: price tag $& and $` and $'");
  });
});

describe("the params a run keeps for its mode", () => {
  it("drops a param whose modes leave out the current mode", () => {
    const stored = { duration: 5, auto_shots: true, multi_prompt: null };
    expect(paramsForMode(stored, kling, "multi_shot")).toEqual({ duration: 5, multi_prompt: null });
  });

  it("keeps a param declared for the current mode and one that names no modes", () => {
    const stored = { duration: 5, auto_shots: true };
    expect(paramsForMode(stored, kling, "t2v")).toEqual({ duration: 5, auto_shots: true });
  });

  it("keeps a stored value the model no longer declares untouched", () => {
    expect(paramsForMode({ seed: 7 }, kling, "t2v")).toEqual({ seed: 7 });
  });
});
