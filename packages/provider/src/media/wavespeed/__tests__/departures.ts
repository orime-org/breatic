// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { isPresent } from "../../../pricing/estimate.js";

/** Where the WaveSpeed bindings depart from what today's code sends, for the fixture tests that compare the two. */

/** Models WaveSpeed no longer serves (absent from `/api/v3/models`, rechecked on 2026-11-02): they carry no WaveSpeed binding. */
export const OFF_WAVESPEED: ReadonlySet<string> = new Set(["veed-clean-audio", "recraft-v4-style-text-to-image"]);

/**
 * Where a binding departs from today's body on purpose, by model: a field renamed to the
 * name WaveSpeed's schema gives it (WaveSpeed takes both and echoes the schema's name,
 * probed 2026-11-01), or a field left out because WaveSpeed's schema has none and it
 * ignores the field (inner#1872, inner#1873).
 */
export const DEPARTURES: Readonly<Record<string, { rename?: Record<string, string>; omit?: string[]; prompt?: (prompt: string) => string }>> = {
  // WaveSpeed's prompt description names reference videos <VIDEO_REF_0>, ... from 0; today's prompt writes "the reference video 1".
  "gemini-omni-1.1-flash-reference-to-video": { prompt: (prompt) => prompt.replace(/the reference video (\d+)/g, (_m, n: string) => `<VIDEO_REF_${Number(n) - 1}>`) },
  "flux-3-start-end-to-video": { rename: { start_image: "image", end_image: "last_image" } },
  "muse-image-edit": { rename: { image_urls: "images" } },
  "wan-3.0-text-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-image-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-reference-to-video": { rename: { enable_audio: "generate_audio" } },
  "elevenlabs-v3": { omit: ["similarity"] },
  "sfx-1.6-text-to-audio": { omit: ["ambience", "double_output"] },
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
 * Whether a Seedance 2.5 run asks for 4K, which ByteDance's Seedance 2.5 does not output.
 * @param run - The run.
 * @returns True when it does.
 */
const seedance4k = (run: Run): boolean => run.params.resolution === "4k";

/**
 * Whether a Tripo run holds an input pair Tripo refuses with error 1004: texture quality fast on a texture version
 * other than v3.5, or parts with texture or PBR on (each on by default).
 * @param run - The run.
 * @returns True when it does.
 */
const tripo1004 = (run: Run): boolean => (run.params.texture_quality === "fast" && run.params.texture_version !== "v3.5")
  || (run.params.generate_parts === true && !(run.params.texture === false && run.params.pbr === false));

/**
 * Runs outside a limit the model's vendor states, by model, in the vendor's words: the model's own `rejects` refuse
 * them on every upstream. Today's code estimated them on WaveSpeed.
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
  // ByteDance: "Dreamina Seedance 2.5: Default 720p; supports 480p, 720p, and 1080p".
  "seedance-2.5-text-to-video": seedance4k,
  "seedance-2.5-image-to-video": seedance4k,
  "seedance-2.5-video-extend": seedance4k,
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
