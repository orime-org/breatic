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
 * Wire shape a source param field carries — `"list"` (an array of URL strings,
 * e.g. `images`) or `"single"` (one URL string, e.g. `image` / `video_url`).
 * The worker reads each field by exactly this shape (list fields are iterated,
 * single fields used directly), so the gate must mirror it: a bare string in a
 * `"list"` field is a guaranteed-failure input, not a source.
 */
type SourceFieldShape = "list" | "single";

/**
 * source type → the param fields that carry it on the wire, each tagged with the
 * shape the worker reads it as. A source of a type is "present" when ANY of its
 * fields holds a value shaped the way the worker will consume it. Grounded in
 * config source params + worker transports (image: `images` is a list, `image` /
 * `end_image` single; video / audio fields all single).
 */
const SOURCE_TYPE_PARAM_FIELDS: Readonly<
  Record<SourceType, ReadonlyArray<readonly [field: string, shape: SourceFieldShape]>>
> = {
  image: [["images", "list"], ["image", "single"], ["end_image", "single"]],
  video: [["video", "single"], ["video_url", "single"]],
  audio: [["audio", "single"], ["audio_url", "single"], ["ref_audio_url", "single"]],
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
 * Whether a source of `type` is present in a submitted params payload, checking
 * each carrier field by the shape the worker reads it as. `params` is
 * `z.record(z.unknown())` on the wire (zod does not shape-check it), so this
 * guards against a crafted request putting the wrong shape in a source field:
 * a `"list"` field counts only as a non-empty array with at least one non-empty
 * string URL; a `"single"` field counts only as a non-empty string.
 * @param type - The source type to look for.
 * @param params - The submitted task params.
 * @returns True when the params carry at least one usable source of that type.
 */
function hasSource(type: SourceType, params: Record<string, unknown>): boolean {
  for (const [field, shape] of SOURCE_TYPE_PARAM_FIELDS[type]) {
    const value = params[field];
    const present =
      shape === "list"
        ? Array.isArray(value) &&
          value.some((entry) => typeof entry === "string" && entry.length > 0)
        : typeof value === "string" && value.length > 0;
    if (present) return true;
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
 * in params. Applied by the server BEFORE enqueue so no task row / job is
 * created for an input the model would reject. (Not a billing guard: billing is
 * post-success, so a source-less run that reached the worker would fail and
 * never bill anyway — the gate saves the doomed attempt, not the credits.) The
 * SAME `sourcesByMode` the frontend reads drives this — one rule, checked here
 * against params.
 * @param sourcesByMode - The model's per-mode source requirements ({@link computeSourcesByMode}); the catalog carries it precomputed.
 * @param params - The submitted task params (`params.images` / `video_url` / … are the source carriers).
 * @returns True when a required source type is missing → reject before enqueue.
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
