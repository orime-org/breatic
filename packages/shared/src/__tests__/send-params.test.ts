// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A run laid out in our param names for provider to send (inner#1743): a joining slot's files travel inside their
 * pool and the prompt names them by neutral reference, a list sends only its whole entries, nothing empty goes, a
 * param another filled one replaces stays behind, and a model whose settings travel in its prompt has them written
 * there. Which upstream field each name becomes is provider's.
 */

import { describe, expect, it } from "vitest";

import { LIGHT_COLORS, LIGHT_QUALITIES, lightDirectionPhrase } from "@shared/index";
import { cameraPrompt, paramsToSend, type SendableModel } from "@shared/send-params";

const EDIT: SendableModel = {
  name: "gpt-edit",
  takes_prompt: true,
  params: {
    images: { fill: "pool", type: "list", default: null, mention: "image {n}" },
    style_images: { fill: "canvas", type: "list", default: null, optional: true, joins: "images", prompt_note: "Style references: {list}." },
    duration: { fill: "panel", default: 5 },
    output_format: { fill: "none", default: "png" },
  },
};

describe("paramsToSend", () => {
  it("sends every param the run carries, under our names, with the prompt as written", () => {
    expect(paramsToSend(EDIT, { images: ["a"], duration: 8, output_format: "png" }, "a pan")).toEqual({
      params: { images: ["a"], duration: 8, output_format: "png" },
      prompt: "a pan",
    });
  });

  it("folds a joining style slot into its pool and names its files by neutral reference", () => {
    expect(paramsToSend(EDIT, { images: ["a", "b"], style_images: ["s1", "s2"] }, "Edit {{ref:images:1}}.")).toEqual({
      params: { images: ["a", "b", "s1", "s2"] },
      prompt: "Edit {{ref:images:1}}. Style references: {{ref:images:3}} and {{ref:images:4}}.",
    });
  });

  it("leaves out a param the run carries nothing for, and one the model does not declare", () => {
    expect(paramsToSend(EDIT, { images: [], duration: 5, output_format: null, stray: 1 }, "x").params).toEqual({ duration: 5 });
  });

  it("sends no prompt to a model that reads none", () => {
    const driven: SendableModel = { name: "driven", takes_prompt: false, params: { image: { fill: "canvas", default: null } } };
    expect(paramsToSend(driven, { image: "i" }, "ignored")).toEqual({ params: { image: "i" }, prompt: "" });
  });

  it("keeps a param off the wire when the one that replaces it is sent", () => {
    const model: SendableModel = {
      name: "frames",
      takes_prompt: true,
      params: { image: { fill: "canvas", default: null }, images: { fill: "pool", type: "list", default: null, replaces: "image" } },
    };
    expect(paramsToSend(model, { image: "a", images: ["b"] }, "").params).toEqual({ images: ["b"] });
    expect(paramsToSend(model, { image: "a", images: [] }, "").params).toEqual({ image: "a" });
  });

  it("sends only the list entries with every field filled, and no list when none is", () => {
    const model: SendableModel = {
      name: "dialogue",
      takes_prompt: true,
      params: { speakers: { fill: "panel", type: "items", default: null, fields: { speaker: {}, voice: { values: ["Kore"] } } } },
    };
    expect(paramsToSend(model, { speakers: [{ speaker: "A", voice: "Kore" }, { speaker: "", voice: "Kore" }] }, "").params).toEqual({
      speakers: [{ speaker: "A", voice: "Kore" }],
    });
    expect(paramsToSend(model, { speakers: [{ speaker: "", voice: "" }] }, "").params).toEqual({});
  });
});

describe("Nano Banana 2's camera", () => {
  const CAMERA = { camera: "ARRI Alexa 35", lens: "Cooke S4/i", focal_length: 85, aperture: "f/4" };
  const NANO: SendableModel = {
    name: "nano-banana-2",
    takes_prompt: true,
    params: {
      resolution: { fill: "panel", default: "1k" },
      enable_camera: { fill: "panel", default: false },
      camera: { fill: "panel", default: null },
      lens: { fill: "panel", default: null },
      focal_length: { fill: "panel", default: null },
      aperture: { fill: "panel", default: null },
    },
  };

  it("keeps all five camera params off the wire and writes the camera into the prompt when it is on", () => {
    const sent = paramsToSend(NANO, { resolution: "2k", enable_camera: true, ...CAMERA }, "a cat");
    expect(sent.params).toEqual({ resolution: "2k" });
    expect(JSON.parse(sent.prompt)).toEqual({
      subject: "a cat",
      technical: { camera: "ARRI Alexa 35", lens: "Cooke S4/i", focal_length: "85mm", aperture: "f/4" },
    });
  });

  it("leaves the camera out when it is off, though its defaults are filled", () => {
    expect(JSON.parse(paramsToSend(NANO, { enable_camera: false, ...CAMERA }, "a cat").prompt)).toEqual({ subject: "a cat" });
  });

  it("names the camera for a rewrite of the prompt, and nothing when it is off", () => {
    expect(cameraPrompt({ enable_camera: true, ...CAMERA })).toBe("ARRI Alexa 35, Cooke S4/i, 85mm, f/4");
    expect(cameraPrompt({ enable_camera: false, ...CAMERA })).toBe("");
  });
});

describe("the relight tool's model", () => {
  const SOURCE = "https://assets.example.com/i/a.png";
  const REFERENCE = "https://assets.example.com/i/ref.png";
  const RELIGHT: SendableModel = {
    name: "nano-banana-2-relight",
    takes_prompt: true,
    params: Object.fromEntries(
      ["images", "light_azimuth", "light_elevation", "light_color", "light_color_hex", "light_intensity", "light_quality", "light_reference", "resolution", "aspect_ratio"].map(
        (name) => [name, { fill: "tool", default: null }],
      ),
    ),
  };
  const MANUAL = {
    images: [SOURCE],
    light_azimuth: 315,
    light_elevation: 30,
    light_color: "warm",
    light_intensity: "auto",
    light_quality: "soft",
    resolution: "2k",
    aspect_ratio: "2:3",
  };
  /**
   * The JSON prompt the run sends.
   * @param params - The run's params.
   * @param prompt - What the user wrote.
   * @returns The parsed prompt.
   */
  const json = (params: Record<string, unknown>, prompt = ""): Record<string, unknown> => JSON.parse(paramsToSend(RELIGHT, params, prompt).prompt) as Record<string, unknown>;

  it("keeps the light settings, the reference and the ratio off the wire without a reference: one image keeps its own shape", () => {
    expect(paramsToSend(RELIGHT, MANUAL, "").params).toEqual({ images: [SOURCE], resolution: "2k" });
  });

  it("writes the manual light into the prompt and leaves Auto fields out", () => {
    const sent = json(MANUAL);
    expect(sent.task).toBe("relight");
    expect(sent.lighting).toEqual({ direction: lightDirectionPhrase(315, 30), color: LIGHT_COLORS.warm!.phrase, quality: LIGHT_QUALITIES.soft! });
    expect(sent).not.toHaveProperty("reference");
    expect(sent).not.toHaveProperty("note");
    expect(sent.preserve).toEqual(expect.arrayContaining(["subject", "background", "composition"]));
  });

  it("takes the direction from a reference, sent second, at the source's ratio", () => {
    const sent = paramsToSend(RELIGHT, { ...MANUAL, light_reference: REFERENCE }, "");
    const prompt = JSON.parse(sent.prompt) as { lighting: Record<string, string>; reference?: string };
    expect(prompt.lighting).not.toHaveProperty("direction");
    expect(prompt.reference).toMatch(/second image/);
    expect(sent.params).toEqual({ images: [SOURCE, REFERENCE], resolution: "2k", aspect_ratio: "2:3" });
  });

  it("sends no ratio with a reference when the source's size was not known", () => {
    expect(paramsToSend(RELIGHT, { ...MANUAL, light_reference: REFERENCE, aspect_ratio: "auto" }, "").params).toEqual({
      images: [SOURCE, REFERENCE],
      resolution: "2k",
    });
  });

  it("leaves the lighting block out when a reference decides everything", () => {
    expect(json({ ...MANUAL, light_color: "auto", light_quality: "auto", light_reference: REFERENCE })).not.toHaveProperty("lighting");
  });

  it("adds what the user wrote as a note", () => {
    expect(json(MANUAL, "  rim light on the hair ").note).toBe("rim light on the hair");
  });

  it("says straight overhead once, whatever the azimuth, and reads an angle off the grid at its nearest step", () => {
    expect((json({ ...MANUAL, light_elevation: 90 }).lighting as Record<string, string>).direction).toBe("from directly above");
    expect((json({ ...MANUAL, light_azimuth: 44, light_elevation: 29 }).lighting as Record<string, string>).direction).toBe(lightDirectionPhrase(45, 30));
  });

  it("takes from the reference only what the user left on Auto, and says the set values win", () => {
    const auto = { ...MANUAL, light_color: "auto", light_quality: "auto", light_reference: REFERENCE };
    const all = json(auto).reference as string;
    expect(all).toMatch(/direction/);
    expect(all).toMatch(/colour/);
    expect(all).toMatch(/shadow/);
    expect(all).not.toMatch(/instead/);
    const red = json({ ...auto, light_color: "red" });
    expect((red.lighting as Record<string, string>).color).toBe(LIGHT_COLORS.red!.phrase);
    expect(red.reference).not.toMatch(/colour/);
    expect(red.reference).toMatch(/instead/);
  });

  it("writes a hand-picked colour as its hex code, and leaves it out when Custom holds none well-formed", () => {
    expect((json({ ...MANUAL, light_color: "custom", light_color_hex: "#8fc0ff" }).lighting as Record<string, string>).color).toBe("#8FC0FF");
    for (const hex of [undefined, "", "#8fc0f", "red"]) {
      expect((json({ ...MANUAL, light_color: "custom", light_color_hex: hex }).lighting as Record<string, string>).color, String(hex)).toBeUndefined();
    }
  });
});
