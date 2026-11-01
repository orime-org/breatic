// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
  "ideogram-v3-quality": { fal: "fal-ai/ideogram/v3", sandbase: "ideogram-ai/ideogram-v3" },
  "recraft-v4-style-text-to-image": { fal: "recraft/v4/style/text-to-image" },
  "gpt-image-2.5-sunburst-edit": { fal: "openai/gpt-image-2.5/sunburst/edit", sandbase: "openai/gpt-image-2.5-sunburst/edit" },
  "muse-image-edit": { fal: "meta/muse-image/edit" },
  "nano-banana-pro-edit-ultra": {},
  "qwen-image-edit-multiple-angles": { fal: "fal-ai/qwen-image-edit-2511-multiple-angles", sandbase: "alibaba/qwen-image-edit/2511/multiple-angles" },
  "pro-upscaler": {},
  "bria-remove-background": { fal: "fal-ai/bria/background/remove" },
  "bria-genfill": {},
  "bria-eraser": { fal: "fal-ai/bria/eraser" },
  "seedream-v4.5-edit": { fal: "fal-ai/bytedance/seedream/v4.5/edit", sandbase: "bytedance/seedream/4.5/edit" },
  "meshy6-t23d": { fal: "fal-ai/meshy/v6/text-to-3d" },
  "hunyuan3d-v3": { fal: "fal-ai/hunyuan3d-v3/text-to-3d" },
  "hunyuan3d-v3-i23d": { fal: "fal-ai/hunyuan3d-v3/image-to-3d", sandbase: "tencent/hunyuan-3d/3.0/image-to-3d" },
  "hunyuan3d-v3.1-rapid": { fal: "fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d" },
  "realtime-tts-2": {},
  "gemini-3.1-flash-text-to-speech": { fal: "fal-ai/gemini-3.1-flash-tts", sandbase: "google/gemini-3.1-flash-tts" },
  "minimax-speech-2.8-hd": { fal: "fal-ai/minimax/speech-2.8-hd", sandbase: "minimax/speech/2.8/hd" },
  "elevenlabs-v3": { fal: "fal-ai/elevenlabs/tts/eleven-v3", sandbase: "elevenlabs/v3" },
  "minimax-voice-clone": { fal: "fal-ai/minimax/voice-clone", sandbase: "minimax/voice-clone" },
  "omnivoice-voice-clone": {},
  "elevenlabs-voice-changer": { fal: "fal-ai/elevenlabs/voice-changer" },
  "gemini-omni-1.1-flash-text-to-video": { fal: "google/gemini-omni-flash/v1.1/text-to-video", sandbase: "google/gemini-omni-flash/1.1/text-to-video" },
  "wan-3.0-text-to-video": { fal: "alibaba/wan-3.0/text-to-video", sandbase: "alibaba/wan/3.0/text-to-video" },
  "seedance-2.5-text-to-video": { fal: "bytedance/seedance-2.5/us/text-to-video", sandbase: "bytedance/seedance/2.5/text-to-video" },
  "minimax-h3-text-to-video": { fal: "minimax/h3/text-to-video", sandbase: "minimax/h3/text-to-video" },
  "kling-v3.0-4k-text-to-video": { fal: "fal-ai/kling-video/v3/4k/text-to-video", sandbase: "kwaivgi/kling-video/v3/4k/text-to-video" },
  "gemini-omni-1.1-flash-image-to-video": { fal: "google/gemini-omni-flash/v1.1/image-to-video", sandbase: "google/gemini-omni-flash/1.1/image-to-video" },
  "minimax-h3-image-to-video": { fal: "minimax/h3/image-to-video", sandbase: "minimax/h3/image-to-video" },
  "wan-3.0-image-to-video": { fal: "alibaba/wan-3.0/image-to-video", sandbase: "alibaba/wan/3.0/image-to-video" },
  "seedance-2.5-image-to-video": { fal: "bytedance/seedance-2.5/us/image-to-video", sandbase: "bytedance/seedance/2.5/image-to-video" },
  "kling-video-o3-4k-image-to-video": { fal: "fal-ai/kling-video/o3/4k/image-to-video", sandbase: "kwaivgi/kling-video/o3/4k/image-to-video" },
  "wan-2.2-animate-2": {},
  "dreamactor-v2": { fal: "fal-ai/bytedance/dreamactor/v2", sandbase: "bytedance/dreamactor/2.0" },
  "minimax-h3-reference-to-video": { fal: "minimax/h3/reference-to-video", sandbase: "minimax/h3/reference-to-video" },
  "gemini-omni-1.1-flash-reference-to-video": { fal: "google/gemini-omni-flash/v1.1/reference-to-video", sandbase: "google/gemini-omni-flash/1.1/reference-to-video" },
  "wan-3.0-reference-to-video": { fal: "alibaba/wan-3.0/reference-to-video", sandbase: "alibaba/wan/3.0/reference-to-video" },
  "happyhorse-1.1-reference-to-video": { fal: "alibaba/happy-horse/v1.1/reference-to-video", sandbase: "alibaba/happy-horse/1.1/reference-to-video" },
  "flux-3-start-end-to-video": { fal: "blackforestlabs/flux-3/first-last-frame-to-video" },
  "seedance-2.5-video-extend": { fal: "bytedance/seedance-2.5/us/reference-to-video", sandbase: "bytedance/seedance/2.5/reference-to-video" },
  "wan-3.0-video-edit": {},
  "kling-v3-pro-motion": { fal: "fal-ai/kling-video/v3/pro/motion-control", sandbase: "kwaivgi/kling-video/v3/pro/motion-control" },
  "omnihuman-1.5": { fal: "fal-ai/bytedance/omnihuman/v1.5", sandbase: "bytedance/omnihuman/1.5" },
  "seedance-2.5-talking-avatar": {},
  "sync-lipsync-3": { fal: "fal-ai/sync-lipsync/v3", sandbase: "sync/lipsync/3.0/video-to-video" },
  "infinitetalk-video-to-video": { fal: "fal-ai/infinitalk/video-to-video", sandbase: "meigen/infinitetalk/video-to-video" },
  "infinitetalk-multi": {},
  "sync-react-1": { fal: "fal-ai/sync-lipsync/react-1" },
  "ltx-2.3-lipsync": {},
  "seedvr2-video": { fal: "fal-ai/seedvr/upscale/video", sandbase: "bytedance/seedvr/upscale/video" },
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
const bindingOf = (model: string, upstream: string): MediaBinding | undefined =>
  models[model]?.upstreams.find((b) => b.upstream === upstream);

/** ElevenLabs' premade voices among the catalog's elevenlabs-v3 voices: their samples live under `premade/voices/`. */
function premadeVoices(): string[] {
  const tts = yaml<{ models: { name: string; voices?: { id: string; sample_url?: string }[] }[] }>("models/tts/models.yaml");
  const voices = tts.models.find((m) => m.name === "elevenlabs-v3")?.voices ?? [];
  return voices.filter((v) => v.sample_url?.includes("/premade/voices/") === true).map((v) => v.id);
}

describe("the reseller upstreams", () => {
  it("declares fal and SandBase", () => {
    expect(config.upstreams.fal).toEqual({ kind: "fal", base_url: "https://queue.fal.run", billing_url: "https://api.fal.ai/v1", key_env: "FAL_KEY", concurrency: 10 });
    expect(config.upstreams.sandbase).toEqual({ kind: "sandbase", base_url: "https://api.sandbase.ai/v1", key_env: "SANDBASE_API_KEY", concurrency: 10 });
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
  it("sends ideogram-v3-quality at QUALITY on both", () => {
    for (const upstream of ["fal", "sandbase"]) expect(bindingOf("ideogram-v3-quality", upstream)?.fixed).toMatchObject({ rendering_speed: "QUALITY" });
  });

  it("upscales seedvr2-video to the target resolution on both", () => {
    for (const upstream of ["fal", "sandbase"]) expect(bindingOf("seedvr2-video", upstream)?.fixed).toMatchObject({ upscale_mode: "target" });
  });

  it("extends a video through reference-to-video, SandBase without 4k", () => {
    expect(bindingOf("seedance-2.5-video-extend", "fal")?.fixed).toMatchObject({ task: "extension" });
    const sandbase = bindingOf("seedance-2.5-video-extend", "sandbase");
    expect(sandbase?.fixed).toMatchObject({ task_type: "extend" });
    expect(sandbase?.params?.resolution?.supported).not.toContain("4k");
    expect(sandbase?.params?.video).toMatchObject({ field: "videos", as: "list" });
  });

  it.each(["gpt-image-2.5-sunburst-text-to-image", "gpt-image-2.5-sunburst-edit"])("serves %s on fal only at 1k and the five preset ratios", (model) => {
    const fal = bindingOf(model, "fal");
    expect([...(fal?.params?.aspect_ratio?.supported ?? [])].sort()).toEqual(["16:9", "1:1", "3:4", "4:3", "9:16"]);
    expect(fal?.drops?.resolution).toEqual(["1k"]);
  });

  it("speaks elevenlabs-v3 only in ElevenLabs' premade voices, by name, on both", () => {
    const premade = premadeVoices();
    expect(premade).toHaveLength(23);
    for (const upstream of ["fal", "sandbase"]) {
      const binding = bindingOf("elevenlabs-v3", upstream);
      expect(binding?.voice_map?.voice_id).toEqual(Object.fromEntries(premade.map((v) => [v, v])));
      expect(binding?.drops?.similarity).toHaveProperty("all_values");
    }
  });

  it("writes the multiple-angles distance as a zoom, close-up the highest, on both", () => {
    for (const upstream of ["fal", "sandbase"]) {
      expect(bindingOf("qwen-image-edit-multiple-angles", upstream)?.params?.distance).toMatchObject({ field: "zoom", values: { "0": 10, "1": 5, "2": 0 } });
    }
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
