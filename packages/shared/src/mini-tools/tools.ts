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
    guide: "cuts the subject out onto a transparent background",
    icon: "Eraser",
    params: [],
    slots: [],
    outputs: [{ modality: "image", namePrefix: "NOBG" }],
    sourceParam: "image",
  },
  {
    id: "image.upscale",
    source: "image",
    run: { kind: "model", model: "pro-upscaler" },
    labelKey: key("image.upscale", "label"),
    guide: "makes the picture larger and sharper, at 2K, 4K or 8K",
    icon: "Maximize2",
    params: [
      {
        key: "target_megapixels",
        sizeTiers: [
          { label: "2K", longEdge: 2048 },
          { label: "4K", longEdge: 4096 },
          { label: "8K", longEdge: 8192 },
        ],
      },
      { key: "creativity" },
    ],
    slots: [],
    outputs: [{ modality: "image", namePrefix: "UPSCALE" }],
    sourceParam: "image",
  },
  {
    id: "image.digital-human",
    source: "image",
    run: { kind: "model", model: "seedance-2.5-talking-avatar" },
    labelKey: key("image.digital-human", "label"),
    guide: "turns a picture of a person into a video of them speaking a sound you pick",
    icon: "UserRound",
    params: [{ key: "resolution" }],
    slots: [slot("image.digital-human", "audio", "audio", "audio")],
    outputs: [{ modality: "video", namePrefix: "AVATAR" }],
    sourceParam: "image",
    prompt: { placeholderKey: key("image.digital-human", "prompt") },
  },
  {
    id: "image.crop",
    source: "image",
    run: { kind: "browser" },
    labelKey: key("image.crop", "label"),
    guide: "keeps part of the picture, at a ratio or a size in pixels",
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
    guide: "turns the picture by quarter turns or flips it",
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
    guide: "raises the video to a higher resolution while keeping what is in the frame",
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
    guide: "adds frames between the existing ones so motion plays smoother",
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
    guide: "continues the video past its end with a part you describe",
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
    guide: "changes the whole video as you describe, optionally guided by reference pictures and sounds",
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
    guide: "makes the character in a picture you pick copy the movement in the video, keeping its sound",
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
    guide: "puts the character in a picture you pick through the video's movement in a scene you describe",
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
    guide: "keeps part of the frame, at a ratio or a size in pixels",
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
    guide: "plays the video faster or slower",
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
    guide: "keeps a stretch of the video between two times",
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
    guide: "changes exposure, colour and other picture settings",
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
    guide: "cleans background noise out of the video's sound",
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
    guide: "steadies shaky footage",
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
    guide: "converts the video to HDR",
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
    guide: "splits a track into the voice and the backing",
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
    guide: "continues the sound past its end with a part you describe",
    icon: "Timer",
    params: [{ key: "append_duration" }, { key: "ambience" }, { key: "double_output" }],
    slots: [],
    outputs: [{ modality: "audio", namePrefix: "EXTEND" }],
    sourceParam: "audio",
    prompt: { placeholderKey: key("audio.extend", "prompt") },
  },
];
