// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every mini-tool, in the order each modality's Tools submenu lists them
 * (inner#888 §3, batch one). The one place a tool is declared: the server's
 * request schema, the worker's model and the web's menu and panel are all
 * read from here.
 */

import type { MiniToolSlot, MiniToolSpec, EnumParam, RectParam } from "@shared/mini-tools/types.js";

/**
 * The i18n key of a tool's own text.
 * @param id - The tool id.
 * @param leaf - The text's name under the tool.
 * @returns The key.
 */
function key(id: string, leaf: string): string {
  return `canvas.miniTool.${id}.${leaf}`;
}

/**
 * A slot filled from the canvas.
 * @param id - The tool id, for the banner key.
 * @param slotKey - The slot's key.
 * @param param - The pinned model's yaml param it fills.
 * @param accepts - The medium it takes.
 * @param many - Whether it takes a list.
 * @returns The slot.
 */
function slot(
  id: string,
  slotKey: string,
  param: string,
  accepts: MiniToolSlot["accepts"],
  many = false,
): MiniToolSlot {
  return { key: slotKey, param, accepts, many, bannerKey: key(id, `slot.${slotKey}`) };
}

/** The crop aspect choices (A9). */
const ASPECT: EnumParam = {
  kind: "enum",
  key: "aspect",
  default: "free",
  options: [
    { value: "free", label: "Free" },
    { value: "original", label: "Original" },
    { value: "1:1" },
    { value: "2:3" },
    { value: "3:2" },
    { value: "3:4" },
    { value: "4:3" },
    { value: "9:16" },
    { value: "16:9" },
  ],
};

const RECT: RectParam = { kind: "rect", key: "rect", aspect: "aspect" };

export const MINI_TOOLS: readonly MiniToolSpec[] = [
  {
    id: "image.remove-bg",
    source: "image",
    run: { kind: "model", model: "bria-remove-background" },
    labelKey: key("image.remove-bg", "label"),
    icon: "Eraser",
    params: [],
    slots: [],
    outputs: [{ modality: "image", namePrefix: "NOBG" }],
    sourceParam: "image",
  },
  {
    id: "image.upscale",
    source: "image",
    run: { kind: "model", model: "crystal-upscaler" },
    labelKey: key("image.upscale", "label"),
    icon: "Maximize2",
    params: [{ key: "target_megapixels" }, { key: "creativity" }],
    slots: [],
    outputs: [{ modality: "image", namePrefix: "UPSCALE" }],
    sourceParam: "image",
  },
  {
    id: "image.digital-human",
    source: "image",
    run: { kind: "model", model: "omnihuman-1.5" },
    labelKey: key("image.digital-human", "label"),
    icon: "UserRound",
    params: [],
    slots: [slot("image.digital-human", "audio", "audio", "audio")],
    outputs: [{ modality: "video", namePrefix: "AVATAR" }],
    sourceParam: "image",
  },
  {
    id: "image.crop",
    source: "image",
    run: { kind: "browser" },
    labelKey: key("image.crop", "label"),
    icon: "Crop",
    params: [ASPECT, RECT],
    slots: [],
    outputs: [{ modality: "image", namePrefix: "CROP" }],
    sourceParam: "image",
  },
  {
    id: "image.rotate",
    source: "image",
    run: { kind: "browser" },
    labelKey: key("image.rotate", "label"),
    icon: "RotateCw",
    params: [{ kind: "orient", key: "orient" }],
    slots: [],
    outputs: [{ modality: "image", namePrefix: "ROTATE" }],
    sourceParam: "image",
  },
  {
    id: "video.upscale",
    source: "video",
    run: { kind: "model", model: "seedvr2-video" },
    labelKey: key("video.upscale", "label"),
    icon: "Maximize2",
    params: [{ key: "target_resolution" }],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "UPSCALE" }],
    sourceParam: "video",
  },
  {
    id: "video.interpolate",
    source: "video",
    run: { kind: "model", model: "rife-interpolation" },
    labelKey: key("video.interpolate", "label"),
    icon: "GalleryVerticalEnd",
    params: [],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "SMOOTH" }],
    sourceParam: "video",
  },
  {
    id: "video.extend",
    source: "video",
    run: { kind: "model", model: "seedance-2.5-video-extend" },
    labelKey: key("video.extend", "label"),
    icon: "StretchHorizontal",
    params: [{ key: "resolution" }, { key: "duration" }, { key: "generate_audio" }],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "EXTEND" }],
    sourceParam: "video",
    prompt: { placeholderKey: key("video.extend", "prompt") },
  },
  {
    id: "video.edit",
    source: "video",
    run: { kind: "model", model: "wan-3.0-video-edit" },
    labelKey: key("video.edit", "label"),
    icon: "Wand2",
    params: [
      { key: "resolution" },
      { key: "duration" },
      { key: "generate_audio" },
      { key: "enable_prompt_expansion" },
    ],
    slots: [
      slot("video.edit", "images", "reference_images", "image", true),
      slot("video.edit", "audios", "reference_audios", "audio", true),
    ],
    outputs: [{ modality: "video", namePrefix: "EDIT" }],
    sourceParam: "video",
    prompt: { placeholderKey: key("video.edit", "prompt") },
  },
  {
    id: "video.motion",
    source: "video",
    run: { kind: "model", model: "kling-v3-pro-motion" },
    labelKey: key("video.motion", "label"),
    icon: "PersonStanding",
    params: [{ key: "character_orientation" }, { key: "keep_original_sound" }, { key: "negative_prompt" }],
    slots: [slot("video.motion", "character", "image", "image")],
    outputs: [{ modality: "video", namePrefix: "MOTION" }],
    sourceParam: "video",
    prompt: { placeholderKey: key("video.motion", "prompt") },
  },
  {
    id: "video.animate",
    source: "video",
    run: { kind: "model", model: "wan-2.2-animate-2" },
    labelKey: key("video.animate", "label"),
    icon: "Clapperboard",
    params: [{ key: "motion_prompt" }, { key: "resolution" }],
    slots: [slot("video.animate", "character", "image", "image")],
    outputs: [{ modality: "video", namePrefix: "ANIMATE" }],
    sourceParam: "video",
    prompt: { placeholderKey: key("video.animate", "prompt") },
  },
  {
    id: "video.crop",
    source: "video",
    run: { kind: "container", op: "crop" },
    labelKey: key("video.crop", "label"),
    icon: "Crop",
    params: [ASPECT, RECT],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "CROP" }],
    sourceParam: "video",
  },
  {
    id: "video.speed",
    source: "video",
    run: { kind: "container", op: "speed" },
    labelKey: key("video.speed", "label"),
    icon: "Gauge",
    params: [{ kind: "number", key: "rate", default: 1, min: 0.25, max: 4, step: 0.25, unit: "×" }],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "SPEED" }],
    sourceParam: "video",
  },
  {
    id: "video.cut",
    source: "video",
    run: { kind: "container", op: "cut" },
    labelKey: key("video.cut", "label"),
    icon: "Scissors",
    params: [{ kind: "range", key: "range" }],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "CUT" }],
    sourceParam: "video",
  },
  {
    id: "video.adjust",
    source: "video",
    run: { kind: "container", op: "adjust" },
    labelKey: key("video.adjust", "label"),
    icon: "SlidersHorizontal",
    params: [{ kind: "adjust", key: "value" }],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "ADJUST" }],
    sourceParam: "video",
  },
  {
    id: "video.audio-denoise",
    source: "video",
    run: { kind: "container", op: "audio_denoise" },
    labelKey: key("video.audio-denoise", "label"),
    icon: "AudioLines",
    params: [{ kind: "number", key: "intensity", default: 50, min: 1, max: 100, step: 1 }],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "DENOISE" }],
    sourceParam: "video",
  },
  {
    id: "video.stabilize",
    source: "video",
    run: { kind: "container", op: "stabilize" },
    labelKey: key("video.stabilize", "label"),
    icon: "Crosshair",
    params: [
      { kind: "number", key: "shakiness", default: 5, min: 1, max: 10, step: 1 },
      { kind: "number", key: "smoothing", default: 10, min: 1, max: 30, step: 1 },
    ],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "STABLE" }],
    sourceParam: "video",
  },
  {
    id: "video.hdr",
    source: "video",
    run: { kind: "container", op: "hdr" },
    labelKey: key("video.hdr", "label"),
    icon: "Sun",
    params: [
      {
        kind: "enum",
        key: "transfer",
        default: "pq",
        options: [{ value: "pq" }, { value: "hlg" }],
      },
    ],
    slots: [],
    outputs: [{ modality: "video", namePrefix: "HDR" }],
    sourceParam: "video",
  },
  {
    id: "audio.separate",
    source: "audio",
    run: { kind: "model", model: "vocal-remover" },
    labelKey: key("audio.separate", "label"),
    icon: "SplitSquareVertical",
    params: [],
    slots: [],
    outputs: [
      { modality: "audio", namePrefix: "VOCALS" },
      { modality: "audio", namePrefix: "INSTRUMENTAL" },
    ],
    sourceParam: "audio",
  },
  {
    id: "audio.extend",
    source: "audio",
    run: { kind: "model", model: "sfx-1.6-extend-audio" },
    labelKey: key("audio.extend", "label"),
    icon: "Timer",
    params: [{ key: "append_duration" }, { key: "ambience" }, { key: "double_output" }],
    slots: [],
    outputs: [{ modality: "audio", namePrefix: "EXTEND" }],
    sourceParam: "audio",
    prompt: { placeholderKey: key("audio.extend", "prompt") },
  },
];
