// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBody } from "../../media/body.js";
import { estimateCost, orderByPrice, rejectedInput, type EstimateInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import { droppedValues, type MediaBinding } from "../schema.js";
import type { SchemaSnapshot } from "../upstream-schema.js";
import { ROOT, catalog, shipped } from "./shipped.js";

/**
 * The reseller each catalog model is bound to and its id there: a model on fal or
 * SandBase only when the same model at the same version and mode is there
 * (rechecked against both full model lists on 2026-11-01, inner#1775).
 */
const RESELLERS: Readonly<Record<string, { fal?: string; sandbase?: string }>> = {
  "mureka-v9.5-generate-song": { fal: "mureka/v9.5/generate/song" },
  "mureka-v9.5-generate-bgm": { fal: "mureka/v9.5/generate/instrumental" },
  "lyria-3-pro-music": { fal: "fal-ai/lyria3/pro" },
  "minimax-music-cover": {},
  "sonilo-video-to-music": {},
  "sfx-1.6-text-to-audio": { fal: "mirelo-ai/sfx1.6/text-to-audio" },
  "sonilo-sfx-v1": {},
  "hunyuan-video-foley": { fal: "fal-ai/hunyuan-video-foley" },
  "vocal-remover": {},
  "veed-clean-audio": { fal: "veed/clean-audio" },
  "sfx-1.6-extend-audio": { fal: "mirelo-ai/sfx1.6/extend-audio" },
  "gpt-image-2.5-sunburst-text-to-image": { fal: "openai/gpt-image-2.5/sunburst/text-to-image", sandbase: "openai/gpt-image-2.5-sunburst" },
  "grok-imagine-image-v2.0-text-to-image": { fal: "xai/grok-imagine-image/v2.0/text-to-image", sandbase: "xai/grok-imagine-image/2.0/text-to-image" },
  "nano-banana-2": { fal: "fal-ai/nano-banana-2", sandbase: "google/nano-banana-2" },
  "nano-banana-2-relight": { fal: "fal-ai/nano-banana-2/edit", sandbase: "google/nano-banana-2/edit" },
  "nano-banana-2-quick-edit": { fal: "fal-ai/nano-banana-2/edit", sandbase: "google/nano-banana-2/edit" },
  "recraft-v4.1-pro-text-to-vector": { fal: "fal-ai/recraft/v4.1/pro/text-to-vector" },
  "riverflow-2.0-pro-text-to-image": {},
  "krea-v2-large-text-to-image": { fal: "krea/v2/large/text-to-image" },
  // fal turns MagicPrompt on or off; WaveSpeed and SandBase leave it to Ideogram's AUTO (inner#1859).
  "ideogram-v3-quality": {},
  "recraft-v4-style-text-to-image": { fal: "recraft/v4/style/text-to-image" },
  "gpt-image-2.5-sunburst-edit": { fal: "openai/gpt-image-2.5/sunburst/edit", sandbase: "openai/gpt-image-2.5-sunburst/edit" },
  "muse-image-edit": { fal: "meta/muse-image/edit" },
  "nano-banana-pro-edit-ultra": {},
  // fal bills it per output megapixel at the source's size, which an estimate cannot know (inner#1859).
  // SandBase runs it on fal's endpoint, whose steps, guidance and LoRA scale WaveSpeed states no counterpart of (inner#1859).
  "qwen-image-edit-multiple-angles": {},
  "pro-upscaler": {},
  "bria-remove-background": { fal: "fal-ai/bria/background/remove" },
  "bria-genfill": {},
  "bria-eraser": { fal: "fal-ai/bria/eraser" },
  // fal offers no output format and its example edit is a PNG, where WaveSpeed returns JPEG (inner#1859).
  "seedream-v4.5-edit": { sandbase: "bytedance/seedream/4.5/edit" },
  "meshy6-t23d": { fal: "fal-ai/meshy/v6/text-to-3d" },
  "hunyuan3d-v3": { fal: "fal-ai/hunyuan3d-v3/text-to-3d" },
  "hunyuan3d-v3-i23d": { fal: "fal-ai/hunyuan3d-v3/image-to-3d", sandbase: "tencent/hunyuan-3d/3.0/image-to-3d" },
  // fal makes this model textured only as OBJ, and our 3D takes GLB.
  "hunyuan3d-v3.1-rapid": {},
  "realtime-tts-2": {},
  "gemini-3.1-flash-text-to-speech": { fal: "fal-ai/gemini-3.1-flash-tts", sandbase: "google/gemini-3.1-flash-tts" },
  "minimax-speech-2.8-hd": { fal: "fal-ai/minimax/speech-2.8-hd", sandbase: "minimax/speech/2.8/hd" },
  "elevenlabs-v3": { fal: "fal-ai/elevenlabs/tts/eleven-v3", sandbase: "elevenlabs/v3" },
  "minimax-voice-clone": { fal: "fal-ai/minimax/voice-clone", sandbase: "minimax/voice-clone" },
  "omnivoice-voice-clone": {},
  "elevenlabs-voice-changer": { fal: "fal-ai/elevenlabs/voice-changer" },
  "gemini-omni-1.1-flash-text-to-video": { fal: "google/gemini-omni-flash/v1.1/text-to-video", sandbase: "google/gemini-omni-flash/1.1/text-to-video" },
  // SandBase has no prompt-expansion field and Alibaba rewrites by default (prompt_extend true); WaveSpeed does not (inner#1859).
  "wan-3.0-text-to-video": { fal: "alibaba/wan-3.0/text-to-video" },
  "seedance-2.5-text-to-video": { fal: "bytedance/seedance-2.5/us/text-to-video", sandbase: "bytedance/seedance/2.5/text-to-video" },
  // fal's minimax/h3 takes 5-15 s, renders 480P/768P natively and expands the prompt: MiniMax-H3-Max, not MiniMax-H3 (inner#1859).
  "minimax-h3-text-to-video": { sandbase: "minimax/h3/text-to-video" },
  // WaveSpeed defaults cfg_scale to 0.5; SandBase has no such field and Kling's docs state none (inner#1859).
  "kling-v3.0-4k-text-to-video": { fal: "fal-ai/kling-video/v3/4k/text-to-video" },
  "gemini-omni-1.1-flash-image-to-video": { fal: "google/gemini-omni-flash/v1.1/image-to-video", sandbase: "google/gemini-omni-flash/1.1/image-to-video" },
  "minimax-h3-image-to-video": { sandbase: "minimax/h3/image-to-video" },
  "wan-3.0-image-to-video": { fal: "alibaba/wan-3.0/image-to-video" },
  "seedance-2.5-image-to-video": { fal: "bytedance/seedance-2.5/us/image-to-video", sandbase: "bytedance/seedance/2.5/image-to-video" },
  "kling-video-o3-4k-image-to-video": { fal: "fal-ai/kling-video/o3/4k/image-to-video", sandbase: "kwaivgi/kling-video/o3/4k/image-to-video" },
  "wan-2.2-animate-2": {},
  "dreamactor-v2": { fal: "fal-ai/bytedance/dreamactor/v2", sandbase: "bytedance/dreamactor/2.0" },
  "minimax-h3-reference-to-video": { sandbase: "minimax/h3/reference-to-video" },
  "gemini-omni-1.1-flash-reference-to-video": { fal: "google/gemini-omni-flash/v1.1/reference-to-video", sandbase: "google/gemini-omni-flash/1.1/reference-to-video" },
  "wan-3.0-reference-to-video": { fal: "alibaba/wan-3.0/reference-to-video" },
  "happyhorse-1.1-reference-to-video": { fal: "alibaba/happy-horse/v1.1/reference-to-video", sandbase: "alibaba/happy-horse/1.1/reference-to-video" },
  "flux-3-start-end-to-video": { fal: "blackforestlabs/flux-3/first-last-frame-to-video" },
  // WaveSpeed returns the source joined to the new segment; fal and SandBase document only the new clip (inner#1859).
  "seedance-2.5-video-extend": {},
  "wan-3.0-video-edit": {},
  "kling-v3-pro-motion": { fal: "fal-ai/kling-video/v3/pro/motion-control", sandbase: "kwaivgi/kling-video/v3/pro/motion-control" },
  "omnihuman-1.5": { fal: "fal-ai/bytedance/omnihuman/v1.5", sandbase: "bytedance/omnihuman/1.5" },
  "seedance-2.5-talking-avatar": {},
  "sync-lipsync-3": { fal: "fal-ai/sync-lipsync/v3", sandbase: "sync/lipsync/3.0/video-to-video" },
  // fal draws its seed from a fixed 42, so the same inputs always give the same video, which WaveSpeed does not.
  "infinitetalk-video-to-video": {},
  "infinitetalk-multi": {},
  "sync-react-1": { fal: "fal-ai/sync-lipsync/react-1" },
  "ltx-2.3-lipsync": {},
  // Both resellers default noise_scale to 0.1, and WaveSpeed states no noise level (inner#1859).
  "seedvr2-video": {},
  "rife-interpolation": { fal: "fal-ai/rife/video" },
};

const config = shipped();
const models = config.media.models;
const catalogModels = new Map(catalog().models.map((m) => [m.name, m]));

/** What a condition names besides params: JSONata's operators and literals, `get_duration` and its keyword args. */
const CONDITION_WORDS = new Set(["and", "or", "not", "in", "true", "false", "null", "get_duration", "min", "max", "total"]);

/** A sample source url. */
const URL_A = "https://a/x.mp4";

/**
 * One model's binding on one upstream.
 * @param model - Our model.
 * @param upstream - The upstream.
 * @returns The binding, if any.
 */
const bindingOf = (model: string, upstream: string): MediaBinding | undefined =>
  models[model]?.upstreams.find((b) => b.upstream === upstream);

/**
 * ElevenLabs' premade voices among a catalog model's voices, each with ElevenLabs' own id:
 * their samples live under `premade/voices/<voice id>/`.
 * @param model - The catalog model.
 * @returns Our voice name and ElevenLabs' id of each.
 */
function premadeVoices(model = "elevenlabs-v3"): { name: string; id: string }[] {
  const voices = (catalog().models.find((m) => m.name === model)?.voices as { id: string; sample_url?: string }[] | undefined) ?? [];
  return voices.flatMap((v) => {
    const id = /\/premade\/voices\/([^/]+)\//.exec(v.sample_url ?? "")?.[1];
    return id === undefined ? [] : [{ name: v.id, id }];
  });
}

describe("the reseller upstreams", () => {
  it("declares fal and SandBase", () => {
    expect(config.upstreams.fal).toEqual({ kind: "fal", base_url: "https://queue.fal.run", billing_url: "https://api.fal.ai/v1", key_env: "FAL_KEY", concurrency: 10 });
    expect(config.upstreams.sandbase).toEqual({ kind: "sandbase", base_url: "https://api.sandbase.ai/v1", key_env: "SANDBASE_API_KEY", concurrency: 10, empty_output_wait_ms: 600_000 });
  });

  it("lists every catalog model", () => {
    expect(Object.keys(RESELLERS).sort()).toEqual(Object.keys(models).sort());
  });

  it.each(Object.entries(RESELLERS))("binds %s on exactly the resellers that serve it, fal at weight 2 and SandBase at 3", (model, expected) => {
    const fal = bindingOf(model, "fal");
    const sandbase = bindingOf(model, "sandbase");
    expect(fal?.model_id).toBe(expected.fal);
    expect(sandbase?.model_id).toBe(expected.sandbase);
    if (fal !== undefined) expect(fal.weight).toBe(2);
    if (sandbase !== undefined) expect(sandbase.weight).toBe(3);
  });
});

describe("the reseller bindings that serve only part of a model, or always send a field", () => {
  it("names Gemini Omni reference videos on WaveSpeed the way its schema says, as on fal and SandBase", () => {
    expect(bindingOf("gemini-omni-1.1-flash-reference-to-video", "wavespeed")?.mentions).toMatchObject({ images: "<IMAGE_REF_{i}>", videos: "<VIDEO_REF_{i}>" });
  });

  it("names HappyHorse 1.1 reference images on SandBase the way SandBase's own docs and example prompt do", () => {
    expect(bindingOf("happyhorse-1.1-reference-to-video", "sandbase")?.mentions).toEqual({ images: "[Image {n}]" });
  });

  it("states the voice-clone preview model drop by what fal's field is", () => {
    expect(String((bindingOf("minimax-voice-clone", "fal")?.drops?.model as { all_values?: string } | undefined)?.all_values)).not.toMatch(/no such field/);
  });

  it("returns sfx-1.6 extend-audio on fal as MP3, as WaveSpeed returned SFX 1.6", () => {
    expect(bindingOf("sfx-1.6-extend-audio", "fal")?.fixed).toMatchObject({ upload_audio_format: "mp3" });
  });

  it("speaks MiniMax Speech 2.8 HD on fal without loudness normalization, as WaveSpeed does", () => {
    expect(bindingOf("minimax-speech-2.8-hd", "fal")?.fixed).toMatchObject({ "normalization_setting.enabled": false });
  });

  it.each([null, ""])("sends fal Kling 3.0 4K an empty negative prompt when the run's is %j, as WaveSpeed applies none", (value) => {
    const fal = bindingOf("kling-v3.0-4k-text-to-video", "fal")!;
    expect(buildBody(fal, { prompt: "a fox", params: { negative_prompt: value } }).negative_prompt).toBe("");
  });

  it("returns a seedream-v4.5 edit on SandBase as JPEG, as WaveSpeed does", () => {
    expect(bindingOf("seedream-v4.5-edit", "sandbase")?.fixed).toMatchObject({ output_format: "jpeg" });
  });

  it("keeps the source's transparency through a Bria erase on fal, as WaveSpeed does", () => {
    expect(bindingOf("bria-eraser", "fal")?.fixed).toMatchObject({ preserve_alpha: true });
  });

  it("returns sfx-1.6 text-to-audio on fal as MP3, as WaveSpeed does", () => {
    expect(bindingOf("sfx-1.6-text-to-audio", "fal")?.fixed).toMatchObject({ upload_audio_format: "mp3" });
  });

  it("loops a short video under the audio on fal, as WaveSpeed does", () => {
    expect(bindingOf("sync-react-1", "fal")?.fixed).toMatchObject({ lipsync_mode: "loop" });
  });

  it.each(["kling-video-o3-4k-image-to-video"])("serves %s on SandBase only as a single shot", (model) => {
    const sandbase = bindingOf(model, "sandbase");
    expect(sandbase?.drops?.multi_prompt).toEqual([]);
    expect(sandbase?.params?.multi_prompt).toBeUndefined();
    expect((sandbase?.rejects ?? []).filter((r) => r.when.includes("multi_prompt"))).toEqual([]);
  });

  it.each(["gpt-image-2.5-sunburst-text-to-image", "gpt-image-2.5-sunburst-edit"])("serves %s on fal only at 1k 1:1, the one preset as large as WaveSpeed's 1k", (model) => {
    const fal = bindingOf(model, "fal");
    // WaveSpeed's 1k is 1024x1024 at 1:1 and 1184x880 at 4:3 (measured); fal's presets are 1024x1024 and 1024x768.
    expect(fal?.params?.aspect_ratio?.supported).toEqual(["1:1"]);
    expect(fal?.drops?.resolution).toMatchObject({ values: ["1k"], equivalent: expect.stringContaining("1024x1024") });
    expect(JSON.stringify(fal?.pricing)).not.toMatch(/16:9|9:16/);
  });

  it("speaks elevenlabs-v3 only in ElevenLabs' premade voices, by ElevenLabs' voice id, on both", () => {
    const premade = premadeVoices();
    expect(premade).toHaveLength(23);
    expect(premade.find((v) => v.name === "Adam")?.id).toBe("pNInz6obpgDQGcFmaJgB");
    for (const upstream of ["fal", "sandbase"]) {
      const binding = bindingOf("elevenlabs-v3", upstream);
      expect(binding?.voice_map?.voice_id).toEqual(Object.fromEntries(premade.map((v) => [v.name, v.id])));
      expect(binding?.drops?.similarity).toHaveProperty("all_values");
    }
  });

  it("changes a voice on fal only into the presets fal names, by name", () => {
    // fal's voice-changer documents these names and no voice ids.
    const presets = ["Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River", "Liam", "Charlotte", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris", "Brian", "Daniel", "Lily", "Bill"];
    const premade = premadeVoices("elevenlabs-voice-changer").map((v) => v.name);
    expect(premade).toEqual(expect.arrayContaining(presets));
    expect(bindingOf("elevenlabs-voice-changer", "fal")?.voice_map?.voice_id).toEqual(Object.fromEntries(presets.map((name) => [name, name])));
  });

  it("clones a MiniMax voice and speaks it in a second step on both", () => {
    const speak = { fal: "fal-ai/minimax/speech-2.8-hd", sandbase: "minimax/speech/2.8/hd" };
    for (const [upstream, endpoint] of Object.entries(speak)) {
      const binding = bindingOf("minimax-voice-clone", upstream);
      expect(binding?.reused_by).toBe("audio");
      expect(binding?.extra_steps?.map((s) => [s.kind, s.endpoint])).toEqual([["speak", endpoint]]);
      expect(binding?.drops?.model).toHaveProperty("all_values");
    }
  });

  it("uploads a reference and a melody and clones a vocal for a Mureka song on fal", () => {
    const steps = bindingOf("mureka-v9.5-generate-song", "fal")?.extra_steps?.map((s) => [s.kind, s.endpoint]);
    expect(steps).toEqual(expect.arrayContaining([
      ["upload_reference", "mureka/api/files/upload"],
      ["upload_melody", "mureka/api/files/upload"],
      ["vocal", "mureka/api/voice/clone"],
    ]));
  });
});

describe("SandBase runs", () => {
  it("asks for an async run wherever the model's snapshot offers one", () => {
    const sync: string[] = [];
    for (const [model, { upstreams }] of Object.entries(models)) {
      const binding = upstreams.find((b) => b.upstream === "sandbase");
      if (binding === undefined) continue;
      const path = resolve(ROOT, "packages/provider/test/fixtures/upstream-schemas/sandbase", `${binding.model_id}.json`);
      const modes = existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot).modes ?? []) : [];
      if (modes.includes("async") && binding.fixed?.mode !== "async") sync.push(model);
    }
    expect(sync).toEqual([]);
  });
});

describe("the WaveSpeed binding a relisted model gets back", () => {
  it("serves meshy6-t23d on WaveSpeed under the id it is listed under again, ahead of fal", () => {
    expect(bindingOf("meshy6-t23d", "wavespeed")).toMatchObject({ model_id: "meshy/v6/text-to-3d", weight: 1 });
  });
});

describe("the limits a reseller states beyond its schema", () => {
  const provider = createProvider({ config: shipped(), keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });

  /**
   * A run as the application prepares it.
   * @param input - What differs from an empty run.
   * @returns The run.
   */
  const run = (input: Partial<EstimateInput>): EstimateInput => ({ params: {}, prompt: "", durations: {}, placeholders: [], durationsMissing: [], ...input });

  /**
   * What an upstream refuses of a run of a model.
   * @param model - The model.
   * @param upstream - The upstream.
   * @param input - The run.
   * @returns What it refuses, if anything.
   */
  const refused = (model: string, upstream: string, input: Partial<EstimateInput>): ReturnType<typeof rejectedInput> => rejectedInput(provider.pricingRules(model), upstream, run(input));

  it.each(["fal", "sandbase"])("keeps a HappyHorse prompt over 2500 characters off %s", async (upstream) => {
    const reference = { images: ["https://a/1.png"] };
    expect(await refused("happyhorse-1.1-reference-to-video", upstream, { prompt: "x".repeat(2500), params: reference })).toBeUndefined();
    expect(await refused("happyhorse-1.1-reference-to-video", upstream, { prompt: "x".repeat(2501), params: reference })).toEqual({ reason: expect.stringContaining("2500") });
  });

  it.each(["fal", "sandbase"])("counts a HappyHorse prompt on %s as it is sent, each reference written the upstream's way", async (upstream) => {
    const reference = { images: ["https://a/1.png"] };
    expect(await refused("happyhorse-1.1-reference-to-video", upstream, { prompt: `${"x".repeat(2490)}<<ref:images:1>>`, params: reference })).toBeUndefined();
  });

  it("prices each GPT Image 2.5 edit reference on fal at fal's figure for a large image", async () => {
    const input = run({ prompt: "make it blue", params: { images: ["https://a/1.png", "https://a/2.png"], aspect_ratio: "1:1", quality: "high" } });
    const estimate = await estimateCost(provider.pricingRules("gpt-image-2.5-sunburst-edit"), provider.availability("gpt-image-2.5-sunburst-edit"), input, { mode: "upstream", upstream: "fal" });
    expect(estimate?.usd).toBeCloseTo(0.05268 + 2 * 0.012 + 0.000005 * (12 / 4), 6);
  });

  describe("GPT Image 2.5 prompt text on fal, at $5.00 per 1M tokens", () => {
    const params = { aspect_ratio: "1:1", quality: "low", resolution: "1k" };
    const onFal = async (prompt: string): Promise<{ usd: number; bound: string } | null> =>
      estimateCost(provider.pricingRules("gpt-image-2.5-sunburst-text-to-image"), provider.availability("gpt-image-2.5-sunburst-text-to-image"), run({ prompt, params }), { mode: "upstream", upstream: "fal" });

    it("counts about four ASCII characters a token", async () => {
      expect((await onFal("x".repeat(400)))?.usd).toBeCloseTo(0.00588 + 0.000005 * 100, 7);
    });

    it("counts each other character a token", async () => {
      expect((await onFal("狐".repeat(1000)))?.usd).toBeCloseTo(0.00588 + 0.000005 * 1000, 7);
    });

    it("prices a run with no prompt yet as at least the image", async () => {
      expect(await onFal("")).toEqual({ usd: 0.00588, bound: "at_least", upstream: "fal" });
    });

    it("ranks WaveSpeed's flat $0.01 ahead of fal once the prompt costs more than the difference", async () => {
      const order = await orderByPrice(provider.pricingRules("gpt-image-2.5-sunburst-text-to-image"), provider.availability("gpt-image-2.5-sunburst-text-to-image"), run({ prompt: "狐".repeat(1000), params }));
      const at = (upstream: string): number => order.findIndex((e) => e.upstream === upstream);
      expect(at("wavespeed")).toBeLessThan(at("fal"));
    });
  });

  // fal states Sync Lipsync 3 per minute of video; whether a longer audio or the output decides it is to be measured (inner#1859).
  it("prices fal Sync Lipsync 3 by the video's length", async () => {
    const input = run({ params: { video: "https://a/v.mp4", audio: "https://a/a.mp3" }, durations: { video: [60], audio: [10] } });
    const estimate = await estimateCost(provider.pricingRules("sync-lipsync-3"), provider.availability("sync-lipsync-3"), input, { mode: "upstream", upstream: "fal" });
    const rule = bindingOf("sync-lipsync-3", "fal")?.pricing as { base_price: number };
    expect(estimate?.usd).toBeCloseTo(rule.base_price / 1_000_000, 6);
  });

  it.each([[[], 5], [[10], 15], [[4, 6], 15]])("prices SandBase MiniMax H3 reference runs by input and output seconds (reference clips %j)", async (clips, seconds) => {
    const videos = clips.map((_, i) => `https://a/${i}.mp4`);
    const input = run({ params: { duration: 5, resolution: "2k", images: ["https://a/1.png"], ...(videos.length === 0 ? {} : { videos }) }, durations: clips.length === 0 ? {} : { videos: clips } });
    const estimate = await estimateCost(provider.pricingRules("minimax-h3-reference-to-video"), provider.availability("minimax-h3-reference-to-video"), input, { mode: "upstream", upstream: "sandbase" });
    expect(estimate).toMatchObject({ bound: "exact" });
    expect(estimate?.usd).toBeCloseTo(seconds * 0.13, 6);
  });

  it.each([[60, 10], [10, 60]])("prices SandBase Sync Lipsync 3 per output second, the shorter input (video %i s, audio %i s)", async (video, audio) => {
    const input = run({ params: { video: "https://a/v.mp4", audio: "https://a/a.mp3" }, durations: { video: [video], audio: [audio] } });
    const estimate = await estimateCost(provider.pricingRules("sync-lipsync-3"), provider.availability("sync-lipsync-3"), input, { mode: "upstream", upstream: "sandbase" });
    expect(estimate?.usd).toBeCloseTo(10 * 0.135, 6);
  });

  it("keeps a GPT Image 2.5 run above 1k off fal, which renders 1024x1024 only", async () => {
    for (const model of ["gpt-image-2.5-sunburst-text-to-image", "gpt-image-2.5-sunburst-edit"]) {
      const params = { aspect_ratio: "1:1", quality: "medium", ...(model.endsWith("edit") ? { images: ["https://a/1.png"] } : {}) };
      expect(await refused(model, "fal", { prompt: "a fox", params: { ...params, resolution: "1k" } })).toBeUndefined();
      expect(await refused(model, "fal", { prompt: "a fox", params: { ...params, resolution: "4k" } })).toEqual({ param: "resolution", value: "4k" });
    }
  });

  it("limits each param a binding drops at listed values to those values", () => {
    const wrong: string[] = [];
    for (const [model, { upstreams }] of Object.entries(models)) {
      const rules = provider.pricingRules(model).upstreams as { upstream: string; limits?: Record<string, unknown[]> }[];
      for (const binding of upstreams) {
        for (const [param, drop] of Object.entries(binding.drops ?? {})) {
          const values = droppedValues(drop);
          if (values === undefined) continue;
          const limit = rules.find((r) => r.upstream === binding.upstream)?.limits?.[param];
          if (JSON.stringify(limit) !== JSON.stringify(values)) wrong.push(`${model} on ${binding.upstream}: ${param} limited to ${JSON.stringify(limit)}, drop lists ${JSON.stringify(values)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  // Each row: model, upstream, a run the upstream's own words refuse beyond the model vendor's, the nearest run it takes, and words of the reason.
  const STATED: [string, string, Partial<EstimateInput>, Partial<EstimateInput>, string][] = [
    ["mureka-v9.5-generate-song", "wavespeed", { prompt: "x".repeat(1025) }, { prompt: "x".repeat(1024) }, "WaveSpeed prompt"],
    ["krea-v2-large-text-to-image", "wavespeed", { prompt: "x".repeat(5001) }, { prompt: "x".repeat(5000) }, "5000"],
    ["minimax-h3-reference-to-video", "wavespeed", { prompt: "a fox", params: { duration: 5, audios: [URL_A] }, durations: { audios: [5] } }, { prompt: "a fox", params: { duration: 5, audios: [URL_A], images: [URL_A] }, durations: { audios: [5] } }, "alone"],
    ["infinitetalk-video-to-video", "wavespeed", { prompt: "talk", params: { audio: URL_A, video: URL_A }, durations: { audio: [601] } }, { prompt: "talk", params: { audio: URL_A, video: URL_A }, durations: { audio: [600] } }, "10 minutes"],
    ["seedvr2-video", "wavespeed", { params: { video: URL_A }, durations: { video: [601] } }, { params: { video: URL_A }, durations: { video: [600] } }, "10 minutes"],
    ["rife-interpolation", "wavespeed", { params: { video: URL_A }, durations: { video: [601] } }, { params: { video: URL_A }, durations: { video: [600] } }, "10 minutes"],
    ["ltx-2.3-lipsync", "wavespeed", { params: { audio: URL_A, image: URL_A }, durations: { audio: [21] } }, { params: { audio: URL_A, image: URL_A }, durations: { audio: [20] } }, "5-20 seconds"],
    ["ltx-2.3-lipsync", "wavespeed", { params: { audio: URL_A, image: URL_A }, durations: { audio: [4] } }, { params: { audio: URL_A, image: URL_A }, durations: { audio: [5] } }, "5-20 seconds"],
    ["wan-3.0-video-edit", "wavespeed", { prompt: "edit", params: { video: URL_A, duration: 16 }, durations: { video: [5] } }, { prompt: "edit", params: { video: URL_A, duration: 15 }, durations: { video: [5] } }, "2-15"],
    ["wan-3.0-reference-to-video", "fal", { prompt: "a fox", params: { duration: 1, videos: [URL_A] }, durations: { videos: [5] } }, { prompt: "a fox", params: { duration: 2, videos: [URL_A] }, durations: { videos: [5] } }, "minimum 2"],
  ];

  it.each(STATED)("keeps a %s run off %s where its own words refuse it, and takes the nearest run it allows", async (model, upstream, refusedRun, takenRun, words) => {
    // Without the model vendor's limits, so the refusal can only be the binding's own.
    const own = { ...provider.pricingRules(model), rejects: [] };
    expect(await rejectedInput(own, upstream, run(refusedRun))).toEqual({ reason: expect.stringContaining(words) });
    expect(await rejectedInput(own, upstream, run(takenRun))).toBeUndefined();
  });

  // Each row: model, a run its vendor's own words refuse, the nearest run the vendor takes, and words of the reason.
  const VENDOR: [string, Partial<EstimateInput>, Partial<EstimateInput>, string][] = [
    ["mureka-v9.5-generate-song", { prompt: "a song", params: { lyrics: "x".repeat(5001) } }, { prompt: "a song", params: { lyrics: "x".repeat(5000) } }, "5000"],
    ["mureka-v9.5-generate-song", { prompt: "a song", params: { lyrics: "la", song: URL_A }, durations: { song: [20] } }, { prompt: "a song", params: { lyrics: "la", song: URL_A }, durations: { song: [30] } }, "[30,30]"],
    ["mureka-v9.5-generate-song", { prompt: "a song", params: { lyrics: "la", vocal: URL_A }, durations: { vocal: [14] } }, { prompt: "a song", params: { lyrics: "la", vocal: URL_A }, durations: { vocal: [15] } }, "[15,30]"],
    // Measured on WaveSpeed (2026-11-07): lyrics, prompt and melody failed; lyrics and melody completed.
    ["mureka-v9.5-generate-song", { prompt: "a song", params: { lyrics: "la", melody: URL_A }, durations: { melody: [10] } }, { params: { lyrics: "la", melody: URL_A }, durations: { melody: [10] } }, "combination"],
    ["mureka-v9.5-generate-bgm", { prompt: "x".repeat(1025) }, { prompt: "x".repeat(1024) }, "1024"],
    ["hunyuan3d-v3", { prompt: "x".repeat(1025) }, { prompt: "x".repeat(1024) }, "1024"],
    ["elevenlabs-voice-changer", { params: { audio: URL_A, voice_id: "Aria" }, durations: { audio: [301] } }, { params: { audio: URL_A, voice_id: "Aria" }, durations: { audio: [300] } }, "300 seconds"],
    ["dreamactor-v2", { params: { image: URL_A, video: URL_A }, durations: { video: [31] } }, { params: { image: URL_A, video: URL_A }, durations: { video: [30] } }, "30 seconds"],
    ["minimax-voice-clone", { prompt: "hi", params: { audio: URL_A }, durations: { audio: [9] } }, { prompt: "hi", params: { audio: URL_A }, durations: { audio: [10] } }, "10 seconds"],
    ["minimax-voice-clone", { prompt: "hi", params: { audio: URL_A }, durations: { audio: [301] } }, { prompt: "hi", params: { audio: URL_A }, durations: { audio: [300] } }, "5 minutes"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 5, audios: [URL_A, URL_A] }, durations: { audios: [16, 15] } }, { prompt: "a fox", params: { duration: 5, audios: [URL_A, URL_A] }, durations: { audios: [15, 15] } }, "30 seconds"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [16, 15] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [15, 15] } }, "30 seconds"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 31 } }, { prompt: "a fox", params: { duration: 30 } }, "[4, 30]"],
    ["gemini-omni-1.1-flash-reference-to-video", { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [3.5] } }, { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [3] } }, "3 seconds"],
    ["wan-3.0-reference-to-video", { prompt: "a fox", params: { duration: 20, videos: [URL_A] }, durations: { videos: [12] } }, { prompt: "a fox", params: { duration: 18, videos: [URL_A] }, durations: { videos: [12] } }, "30 seconds"],
    ["wan-3.0-reference-to-video", { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [8, 8] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [8, 7] } }, "15 seconds"],
    ["wan-3.0-reference-to-video", { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [0.5] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [1] } }, "[1, 15]"],
    ["wan-3.0-reference-to-video", { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A] }, durations: { audios: [16] } }, { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A] }, durations: { audios: [15] } }, "15 seconds"],
    ["kling-v3-pro-motion", { prompt: "dance", params: { image: URL_A, video: URL_A }, durations: { video: [2.9] } }, { prompt: "dance", params: { image: URL_A, video: URL_A }, durations: { video: [3] } }, "3 seconds"],
    ["kling-v3.0-4k-text-to-video", { prompt: "x".repeat(3073), params: { duration: 5 } }, { prompt: "x".repeat(3072), params: { duration: 5 } }, "3072"],
    ["kling-video-o3-4k-image-to-video", { prompt: "x".repeat(3073), params: { duration: 5, image: URL_A } }, { prompt: "x".repeat(3072), params: { duration: 5, image: URL_A } }, "3072"],
    ["recraft-v4.1-pro-text-to-vector", { prompt: "x".repeat(10001) }, { prompt: "x".repeat(10000) }, "10,000"],
    ["sync-react-1", { params: { audio: URL_A, video: URL_A }, durations: { audio: [16], video: [5] } }, { params: { audio: URL_A, video: URL_A }, durations: { audio: [15], video: [5] } }, "15 seconds"],
    ["sync-react-1", { params: { audio: URL_A, video: URL_A }, durations: { audio: [5], video: [16] } }, { params: { audio: URL_A, video: URL_A }, durations: { audio: [5], video: [15] } }, "15 seconds"],
    ["gpt-image-2.5-sunburst-text-to-image", { prompt: "x".repeat(32001) }, { prompt: "x".repeat(32000) }, "32000"],
    ["gpt-image-2.5-sunburst-edit", { prompt: "x".repeat(32001), params: { images: [URL_A], aspect_ratio: "1:1" } }, { prompt: "x".repeat(32000), params: { images: [URL_A], aspect_ratio: "1:1" } }, "32000"],
    ["minimax-h3-reference-to-video", { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A] }, durations: { audios: [1.5] } }, { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A] }, durations: { audios: [2] } }, "[2, 15]"],
    ["minimax-h3-reference-to-video", { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A, URL_A] }, durations: { audios: [8, 8] } }, { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A, URL_A] }, durations: { audios: [8, 7] } }, "15 s"],
    ["minimax-h3-reference-to-video", { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [8, 8] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [8, 7] } }, "15 s"],
    ["minimax-speech-2.8-hd", { prompt: "x".repeat(10001), params: { voice_id: "Wise_Woman" } }, { prompt: "x".repeat(10000), params: { voice_id: "Wise_Woman" } }, "10,000"],
    ["mureka-v9.5-generate-song", { prompt: "x".repeat(1025), params: { lyrics: "la" } }, { prompt: "x".repeat(1024), params: { lyrics: "la" } }, "maximum 1024"],
    ["mureka-v9.5-generate-song", { prompt: "x".repeat(2001) }, { prompt: "x".repeat(2000) }, "maximum 2000"],
    ["mureka-v9.5-generate-song", { params: { lyrics: "la", melody: URL_A }, durations: { melody: [4] } }, { params: { lyrics: "la", melody: URL_A }, durations: { melody: [5] } }, "[5,60]"],
    ["minimax-music-cover", { prompt: "x".repeat(9), params: { audio: URL_A }, durations: { audio: [30] } }, { prompt: "x".repeat(10), params: { audio: URL_A }, durations: { audio: [30] } }, "10-300 characters"],
    ["minimax-music-cover", { prompt: "x".repeat(301), params: { audio: URL_A }, durations: { audio: [30] } }, { prompt: "x".repeat(300), params: { audio: URL_A }, durations: { audio: [30] } }, "10-300 characters"],
    ["minimax-music-cover", { prompt: "a jazz cover", params: { audio: URL_A }, durations: { audio: [5.9] } }, { prompt: "a jazz cover", params: { audio: URL_A }, durations: { audio: [6] } }, "6 seconds to 6 minutes"],
    ["minimax-music-cover", { prompt: "a jazz cover", params: { audio: URL_A }, durations: { audio: [361] } }, { prompt: "a jazz cover", params: { audio: URL_A }, durations: { audio: [360] } }, "6 seconds to 6 minutes"],
    ["sonilo-video-to-music", { params: { video: URL_A }, durations: { video: [361] } }, { params: { video: URL_A }, durations: { video: [360] } }, "6 minutes"],
    ["sonilo-video-to-music", { prompt: "x".repeat(2001), params: { video: URL_A }, durations: { video: [10] } }, { prompt: "x".repeat(2000), params: { video: URL_A }, durations: { video: [10] } }, "maxLength 2000"],
    ["sfx-1.6-text-to-audio", { prompt: "rain", params: { duration: 0.09 } }, { prompt: "rain", params: { duration: 0.1 } }, "100-60000"],
    ["sfx-1.6-text-to-audio", { prompt: "rain", params: { duration: 61 } }, { prompt: "rain", params: { duration: 60 } }, "without loop"],
    ["sfx-1.6-text-to-audio", { prompt: "rain", params: { loop: true, duration: 0.9 } }, { prompt: "rain", params: { loop: true, duration: 1 } }, "1000-600000"],
    ["sfx-1.6-text-to-audio", { prompt: "rain", params: { loop: true, duration: 601 } }, { prompt: "rain", params: { loop: true, duration: 600 } }, "at most 600000"],
    ["sfx-1.6-text-to-audio", { prompt: "x".repeat(5001) }, { prompt: "x".repeat(5000) }, "5000"],
    ["sonilo-sfx-v1", { prompt: "x".repeat(2001) }, { prompt: "x".repeat(2000) }, "maxLength 2000"],
    ["veed-clean-audio", { params: { audio: URL_A }, durations: { audio: [1801] } }, { params: { audio: URL_A }, durations: { audio: [1800] } }, "30 minutes"],
    ["veed-clean-audio", { params: { audio: URL_A, strength: 1.05 }, durations: { audio: [60] } }, { params: { audio: URL_A, strength: 1 }, durations: { audio: [60] } }, "maximum 1"],
    ["sfx-1.6-extend-audio", { prompt: "rain", params: { audio: URL_A }, durations: { audio: [2.9] } }, { prompt: "rain", params: { audio: URL_A }, durations: { audio: [3] } }, "at least 3 seconds"],
    ["sfx-1.6-extend-audio", { prompt: "rain", params: { audio: URL_A, append_duration: 0.9 }, durations: { audio: [5] } }, { prompt: "rain", params: { audio: URL_A, append_duration: 1 }, durations: { audio: [5] } }, "min 1000"],
    ["sfx-1.6-extend-audio", { prompt: "rain", params: { audio: URL_A, append_duration: 58 }, durations: { audio: [5] } }, { prompt: "rain", params: { audio: URL_A, append_duration: 57 }, durations: { audio: [5] } }, "max 57000"],
    ["sfx-1.6-extend-audio", { prompt: "x".repeat(5001), params: { audio: URL_A }, durations: { audio: [5] } }, { prompt: "x".repeat(5000), params: { audio: URL_A }, durations: { audio: [5] } }, "5000"],
    ["recraft-v4-style-text-to-image", { prompt: "x".repeat(10001) }, { prompt: "x".repeat(10000) }, "10,000"],
    ["pro-upscaler", { params: { image: URL_A, creativity: 11 } }, { params: { image: URL_A, creativity: 10 } }, "between -10 and 10"],
    ["pro-upscaler", { params: { image: URL_A, creativity: -11 } }, { params: { image: URL_A, creativity: -10 } }, "between -10 and 10"],
    ["pro-upscaler", { params: { image: URL_A, target_megapixels: 65 } }, { params: { image: URL_A, target_megapixels: 64 } }, "64 MP"],
    ["meshy6-t23d", { prompt: "x".repeat(801) }, { prompt: "x".repeat(800) }, "800 characters"],
    ["meshy6-t23d", { prompt: "a fox", params: { target_polycount: 300001 } }, { prompt: "a fox", params: { target_polycount: 300000 } }, "100 to 300000"],
    ["meshy6-t23d", { prompt: "a fox", params: { target_polycount: 99 } }, { prompt: "a fox", params: { target_polycount: 100 } }, "100 to 300000"],
    ["meshy6-t23d", { prompt: "a fox", params: { target_polycount: 1000.5 } }, { prompt: "a fox", params: { target_polycount: 1000 } }, "integer"],
    ["hunyuan3d-v3", { prompt: "a fox", params: { face_count: 1500001 } }, { prompt: "a fox", params: { face_count: 1500000 } }, "[3000, 1500000]"],
    ["hunyuan3d-v3", { prompt: "a fox", params: { face_count: 2999 } }, { prompt: "a fox", params: { face_count: 3000 } }, "[3000, 1500000]"],
    ["hunyuan3d-v3", { prompt: "a fox", params: { face_count: 3000.5 } }, { prompt: "a fox", params: { face_count: 3000 } }, "Integer"],
    ["hunyuan3d-v3-i23d", { params: { image: URL_A, face_count: 1500001 } }, { params: { image: URL_A, face_count: 1500000 } }, "[3000, 1500000]"],
    ["hunyuan3d-v3-i23d", { params: { image: URL_A, face_count: 3000.5 } }, { params: { image: URL_A, face_count: 3000 } }, "Integer"],
    ["realtime-tts-2", { prompt: "hi", params: { speed: 1.55 } }, { prompt: "hi", params: { speed: 1.5 } }, "[0.5, 1.5]"],
    ["realtime-tts-2", { prompt: "hi", params: { speed: 0.45 } }, { prompt: "hi", params: { speed: 0.5 } }, "[0.5, 1.5]"],
    ["minimax-speech-2.8-hd", { prompt: "hi", params: { voice_id: "Wise_Woman", speed: 2.05 } }, { prompt: "hi", params: { voice_id: "Wise_Woman", speed: 2 } }, "[0.5, 2]"],
    ["minimax-speech-2.8-hd", { prompt: "hi", params: { voice_id: "Wise_Woman", volume: 10.1 } }, { prompt: "hi", params: { voice_id: "Wise_Woman", volume: 10 } }, "(0, 10]"],
    ["minimax-speech-2.8-hd", { prompt: "hi", params: { voice_id: "Wise_Woman", volume: 0 } }, { prompt: "hi", params: { voice_id: "Wise_Woman", volume: 0.1 } }, "(0, 10]"],
    ["elevenlabs-v3", { prompt: "x".repeat(5001), params: { voice_id: "Adam" } }, { prompt: "x".repeat(5000), params: { voice_id: "Adam" } }, "5,000"],
    ["wan-3.0-text-to-video", { prompt: "x".repeat(20001) }, { prompt: "x".repeat(20000) }, "20,000"],
    ["wan-3.0-text-to-video", { prompt: "a fox", params: { duration: 31 } }, { prompt: "a fox", params: { duration: 30 } }, "[2, 30]"],
    ["wan-3.0-text-to-video", { prompt: "a fox", params: { duration: 1 } }, { prompt: "a fox", params: { duration: 2 } }, "[2, 30]"],
    ["wan-3.0-text-to-video", { prompt: "a fox", params: { duration: 5.5 } }, { prompt: "a fox", params: { duration: 5 } }, "an integer"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [1.9] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [2] } }, "2-30 seconds"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 5, audios: [URL_A] }, durations: { audios: [1.9] } }, { prompt: "a fox", params: { duration: 5, audios: [URL_A] }, durations: { audios: [2] } }, "2-30 seconds"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 3 } }, { prompt: "a fox", params: { duration: 4 } }, "[4, 30]"],
    ["seedance-2.5-text-to-video", { prompt: "a fox", params: { duration: 5.5 } }, { prompt: "a fox", params: { duration: 5 } }, "[4, 30]"],
    ["minimax-h3-text-to-video", { prompt: "x".repeat(7001) }, { prompt: "x".repeat(7000) }, "7000"],
    ["kling-v3.0-4k-text-to-video", { prompt: "a fox", params: { duration: 10, multi_prompt: [{ prompt: "a", duration: 5 }, { prompt: "b", duration: 4 }] } }, { prompt: "a fox", params: { duration: 10, multi_prompt: [{ prompt: "a", duration: 5 }, { prompt: "b", duration: 5 }] } }, "equal the total"],
    ["kling-v3.0-4k-text-to-video", { prompt: "a fox", params: { duration: 5, multi_prompt: [{ prompt: "x".repeat(513), duration: 5 }] } }, { prompt: "a fox", params: { duration: 5, multi_prompt: [{ prompt: "x".repeat(512), duration: 5 }] } }, "max 512"],
    ["minimax-h3-image-to-video", { prompt: "x".repeat(7001), params: { image: URL_A } }, { prompt: "x".repeat(7000), params: { image: URL_A } }, "7000"],
    ["wan-3.0-image-to-video", { prompt: "x".repeat(20001), params: { image: URL_A } }, { prompt: "x".repeat(20000), params: { image: URL_A } }, "20,000"],
    ["wan-3.0-image-to-video", { prompt: "a fox", params: { image: URL_A, duration: 31 } }, { prompt: "a fox", params: { image: URL_A, duration: 30 } }, "[2, 30]"],
    ["seedance-2.5-image-to-video", { prompt: "a fox", params: { image: URL_A, duration: 31 } }, { prompt: "a fox", params: { image: URL_A, duration: 30 } }, "[4, 30]"],
    ["kling-video-o3-4k-image-to-video", { prompt: "a fox", params: { image: URL_A, duration: 10, multi_prompt: [{ prompt: "a", duration: 5 }, { prompt: "b", duration: 4 }] } }, { prompt: "a fox", params: { image: URL_A, duration: 10, multi_prompt: [{ prompt: "a", duration: 5 }, { prompt: "b", duration: 5 }] } }, "equal the total"],
    ["kling-video-o3-4k-image-to-video", { prompt: "a fox", params: { image: URL_A, duration: 5, multi_prompt: [{ prompt: "x".repeat(513), duration: 5 }] } }, { prompt: "a fox", params: { image: URL_A, duration: 5, multi_prompt: [{ prompt: "x".repeat(512), duration: 5 }] } }, "max 512"],
    ["minimax-h3-reference-to-video", { prompt: "x".repeat(7001), params: { images: [URL_A] } }, { prompt: "x".repeat(7000), params: { images: [URL_A] } }, "7000"],
    ["minimax-h3-reference-to-video", { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [1.9] } }, { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [2] } }, "[2, 15] s"],
    ["wan-3.0-reference-to-video", { prompt: "x".repeat(20001), params: { images: [URL_A] } }, { prompt: "x".repeat(20000), params: { images: [URL_A] } }, "20,000"],
    ["wan-3.0-reference-to-video", { prompt: "a fox", params: { images: [URL_A], duration: 5.5 } }, { prompt: "a fox", params: { images: [URL_A], duration: 5 } }, "an integer"],
    ["wan-3.0-reference-to-video", { prompt: "a fox", params: { images: [URL_A], audios: [URL_A] }, durations: { audios: [0.9] } }, { prompt: "a fox", params: { images: [URL_A], audios: [URL_A] }, durations: { audios: [1] } }, "[1, 15]"],
    ["happyhorse-1.1-reference-to-video", { prompt: "x".repeat(5001), params: { images: [URL_A] } }, { prompt: "x".repeat(5000), params: { images: [URL_A] } }, "5,000"],
    ["happyhorse-1.1-reference-to-video", { prompt: "狐".repeat(2501), params: { images: [URL_A] } }, { prompt: "狐".repeat(2500), params: { images: [URL_A] } }, "2,500"],
    ["happyhorse-1.1-reference-to-video", { prompt: "a fox", params: { images: [URL_A], duration: 16 } }, { prompt: "a fox", params: { images: [URL_A], duration: 15 } }, "3 to 15"],
    ["happyhorse-1.1-reference-to-video", { prompt: "a fox", params: { images: [URL_A], duration: 2 } }, { prompt: "a fox", params: { images: [URL_A], duration: 3 } }, "3 to 15"],
    ["flux-3-start-end-to-video", { prompt: "a fox", params: { image: URL_A, duration: 21 } }, { prompt: "a fox", params: { image: URL_A, duration: 20 } }, "5 to 20"],
    ["flux-3-start-end-to-video", { prompt: "a fox", params: { image: URL_A, duration: 4 } }, { prompt: "a fox", params: { image: URL_A, duration: 5 } }, "5 to 20"],
    ["seedance-2.5-video-extend", { prompt: "go on", params: { video: URL_A }, durations: { video: [1.9] } }, { prompt: "go on", params: { video: URL_A }, durations: { video: [2] } }, "2-30 seconds"],
    ["seedance-2.5-video-extend", { prompt: "go on", params: { video: URL_A, duration: 31 }, durations: { video: [5] } }, { prompt: "go on", params: { video: URL_A, duration: 30 }, durations: { video: [5] } }, "[4, 30]"],
    ["wan-3.0-video-edit", { prompt: "edit", params: { video: URL_A }, durations: { video: [15.5] } }, { prompt: "edit", params: { video: URL_A }, durations: { video: [15] } }, "total no more than 15 seconds"],
    ["wan-3.0-video-edit", { prompt: "edit", params: { video: URL_A }, durations: { video: [0.9] } }, { prompt: "edit", params: { video: URL_A }, durations: { video: [1] } }, "[1, 15] seconds per clip"],
    ["wan-3.0-video-edit", { prompt: "edit", params: { video: URL_A, duration: 5.5 }, durations: { video: [5] } }, { prompt: "edit", params: { video: URL_A, duration: 5 }, durations: { video: [5] } }, "an integer"],
    ["wan-3.0-video-edit", { prompt: "edit", params: { video: URL_A, duration: 16 }, durations: { video: [15] } }, { prompt: "edit", params: { video: URL_A, duration: 15 }, durations: { video: [15] } }, "must not exceed 30 seconds"],
    ["wan-3.0-video-edit", { prompt: "edit", params: { video: URL_A, reference_audios: [URL_A] }, durations: { video: [5], reference_audios: [15.5] } }, { prompt: "edit", params: { video: URL_A, reference_audios: [URL_A] }, durations: { video: [5], reference_audios: [15] } }, "no more than 15 seconds"],
    ["wan-3.0-video-edit", { prompt: "edit", params: { video: URL_A, reference_audios: [URL_A] }, durations: { video: [5], reference_audios: [0.9] } }, { prompt: "edit", params: { video: URL_A, reference_audios: [URL_A] }, durations: { video: [5], reference_audios: [1] } }, "[1, 15] seconds per clip"],
    ["kling-v3-pro-motion", { prompt: "x".repeat(2501), params: { image: URL_A, video: URL_A }, durations: { video: [5] } }, { prompt: "x".repeat(2500), params: { image: URL_A, video: URL_A }, durations: { video: [5] } }, "2500 characters"],
    ["kling-v3-pro-motion", { prompt: "dance", params: { image: URL_A, video: URL_A, character_orientation: "image" }, durations: { video: [10.5] } }, { prompt: "dance", params: { image: URL_A, video: URL_A, character_orientation: "image" }, durations: { video: [10] } }, "up to 10 s"],
    ["kling-v3-pro-motion", { prompt: "dance", params: { image: URL_A, video: URL_A }, durations: { video: [30.5] } }, { prompt: "dance", params: { image: URL_A, video: URL_A }, durations: { video: [30] } }, "up to 30 s"],
    ["omnihuman-1.5", { params: { image: URL_A, audio: URL_A }, durations: { audio: [60] } }, { params: { image: URL_A, audio: URL_A }, durations: { audio: [59.9] } }, "less than 60 seconds"],
  ];

  // Each entry: a model on an upstream that cannot take a row's param at all, so it refuses the row's runs before any
  // limit is read, keyed "<model> on <upstream>: <param>", with why.
  const SKIPS: Readonly<Record<string, string>> = {
    "seedance-2.5-text-to-video on fal: audios": "fal's text-to-video endpoint takes no reference audio",
    "seedance-2.5-text-to-video on fal: videos": "fal's text-to-video endpoint takes no reference video",
    "seedance-2.5-text-to-video on sandbase: audios": "SandBase's text-to-video endpoint takes no reference audio",
    "seedance-2.5-text-to-video on sandbase: videos": "SandBase's text-to-video endpoint takes no reference video",
    "sfx-1.6-text-to-audio on wavespeed: loop": "WaveSpeed offers no loop control",
    "kling-video-o3-4k-image-to-video on sandbase: multi_prompt": "SandBase serves the model only as a single shot",
  };

  /**
   * A row's run as the application sends it: every param the catalog gives a default at that default, then the row's.
   * @param model - The model.
   * @param input - The row's run.
   * @returns The run.
   */
  const withDefaults = (model: string, input: Partial<EstimateInput>): Partial<EstimateInput> => {
    const params = (catalogModels.get(model)?.params ?? {}) as Record<string, { default?: unknown }>;
    const defaults = Object.fromEntries(Object.entries(params).flatMap(([name, p]) => (p.default === undefined || p.default === null ? [] : [[name, p.default] as const])));
    return { ...input, params: { ...defaults, ...input.params } };
  };

  it.each(VENDOR)("keeps a %s run its vendor's words refuse off every upstream, and lets the nearest run the vendor takes through", async (model, refusedRow, takenRow, words) => {
    const upstreams = (config.media.models[model]?.upstreams ?? []).map((b) => b.upstream);
    expect(upstreams.length).toBeGreaterThan(0);
    for (const upstream of upstreams) {
      const refusal = await refused(model, upstream, withDefaults(model, refusedRow));
      expect(refusal, upstream).toBeDefined();
      if (refusal !== undefined && "param" in refusal) {
        expect(SKIPS[`${model} on ${upstream}: ${refusal.param}`], `${upstream} refuses ${refusal.param}`).toBeDefined();
        continue;
      }
      expect(refusal, upstream).toEqual({ reason: expect.stringContaining(words) });
      // The nearest run the vendor takes: taken, or refused only by a value limit or a reject of the binding itself.
      const taken = await refused(model, upstream, withDefaults(model, takenRow));
      const own = (bindingOf(model, upstream)?.rejects ?? []).map((r) => r.reason);
      expect(taken === undefined || "param" in taken || (taken.evaluationError === undefined && own.includes(taken.reason)), `${upstream}: ${JSON.stringify(taken)}`).toBe(true);
    }
  });

  it("reads in every vendor limit only the model's own params, their item fields and the prompt", () => {
    const strangers: string[] = [];
    for (const [model, { rejects }] of Object.entries(models)) {
      const params = (catalogModels.get(model)?.params ?? {}) as Record<string, { fields?: Record<string, unknown> }>;
      const ours = new Set(["prompt", ...Object.keys(params), ...Object.values(params).flatMap((p) => Object.keys(p.fields ?? {}))]);
      for (const { when } of rejects ?? []) {
        const names = when.replace(/"[^"]*"|\/(?:[^/\\]|\\.)*\//g, "").match(/(?<![$\w.])[A-Za-z_]\w*/g) ?? [];
        strangers.push(...names.filter((name) => !CONDITION_WORDS.has(name) && !ours.has(name)).map((name) => `${model}: "${name}" in ${when}`));
      }
    }
    expect(strangers, strangers.join("\n")).toEqual([]);
  });

  it("exercises every vendor limit: a VENDOR row's run is refused on the model's first upstream that takes its values with exactly its reason", async () => {
    const untested: string[] = [];
    for (const [model, { rejects, upstreams }] of Object.entries(models)) {
      const order = [...upstreams].sort((a, b) => a.weight - b.weight).map((b) => b.upstream);
      const rules = provider.pricingRules(model);
      const rows = VENDOR.filter(([m]) => m === model).map(([, refusedRow]) => run(withDefaults(model, refusedRow)));
      for (const reject of rejects ?? []) {
        // The limit alone, on a binding stripped of its own checks, tells which of two limits sharing a reason holds.
        const alone = { ...rules, rejects: [{ when: reject.when, reason: reject.reason }], upstreams: (rules.upstreams as Record<string, unknown>[]).map((u) => ({ ...u, rejects: [], limits: {}, voices: {} })) };
        let hit = false;
        for (const input of rows) {
          // The first upstream that takes the row's values (SKIPS lists those that do not).
          let [upstream, ...rest] = order;
          let whole = await rejectedInput(rules, upstream!, input);
          while (whole !== undefined && "param" in whole && rest.length > 0) {
            [upstream, ...rest] = rest;
            whole = await rejectedInput(rules, upstream!, input);
          }
          if (JSON.stringify(whole) === JSON.stringify({ reason: reject.reason }) && JSON.stringify(await rejectedInput(alone, upstream!, input)) === JSON.stringify({ reason: reject.reason })) hit = true;
        }
        if (!hit) untested.push(`${model}: ${reject.when}`);
      }
    }
    expect(untested, untested.join("\n")).toEqual([]);
  });

  // Mirelo's /v3/models states max_prompt_chars 5000, and WaveSpeed refused 5001 characters (probed 2026-11-06).
  it.each(["sfx-1.6-text-to-audio", "sfx-1.6-extend-audio"])("caps a %s prompt at Mirelo's 5000 characters on every upstream", (model) => {
    expect(catalog().models.find((m) => m.name === model)?.max_input_chars).toBe(5000);
  });

  // fal doubles the output itself ("concatenate the loop with itself for a 2x-length output") and does not say which
  // seconds it bills, so a doubled run is priced at twice the appended seconds until a funded run shows (inner#1859).
  it.each([[false, 1], [true, 2]])("prices a fal SFX 1.6 extend run with double_output %s at %s times the appended seconds", async (double, times) => {
    const input = run({ prompt: "rain", params: { audio: URL_A, append_duration: 10, num_samples: 1, ambience: true, double_output: double }, durations: { audio: [5] } });
    const estimate = await estimateCost(provider.pricingRules("sfx-1.6-extend-audio"), provider.availability("sfx-1.6-extend-audio"), input, { mode: "upstream", upstream: "fal" });
    expect(estimate?.usd).toBeCloseTo(0.01 * 10 * times, 6);
  });

  // fal: "rounded to whole seconds, then up to full minutes".
  it.each([[60.4, 1], [60.6, 2], [0.4, 1]])("prices a %s s veed clean audio run on fal at %s minutes", async (seconds, minutes) => {
    const input = run({ params: { audio: URL_A }, durations: { audio: [seconds] } });
    const rules = provider.pricingRules("veed-clean-audio");
    const minute = await estimateCost(rules, provider.availability("veed-clean-audio"), run({ params: { audio: URL_A }, durations: { audio: [60] } }), { mode: "upstream", upstream: "fal" });
    const estimate = await estimateCost(rules, provider.availability("veed-clean-audio"), input, { mode: "upstream", upstream: "fal" });
    expect(estimate?.usd).toBeCloseTo((minute?.usd ?? Number.NaN) * minutes, 9);
  });

  it("keeps a Mureka vocal sample outside 15 to 30 seconds off fal's voice clone", async () => {
    const song = (seconds: number): Partial<EstimateInput> => ({ prompt: "a calm song", params: { vocal: "https://a/v.mp3" }, durations: { vocal: [seconds] } });
    expect(await refused("mureka-v9.5-generate-song", "fal", song(20))).toBeUndefined();
    expect(await refused("mureka-v9.5-generate-song", "fal", song(10))).toEqual({ reason: expect.stringContaining("[15,30]") });
    expect(await refused("mureka-v9.5-generate-song", "fal", song(40))).toEqual({ reason: "fal mureka/api/voice/clone audio: up to 30 seconds (Mureka trims past 30)" });
  });

  describe.each(["fal", "sandbase"])("Gemini speaker ids on %s", (upstream) => {
    /**
     * A two-speaker run whose first speaker is named so.
     * @param first - The first speaker item.
     * @returns The run.
     */
    const speakers = (first: Record<string, unknown>): Partial<EstimateInput> => ({ prompt: "Host: hi. Guest: hello.", params: { speakers: [first, { speaker: "Guest", voice: "Kore" }] } });

    // The upstream checks ^\w+$ with Unicode word characters: SandBase takes 主持人 and refuses 李·明.
    it.each([["ASCII", "Host_1"], ["CJK", "主持人"], ["kana", "ミク"], ["Hangul", "김민수"], ["Greek", "Ελένη"], ["accented", "José"], ["combining accent", "Jose\u0301"], ["Arabic-Indic digit", "٣"]])(
      "takes a %s speaker",
      async (_label, name) => {
        expect(await refused("gemini-3.1-flash-text-to-speech", upstream, speakers({ speaker: name, voice: "Charon" }))).toBeUndefined();
      },
    );

    it.each([["empty", ""], ["space", "Al ice"], ["middle dot", "李·明"], ["full-width comma", "张，三"], ["ideographic space", "张\u3000三"], ["no-break space", "a\u00a0b"], ["hyphen", "A-B"], ["emoji", "😀"], ["number", 5], ["missing", undefined]])(
      "keeps a %s speaker off, without failing the check",
      async (_label, name) => {
        const first = name === undefined ? { voice: "Charon" } : { speaker: name, voice: "Charon" };
        expect(await refused("gemini-3.1-flash-text-to-speech", upstream, speakers(first))).toEqual({ reason: expect.stringContaining("speaker") });
      },
    );
  });

  it("prices a Krea run without style images at WaveSpeed's flat price and keeps the tie on WaveSpeed", async () => {
    const rules = provider.pricingRules("krea-v2-large-text-to-image");
    const input = run({ prompt: "a fox", params: { style_images: null } });
    expect(await estimateCost(rules, provider.availability("krea-v2-large-text-to-image"), input, { mode: "default" })).toMatchObject({ upstream: "wavespeed", usd: expect.closeTo(0.06, 6) });
    expect((await estimateCost(rules, provider.availability("krea-v2-large-text-to-image"), input, { mode: "cheapest" }))?.upstream).toBe("wavespeed");
  });
});
