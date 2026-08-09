// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The options a generation parameter offers, read off whichever model is
 * active. Shared by the image and video panels and by the camera cluster
 * (#1896).
 *
 * A catalog parameter states its allowed values in one of two shapes, and a
 * reader that only understands the first makes the second's group vanish:
 *
 * - a `values` list (every image parameter, and video aspect ratio /
 *   resolution / audio; `seedance-2.0` states duration this way too, as
 *   `[5, 10, 15]`)
 * - `min` + `max` bounds — how `kling-o3-pro` states duration (3 to 15
 *   seconds), and how the image-to-video entries state theirs
 *
 * Ranges expand one step per second, matching how the reference design lists
 * durations one by one (user 2026-08-08). Seconds are the unit these bounds
 * are in, which is why the step is a whole one and fractional bounds are
 * pulled inward to whole seconds rather than offered as halves.
 */

import type { ModelEntry } from '@breatic/shared';

/**
 * A value a parameter can take — the catalog's own type, which is what gets
 * stored on the node and submitted upstream.
 */
export type ParamOptionValue = string | number | boolean;

/**
 * The allowed values of one model parameter, in the catalog's own types.
 *
 * Types are preserved rather than stringified: duration and focal length are
 * numbers upstream, so a display string would both reach the provider as `"5"`
 * instead of `5` and stop the control from recognizing its own current value
 * (`'5' === 5` is false, so nothing would read as selected). Callers render
 * with `String(v)`.
 *
 * `values` wins when a descriptor carries both shapes: a list is the more
 * precise statement — it can skip values a range would include, so a model
 * accepting only 4, 6 and 8 seconds must not be offered 5 and 7.
 * @param model - The model whose parameter definitions to read.
 * @param key - The parameter name (`aspect_ratio` / `resolution` / `duration`).
 * @returns The allowed values; empty when the parameter is absent or declares
 *   neither shape usefully.
 */
export function paramValues(model: ModelEntry, key: string): ParamOptionValue[] {
  const descriptor = model.params?.[key];
  if (!descriptor) return [];

  // model.params is trusted (the catalog is sanitized at the API boundary):
  // `values` is a readonly array or undefined, so a truthiness check suffices.
  if (descriptor.values) return [...descriptor.values];

  return expandRange(descriptor.min, descriptor.max);
}

/**
 * Whole-number steps across an inclusive range.
 *
 * Both bounds are required: one alone says nothing about where the other end
 * is, and guessing it would offer the user values the model may reject. A
 * non-finite bound is refused rather than clamped — the catalog is sanitized
 * upstream, so one arriving as NaN or Infinity means something is wrong, and
 * looping on it would not terminate.
 * @param min - Lower bound, inclusive.
 * @param max - Upper bound, inclusive.
 * @returns One number per whole step; empty when the range is unusable.
 */
function expandRange(min: number | undefined, max: number | undefined): number[] {
  if (typeof min !== 'number' || typeof max !== 'number') return [];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];

  // Pull fractional bounds inward: the labels are whole seconds, so a range of
  // 3.5 to 6.5 offers 4, 5 and 6 rather than inventing half-second options.
  const first = Math.ceil(min);
  const last = Math.floor(max);
  if (first > last) return [];

  const out: number[] = [];
  for (let v = first; v <= last; v += 1) out.push(v);
  return out;
}
