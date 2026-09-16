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
 * What has to hold before one of these controls counts for anything.
 *
 * A panel offering a control is not the same as that control being live: the
 * reference-clip switch is not mounted until a clip is picked, the lyrics box
 * is taken away while the track is marked instrumental, and the four camera
 * wheels are drawn whatever the switch says while the run throws their values
 * out until it is on. Read off {@link PANEL_PARAM_CONTROLS} alone all three
 * look unconditional, and a reader told to set one gets nothing for it.
 *
 * One table for all three because they ask the same of a reader — do this
 * first, or setting it is wasted — and one clause in the answer can say so.
 */
export type ControlGate =
  /** That source parameter has to hold something first. */
  | { readonly kind: "source"; readonly param: string }
  /** That switch has to be on; the value is dropped while it is off. */
  | { readonly kind: "flagOn"; readonly param: string }
  /** That switch has to be off; the control goes away while it is on. */
  | { readonly kind: "flagOff"; readonly param: string };

/** The gate on each gated control, by node type and parameter name. */
export const CONTROL_GATES: Readonly<
  Record<GenerationNodeType, Readonly<Record<string, ControlGate>>>
> = {
  image: {
    camera: { kind: "flagOn", param: "enable_camera" },
    lens: { kind: "flagOn", param: "enable_camera" },
    focal_length: { kind: "flagOn", param: "enable_camera" },
    aperture: { kind: "flagOn", param: "enable_camera" },
  },
  video: { keep_original_sound: { kind: "source", param: "video" } },
  audio: { lyrics: { kind: "flagOff", param: "is_instrumental" } },
};

/**
 * What each mode is called, in the words its picker puts on screen.
 *
 * The mode code is nowhere in the panel: the selector renders this and
 * nothing else, so it is the only thing a reader can match an answer against.
 * Written a second time in the catalog it came out as `audio-to-music` and
 * `digital human`, two names no selector shows.
 *
 * English in every locale, the way the pickers hold them -- these read as the
 * product's names for the modes rather than as sentences to translate.
 */
export const MODE_LABELS: Readonly<
  Record<GenerationNodeType, Readonly<Record<string, string>>>
> = {
  image: {
    t2i: "Text to Image",
    i2i: "Image to Image",
  },
  video: {
    t2v: "Text to Video",
    i2v: "Image to Video",
    first_last: "First-Last Frame",
    animate: "Image Animation",
    ref: "Reference to Video",
    talking_head: "Talking Head",
  },
  audio: {
    tts: "Text to Speech",
    voice_clone: "Voice Cloning",
    sfx: "Sound Effects",
    t2m: "Text to Music",
    a2m: "Reference to Music",
  },
};

/**
 * The source parameter a reader fills by naming it in the prompt.
 *
 * Two gestures reach a source and they are not interchangeable. A slot is
 * picked: click the slot, click a node, done. The reference list is two steps
 * — an incoming edge puts an image in the pool, and an `@`-mention in the
 * prompt picks which of the pool this run uses. Told only to point a node at
 * this one, a reader wires an edge, presses Generate, and the run goes out
 * with no source at all.
 */
export const REFERENCE_POOL_PARAM = "images";
