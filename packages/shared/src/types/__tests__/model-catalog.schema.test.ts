// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  sanitizeModelCatalog,
  isImageGenerationMode,
  requiresSourceImage,
} from "@shared/types/model-catalog.js";
import type { ModelCatalog, ModelEntry } from "@shared/types/model-catalog.js";

/**
 * Builds a well-formed image ModelEntry fixture.
 * @param name - Model id.
 * @param over - Field overrides.
 * @returns A valid ModelEntry (as a plain object, to be fed as untrusted input).
 */
function entry(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    display_name: name.toUpperCase(),
    modality: "image",
    mode: "generate",
    description: "",
    guide: "",
    tier: "optional",
    cost_per_call: 5,
    generation_time: 10,
    params: {
      aspect_ratio: { description: "", values: ["1:1", "16:9"], default: "1:1" },
    },
    providers: [{ name: "p", model_id: "m", priority: 0, available: true }],
    ...over,
  };
}

/**
 * Builds a well-formed catalog wrapping the given image entries.
 * @param image - Image-modality entries (raw plain objects).
 * @returns A catalog-shaped plain object.
 */
function catalog(image: unknown[]): Record<string, unknown> {
  return {
    image,
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: image.length,
  };
}

describe("sanitizeModelCatalog — boundary validation for the model catalog", () => {
  it("passes a well-formed catalog through intact", () => {
    const raw = catalog([entry("flux"), entry("sdxl", { tier: "recommended" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(2);
    expect(out.image[0]?.name).toBe("flux");
    expect(out.image[1]?.tier).toBe("recommended");
    expect(out.image[0]?.params.aspect_ratio?.values).toEqual(["1:1", "16:9"]);
    expect(out.total).toBe(2);
  });

  it("preserves a valid icon name on an entry", () => {
    const raw = catalog([entry("flux", { icon: "nano-banana" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.icon).toBe("nano-banana");
  });

  it("coerces a non-string icon to undefined but keeps the entry", () => {
    const raw = catalog([entry("flux", { icon: 123 })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.icon).toBeUndefined();
  });

  it("leaves icon undefined when the field is absent (icon is optional)", () => {
    const out = sanitizeModelCatalog(catalog([entry("flux")]));
    expect(out.image[0]?.icon).toBeUndefined();
  });

  it("drops an entry whose name is not a string (identity is required)", () => {
    const raw = catalog([entry("good"), entry("x", { name: 123 }), entry("also-good")]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image.map((m) => m.name)).toEqual(["good", "also-good"]);
  });

  it("drops an entry whose name is an empty string", () => {
    const raw = catalog([entry("good"), entry("", { name: "" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image.map((m) => m.name)).toEqual(["good"]);
  });

  it("coerces a non-number cost_per_call to 0 but keeps the entry", () => {
    const raw = catalog([entry("flux", { cost_per_call: "7" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.cost_per_call).toBe(0);
    expect(typeof out.image[0]?.cost_per_call).toBe("number");
  });

  it("coerces a non-object params to an empty object but keeps the entry", () => {
    const raw = catalog([entry("flux", { params: "not-an-object" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.params).toEqual({});
  });

  it("coerces a malformed single descriptor to a safe descriptor (keeps siblings)", () => {
    const raw = catalog([
      entry("flux", {
        params: {
          good: { description: "ok", values: ["a"], default: "a" },
          bad: "i-am-a-string-not-a-descriptor",
        },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    const p = out.image[0]?.params;
    expect(p?.good?.values).toEqual(["a"]);
    // the bad descriptor is coerced to a safe empty descriptor, not dropped or crashing
    expect(p?.bad).toBeDefined();
    expect(p?.bad?.values).toBeUndefined();
  });

  it("coerces a non-array descriptor.values to undefined but keeps the descriptor", () => {
    const raw = catalog([
      entry("flux", {
        params: { aspect_ratio: { description: "", values: "1:1", default: "1:1" } },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.params.aspect_ratio?.values).toBeUndefined();
  });

  it("coerces a non-array modality bucket to an empty array", () => {
    const raw = catalog([]);
    raw.image = "not-an-array";
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toEqual([]);
  });

  it("fills a missing modality bucket with an empty array", () => {
    const raw = catalog([entry("flux")]);
    delete raw.tts;
    const out = sanitizeModelCatalog(raw);
    expect(out.tts).toEqual([]);
    expect(out.image).toHaveLength(1);
  });

  it("coerces a non-number total to 0", () => {
    const raw = catalog([entry("flux")]);
    raw.total = "lots";
    const out = sanitizeModelCatalog(raw);
    expect(out.total).toBe(0);
  });

  it("returns a safe empty catalog when the whole response is not an object", () => {
    for (const garbage of [null, undefined, "string", 42, [], true]) {
      const out = sanitizeModelCatalog(garbage);
      expect(out.image).toEqual([]);
      expect(out.video).toEqual([]);
      expect(out.audio).toEqual([]);
      expect(out.tts).toEqual([]);
      expect(out.three_d).toEqual([]);
      expect(out.understand).toEqual([]);
      expect(out.total).toBe(0);
    }
  });

  it("never throws on arbitrarily nested garbage", () => {
    const raw = {
      image: [{ name: "ok" }, null, 42, "str", { name: {} }, []],
      video: { not: "an-array" },
      total: {},
    };
    expect(() => sanitizeModelCatalog(raw)).not.toThrow();
    const out = sanitizeModelCatalog(raw);
    // only the one entry with a valid string name survives
    expect(out.image.map((m) => m.name)).toEqual(["ok"]);
    expect(out.video).toEqual([]);
  });

  it("guarantees a ModelCatalog-typed result (compile-time contract)", () => {
    const out: ModelCatalog = sanitizeModelCatalog(catalog([entry("flux")]));
    const first: ModelEntry | undefined = out.image[0];
    expect(first?.name).toBe("flux");
  });

  // Adversarial round 1 (2026-07-09): the following edge cases were probed and
  // confirmed safe; locked in as permanent guards because the whole app trusts
  // this boundary — a future change to z.number() or the params transform that
  // reintroduced a non-finite number or a prototype-pollution vector must fail.

  it("coerces a non-finite cost_per_call (NaN / Infinity) to 0 — z.number() rejects non-finite", () => {
    const nan = sanitizeModelCatalog(catalog([entry("a", { cost_per_call: NaN })]));
    expect(nan.image[0]?.cost_per_call).toBe(0);
    const inf = sanitizeModelCatalog(catalog([entry("b", { cost_per_call: Infinity })]));
    expect(inf.image[0]?.cost_per_call).toBe(0);
  });

  it("coerces a non-finite total to 0", () => {
    const raw = catalog([entry("a")]);
    raw.total = NaN;
    expect(sanitizeModelCatalog(raw).total).toBe(0);
  });

  it("classifies image model modes: generation (t2i / i2i) vs pure tools", () => {
    // Generation modes — offerable in the Generate picker + agent plan.
    expect(isImageGenerationMode("t2i")).toBe(true); // text-to-image
    expect(isImageGenerationMode("i2i")).toBe(true); // image-to-image
    expect(isImageGenerationMode(["t2i"])).toBe(true);
    // A multi-mode edit model qualifies via its i2i capability (has i2i).
    expect(isImageGenerationMode(["i2i", "edit"])).toBe(true);
    // `edit` ALONE is not a generation mode — that is mini-tool territory.
    expect(isImageGenerationMode("edit")).toBe(false);
    expect(isImageGenerationMode(["edit"])).toBe(false);
    // Pure utility tools — belong in the mini-tool system, NOT the generate picker.
    expect(isImageGenerationMode("remove_bg")).toBe(false); // background removal
    expect(isImageGenerationMode("upscale")).toBe(false);
    expect(isImageGenerationMode(["upscale"])).toBe(false);
    // Unknown / empty — not generatable.
    expect(isImageGenerationMode("")).toBe(false);
    expect(isImageGenerationMode([])).toBe(false);
    expect(isImageGenerationMode("t2v")).toBe(false); // a video mode, not image
  });

  it("classifies which image modes REQUIRE a source image (i2i / edit)", () => {
    // Modes that consume a source image as input.
    expect(requiresSourceImage("i2i")).toBe(true); // image-to-image
    expect(requiresSourceImage("edit")).toBe(true); // inpaint / edit
    expect(requiresSourceImage(["i2i"])).toBe(true);
    expect(requiresSourceImage(["edit"])).toBe(true);
    // A multi-mode model qualifies if ANY mode needs a source image.
    expect(requiresSourceImage(["i2i", "edit"])).toBe(true);
    expect(requiresSourceImage(["t2i", "edit"])).toBe(true);
    // text-to-image generates from scratch — needs NO source image.
    expect(requiresSourceImage("t2i")).toBe(false);
    expect(requiresSourceImage(["t2i"])).toBe(false);
    // Unknown / empty / other-modality — not a source-image mode.
    expect(requiresSourceImage("")).toBe(false);
    expect(requiresSourceImage([])).toBe(false);
    expect(requiresSourceImage("remove_bg")).toBe(false);
    expect(requiresSourceImage("t2v")).toBe(false);
  });

  it("drops a __proto__ param key without polluting the result prototype", () => {
    // JSON.parse yields a REAL own "__proto__" property (an object literal would
    // instead set the prototype at author time). The sanitizer must neither
    // crash, pollute the prototype, nor drop the legit sibling param.
    const raw = JSON.parse(
      '{"image":[{"name":"flux","display_name":"F","modality":"image","mode":"generate","description":"","guide":"","tier":"optional","cost_per_call":5,"generation_time":10,"params":{"__proto__":{"description":"","values":["x"],"default":"x"},"aspect_ratio":{"description":"","values":["1:1"],"default":"1:1"}},"providers":[]}],"video":[],"audio":[],"tts":[],"three_d":[],"understand":[],"total":1}',
    ) as unknown;
    const out = sanitizeModelCatalog(raw);
    const params = out.image[0]?.params;
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype); // not polluted
    expect(params?.aspect_ratio?.values).toEqual(["1:1"]); // legit sibling kept
  });
});
