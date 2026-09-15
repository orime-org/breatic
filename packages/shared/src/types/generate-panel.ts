// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a generate panel offers, per node type (#261).
 *
 * A model's catalog entry says what the upstream accepts. What a person can
 * actually set is decided here: which of a model's parameters arrive by
 * pointing at another node, and which of the rest the panel draws a control
 * for. Both facts were written only in the panels until the agent started
 * answering "what can this node do" out of the same question -- and an answer
 * read off the catalog alone tells a reader to set fields that have no
 * control and to supply URLs the canvas fills.
 *
 * So the facts live here, the answer reads them, and a test on the panel side
 * derives the same facts from the panels' own definitions and asserts the two
 * agree. A control added or a slot moved is written in both places, and the
 * one that falls behind is named by a failing assertion.
 */

import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/**
 * The parameter names each mode fills by pointing at another node.
 *
 * Two gestures reach the same place: a slot is picked (click the slot, then
 * click a node) and a reference is a relationship (`images`, the only one).
 * Both leave the reader nothing to type, which is what this answers.
 *
 * Keyed by mode because a model can serve several: the image-to-video entry
 * also serves first-last-frame and declares the end frame for it, and asked
 * about image-to-video it would otherwise report a slot that mode has not.
 */
export const MODE_SOURCE_FIELDS: Readonly<
  Record<GenerationNodeType, Readonly<Record<string, readonly string[]>>>
> = {
  image: {
    t2i: ["style_images"],
    i2i: ["images", "style_images"],
  },
  video: {
    t2v: [],
    i2v: ["image"],
    first_last: ["image", "end_image"],
    animate: ["image", "video"],
    ref: ["images", "video"],
    talking_head: ["image", "audio"],
  },
  audio: {
    tts: [],
    voice_clone: ["audio"],
    sfx: [],
    t2m: [],
    a2m: ["song", "voice", "instrumental"],
  },
};

/**
 * The parameter names each node's panel draws a control for.
 *
 * A panel draws the controls it has been given, not one per declared
 * parameter, so a parameter absent from here runs at whatever the upstream
 * defaults to and nobody can change it by hand. The answer says so rather
 * than presenting it as a field to fill.
 *
 * The voice choice is absent on purpose: its two vendors spell it differently
 * (`voice_id` and `reference_id`) and the picker finds it by the
 * `remote_source` marker rather than by name, so naming it here would copy a
 * rule out as an enumeration that the next vendor's spelling falls out of.
 */
export const PANEL_PARAM_CONTROLS: Readonly<
  Record<GenerationNodeType, readonly string[]>
> = {
  image: [
    "aspect_ratio",
    "resolution",
    "camera",
    "lens",
    "focal_length",
    "aperture",
    "enable_camera",
  ],
  video: [
    "aspect_ratio",
    "resolution",
    "duration",
    "generate_audio",
    "keep_original_sound",
  ],
  audio: [
    "stability",
    "similarity",
    "speed",
    "volume",
    "is_instrumental",
    "duration",
    "lyrics",
  ],
};

/**
 * Controls a panel mounts only once one of its source slots holds something.
 *
 * `keep_original_sound` says whether to carry the reference clip's own audio
 * over, so the video panel offers it only when a clip has been picked — and
 * reference-to-video runs perfectly well without one. Read off
 * {@link PANEL_PARAM_CONTROLS} alone the switch looks unconditional, and a
 * reader told to set it finds three rows in the pill and no switch.
 *
 * Keyed by the parameter and valued by the source parameter it waits on, so
 * the answer can name what to fill first rather than only that something is
 * missing.
 */
export const CONTROL_NEEDS_SOURCE: Readonly<
  Record<GenerationNodeType, Readonly<Record<string, string>>>
> = {
  image: {},
  video: { keep_original_sound: "video" },
  audio: {},
};
