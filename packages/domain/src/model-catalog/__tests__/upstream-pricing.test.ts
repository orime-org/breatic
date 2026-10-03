// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every WaveSpeed endpoint the catalog reaches carries its pricing contract,
 * and that contract prices the examples WaveSpeed's own readme gives for the
 * endpoint. `usd` is the readme's figure before `discount_rate`; the test
 * applies the discount from the yaml, so a wrong rate fails here too.
 *
 * Two endpoints are priced from the formula, not the readme, because the two
 * disagree and the formula is what the contract API publishes:
 * `bytedance/avatar-omni-human-1.5` (readme $0.25/s, formula base_price
 * 160000/s) and `sonilo/video-to-music` (readme bills 5s as 5s, formula bills
 * at least 10s). A smoke run's actual charge settles which one is right.
 */
import { describe, expect, it } from "vitest";
import { upstreamPriceUsd, type ClipDurations } from "@breatic/shared/pricing";
import { getFullModelConfig, MODALITIES, type FullProviderEndpoint } from "@domain/model-catalog/model-catalog";

interface PriceCase {
  readonly input: Readonly<Record<string, unknown>>;
  readonly durations?: ClipDurations;
  readonly usd: number;
}

const text = (chars: number): string => "x".repeat(chars);
const urls = (n: number): string[] => Array.from({ length: n }, (_, i) => `u${i}`);

const CASES: Readonly<Record<string, readonly PriceCase[]>> = {
  "alibaba/happyhorse-1.1/reference-to-video": [
    { input: { resolution: "720p", duration: 5 }, usd: 0.7 },
    { input: { resolution: "1080p", duration: 5 }, usd: 0.945 },
  ],
  "alibaba/wan-3.0/image-to-video": [
    { input: { resolution: "480p", duration: 2 }, usd: 0.1 },
    { input: { resolution: "720p", duration: 5 }, usd: 0.5 },
  ],
  "alibaba/wan-3.0/reference-to-video": [
    { input: { resolution: "720p", duration: 5, reference_videos: [] }, usd: 0.5 },
    { input: { resolution: "720p", duration: 5, reference_videos: urls(1) }, durations: { reference_videos: [5] }, usd: 1.0 },
  ],
  "alibaba/wan-3.0/text-to-video": [{ input: { resolution: "1080p", duration: 10 }, usd: 2.0 }],
  "alibaba/wan-3.0/video-edit": [
    { input: { resolution: "480p", video: "v" }, durations: { video: [1] }, usd: 0.15 },
    { input: { resolution: "720p", video: "v" }, durations: { video: [5] }, usd: 1.0 },
  ],
  "black-forest-labs/flux-3/start-end-to-video": [
    { input: { resolution: "720p", duration: 5 }, usd: 0.85 },
    { input: { resolution: "1080p", duration: 5 }, usd: 1.45 },
  ],
  "bria/remove-background": [{ input: {}, usd: 0.018 }],
  "bytedance/avatar-omni-human-1.5": [{ input: { audio: "a" }, durations: { audio: [10] }, usd: 1.6 }],
  "bytedance/dreamactor-v2": [{ input: { video: "v" }, durations: { video: [10] }, usd: 0.5 }],
  "bytedance/seedance-2.5/text-to-video": [
    { input: { resolution: "480p", duration: 5, reference_videos: [] }, usd: 0.9 },
    { input: { resolution: "480p", reference_videos: urls(1) }, durations: { reference_videos: [5] }, usd: 1.1 },
  ],
  "bytedance/seedance-2.5/video-extend": [{ input: { resolution: "480p", video: "v" }, durations: { video: [5] }, usd: 1.1 }],
  "clarity-ai/crystal-upscaler": [
    { input: { target_megapixels: 4 }, usd: 0.05 },
    { input: { target_megapixels: 16 }, usd: 0.2 },
  ],
  "elevenlabs/eleven-v3": [{ input: { text: text(1000) }, usd: 0.2 }],
  "elevenlabs/voice-changer": [{ input: { audio: "a" }, durations: { audio: [30] }, usd: 0.12 }],
  "google/gemini-3.1-flash/text-to-speech": [
    { input: { text: text(50) }, usd: 0.01 },
    { input: { text: text(1000) }, usd: 0.2 },
  ],
  "google/gemini-omni-1.1-flash/image-to-video": [{ input: { resolution: "720p", duration: 5 }, usd: 0.5 }],
  "google/gemini-omni-1.1-flash/reference-to-video": [{ input: { resolution: "720p", duration: 8 }, usd: 0.8 }],
  "google/gemini-omni-1.1-flash/text-to-video": [{ input: { resolution: "4k", duration: 10 }, usd: 3.0 }],
  "google/lyria-3-pro/music": [{ input: {}, usd: 0.08 }],
  "google/nano-banana-2/text-to-image": [
    { input: { resolution: "0.5k", enable_web_search: false, enable_image_search: false }, usd: 0.045 },
    { input: { resolution: "2k", enable_web_search: true, enable_image_search: false }, usd: 0.119 },
  ],
  "google/nano-banana-pro/edit-ultra": [
    { input: { resolution: "4k" }, usd: 0.15 },
    { input: { resolution: "8k" }, usd: 0.18 },
  ],
  "inworld/realtime-tts-2": [{ input: { text: text(1000) }, usd: 0.05 }],
  "kwaivgi/kling-v3.0-4k/text-to-video": [{ input: { duration: 5 }, usd: 2.1 }],
  "kwaivgi/kling-v3.0-pro/motion-control": [
    { input: { video: "v" }, durations: { video: [2] }, usd: 0.504 },
    { input: { video: "v" }, durations: { video: [10] }, usd: 1.68 },
  ],
  "kwaivgi/kling-video-o3-4k/image-to-video": [{ input: { duration: 10 }, usd: 4.2 }],
  "meta/muse-image/edit": [{ input: {}, usd: 0.011 }],
  "minimax/h3/image-to-video": [
    { input: { resolution: "768p", duration: 5 }, usd: 0.5 },
    { input: { resolution: "2k", duration: 10 }, usd: 1.4 },
  ],
  "minimax/h3/reference-to-video": [
    {
      input: { resolution: "768p", duration: 5, reference_videos: urls(1), reference_images: [] },
      durations: { reference_videos: [5] },
      usd: 1.0,
    },
    {
      input: { resolution: "2k", duration: 5, reference_videos: urls(1), reference_images: [] },
      durations: { reference_videos: [5] },
      usd: 1.4,
    },
  ],
  "minimax/h3/text-to-video": [{ input: { resolution: "2k", duration: 15 }, usd: 2.1 }],
  "minimax/music-cover": [{ input: {}, usd: 0.15 }],
  "minimax/speech-2.8-hd": [{ input: { text: text(1000) }, usd: 0.1 }],
  "minimax/voice-clone": [{ input: {}, usd: 1.6 }],
  "mirelo-ai/sfx-1.6/extend-audio": [{ input: { append_duration: 10, num_samples: 1 }, usd: 0.1 }],
  "mirelo-ai/sfx-1.6/text-to-audio": [{ input: { duration: 30, num_samples: 1 }, usd: 0.3 }],
  "mureka-ai/mureka-v9.5/generate-bgm": [{ input: {}, usd: 0.225 }],
  "mureka-ai/mureka-v9.5/generate-song": [{ input: {}, usd: 0.225 }],
  "openai/gpt-image-2.5-sunburst/edit": [
    { input: { quality: "medium", resolution: "1k", images: urls(1) }, usd: 0.039 },
    { input: { quality: "high", resolution: "2k", images: urls(3) }, usd: 0.195 },
  ],
  "openai/gpt-image-2.5-sunburst/text-to-image": [
    { input: { quality: "medium", resolution: "1k" }, usd: 0.024 },
    { input: { quality: "max", resolution: "4k" }, usd: 1.0 },
  ],
  "recraft-ai/recraft-v4.1-pro/text-to-vector": [{ input: {}, usd: 0.3 }],
  "recraft-ai/recraft-v4-style/text-to-image": [
    { input: {}, usd: 0.0385 },
    { input: { images: urls(2) }, usd: 0.044 },
  ],
  "wavespeed-ai/krea-v2-large/text-to-image": [
    { input: {}, usd: 0.06 },
    { input: { reference: urls(3) }, usd: 0.065 },
  ],
  "ideogram-ai/ideogram-v3-quality": [{ input: {}, usd: 0.09 }],
  "sonilo/v1/text-to-sfx": [{ input: { duration: 60 }, usd: 0.12 }],
  "sonilo/video-to-music": [
    { input: { video: "v" }, durations: { video: [60] }, usd: 0.54 },
    { input: { video: "v" }, durations: { video: [5] }, usd: 0.09 },
  ],
  "sourceful/riverflow-2.0-pro/text-to-image": [
    { input: { resolution: "1k" }, usd: 0.15 },
    { input: { resolution: "4k" }, usd: 0.33 },
  ],
  "sync/lipsync-3": [{ input: { video: "v" }, durations: { video: [10] }, usd: 1.35 }],
  "sync/react-1": [{ input: { audio: "a" }, durations: { audio: [5] }, usd: 0.835 }],
  "wavespeed-ai/audio-vocal-isolator": [{ input: { audio: "a" }, durations: { audio: [60] }, usd: 0.06 }],
  "wavespeed-ai/hunyuan-video-foley": [{ input: {}, usd: 0.05 }],
  "wavespeed-ai/infinitetalk/multi": [
    {
      input: { resolution: "480p", order: "left_right", left_audio: "l", right_audio: "r" },
      durations: { left_audio: [5], right_audio: [5] },
      usd: 0.3,
    },
    {
      input: { resolution: "480p", order: "meanwhile", left_audio: "l", right_audio: "r" },
      durations: { left_audio: [5], right_audio: [5] },
      usd: 0.15,
    },
  ],
  "wavespeed-ai/infinitetalk/video-to-video": [
    { input: { resolution: "720p", audio: "a" }, durations: { audio: [10] }, usd: 0.6 },
  ],
  "wavespeed-ai/ltx-2.3/lipsync": [{ input: { resolution: "720p", audio: "a" }, durations: { audio: [5] }, usd: 0.15 }],
  "wavespeed-ai/omnivoice/voice-clone": [
    { input: { text: text(50) }, usd: 0.005 },
    { input: { text: text(500) }, usd: 0.025 },
  ],
  "wavespeed-ai/qwen-image/edit-multiple-angles": [{ input: {}, usd: 0.025 }],
  "wavespeed-ai/rife": [{ input: { video: "v" }, durations: { video: [10] }, usd: 0.1 }],
  "wavespeed-ai/seedvr2/video": [
    { input: { target_resolution: "720p", video: "v" }, durations: { video: [5] }, usd: 0.1 },
    { input: { target_resolution: "4k", video: "v" }, durations: { video: [5] }, usd: 0.3 },
  ],
  "wavespeed-ai/wan-2.2/animate-2": [{ input: { resolution: "720p", video: "v" }, durations: { video: [10] }, usd: 0.8 }],
  "x-ai/grok-imagine-image-v2.0/text-to-image": [{ input: {}, usd: 0.05 }],
};

/**
 * Every WaveSpeed provider entry in the catalog, keyed by its endpoint. 3D is
 * left out: its two models stay as they are and are not part of this catalog.
 *
 * @returns The provider entries by `model_id`.
 */
function wavespeedEndpoints(): Map<string, FullProviderEndpoint> {
  const byEndpoint = new Map<string, FullProviderEndpoint>();
  for (const modality of MODALITIES.filter((m) => m !== "three_d")) {
    for (const model of getFullModelConfig(modality).models) {
      for (const provider of model.providers ?? []) {
        if (provider.name === "wavespeed") byEndpoint.set(provider.model_id, provider);
      }
    }
  }
  return byEndpoint;
}

describe("WaveSpeed pricing contracts in the catalog", () => {
  const endpoints = wavespeedEndpoints();

  it("covers exactly the 58 endpoints of the finalized catalog", () => {
    expect([...endpoints.keys()].sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const [endpoint, cases] of Object.entries(CASES)) {
    it(`prices ${endpoint} as its readme does`, async () => {
      const pricing = endpoints.get(endpoint)?.pricing;
      expect(pricing, `${endpoint} declares no pricing`).toBeDefined();
      const { base_price, formula, discount_rate } = pricing as {
        base_price: number;
        formula: string;
        discount_rate: number;
      };
      for (const c of cases) {
        const usd = await upstreamPriceUsd(
          { basePrice: base_price, formula, discountRate: discount_rate },
          c.input,
          c.durations ?? {},
        );
        expect(usd).toBeCloseTo((c.usd * discount_rate) / 100, 6);
      }
    });
  }
});
