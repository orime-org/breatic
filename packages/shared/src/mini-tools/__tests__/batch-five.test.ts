// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  CONTAINER_OPS,
  defaultParamsOf,
  miniToolById,
  miniToolRequestSchema,
  miniToolsFor,
  outputsOf,
} from "@shared/mini-tools/index.js";
import { defaultDynamicsValue } from "@shared/audio-dynamics.js";
import { defaultEqValue } from "@shared/audio-eq.js";

// inner#1305: the container edits in the order the submenu lists them, then the model tools.
const AUDIO_TOOLS = [
  ["audio.denoise", "denoise", "DENOISE", "AudioLines"],
  ["audio.normalize", "normalize", "LOUDNESS", "Volume2"],
  ["audio.speed", "audio_speed", "SPEED", "Gauge"],
  ["audio.cut", "audio_cut", "CUT", "Scissors"],
  ["audio.eq", "eq", "EQ", "SlidersVertical"],
  ["audio.compress", "compress", "COMPRESS", "Shrink"],
  ["audio.pan", "pan", "PAN", "MoveHorizontal"],
  ["audio.reverb", "reverb", "REVERB", "Waves"],
  ["audio.voice", "voice", "VOICE", "Mic"],
  ["audio.pitch", "pitch", "PITCH", "Music2"],
] as const;

describe("batch-five audio tools", () => {
  it("lists the ten container edits, then enhance, separate and extend", () => {
    expect(miniToolsFor("audio").map((tool) => tool.id)).toEqual([
      ...AUDIO_TOOLS.map(([id]) => id),
      "audio.enhance",
      "audio.separate",
      "audio.extend",
    ]);
  });

  it("runs each edit in the container on its own operation, one audio out, with its prefix and icon", () => {
    for (const [id, op, prefix, icon] of AUDIO_TOOLS) {
      const tool = miniToolById(id);
      expect(tool?.source, id).toBe("audio");
      expect(tool?.run, id).toEqual({ kind: "container", op });
      expect(tool?.icon, id).toBe(icon);
      expect(tool?.sourceParam, id).toBe("audio");
      expect(tool && outputsOf(tool, defaultParamsOf(tool)).map((o) => [o.modality, o.namePrefix]), id).toEqual([
        ["audio", prefix],
      ]);
      expect(CONTAINER_OPS, id).toContain(op);
    }
  });

  it("pins enhance to the veed cleanup model and shows its strength as a percentage", () => {
    const enhance = miniToolById("audio.enhance");
    expect(enhance?.run).toEqual({ kind: "model", model: "veed-clean-audio" });
    expect(enhance?.params).toEqual([{ key: "strength", display: "percent" }]);
    expect(enhance?.icon).toBe("Sparkles");
    expect(enhance && outputsOf(enhance, {}).map((o) => [o.modality, o.namePrefix])).toEqual([["audio", "ENHANCE"]]);
  });

  it("starts every edit on its confirmed defaults", () => {
    const defaults = Object.fromEntries(
      AUDIO_TOOLS.map(([id]) => {
        const tool = miniToolById(id);
        return [id, tool && defaultParamsOf(tool)];
      }),
    );
    expect(defaults).toEqual({
      "audio.denoise": { intensity: 50 },
      "audio.normalize": { target: "-16" },
      "audio.speed": { rate: 1, keepPitch: true },
      "audio.cut": { range: null },
      "audio.eq": { eq: defaultEqValue },
      "audio.compress": { dynamics: defaultDynamicsValue },
      "audio.pan": { pan: 0, width: 100 },
      "audio.reverb": { room: "large_room", amount: 50 },
      "audio.voice": { intensity: 50 },
      "audio.pitch": { semitones: 0, cents: 0 },
    });
  });

  it("offers the four loudness targets with the platform each serves", () => {
    const normalize = miniToolById("audio.normalize");
    const target = normalize?.params.find((p) => p.key === "target");
    expect(target).toEqual({
      kind: "enum",
      key: "target",
      default: "-16",
      options: [
        { value: "-14", label: "−14 LUFS · Spotify / YouTube" },
        { value: "-16", label: "−16 LUFS · Podcasts" },
        { value: "-23", label: "−23 LUFS · EBU R128" },
        { value: "-24", label: "−24 LUFS · ATSC A/85" },
      ],
    });
  });

  it("offers six reverb rooms by name", () => {
    const room = miniToolById("audio.reverb")?.params.find((p) => p.key === "room");
    expect(room && "options" in room && room.options).toEqual([
      { value: "small_room", label: "Small room" },
      { value: "medium_room", label: "Medium room" },
      { value: "large_room", label: "Large room" },
      { value: "church_hall", label: "Church hall" },
      { value: "cathedral", label: "Cathedral" },
      { value: "bathroom", label: "Bathroom" },
    ]);
  });

  it("reads pan as a balance and pitch as signed numbers", () => {
    const pan = miniToolById("audio.pan")?.params;
    expect(pan).toEqual([
      { kind: "number", key: "pan", default: 0, min: -100, max: 100, step: 1, format: "balance" },
      { kind: "number", key: "width", default: 100, min: 0, max: 200, step: 5, unit: "%" },
    ]);
    const pitch = miniToolById("audio.pitch")?.params;
    expect(pitch).toEqual([
      { kind: "number", key: "semitones", default: 0, min: -12, max: 12, step: 1, format: "signed" },
      { kind: "number", key: "cents", default: 0, min: -100, max: 100, step: 1, format: "signed" },
    ]);
  });

  it("keeps the video speed's range and adds keep-pitch on audio", () => {
    expect(miniToolById("audio.speed")?.params).toEqual([
      { kind: "number", key: "rate", default: 1, min: 0.25, max: 4, step: 0.25, unit: "×" },
      { kind: "toggle", key: "keepPitch", default: true },
    ]);
  });
});

describe("batch-five request schema", () => {
  const base = {
    project_id: "00000000-0000-4000-8000-000000000001",
    space_id: "00000000-0000-4000-8000-000000000002",
    node_ids: ["00000000-0000-4000-8000-000000000003"],
    source: { url: "https://cdn.example.com/a.m4a", duration: 12 },
    slots: {},
  };
  const parse = (tool: string, params: Record<string, unknown>): boolean =>
    miniToolRequestSchema.safeParse({ ...base, tool, params }).success;

  it("takes keep-pitch as a boolean only", () => {
    expect(parse("audio.speed", { rate: 1.5, keepPitch: false })).toBe(true);
    expect(parse("audio.speed", { rate: 1.5, keepPitch: "no" })).toBe(false);
  });

  it("takes ten band gains within range under a known preset or custom", () => {
    expect(parse("audio.eq", { eq: { preset: "custom", gains: [12, -12, 0, 0, 0, 0, 0, 0, 0, 3] } })).toBe(true);
    expect(parse("audio.eq", { eq: { preset: "voice", gains: [-6, -4, -2, 0, 0, 2, 3, 3, 1, 0] } })).toBe(true);
    expect(parse("audio.eq", { eq: { preset: "custom", gains: [13, 0, 0, 0, 0, 0, 0, 0, 0, 0] } })).toBe(false);
    expect(parse("audio.eq", { eq: { preset: "custom", gains: [0, 0, 0] } })).toBe(false);
    expect(parse("audio.eq", { eq: { preset: "loud", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } })).toBe(false);
  });

  it("holds each compressor setting to its range", () => {
    const ok = { preset: "custom", threshold: -60, ratio: 20, attack: 0.1, release: 2000, makeup: 24 };
    expect(parse("audio.compress", { dynamics: ok })).toBe(true);
    expect(parse("audio.compress", { dynamics: { ...ok, ratio: 0.5 } })).toBe(false);
    expect(parse("audio.compress", { dynamics: { ...ok, threshold: 1 } })).toBe(false);
    expect(parse("audio.compress", { dynamics: { ...ok, extra: 1 } })).toBe(false);
  });

  it("takes an audio cut's range", () => {
    expect(parse("audio.cut", { range: { start: 1, end: 3 } })).toBe(true);
    expect(parse("audio.cut", { range: { start: 3, end: 1 } })).toBe(false);
  });

  it("takes enhance's strength as its only key", () => {
    expect(parse("audio.enhance", { strength: 0.85 })).toBe(true);
    expect(parse("audio.enhance", { strength: 0.85, target_lufs: -10 })).toBe(false);
  });
});
