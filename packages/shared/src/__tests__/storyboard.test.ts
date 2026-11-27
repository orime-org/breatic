// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Multi-shot inside the video modes (inner#2192): which models take shots in
 * which mode, how many, which Shots choice a node is on, and what a run sends.
 */

import { describe, it, expect } from "vitest";
import { paramsForMode } from "@shared/param-modes.js";
import {
  effectiveShots,
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
    modes: ["t2v"],
    fill: "storyboard",
    fields: { prompt: { type: "text", max_chars: 512 }, duration: { values: [1, 2, 3] } },
  },
  shot_type: { description: "", default: null, values: ["customize"], modes: ["t2v"], fill: "storyboard" },
  auto_shots: {
    description: "",
    default: false,
    values: [true, false],
    modes: ["t2v"],
    fill: "panel",
    shots_auto: true,
  },
};
const seedance: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, min: 4, max: 30, fill: "panel" },
  shots: {
    description: "",
    default: null,
    type: "items",
    modes: ["t2v", "ref"],
    fill: "storyboard",
    into_prompt: "Shot {n} [{start}-{end}s]: {prompt}",
    fields: { prompt: { type: "text" }, duration: { values: [1, 2, 3, 4, 5, 6] } },
  },
};
const other: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, values: [5, 10], fill: "panel" },
};

describe("what a model says about its storyboard", () => {
  it("gives Kling's shots, the value it always sends beside them, seconds and its auto switch in the mode it takes shots in", () => {
    expect(storyboardSpec(kling, "t2v")).toEqual({
      shotsParam: "multi_prompt",
      fixed: { shot_type: "customize" },
      secondsField: "duration",
      totalParam: "duration",
      maxShots: 6,
      maxChars: 512,
      intoPrompt: undefined,
      autoParam: "auto_shots",
    });
  });

  it("gives nothing for a model with no shots param", () => {
    expect(storyboardSpec(other, "t2v")).toBeUndefined();
  });

  it("caps a model that declares no shot limit at the mode's six shots", () => {
    expect(MULTI_SHOT_MAX_SHOTS).toBe(6);
    expect(storyboardSpec(seedance, "t2v")?.maxShots).toBe(6);
  });

  it("keeps a model's own limit when it is below the mode's", () => {
    const tight = { ...kling, multi_prompt: { ...kling.multi_prompt!, max_items: 4 } };
    expect(storyboardSpec(tight, "t2v")?.maxShots).toBe(4);
  });

  it("carries the prompt template of a model that takes its shots in the prompt", () => {
    expect(storyboardSpec(seedance, "t2v")).toMatchObject({
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
    expect(storyboardSend(storyboardSpec(kling, "t2v")!, shots)).toEqual({
      params: {
        shot_type: "customize",
        auto_shots: false,
        multi_prompt: [
          { prompt: "a paper boat", duration: 2 },
          { prompt: "the pond at dusk", duration: 3 },
        ],
      },
      prompt: undefined,
    });
  });

  it("turns the model's own shot planning off, since both name the same upstream field", () => {
    const sent = storyboardSend(storyboardSpec(kling, "t2v")!, shots);
    expect(sent.params.auto_shots).toBe(false);
  });

  it("writes the shots into one prompt with their running seconds for a prompt-only model", () => {
    expect(storyboardSend(storyboardSpec(seedance, "t2v")!, shots)).toEqual({
      params: {},
      prompt: "Shot 1 [0-2s]: a paper boat\nShot 2 [2-5s]: the pond at dusk",
    });
  });
});

describe("the words a shot carries into the prompt", () => {
  it("are written as typed, whatever dollar signs they hold", () => {
    const spec = storyboardSpec(seedance, "t2v")!;
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
    expect(paramsForMode(stored, kling, "i2v")).toEqual({ duration: 5 });
  });

  it("keeps a param declared for the current mode and one that names no modes", () => {
    const stored = { duration: 5, auto_shots: true };
    expect(paramsForMode(stored, kling, "t2v")).toEqual({ duration: 5, auto_shots: true });
  });

  it("keeps a stored value the model no longer declares untouched", () => {
    expect(paramsForMode({ seed: 7 }, kling, "t2v")).toEqual({ seed: 7 });
  });
});

describe("which modes a model takes shots in", () => {
  it("gives a spec in each mode its shots param names, and none elsewhere", () => {
    expect(storyboardSpec(seedance, "t2v")).toBeDefined();
    expect(storyboardSpec(seedance, "ref")).toBeDefined();
    expect(storyboardSpec(seedance, "i2v")).toBeUndefined();
    expect(storyboardSpec(kling, "i2v")).toBeUndefined();
  });

  it("names the model's own auto switch only where it declares shots_auto", () => {
    expect(storyboardSpec(kling, "t2v")?.autoParam).toBe("auto_shots");
    expect(storyboardSpec(seedance, "t2v")?.autoParam).toBeUndefined();
    const unmarked = { ...kling, auto_shots: { ...kling.auto_shots!, shots_auto: undefined } };
    expect(storyboardSpec(unmarked, "t2v")?.autoParam).toBeUndefined();
  });
});

describe("the Shots choice a node is on", () => {
  const klingSpec = storyboardSpec(kling, "t2v");
  const seedanceSpec = storyboardSpec(seedance, "t2v");

  it("is single shot where the model takes no shots, whatever the node holds", () => {
    expect(effectiveShots(undefined, true, { auto_shots: true })).toBe("single");
  });

  it("is multi-shot when the node has it on", () => {
    expect(effectiveShots(seedanceSpec, true, {})).toBe("multi");
    expect(effectiveShots(klingSpec, true, { auto_shots: true })).toBe("multi");
  });

  it("is auto when the model's own switch is on and multi-shot is off", () => {
    expect(effectiveShots(klingSpec, undefined, { auto_shots: true })).toBe("auto");
    expect(effectiveShots(klingSpec, false, { auto_shots: true })).toBe("auto");
  });

  it("is single shot otherwise, and never auto on a model without the switch", () => {
    expect(effectiveShots(klingSpec, undefined, { auto_shots: false })).toBe("single");
    expect(effectiveShots(seedanceSpec, undefined, { auto_shots: true })).toBe("single");
  });
});
