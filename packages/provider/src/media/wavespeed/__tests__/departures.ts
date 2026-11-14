// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { isPresent } from "../../../pricing/estimate.js";

/** Where the WaveSpeed bindings depart from what the code before provider sent, for the fixture tests that compare the two. */

/** Models WaveSpeed no longer serves (absent from `/api/v3/models`, rechecked on 2026-11-02): they carry no WaveSpeed binding. */
export const OFF_WAVESPEED: ReadonlySet<string> = new Set(["veed-clean-audio", "recraft-v4-style-text-to-image"]);

/**
 * Where a binding departs from the body before provider on purpose, by model: a field renamed to the
 * name WaveSpeed's schema gives it (WaveSpeed takes both and echoes the schema's name,
 * probed 2026-11-01), or a field left out because WaveSpeed's schema has none and it
 * ignores the field (inner#1872, inner#1873).
 */
export const DEPARTURES: Readonly<Record<string, { rename?: Record<string, string>; omit?: string[]; prompt?: (prompt: string) => string }>> = {
  // WaveSpeed's prompt description names reference videos <VIDEO_REF_0>, ... from 0; the prompt before provider wrote "the reference video 1".
  "gemini-omni-1.1-flash-reference-to-video": { prompt: (prompt) => prompt.replace(/the reference video (\d+)/g, (_m, n: string) => `<VIDEO_REF_${Number(n) - 1}>`) },
  "flux-3-start-end-to-video": { rename: { start_image: "image", end_image: "last_image" } },
  "muse-image-edit": { rename: { image_urls: "images" } },
  "wan-3.0-text-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-image-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-reference-to-video": { rename: { enable_audio: "generate_audio" } },
  "elevenlabs-v3": { omit: ["similarity"] },
  "sfx-1.6-text-to-audio": { omit: ["ambience", "double_output"] },
  // compose_from is the panel's choice between references and a melody, not a WaveSpeed field; the worker before provider forwarded it under its own name.
  "mureka-v9.5-generate-song": { omit: ["compose_from"] },
};

/**
 * Params the catalog gained after the code before provider was frozen (inner#1743), by model: the body before provider never carried them,
 * so their WaveSpeed field is checked on its own in `body-fixture.test.ts`.
 */
export const ADDED_AFTER_FREEZE: Readonly<Record<string, readonly string[]>> = {
  // MiniMax's language_boost, with the official values (platform.minimax.io speech-t2a-http).
  "minimax-speech-2.8-hd": ["language_boost"],
  // A model main added after the freeze (inner#1825): a voice described in words.
  "qwen3-tts-voice-design": ["voice_description", "language"],
  // The optional rig after a Tripo generation (inner#1692); its switch never reaches the generation.
  "tripo-h3.1-t23d": ["rig_skeleton"],
  "tripo-h3.1-i23d": ["rig_skeleton"],
  "tripo-h3.1-multiview": ["rig_skeleton"],
  // Models added after the freeze (inner#1809); the transparency toggle's body is checked in `seedream-v5.5.test.ts`.
  "seedream-v5.5-text-to-image": ["aspect_ratio", "resolution", "transparency"],
  "seedream-v5.5-edit": ["aspect_ratio", "images", "resolution", "transparency"],
};

/**
 * Values of ours WaveSpeed cannot serve, by model and param: those it refuses with a 400, and
 * a true for a switch it has no field for (probed 2026-11-01; inner#1872, inner#1873). Its
 * bindings keep them out (`supported`, or `drops: [false]`), so a run holding one is never sent to WaveSpeed.
 */
export const REFUSED: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> = {
  "nano-banana-2-relight": { output_format: ["webp"] },
  "nano-banana-2-quick-edit": { output_format: ["webp"] },
  "muse-image-edit": { aspect_ratio: ["9:21"] },
  "sfx-1.6-text-to-audio": { loop: [true], double_output: [true] },
};

/** A run as the predicates below read it: our params and the known clip lengths. */
type Run = { params: Readonly<Record<string, unknown>>; prompt?: string; durations?: Readonly<Record<string, readonly number[]>> };

/**
 * Whether a run's shots add up to other than its duration.
 * @param run - The run.
 * @returns True when they do.
 */
const shotsOffTotal = (run: Run): boolean => {
  const shots = run.params.multi_prompt;
  return Array.isArray(shots) && shots.reduce((sum: number, shot: { duration: number }) => sum + shot.duration, 0) !== run.params.duration;
};

/**
 * Whether a Tripo run holds an input pair Tripo refuses with error 1004: texture quality fast on a texture version
 * other than v3.5, or parts with texture or PBR on (each on by default).
 * @param run - The run.
 * @returns True when it does.
 */
const tripo1004 = (run: Run): boolean => (run.params.texture_quality === "fast" && run.params.texture_version !== "v3.5")
  || (run.params.generate_parts === true && !(run.params.texture === false && run.params.pbr === false));

/** WaveSpeed's 10% off on a model's page, which `/model/price` charges as `discounted_price`. */
const TEN_PERCENT_OFF = 0.9;

/**
 * Models whose WaveSpeed charge changed after the fixture froze, by model: what WaveSpeed charges for a run now,
 * from the model's page and `/model/price` (pnpm provider:prices, read 2026-11-13). Their estimate is that charge.
 */
export const REPRICED: Readonly<Record<string, (run: Run) => number>> = {
  // https://wavespeed.ai/models/x-ai/grok-imagine-image-v2.0/text-to-image: medium quality, "1k ... $0.06", "2k ... $0.08".
  "grok-imagine-image-v2.0-text-to-image": (r) => (r.params.resolution === "1k" ? 0.06 : 0.08),
  // https://wavespeed.ai/models/recraft-ai/recraft-v4.1-pro/text-to-vector: "Each generated vector image costs $0.36".
  "recraft-v4.1-pro-text-to-vector": () => 0.36,
  // https://wavespeed.ai/models/mirelo-ai/sfx-1.6/text-to-audio: "$0.02 per generated second per sample".
  "sfx-1.6-text-to-audio": (r) => 0.02 * Number(r.params.duration) * Number(r.params.num_samples),
  // https://wavespeed.ai/models/google/nano-banana-2/edit: 0.5k $0.045, 1k $0.07, 2k $0.105, 4k $0.14, at 10% off.
  "nano-banana-2-relight": (r) => nanoBananaEdit(r),
  "nano-banana-2-quick-edit": (r) => nanoBananaEdit(r),
  // https://wavespeed.ai/models/bytedance/seedance-2.5/talking-avatar: per audio second, 480p $0.22, 720p $0.44,
  // "rounded up to whole seconds, with a 4-second minimum and a 120-second maximum", at 10% off.
  "seedance-2.5-talking-avatar": (r) => {
    const seconds = Math.max(4, Math.min(Math.ceil(r.durations?.audio?.[0] ?? 0), 120));
    return seconds * (r.params.resolution === "480p" ? 0.22 : 0.44) * TEN_PERCENT_OFF;
  },
};

/**
 * Nano Banana 2 edit's charge for a run: its price for the resolution, at WaveSpeed's 10% off.
 * @param run - The run.
 * @returns The charge in USD.
 */
function nanoBananaEdit(run: Run): number {
  const byResolution: Readonly<Record<string, number>> = { "0.5k": 0.045, "1k": 0.07, "2k": 0.105, "4k": 0.14 };
  return (byResolution[String(run.params.resolution)] ?? 0.07) * TEN_PERCENT_OFF;
}

/**
 * Runs outside a limit the model's vendor states, by model, in the vendor's words: the model's own `rejects` refuse
 * them on every upstream. The code before provider estimated them on WaveSpeed.
 */
export const OUTSIDE_VENDOR: Readonly<Record<string, (run: Run) => boolean>> = {
  // Google: "Video references support a maximum of 3 clips, up to 3 seconds each."
  "gemini-omni-1.1-flash-reference-to-video": (r) => (r.durations?.videos ?? []).some((s) => s > 3),
  // Mureka's upload: reference "[30,30] seconds", melody "[5,60] seconds"; melody_id "does not support combination with other control options".
  "mureka-v9.5-generate-song": (r) => (r.durations?.song ?? []).some((s) => s < 30) || (r.durations?.melody ?? []).some((s) => s < 5)
    || (isPresent(r.params.melody) && (isPresent(r.params.song) || isPresent(r.params.vocal) || (r.prompt ?? "") !== "")),
  // Kling: "sum of all shot durations must equal the total video duration".
  "kling-v3.0-4k-text-to-video": shotsOffTotal,
  "kling-video-o3-4k-image-to-video": shotsOffTotal,
  // MiniMax: "Audio duration: at least 10 seconds, no longer than 5 minutes".
  "minimax-voice-clone": (r) => (r.durations?.audio ?? []).some((s) => s < 10 || s > 300),
  // Tripo: "Any other texture version returns `1004`"; generate_parts with "`texture=true` or `pbr=true` ... is rejected with error code `1004`".
  "tripo-h3.1-t23d": tripo1004,
  "tripo-h3.1-i23d": tripo1004,
  "tripo-h3.1-multiview": tripo1004,
};

/**
 * Whether a run holds a value WaveSpeed cannot serve for this model.
 * @param model - The model.
 * @param input - The run's params.
 * @returns True when WaveSpeed refuses the run.
 */
export function holdsRefused(model: string, input: Run): boolean {
  return Object.entries(REFUSED[model] ?? {}).some(([param, values]) => values.includes(input.params[param]));
}

/**
 * Whether a run is outside a limit the model's vendor states.
 * @param model - The model.
 * @param input - The run's params and known clip lengths.
 * @returns True when no upstream may take it.
 */
export function outsideVendor(model: string, input: Run): boolean {
  return OUTSIDE_VENDOR[model]?.(input) === true;
}
