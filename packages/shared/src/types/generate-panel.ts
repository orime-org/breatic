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
 * So the facts live here, the panels read them, the answer reads them, and a
 * test on each side pins its own table against these. A control added or a
 * slot moved changes one place and both sides follow.
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
    "voice_id",
    "reference_id",
    "lyrics",
  ],
};
