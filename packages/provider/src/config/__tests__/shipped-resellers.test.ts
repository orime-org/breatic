// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBody } from "../../media/body.js";
import { estimateCost, rejectedInput, type EstimateInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import type { MediaBinding } from "../schema.js";
import type { SchemaSnapshot } from "../upstream-schema.js";
import { ROOT, shipped, yaml } from "./shipped.js";

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
  "seedream-v4.5-edit": { fal: "fal-ai/bytedance/seedream/v4.5/edit", sandbase: "bytedance/seedream/4.5/edit" },
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
  "minimax-h3-text-to-video": { fal: "minimax/h3/text-to-video", sandbase: "minimax/h3/text-to-video" },
  // WaveSpeed defaults cfg_scale to 0.5; SandBase has no such field and Kling's docs state none (inner#1859).
  "kling-v3.0-4k-text-to-video": { fal: "fal-ai/kling-video/v3/4k/text-to-video" },
  "gemini-omni-1.1-flash-image-to-video": { fal: "google/gemini-omni-flash/v1.1/image-to-video", sandbase: "google/gemini-omni-flash/1.1/image-to-video" },
  "minimax-h3-image-to-video": { fal: "minimax/h3/image-to-video", sandbase: "minimax/h3/image-to-video" },
  "wan-3.0-image-to-video": { fal: "alibaba/wan-3.0/image-to-video" },
  "seedance-2.5-image-to-video": { fal: "bytedance/seedance-2.5/us/image-to-video", sandbase: "bytedance/seedance/2.5/image-to-video" },
  "kling-video-o3-4k-image-to-video": { fal: "fal-ai/kling-video/o3/4k/image-to-video", sandbase: "kwaivgi/kling-video/o3/4k/image-to-video" },
  "wan-2.2-animate-2": {},
  "dreamactor-v2": { fal: "fal-ai/bytedance/dreamactor/v2", sandbase: "bytedance/dreamactor/2.0" },
  "minimax-h3-reference-to-video": { fal: "minimax/h3/reference-to-video", sandbase: "minimax/h3/reference-to-video" },
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

/**
 * One model's binding on one upstream.
 * @param model - Our model.
 * @param upstream - The upstream.
 * @returns The binding, if any.
 */
/** A sample source url. */
const URL_A = "https://a/x.mp4";

const bindingOf = (model: string, upstream: string): MediaBinding | undefined =>
  models[model]?.upstreams.find((b) => b.upstream === upstream);

/**
 * ElevenLabs' premade voices among a catalog model's voices, each with ElevenLabs' own id:
 * their samples live under `premade/voices/<voice id>/`.
 * @param model - The catalog model.
 * @returns Our voice name and ElevenLabs' id of each.
 */
function premadeVoices(model = "elevenlabs-v3"): { name: string; id: string }[] {
  const tts = yaml<{ models: { name: string; voices?: { id: string; sample_url?: string }[] }[] }>("models/tts/models.yaml");
  const voices = tts.models.find((m) => m.name === model)?.voices ?? [];
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
    expect(estimate?.usd).toBeCloseTo(0.05268 + 2 * 0.012, 6);
  });

  // Each row: model, upstream, a run the upstream's own words refuse, the nearest run it takes, and words of the reason.
  const STATED: [string, string, Partial<EstimateInput>, Partial<EstimateInput>, string][] = [
    ["mureka-v9.5-generate-song", "wavespeed", { prompt: "x".repeat(1025), params: { lyrics: "la" } }, { prompt: "x".repeat(1024), params: { lyrics: "la" } }, "1024"],
    ["mureka-v9.5-generate-song", "wavespeed", { prompt: "a song", params: { lyrics: "x".repeat(5001) } }, { prompt: "a song", params: { lyrics: "x".repeat(5000) } }, "5000"],
    ["mureka-v9.5-generate-song", "wavespeed", { prompt: "a song", params: { lyrics: "la", song: URL_A }, durations: { song: [20] } }, { prompt: "a song", params: { lyrics: "la", song: URL_A }, durations: { song: [30] } }, "30"],
    ["mureka-v9.5-generate-song", "fal", { prompt: "a song", params: { lyrics: "la", song: URL_A }, durations: { song: [20] } }, { prompt: "a song", params: { lyrics: "la", song: URL_A }, durations: { song: [30] } }, "30"],
    ["mureka-v9.5-generate-song", "wavespeed", { prompt: "a song", params: { lyrics: "la", melody: URL_A }, durations: { melody: [3] } }, { prompt: "a song", params: { lyrics: "la", melody: URL_A }, durations: { melody: [10] } }, "[5,60]"],
    ["mureka-v9.5-generate-bgm", "wavespeed", { prompt: "x".repeat(1025) }, { prompt: "x".repeat(1024) }, "1024"],
    ["hunyuan3d-v3", "wavespeed", { prompt: "x".repeat(1025) }, { prompt: "x".repeat(1024) }, "1024"],
    ["krea-v2-large-text-to-image", "wavespeed", { prompt: "x".repeat(5001) }, { prompt: "x".repeat(5000) }, "5000"],
    ["elevenlabs-voice-changer", "fal", { params: { audio: URL_A, voice_id: "Aria" }, durations: { audio: [301] } }, { params: { audio: URL_A, voice_id: "Aria" }, durations: { audio: [300] } }, "5 minutes"],
    ["dreamactor-v2", "sandbase", { params: { image: URL_A, video: URL_A }, durations: { video: [31] } }, { params: { image: URL_A, video: URL_A }, durations: { video: [30] } }, "30 seconds"],
    ["minimax-voice-clone", "fal", { prompt: "hi", params: { audio: URL_A }, durations: { audio: [9] } }, { prompt: "hi", params: { audio: URL_A }, durations: { audio: [10] } }, "10 seconds"],
    ["minimax-voice-clone", "sandbase", { prompt: "hi", params: { audio: URL_A }, durations: { audio: [9] } }, { prompt: "hi", params: { audio: URL_A }, durations: { audio: [10] } }, "10 seconds"],
    ["seedance-2.5-text-to-video", "wavespeed", { prompt: "a fox", params: { duration: 5, audios: [URL_A] }, durations: { audios: [31] } }, { prompt: "a fox", params: { duration: 5, audios: [URL_A] }, durations: { audios: [30] } }, "30 seconds"],
    ["seedance-2.5-text-to-video", "wavespeed", { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [31] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [30] } }, "30 seconds"],
    ["minimax-h3-reference-to-video", "wavespeed", { prompt: "a fox", params: { audios: [URL_A] } }, { prompt: "a fox", params: { audios: [URL_A], images: [URL_A] } }, "alone"],
    ["dreamactor-v2", "wavespeed", { params: { image: URL_A, video: URL_A }, durations: { video: [31] } }, { params: { image: URL_A, video: URL_A }, durations: { video: [30] } }, "30 seconds"],
    ["gemini-omni-1.1-flash-reference-to-video", "wavespeed", { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [4] } }, { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [3] } }, "3 seconds"],
    ["wan-3.0-reference-to-video", "wavespeed", { prompt: "a fox", params: { duration: 20, videos: [URL_A] }, durations: { videos: [12] } }, { prompt: "a fox", params: { duration: 15, videos: [URL_A] }, durations: { videos: [12] } }, "30 seconds"],
    ["wan-3.0-reference-to-video", "wavespeed", { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [8, 8] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A, URL_A] }, durations: { videos: [8, 7] } }, "15 seconds"],
    ["wan-3.0-reference-to-video", "wavespeed", { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [0.5] } }, { prompt: "a fox", params: { duration: 5, videos: [URL_A] }, durations: { videos: [1] } }, "1-15 seconds"],
    ["wan-3.0-reference-to-video", "wavespeed", { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A] }, durations: { audios: [16] } }, { prompt: "a fox", params: { duration: 5, images: [URL_A], audios: [URL_A] }, durations: { audios: [15] } }, "15 seconds"],
    ["kling-v3-pro-motion", "fal", { prompt: "dance", params: { image: URL_A, video: URL_A }, durations: { video: [2] } }, { prompt: "dance", params: { image: URL_A, video: URL_A }, durations: { video: [3] } }, "3"],
    ["infinitetalk-video-to-video", "wavespeed", { prompt: "talk", params: { audio: URL_A, video: URL_A }, durations: { audio: [601] } }, { prompt: "talk", params: { audio: URL_A, video: URL_A }, durations: { audio: [600] } }, "10 minutes"],
    ["sync-react-1", "wavespeed", { params: { audio: URL_A, video: URL_A }, durations: { audio: [16], video: [5] } }, { params: { audio: URL_A, video: URL_A }, durations: { audio: [15], video: [5] } }, "15"],
    ["sync-react-1", "wavespeed", { params: { audio: URL_A, video: URL_A }, durations: { audio: [5], video: [16] } }, { params: { audio: URL_A, video: URL_A }, durations: { audio: [5], video: [15] } }, "15"],
    ["seedvr2-video", "wavespeed", { params: { video: URL_A }, durations: { video: [601] } }, { params: { video: URL_A }, durations: { video: [600] } }, "10 minutes"],
    ["rife-interpolation", "wavespeed", { params: { video: URL_A }, durations: { video: [601] } }, { params: { video: URL_A }, durations: { video: [600] } }, "10 minutes"],
  ];

  // WaveSpeed's own words say it normalizes or trims these, so it takes them.
  it.each([
    ["minimax-h3-reference-to-video", { prompt: "a fox", params: { videos: [URL_A, URL_A] }, durations: { videos: [8, 8] } }],
    ["minimax-h3-reference-to-video", { prompt: "a fox", params: { videos: [URL_A] }, durations: { videos: [1.5] } }],
    ["elevenlabs-voice-changer", { params: { audio: URL_A }, durations: { audio: [400] } }],
  ] as [string, Partial<EstimateInput>][])("takes a %s run on WaveSpeed that it normalizes or trims", async (model, input) => {
    expect(await refused(model, "wavespeed", input)).toBeUndefined();
  });

  it.each(STATED)("keeps a %s run off %s where its own words refuse it, and takes the nearest run it allows", async (model, upstream, refusedRun, takenRun, words) => {
    expect(await refused(model, upstream, refusedRun)).toEqual({ reason: expect.stringContaining(words) });
    expect(await refused(model, upstream, takenRun)).toBeUndefined();
  });

  it("keeps a Mureka vocal sample outside 15 to 30 seconds off fal's voice clone", async () => {
    const song = (seconds: number): Partial<EstimateInput> => ({ prompt: "a calm song", params: { vocal: "https://a/v.mp3" }, durations: { vocal: [seconds] } });
    expect(await refused("mureka-v9.5-generate-song", "fal", song(20))).toBeUndefined();
    for (const seconds of [10, 40]) expect(await refused("mureka-v9.5-generate-song", "fal", song(seconds)), `${seconds} s`).toEqual({ reason: expect.stringContaining("15") });
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
