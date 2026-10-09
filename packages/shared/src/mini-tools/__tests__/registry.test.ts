// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import {
  MINI_TOOLS,
  defaultParamsOf,
  miniToolById,
  miniToolEstimateInput,
  miniToolRequestSchema,
  catalogEntryOf,
  miniToolsFor,
  modelOf,
  servedMiniToolsFor,
  toolFilledParams,
  toolParamKeys,
} from "@shared/mini-tools/index.js";

const BATCH_ONE = {
  // The confirmed demo's order: the free and usage-billed edits first, the model tools after.
  image: [
    "image.crop",
    "image.rotate",
    "image.remove-bg",
    "image.upscale",
    "image.digital-human",
    "image.inpaint",
    "image.erase",
    "image.sketch",
  ],
  video: [
    "video.cut",
    "video.crop",
    "video.speed",
    "video.adjust",
    "video.audio-denoise",
    "video.stabilize",
    "video.hdr",
    "video.upscale",
    "video.interpolate",
    "video.extend",
    "video.edit",
    "video.motion",
    "video.animate",
  ],
  audio: ["audio.separate", "audio.extend"],
} as const;

describe("MINI_TOOLS registry", () => {
  it("declares every batch-one tool exactly once", () => {
    const ids = MINI_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [...BATCH_ONE.image, ...BATCH_ONE.video, ...BATCH_ONE.audio].sort(),
    );
  });

  it("gives every tool at least one output and one modality per output list", () => {
    for (const tool of MINI_TOOLS) {
      expect(tool.outputs.length).toBeGreaterThan(0);
    }
  });

  it("splits vocals and instrumental into two outputs", () => {
    const separate = miniToolById("audio.separate");
    expect(separate?.outputs.map((output) => output.namePrefix)).toEqual([
      "VOCALS",
      "INSTRUMENTAL",
    ]);
  });

  it("makes the digital human an image tool whose output is a video", () => {
    const digitalHuman = miniToolById("image.digital-human");
    expect(digitalHuman?.source).toBe("image");
    expect(digitalHuman?.outputs.map((output) => output.modality)).toEqual(["video"]);
    expect(digitalHuman?.slots.map((slot) => [slot.key, slot.accepts])).toEqual([
      ["audio", "audio"],
    ]);
  });

  it("runs crop and rotate in the browser and the seven video operations in a container", () => {
    expect(miniToolById("image.crop")?.run.kind).toBe("browser");
    expect(miniToolById("image.rotate")?.run.kind).toBe("browser");
    const containerIds = MINI_TOOLS.filter((tool) => tool.run.kind === "container").map(
      (tool) => tool.id,
    );
    expect(containerIds.sort()).toEqual(
      [
        "video.crop",
        "video.speed",
        "video.cut",
        "video.adjust",
        "video.audio-denoise",
        "video.stabilize",
        "video.hdr",
      ].sort(),
    );
  });
});

describe("miniToolsFor", () => {
  it("lists a modality's tools in registry order", () => {
    expect(miniToolsFor("image").map((tool) => tool.id)).toEqual(BATCH_ONE.image);
    expect(miniToolsFor("audio").map((tool) => tool.id)).toEqual(BATCH_ONE.audio);
  });

  it("offers nothing for node types that have no tools", () => {
    expect(miniToolsFor("text")).toEqual([]);
    expect(miniToolsFor("3d")).toEqual([]);
    expect(miniToolsFor("web")).toEqual([]);
  });
});

// inner#888 A1: a model tool whose pinned model the catalog does not serve is
// left off the submenu, as the generation panel leaves such models off its list.
describe("servedMiniToolsFor", () => {
  const entry = (name: string) => ({ name }) as never;
  const catalog = {
    image: [entry("pro-upscaler")],
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    total: 1,
    credit_multiplier: 1,
  } as never;

  it("keeps browser tools and the model tools the catalog serves, in order", () => {
    expect(servedMiniToolsFor("image", catalog).map((tool) => tool.id)).toEqual([
      "image.crop",
      "image.rotate",
      "image.upscale",
    ]);
  });

  it("lists no model tools before the catalog has loaded", () => {
    expect(servedMiniToolsFor("image", undefined).map((tool) => tool.id)).toEqual([
      "image.crop",
      "image.rotate",
    ]);
  });

  it("finds a catalog entry by name in any bucket", () => {
    expect(catalogEntryOf(catalog, "pro-upscaler")).toEqual({ name: "pro-upscaler" });
    expect(catalogEntryOf(catalog, "absent")).toBeUndefined();
  });
});

describe("modelOf and toolParamKeys", () => {
  it("pins the upscaler and exposes its own target params", () => {
    const upscale = miniToolById("image.upscale");
    expect(upscale && modelOf(upscale)).toBe("pro-upscaler");
    expect(upscale && toolParamKeys(upscale)).toEqual(["target_megapixels", "creativity"]);
  });

  it("has no model and no model params for a browser tool", () => {
    const crop = miniToolById("image.crop");
    expect(crop && modelOf(crop)).toBeUndefined();
    expect(crop && toolParamKeys(crop)).toEqual([]);
  });
});

describe("defaultParamsOf", () => {
  it("starts rotate with no turn and no flip", () => {
    const rotate = miniToolById("image.rotate");
    expect(rotate && defaultParamsOf(rotate)).toEqual({
      orient: { turns: 0, flipX: false, flipY: false },
    });
  });

  it("starts HDR on PQ", () => {
    const hdr = miniToolById("video.hdr");
    expect(hdr && defaultParamsOf(hdr)).toEqual({ transfer: "pq" });
  });
});

describe("miniToolRequestSchema", () => {
  const base = {
    project_id: "00000000-0000-4000-8000-000000000001",
    space_id: "00000000-0000-4000-8000-000000000002",
    node_ids: ["00000000-0000-4000-8000-000000000003"],
    source: { url: "https://cdn.example.com/a.png" },
    slots: {},
  };

  it("accepts a model tool carrying only its own keys", () => {
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "image.upscale",
      params: { target_megapixels: 4, creativity: 0 },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a model tool carrying a key it does not expose", () => {
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "image.upscale",
      params: { target_megapixels: 4, model: "other-model" },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a browser tool, which never reaches the server", () => {
    const parsed = miniToolRequestSchema.safeParse({ ...base, tool: "image.crop", params: {} });
    expect(parsed.success).toBe(false);
  });

  it("refuses a node count that differs from the tool's outputs", () => {
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "audio.separate",
      source: { url: "https://cdn.example.com/a.mp3" },
      params: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe("miniToolEstimateInput", () => {
  it("puts the source url and its duration under the pinned model's source param", () => {
    const separate = miniToolById("audio.separate");
    const input =
      separate &&
      miniToolEstimateInput(separate, {
        params: {},
        prompt: "",
        source: { url: "https://cdn.example.com/a.mp3", duration: 300 },
        slots: {},
      });
    expect(input?.params.audio).toBe("https://cdn.example.com/a.mp3");
    expect(input?.durations?.audio).toEqual([300]);
    expect(input?.sources).toEqual(["audio"]);
  });

  it("lays draft params first and the source over them", () => {
    const upscale = miniToolById("video.upscale");
    const input =
      upscale &&
      miniToolEstimateInput(upscale, {
        params: { target_resolution: "4k", video: null },
        prompt: "",
        source: { url: "https://cdn.example.com/v.mp4", duration: 12 },
        slots: {},
      });
    expect(input?.params.video).toBe("https://cdn.example.com/v.mp4");
    expect(input?.params.target_resolution).toBe("4k");
  });
});

// inner#1302: the three tools the reader draws on the node for.
describe("drawing tools", () => {
  const SOURCE = "https://cdn.example.com/a.png";
  const COPY = "https://cdn.example.com/upright.png";
  const MASK = "https://cdn.example.com/mask.png";
  const SKETCH = "https://cdn.example.com/sketch.png";

  it("declares a mask for inpaint and erase and a sketch for the sketch tool", () => {
    expect(miniToolById("image.inpaint")?.drawing).toEqual({ kind: "mask", maskParam: "mask_image" });
    expect(miniToolById("image.erase")?.drawing).toEqual({ kind: "mask", maskParam: "mask_image" });
    expect(miniToolById("image.sketch")?.drawing).toEqual({ kind: "sketch" });
  });

  it("asks for a prompt on inpaint and sketch and none on erase", () => {
    expect(miniToolById("image.inpaint")?.prompt).toBeDefined();
    expect(miniToolById("image.sketch")?.prompt).toBeDefined();
    expect(miniToolById("image.erase")?.prompt).toBeUndefined();
  });

  it("marks the sketch tool's source param as a list and no other tool's", () => {
    const lists = MINI_TOOLS.filter((tool) => tool.sourceMany).map((tool) => tool.id);
    expect(lists).toEqual(["image.sketch"]);
  });

  it("names every media param a tool fills, the mask included", () => {
    expect(toolFilledParams(miniToolById("image.inpaint")!)).toEqual(["image", "mask_image"]);
    expect(toolFilledParams(miniToolById("image.sketch")!)).toEqual(["images"]);
    expect(toolFilledParams(miniToolById("image.digital-human")!)).toEqual(["image", "audio"]);
  });

  it("writes a list source param as a list even before anything is drawn", () => {
    const input = miniToolEstimateInput(miniToolById("image.sketch")!, {
      params: {},
      prompt: "a hat",
      source: { url: SOURCE },
      slots: {},
    });
    expect(input.params.images).toEqual([SOURCE]);
    expect(input.sources).toEqual(["images"]);
  });

  it("sends the sketch composite in place of the source", () => {
    const input = miniToolEstimateInput(miniToolById("image.sketch")!, {
      params: {},
      prompt: "a hat",
      source: { url: SOURCE },
      slots: {},
      drawing: { image: SKETCH },
    });
    expect(input.params.images).toEqual([SKETCH]);
  });

  it("sends the upright copy as the image and the mask under the mask param", () => {
    const input = miniToolEstimateInput(miniToolById("image.inpaint")!, {
      params: {},
      prompt: "a bow tie",
      source: { url: SOURCE },
      slots: {},
      drawing: { image: COPY, mask: MASK },
    });
    expect(input.params.image).toBe(COPY);
    expect(input.params.mask_image).toBe(MASK);
    expect(input.sources).toEqual(["image", "mask_image"]);
  });

  describe("request schema", () => {
    const base = {
      project_id: "00000000-0000-4000-8000-000000000001",
      space_id: "00000000-0000-4000-8000-000000000002",
      node_ids: ["00000000-0000-4000-8000-000000000003"],
      source: { url: SOURCE },
      params: {},
      slots: {},
    };

    it("takes a mask tool's run with both drawn images", () => {
      const parsed = miniToolRequestSchema.safeParse({
        ...base,
        tool: "image.erase",
        drawing: { image: COPY, mask: MASK },
      });
      expect(parsed.success).toBe(true);
    });

    it("refuses a mask tool's run without the drawing", () => {
      expect(miniToolRequestSchema.safeParse({ ...base, tool: "image.erase" }).success).toBe(false);
    });

    it("refuses a mask tool's run without the mask", () => {
      const parsed = miniToolRequestSchema.safeParse({ ...base, tool: "image.erase", drawing: { image: COPY } });
      expect(parsed.success).toBe(false);
    });

    it("takes a sketch run with the composite alone", () => {
      const parsed = miniToolRequestSchema.safeParse({
        ...base,
        tool: "image.sketch",
        prompt: "a hat",
        drawing: { image: SKETCH },
      });
      expect(parsed.success).toBe(true);
    });

    it("refuses a drawing on a tool that has none", () => {
      const parsed = miniToolRequestSchema.safeParse({
        ...base,
        tool: "image.upscale",
        params: { target_megapixels: 4, creativity: 0 },
        drawing: { image: COPY },
      });
      expect(parsed.success).toBe(false);
    });
  });
});
