// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Cross-modality execute-gate rule (#1675). THE single source of truth for
 * "which source inputs does a generation mode require". Lives in domain
 * (backend-only); the frontend never runs this — the catalog projection
 * ships the computed {@link ModelEntry.sourcesByMode} on the wire and the
 * Generate panel reads that. The server calls {@link violatesSourceRequirement}
 * directly (it can import domain), applying the SAME rule to the submitted
 * params. One rule, two consumers (frontend via wire, server via call),
 * differing only in the runtime data each checks (references vs params).
 *
 * `edit` / `upscale` need different source types per modality (image-edit
 * needs an image, video-edit needs a video), so the mode→source map is keyed
 * by (modality, mode), not mode alone.
 */

import type { SourceType } from "@breatic/shared";

/**
 * (modality, mode) → the source types that mode requires. A mode absent from a
 * modality's map (or a modality absent here) needs no source (text-to-X). Every
 * entry is grounded in config/models/<modality>/*.yaml source params (audit
 * 2026-07-15); a `model-config-liveness`-style guard pins that config modes stay
 * covered. `talking_head` needs TWO source types (image + audio).
 */
const MODE_REQUIRED_SOURCES: Readonly<
  Record<string, Readonly<Record<string, readonly SourceType[]>>>
> = {
  image: {
    i2i: ["image"],
    edit: ["image"],
    upscale: ["image"],
    remove_bg: ["image"],
  },
  video: {
    i2v: ["image"],
    animate: ["image"],
    motion: ["image"],
    ref: ["image"],
    talking_head: ["image", "audio"],
    edit: ["video"],
    extend: ["video"],
    upscale: ["video"],
    interpolate: ["video"],
  },
  audio: {
    a2m: ["audio"],
    separate: ["audio"],
  },
  tts: {
    voice_clone: ["audio"],
  },
  three_d: {
    i23d: ["image"],
  },
};

/**
 * source type → the param field names that carry it on the wire. A source of a
 * type is "present" when ANY of its fields holds a non-empty value. Grounded in
 * config source params (image: images/image/end_image; video: video/video_url;
 * audio: audio/audio_url/ref_audio_url).
 */
const SOURCE_TYPE_PARAM_FIELDS: Readonly<Record<SourceType, readonly string[]>> = {
  image: ["images", "image", "end_image"],
  video: ["video", "video_url"],
  audio: ["audio", "audio_url", "ref_audio_url"],
};

/**
 * Required source types for one (modality, mode).
 * @param modality - Model modality (e.g. "image", "video").
 * @param mode - A single mode string.
 * @returns The source types that mode needs; empty when it needs none.
 */
function sourcesForMode(modality: string, mode: string): readonly SourceType[] {
  return MODE_REQUIRED_SOURCES[modality]?.[mode] ?? [];
}

/**
 * Compute the wire {@link ModelEntry.sourcesByMode}: each of a model's modes →
 * the source types it requires. Called by the catalog projection so the
 * frontend can read `sourcesByMode[activeMode]` without running any rule.
 * @param modality - The model's modality.
 * @param mode - The model's `mode` (a single string or an array of modes).
 * @returns A map from each mode to its required source types.
 */
export function computeSourcesByMode(
  modality: string,
  mode: string | string[],
): Record<string, SourceType[]> {
  const modes = Array.isArray(mode) ? mode : [mode];
  const out: Record<string, SourceType[]> = {};
  for (const m of modes) {
    out[m] = [...sourcesForMode(modality, m)];
  }
  return out;
}

/**
 * Whether a source of `type` is present in a submitted params payload — true
 * when any of the type's carrier fields holds a non-empty value (non-empty
 * array, or a non-empty string).
 * @param type - The source type to look for.
 * @param params - The submitted task params.
 * @returns True when the params carry at least one source of that type.
 */
function hasSource(type: SourceType, params: Record<string, unknown>): boolean {
  for (const field of SOURCE_TYPE_PARAM_FIELDS[type]) {
    const value = params[field];
    if (Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Server-side execute gate (#1675): does this model's per-mode source
 * requirement go unmet by the submitted params?
 *
 * A model that can run source-less (ANY mode needs no source — e.g. a HYBRID
 * `["t2i","i2i"]`, or any t2i/t2v/…) is NOT gated: an image-less submission is
 * a valid text-to-X run. Only a model whose EVERY mode needs a source is
 * gated, and then every required source type (across its modes) must be present
 * in params. Applied by the server BEFORE enqueue so no task row / bill is
 * created for an input the model would reject. The SAME `sourcesByMode` the
 * frontend reads drives this — one rule, checked here against params.
 * @param sourcesByMode - The model's per-mode source requirements ({@link computeSourcesByMode}); the catalog carries it precomputed.
 * @param params - The submitted task params (`params.images` / `video_url` / … are the source carriers).
 * @returns True when a required source type is missing → reject before billing.
 */
export function violatesSourceRequirement(
  sourcesByMode: Record<string, SourceType[]>,
  params: Record<string, unknown>,
): boolean {
  const modes = Object.values(sourcesByMode);
  if (modes.length === 0) return false; // unknown model — existence is not this gate's job
  // Source-less escape hatch: any mode needing no source means the model can
  // run from scratch (t2i-like / hybrid), so an empty-source submission is valid.
  if (modes.some((sources) => sources.length === 0)) return false;
  // Every mode needs a source → require each source type any mode demands.
  const required = new Set<SourceType>(modes.flat());
  for (const type of required) {
    if (!hasSource(type, params)) return true;
  }
  return false;
}
