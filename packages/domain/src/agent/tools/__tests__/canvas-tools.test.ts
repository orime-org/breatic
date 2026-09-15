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
} from "@domain/agent/tools/canvas-capabilities.js";
import {
  generationModels,
  renderGenerationModelsForModel,
} from "@domain/agent/tools/generation-models.js";
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
 * @param tool - The tool to run.
 * @param input - Its input.
 * @returns Whatever its execute resolved to.
 */
async function run(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute: (i: unknown, o: object) => Promise<unknown> })
    .execute;
  return execute(input, {});
}

describe("get_canvas_capabilities", () => {
  it("answers with the modes each generation node can be set to", async () => {
    const answer = (await run(canvasCapabilities, {})) as {
      nodes: Array<{ nodeType: string; modes: Array<{ mode: string }> }>;
    };
    expect(answer.nodes.length).toBeGreaterThan(0);
    const image = answer.nodes.find((node) => node.nodeType === "image");
    expect(image?.modes.map((mode) => mode.mode)).toContain("t2i");
  });

  it("puts the modes in front of the model, not a note saying it asked", async () => {
    const answer = await run(canvasCapabilities, {});
    const rendered = renderCapabilitiesForModel(answer);
    expect(rendered).toContain("t2i");
    expect(rendered).toContain("image");
    // The whole point of the call: the text the model reads has to carry the
    // answer. A rendering that merely acknowledges the question leaves the
    // model with nothing to choose from.
    expect(rendered.length).toBeGreaterThan(200);
  });

  it("never names a mode the node's picker does not offer", async () => {
    const rendered = renderCapabilitiesForModel(await run(canvasCapabilities, {}));
    for (const miniToolMode of ["upscale", "remove_bg", "extend", "interpolate"]) {
      expect(rendered, `${miniToolMode} is a mini-tool mode`).not.toContain(miniToolMode);
    }
  });
});

describe("list_generation_models", () => {
  it("answers with the models behind one mode", async () => {
    const answer = (await run(generationModels, {
      nodeType: "image",
      mode: "t2i",
    })) as { available: boolean; models: Array<{ name: string }> };
    expect(answer.available).toBe(true);
    expect(answer.models.length).toBeGreaterThan(0);
  });

  it("puts the model names and parameters in front of the model", async () => {
    const answer = await run(generationModels, { nodeType: "image", mode: "t2i" });
    const rendered = renderGenerationModelsForModel(answer);
    const names = (answer as { models: Array<{ name: string }> }).models.map(
      (model) => model.name,
    );
    for (const name of names) expect(rendered).toContain(name);
    expect(rendered.length).toBeGreaterThan(200);
  });

  it("says what the node does offer when asked for a mode it does not", async () => {
    const answer = await run(generationModels, { nodeType: "image", mode: "upscale" });
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
    const answer = await run(generationModels, { nodeType: "audio", mode: "sfx" });
    const rendered = renderGenerationModelsForModel(answer);
    // The flat number on these is the balance floor, not the price.
    expect(rendered).toMatch(/per \d+ seconds/);
  });

  it("says when a model takes no prompt", async () => {
    const answer = await run(generationModels, {
      nodeType: "video",
      mode: "talking_head",
    });
    expect(renderGenerationModelsForModel(answer).toLowerCase()).toContain("no prompt");
  });

  it("names a parameter's declared type", async () => {
    const answer = await run(generationModels, { nodeType: "image", mode: "i2i" });
    expect(renderGenerationModelsForModel(answer)).toContain("list");
  });

  it("says a voice parameter's values come from elsewhere", async () => {
    const answer = await run(generationModels, { nodeType: "audio", mode: "tts" });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).toContain("voices");
  });

  it("marks the parameters a wired node fills", async () => {
    const answer = await run(generationModels, {
      nodeType: "video",
      mode: "talking_head",
    });
    const rendered = renderGenerationModelsForModel(answer);
    // Rendered like any other field, an agent told it may set what it is shown
    // puts a URL here -- and the node takes it from the wiring instead.
    expect(rendered).toMatch(/image:[^\n]*wired/);
  });
});

describe("what the running turn reads", () => {
  it.each([
    ["get_canvas_capabilities", canvasCapabilities, {}, renderCapabilitiesForModel],
    [
      "list_generation_models",
      generationModels,
      { nodeType: "image", mode: "t2i" },
      renderGenerationModelsForModel,
    ],
  ])(
    "%s converts its answer to the same text the history replays",
    async (_name, canvasTool, input, render) => {
      const answer = await run(canvasTool, input);
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
      expect(converted?.value).toBe(render(answer));
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
