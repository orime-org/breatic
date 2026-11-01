// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Where the WaveSpeed bindings depart from what today's code sends, for the fixture tests that compare the two. */

/** Models WaveSpeed no longer serves (absent from `/api/v3/models` on 2026-11-01): they carry no WaveSpeed binding. */
export const OFF_WAVESPEED: ReadonlySet<string> = new Set(["meshy6-t23d", "veed-clean-audio", "recraft-v4-style-text-to-image", "sfx-1.6-extend-audio"]);

/**
 * Where a binding departs from today's body on purpose, by model: a field renamed to the
 * name WaveSpeed's schema gives it (WaveSpeed takes both and echoes the schema's name,
 * probed 2026-11-01), or a field left out because WaveSpeed's schema has none and it
 * ignores the field (inner#1872, inner#1873).
 */
export const DEPARTURES: Readonly<Record<string, { rename?: Record<string, string>; omit?: string[] }>> = {
  "flux-3-start-end-to-video": { rename: { start_image: "image", end_image: "last_image" } },
  "muse-image-edit": { rename: { image_urls: "images" } },
  "wan-3.0-text-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-image-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-reference-to-video": { rename: { enable_audio: "generate_audio" } },
  "elevenlabs-v3": { omit: ["similarity"] },
  "sfx-1.6-text-to-audio": { omit: ["ambience", "double_output"] },
  "hunyuan3d-v3-i23d": { omit: ["prompt"] },
  "hunyuan3d-v3.1-rapid": { omit: ["prompt"] },
};

/**
 * Values of ours WaveSpeed cannot serve, by model and param: those it refuses with a 400, and
 * a true for a switch it has no field for (probed 2026-11-01; inner#1872, inner#1873). Its
 * bindings keep them out (`supported`, or `drops: [false]`), so a run holding one is never sent to WaveSpeed.
 */
export const REFUSED: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> = {
  "hunyuan3d-v3": { generate_type: ["LowPoly"] },
  "hunyuan3d-v3-i23d": { generate_type: ["LowPoly"] },
  "nano-banana-2-relight": { output_format: ["webp"] },
  "nano-banana-2-quick-edit": { output_format: ["webp"] },
  "muse-image-edit": { aspect_ratio: ["9:21"] },
  "sfx-1.6-text-to-audio": { loop: [true], double_output: [true] },
};

/**
 * Whether a run's params hold a value WaveSpeed cannot serve for this model.
 * @param model - The model.
 * @param params - The run's params.
 * @returns True when some param holds such a value.
 */
export function holdsRefused(model: string, params: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(REFUSED[model] ?? {}).some(([param, values]) => values.includes(params[param]));
}
