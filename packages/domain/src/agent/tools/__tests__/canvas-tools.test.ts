// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two tools an agent asks before it proposes anything (#261).
 *
 * What these pin is the part a catalog test cannot: that the answer the model
 * reads carries the modes and model names, and that the running turn and a
 * replayed history read the same words.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";

import {
  canvasCapabilities,
  renderCapabilitiesForModel,
  type CanvasCapabilityAnswer,
} from "@domain/agent/tools/canvas-capabilities.js";
import {
  generationModels,
  renderGenerationModelsForModel,
} from "@domain/agent/tools/generation-models.js";
import type { ModelsForMode } from "@domain/model-catalog/mode-catalog.js";
import {
  allProviderKeyNames,
  restoreProcessEnv,
  useEnvWithKeys,
} from "@domain/model-catalog/__tests__/catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
  useEnvWithKeys(allProviderKeyNames());
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * Run a tool the way the SDK does.
 * @param canvasTool - The tool to run.
 * @param input - Its input.
 * @returns Whatever its execute resolved to, as the tool's own answer type.
 */
async function run<T>(canvasTool: unknown, input: unknown): Promise<T> {
  const execute = (canvasTool as { execute: (i: unknown, o: object) => Promise<T> })
    .execute;
  return execute(input, {});
}

describe("get_canvas_capabilities", () => {
  it("answers with the modes each generation node can be set to", async () => {
    const answer = await run<CanvasCapabilityAnswer>(canvasCapabilities, {});
    expect(answer.nodes.length).toBeGreaterThan(0);
    const image = answer.nodes.find((node) => node.nodeType === "image");
    expect(image?.modes.map((mode) => mode.mode)).toContain("t2i");
  });

  it("puts the modes in front of the model, not a note saying it asked", async () => {
    const answer = await run<CanvasCapabilityAnswer>(canvasCapabilities, {});
    const rendered = renderCapabilitiesForModel(answer);
    expect(rendered).toContain("t2i");
    // The block header, not the bare word: "image" also occurs inside every
    // mode label the same answer prints.
    expect(rendered).toContain("image node:");
    // The whole point of the call: the text the model reads has to carry the
    // answer. A rendering that merely acknowledges the question leaves the
    // model with nothing to choose from.
    expect(rendered.length).toBeGreaterThan(200);
  });

  it("names a mode the way its picker names it", async () => {
    // The label is what the reader has to find on screen: the mode code is
    // nowhere in the picker. Two of them were written a second time in the
    // catalog and came out as something no selector shows.
    const rendered = renderCapabilitiesForModel(await run<CanvasCapabilityAnswer>(canvasCapabilities, {}));
    expect(rendered).toContain("(Reference to Music)");
    expect(rendered).toContain("(Talking Head)");
  });

  it("never names a mode the node's picker does not offer", async () => {
    const rendered = renderCapabilitiesForModel(await run<CanvasCapabilityAnswer>(canvasCapabilities, {}));
    for (const miniToolMode of ["upscale", "remove_bg", "extend", "interpolate"]) {
      expect(rendered, `${miniToolMode} is a mini-tool mode`).not.toContain(miniToolMode);
    }
  });
});

describe("list_generation_models", () => {
  it("answers with the models behind one mode", async () => {
    const answer = await run<ModelsForMode>(generationModels, {
      nodeType: "image",
      mode: "t2i",
    });
    expect(answer.available).toBe(true);
    if (!answer.available) return;
    expect(answer.models.length).toBeGreaterThan(0);
  });

  it("puts the model names and parameters in front of the model", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "image", mode: "t2i" });
    const rendered = renderGenerationModelsForModel(answer);
    if (!answer.available) throw new Error("t2i has models");
    for (const model of answer.models) expect(rendered).toContain(model.name);
    expect(rendered.length).toBeGreaterThan(200);
  });

  it("says what the node does offer when asked for a mode it does not", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "image", mode: "upscale" });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).toContain("t2i");
  });

  it("refuses a node type that anchors no generate panel", async () => {
    const parsed = (
      canvasToolInput(generationModels) as {
        safeParse: (input: unknown) => { success: boolean };
      }
    ).safeParse({ nodeType: "text", mode: "t2i" });
    expect(parsed.success).toBe(false);
  });

  it("refuses an input carrying anything else", async () => {
    const parsed = (
      canvasToolInput(generationModels) as {
        safeParse: (input: unknown) => { success: boolean };
      }
    ).safeParse({ nodeType: "image", mode: "t2i", model: "sneaked-in" });
    expect(parsed.success).toBe(false);
  });
});

describe("what the rendered answer tells the model", () => {
  it("prices a usage-billed model by its rate", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "sfx" });
    const rendered = renderGenerationModelsForModel(answer);
    // The flat number on these is the balance floor, not the price.
    expect(rendered).toMatch(/per \d+ seconds/);
  });

  it("says when a model takes no prompt", async () => {
    const answer = await run<ModelsForMode>(generationModels, {
      nodeType: "video",
      mode: "talking_head",
    });
    expect(renderGenerationModelsForModel(answer).toLowerCase()).toContain("no prompt");
  });

  it("names a parameter's declared type", async () => {
    // Stated on the slot's own line: every param the catalog gives a type to
    // is a slot, so a type clause reserved for settable fields renders never.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "image", mode: "i2i" });
    expect(renderGenerationModelsForModel(answer)).toMatch(/images:[^\n]*a list/);
  });

  it("says a voice parameter's values come from elsewhere", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "tts" });
    const rendered = renderGenerationModelsForModel(answer);
    // Asserted on the parameter's own line: the word "voices" also appears in
    // one model's prose, so a bare substring passes with the branch deleted.
    expect(rendered).toMatch(/voice_id:[^\n]*not free text/);
  });

  it("lists what the picker lists for a range it walks", async () => {
    // The picker walks an unstepped range one whole step at a time, so the
    // two ends alone would have a reader ask for a value in between.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "t2v" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /duration: one of 3 \| 4 \| 5[^\n]*\| 15;/,
    );
  });

  it("states a stepped range by its bounds and step", async () => {
    // A slider, where the ends and the step say more than walking it would.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "tts" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /stability: 0 to 1 in steps of 0.05;/,
    );
  });

  it("says a control the panel mounts on a slot waits for that slot", async () => {
    // The switch describes the reference clip's audio, so the panel mounts it
    // only once a clip is picked -- and this mode runs without one. Stated as
    // a plain settable field, a reader is told to set a switch that is not
    // on screen.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "ref" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /keep_original_sound:[^\n]*once video is filled/,
    );
  });

  it("says a control the panel drops on a switch waits for that switch", async () => {
    // The lyrics box is gone while the track is marked instrumental, so a
    // reader told to write words has nowhere to write them.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "t2m" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /lyrics:[^\n]*while is_instrumental is on/,
    );
  });

  it("says a value the run drops applies only while its switch is on", async () => {
    // The four camera controls are drawn whatever the switch says, and the run
    // throws their values away while it is off -- so the default this states
    // is not what the run takes.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "image", mode: "t2i" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /camera:[^\n]*only while enable_camera is on/,
    );
  });

  it("says a voice has to be picked rather than quoting a default", async () => {
    // The panel refuses the submit until one is chosen, so the yaml default is
    // never what the run takes -- and it is a vendor id nobody can read.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "tts" });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).toMatch(/voice_id:[^\n]*pick one in the panel/);
    expect(rendered, "the raw vendor id says nothing to a reader").not.toContain(
      "Xb7hH8MSUJpSbSDYk0k2",
    );
  });

  it("leaves a gate off a mode whose model has no such switch", async () => {
    // Reference-to-music takes lyrics on every run: the model behind it
    // declares no instrumental switch, so a clause about one sends the reader
    // looking for a control the panel never draws.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "a2m" });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).toMatch(/lyrics:/);
    expect(rendered, "no switch takes the lyrics box away here").not.toMatch(
      /lyrics:[^\n]*is_instrumental/,
    );
  });

  it("names the other modes of this node a model also serves", async () => {
    // What a model is good at is written once for the whole entry, so an
    // entry serving two modes says things about the other one. Naming that
    // mode is what lets a reader place the sentence it belongs to.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "i2v" });
    expect(renderGenerationModelsForModel(answer)).toMatch(/also serves first_last/i);
  });

  it("states a switch's two values like every other switch", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "t2m" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /is_instrumental: one of true \| false;/,
    );
  });

  it("says when the panel draws no control for a parameter", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "t2v" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /seed: this panel draws no control for it; the run takes/,
    );
  });

  it("names the model the way the picker names it", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "image", mode: "t2i" });
    const rendered = renderGenerationModelsForModel(answer);
    if (!answer.available) throw new Error("t2i has models");
    // Asserted on the head line rather than as a substring: a display name
    // also turns up inside its own model's prose, so `toContain` passes with
    // the head rendering the id alone.
    const heads = rendered.split("\n").filter((line) => line.startsWith("- "));
    for (const model of answer.models) {
      const opening = `- ${model.displayName} (${model.name}) (`;
      expect(
        heads.some((line) => line.startsWith(opening)),
        `${model.name} is named the way the picker names it`,
      ).toBe(true);
    }
  });

  it("marks the parameters a wired node fills", async () => {
    const answer = await run<ModelsForMode>(generationModels, {
      nodeType: "video",
      mode: "talking_head",
    });
    const rendered = renderGenerationModelsForModel(answer);
    // Rendered like any other field, an agent told it may set what it is shown
    // puts a URL here -- and the node takes it from the wiring instead.
    expect(rendered).toMatch(/image:[^\n]*another node on the canvas/);
  });

  it("states how much prompt a capped model takes", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "audio", mode: "tts" });
    expect(renderGenerationModelsForModel(answer)).toMatch(/5000 characters/);
  });

  it("states a list cap whatever else the parameter declares", async () => {
    // The cap belongs to the parameter, not to one of the shapes it can take:
    // a reference list states both its type and how many it holds.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "ref" });
    expect(renderGenerationModelsForModel(answer)).toMatch(/images:[^\n]*at most 7/);
  });

  it("states a cap that tightens when another slot is filled", async () => {
    // The reference list takes fewer when a reference video is picked, and
    // both the panel and the server enforce the tighter number.
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "ref" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /images:[^\n]*at most 7[^\n]*4 when video is set/,
    );
  });

  it("says a source slot is filled from the canvas rather than by wiring", async () => {
    // Drawing an edge fills none of these: a slot is picked by clicking a
    // node, and following an instruction to wire one leaves the slot empty.
    const answer = await run<ModelsForMode>(generationModels, {
      nodeType: "video",
      mode: "talking_head",
    });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).not.toContain("wired into this one");
    expect(rendered).toMatch(/image:[^\n]*another node on the canvas/);
  });

  it("marks an optional source slot the same as a required one", async () => {
    const answer = await run<ModelsForMode>(generationModels, { nodeType: "video", mode: "ref" });
    expect(renderGenerationModelsForModel(answer)).toMatch(
      /video:[^\n]*another node on the canvas/,
    );
  });
});

describe("what the running turn reads", () => {
  it.each([
    [
      "get_canvas_capabilities",
      canvasCapabilities,
      {},
      async (): Promise<string> =>
        renderCapabilitiesForModel(await run<CanvasCapabilityAnswer>(canvasCapabilities, {})),
    ],
    [
      "list_generation_models",
      generationModels,
      { nodeType: "image", mode: "t2i" },
      async (): Promise<string> =>
        renderGenerationModelsForModel(
          await run<ModelsForMode>(generationModels, { nodeType: "image", mode: "t2i" }),
        ),
    ],
  ])(
    "%s converts its answer to the same text the history replays",
    async (_name, canvasTool, input, renderedText) => {
      const answer = await run<unknown>(canvasTool, input);
      const convert = (
        canvasTool as {
          toModelOutput?: (arg: { output: unknown }) => { type: string; value: string };
        }
      ).toModelOutput;
      // Without this the SDK stringifies the payload, so the running turn and
      // a replayed history read different things -- and this is the hook the
      // running turn goes through, not a replay hook.
      expect(convert, "the tool declares toModelOutput").toBeTypeOf("function");
      const converted = convert?.({ output: answer });
      expect(converted?.type).toBe("text");
      expect(converted?.value).toBe(await renderedText());
    },
  );
});

/**
 * A tool's declared input schema.
 * @param tool - The tool to read.
 * @returns Its `inputSchema`.
 */
function canvasToolInput(tool: unknown): unknown {
  return (tool as { inputSchema: unknown }).inputSchema;
}
