// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import {
  MINI_TOOLS,
  defaultParamsOf,
  isModelTool,
  miniToolById,
  miniToolEstimateInput,
  miniToolRequestSchema,
  catalogEntryOf,
  miniToolsFor,
  modelOf,
  mostOutputsOf,
  outputsOf,
  servedMiniToolsFor,
  toolFilledParams,
  toolParamKeys,
} from "@shared/mini-tools/index.js";
import { defaultAdjustValue } from "@shared/adjust-value.js";
import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/upload/mini-tool-job.js";
import { UPLOAD_STATUS_MAX_KEYS } from "@shared/upload/upload-status.js";


const BATCH_ONE = {
  // The confirmed demo's order: the free and usage-billed edits first, the model tools after.
  image: [
    "image.quickEdit",
    "image.crop",
    "image.rotate",
    "image.adjust",
    "image.mark",
    "image.grid",
    "image.remove-bg",
    "image.upscale",
    "image.digital-human",
    "image.inpaint",
    "image.erase",
    "image.sketch",
    "image.expand",
    "image.angle",
    "image.relight",
    "image.restyle",
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
      expect(outputsOf(tool, defaultParamsOf(tool)).length).toBeGreaterThan(0);
    }
  });

  it("asks how every upload of one grouped export ended in a single status request", () => {
    for (const tool of MINI_TOOLS.filter((t) => t.groupOutputs === true)) {
      expect(mostOutputsOf(tool), tool.id).toBeLessThanOrEqual(UPLOAD_STATUS_MAX_KEYS);
    }
  });

  it("keeps every container tool within the outputs one ingest job takes", () => {
    for (const tool of MINI_TOOLS.filter((t) => t.run.kind === "container")) {
      expect(mostOutputsOf(tool), tool.id).toBeLessThanOrEqual(MINI_TOOL_JOB_MAX_OUTPUTS);
    }
  });

  it("counts a variable tool only off whole-number params from one and off list params", () => {
    for (const tool of MINI_TOOLS) {
      const count = tool.outputCount;
      if (!count) continue;
      const keys = count.kind === "product" ? count.params : [count.param];
      for (const key of keys) {
        const param = tool.params.find((p) => p.key === key);
        if (count.kind === "product") {
          expect(param && "kind" in param && param.kind === "number" && Number.isInteger(param.step) && param.min >= 1, `${tool.id}.${key}`).toBe(true);
        } else {
          expect(param && "kind" in param && param.kind === "list", `${tool.id}.${key}`).toBe(true);
        }
      }
    }
  });

  it("skips cells only through a cells param", () => {
    for (const tool of MINI_TOOLS) {
      const count = tool.outputCount;
      if (count?.kind !== "product" || count.except === undefined) continue;
      const param = tool.params.find((p) => p.key === count.except);
      expect(param && "kind" in param && param.kind, tool.id).toBe("cells");
    }
  });

  it("lets the grid split skip tiles", () => {
    const grid = miniToolById("image.grid");
    expect(grid?.outputCount).toEqual({ kind: "product", params: ["rows", "cols"], except: "skip" });
  });

  it("adjusts a picture with the same sliders as a video, in the browser", () => {
    const image = miniToolById("image.adjust");
    const video = miniToolById("video.adjust");
    expect(image?.run.kind).toBe("browser");
    expect(image?.params).toEqual(video?.params);
    expect(image && outputsOf(image, {}).map((output) => [output.modality, output.namePrefix])).toEqual([
      ["image", "ADJUST"],
    ]);
  });

  it("marks a picture up in the browser, for people to read", () => {
    const mark = miniToolById("image.mark");
    expect(mark?.run.kind).toBe("browser");
    expect(mark?.markup).toBe(true);
    expect(mark?.params).toEqual([]);
    expect(mark && outputsOf(mark, {}).map((output) => output.namePrefix)).toEqual(["MARK"]);
  });

  it("cuts a grid into rows times columns of tiles inside a group", () => {
    const grid = miniToolById("image.grid");
    expect(grid?.run.kind).toBe("browser");
    expect(grid?.groupOutputs).toBe(true);
    expect(grid?.outputLayout).toBe("grid");
    expect(grid && outputsOf(grid, {}).length).toBe(9);
    expect(grid && outputsOf(grid, { rows: 2, cols: 8 }).map((output) => output.namePrefix)).toEqual(
      Array.from({ length: 16 }, () => "GRID"),
    );
    expect(grid && mostOutputsOf(grid)).toBe(64);
  });

  it("splits vocals and instrumental into two outputs", () => {
    const separate = miniToolById("audio.separate");
    expect(separate && outputsOf(separate, {}).map((output) => output.namePrefix)).toEqual([
      "VOCALS",
      "INSTRUMENTAL",
    ]);
  });

  it("makes the digital human an image tool whose output is a video", () => {
    const digitalHuman = miniToolById("image.digital-human");
    expect(digitalHuman?.source).toBe("image");
    expect(digitalHuman && outputsOf(digitalHuman, {}).map((output) => output.modality)).toEqual(["video"]);
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

  // inner#1304: quick edit leads the picture's list; after it every source lists its edits before its other model tools.
  it("lists quick edit first, then every source's edits before its other model tools", () => {
    expect(MINI_TOOLS.find((tool) => tool.source === "image")?.id).toBe("image.quickEdit");
    for (const source of new Set(MINI_TOOLS.map((tool) => tool.source))) {
      const rest = MINI_TOOLS.filter((tool) => tool.source === source && tool.id !== "image.quickEdit").map(isModelTool);
      const firstModel = rest.indexOf(true);
      expect(firstModel === -1 ? [] : rest.slice(firstModel), source).not.toContain(false);
    }
  });

  it("keeps browser tools and the model tools the catalog serves, in order", () => {
    expect(servedMiniToolsFor("image", catalog).map((tool) => tool.id)).toEqual([
      "image.crop",
      "image.rotate",
      "image.adjust",
      "image.mark",
      "image.grid",
      "image.upscale",
    ]);
  });

  it("lists no model tools before the catalog has loaded", () => {
    expect(servedMiniToolsFor("image", undefined).map((tool) => tool.id)).toEqual([
      "image.crop",
      "image.rotate",
      "image.adjust",
      "image.mark",
      "image.grid",
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

  it("starts the grid split with every tile picked", () => {
    const grid = miniToolById("image.grid");
    expect(grid && defaultParamsOf(grid)).toEqual({ rows: 3, cols: 3, skip: [] });
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

  // Each channel's range is the one the sliders offer (ADJUST_RANGES).
  it("holds each adjust channel to its own range", () => {
    const adjust = (value: Record<string, number>) =>
      miniToolRequestSchema.safeParse({
        ...base,
        tool: "video.adjust",
        source: { url: "https://cdn.example.com/a.mp4" },
        params: { value: { ...defaultAdjustValue, ...value } },
      }).success;
    expect(adjust({ grain: 100, exposure: -100 })).toBe(true);
    expect(adjust({ grain: -50 })).toBe(false);
    expect(adjust({ vignette: -1 })).toBe(false);
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

  it("marks a source param as a list only where the pinned model takes a list of images", () => {
    const lists = MINI_TOOLS.filter((tool) => tool.sourceMany).map((tool) => tool.id);
    expect(lists).toEqual(["image.quickEdit", "image.sketch", "image.angle", "image.relight", "image.restyle"]);
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

  it("sends the node's source as the image and the mask under the mask param", () => {
    const input = miniToolEstimateInput(miniToolById("image.inpaint")!, {
      params: {},
      prompt: "a bow tie",
      source: { url: SOURCE },
      slots: {},
      drawing: { mask: MASK },
    });
    expect(input.params.image).toBe(SOURCE);
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

    it("takes a mask tool's run with the mask alone", () => {
      const parsed = miniToolRequestSchema.safeParse({
        ...base,
        tool: "image.erase",
        drawing: { mask: MASK },
      });
      expect(parsed.success).toBe(true);
    });

    it("refuses a mask tool's run that sends a picture in place of the source", () => {
      const parsed = miniToolRequestSchema.safeParse({
        ...base,
        tool: "image.erase",
        drawing: { image: COPY, mask: MASK },
      });
      expect(parsed.success).toBe(false);
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

// inner#1304: multi-angle, relight, restyle and quick edit.
describe("batch-four tools", () => {
  const SOURCE = "https://cdn.example.com/a.png";
  const base = {
    project_id: "00000000-0000-4000-8000-000000000001",
    space_id: "00000000-0000-4000-8000-000000000002",
    node_ids: ["00000000-0000-4000-8000-000000000003"],
    source: { url: SOURCE, width: 768, height: 1152 },
    slots: {},
  };

  it("pins each tool to its model, prefix and icon, one image out", () => {
    const rows = ["image.angle", "image.relight", "image.restyle", "image.quickEdit"].map((id) => {
      const tool = miniToolById(id)!;
      return [id, modelOf(tool), tool.icon, outputsOf(tool, {}).map((o) => [o.modality, o.namePrefix])];
    });
    expect(rows).toEqual([
      ["image.angle", "qwen-image-edit-multiple-angles", "Rotate3d", [["image", "ANGLE"]]],
      ["image.relight", "nano-banana-2-relight", "Lightbulb", [["image", "RELIGHT"]]],
      ["image.restyle", "gpt-image-2.5-sunburst-edit", "Palette", [["image", "RESTYLE"]]],
      ["image.quickEdit", "nano-banana-2-quick-edit", "SquarePen", [["image", "EDIT"]]],
    ]);
  });

  it("exposes the camera pose on the multi-angle tool, with a prompt that may stay empty", () => {
    const angle = miniToolById("image.angle")!;
    expect(toolParamKeys(angle)).toEqual(["horizontal_angle", "vertical_angle", "distance"]);
    expect(angle.slots).toEqual([]);
    expect(angle.prompt?.defaultText).toBe("");
  });

  it("draws the light direction as one sphere and the colour as swatches, at 2K by default", () => {
    const relight = miniToolById("image.relight")!;
    expect(isModelTool(relight) && relight.params).toEqual([
      { key: "light_azimuth", display: "lightAngle" },
      { key: "light_elevation", display: "lightAngle" },
      { key: "light_color", display: "swatches" },
      { key: "light_color_hex", display: "swatchCustom" },
      { key: "light_intensity" },
      { key: "light_quality" },
      { key: "resolution", default: "2k" },
    ]);
    expect(relight.prompt?.defaultText).toBe("");
    expect(relight.sourceAspectParam).toBe("aspect_ratio");
  });

  it("takes an optional light reference that hides the direction once filled", () => {
    const relight = miniToolById("image.relight")!;
    expect(relight.slots.map((s) => [s.key, s.param, s.accepts, s.many, s.required])).toEqual([
      ["light_reference", "light_reference", "image", false, undefined],
    ]);
    expect(relight.panel).toEqual({
      columns: { left: ["light_azimuth", "light_elevation"] },
      whenSlotFilled: { slot: "light_reference", hide: ["light_azimuth", "light_elevation"] },
    });
  });

  it("requires one to three style pictures and always prefixes the restyle prompt", () => {
    const restyle = miniToolById("image.restyle")!;
    expect(restyle.slots.map((s) => [s.key, s.param, s.many, s.required])).toEqual([
      ["style", "style_images", true, true],
    ]);
    expect(isModelTool(restyle) && restyle.params).toEqual([{ key: "resolution", default: "2k" }, { key: "quality" }]);
    expect(restyle.prompt?.defaultText).toBe("");
    expect(restyle.prompt?.preamble).toMatch(/style references/);
  });

  it("asks quick edit for a prompt it cannot run without", () => {
    const quickEdit = miniToolById("image.quickEdit")!;
    expect(isModelTool(quickEdit) && quickEdit.params).toEqual([{ key: "resolution", default: "2k" }]);
    expect(quickEdit.prompt?.defaultText).toBeUndefined();
    expect(quickEdit.prompt?.preamble).toBeUndefined();
  });

  it("names in a panel layout only the tool's own params and slots", () => {
    for (const tool of MINI_TOOLS) {
      if (tool.panel === undefined) continue;
      const keys = new Set(tool.params.map((p) => p.key));
      for (const key of [...(tool.panel.columns?.left ?? []), ...(tool.panel.whenSlotFilled?.hide ?? [])]) {
        expect(keys.has(key), `${tool.id}.${key}`).toBe(true);
      }
      const slot = tool.panel.whenSlotFilled?.slot;
      if (slot !== undefined) expect(tool.slots.map((s) => s.key), tool.id).toContain(slot);
    }
  });

  it("keeps the server-filled aspect param out of what the reader sends", () => {
    for (const tool of MINI_TOOLS) {
      if (tool.sourceAspectParam === undefined) continue;
      expect(toolParamKeys(tool), tool.id).not.toContain(tool.sourceAspectParam);
    }
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "image.relight",
      params: { light_azimuth: 315, aspect_ratio: "2:3" },
    });
    expect(parsed.success).toBe(false);
  });

  it("takes a relight run with its light settings and a reference picture", () => {
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "image.relight",
      prompt: "",
      params: {
        light_azimuth: 315,
        light_elevation: 30,
        light_color: "warm",
        light_intensity: "auto",
        light_quality: "soft",
        resolution: "2k",
      },
      slots: { light_reference: { url: "https://cdn.example.com/ref.png" } },
    });
    expect(parsed.success).toBe(true);
  });

  it("takes a restyle run with up to its style pictures", () => {
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "image.restyle",
      params: { resolution: "2k", quality: "medium" },
      slots: { style: [{ url: "https://cdn.example.com/s1.png" }, { url: "https://cdn.example.com/s2.png" }] },
    });
    expect(parsed.success).toBe(true);
  });
});
