// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The join tool (inner#1825, CAP-6): clips of one medium run end to end in the
 * mini-tool container, the source first and the `clips` slot after it in
 * order, with an optional crossfade between neighbours.
 */

import { describe, expect, it } from "vitest";

import {
  CONTAINER_OPS,
  defaultParamsOf,
  miniToolById,
  miniToolRequestSchema,
  outputsOf,
  type MiniToolSlotValue,
} from "@shared/mini-tools/index.js";

const JOINS = [
  { id: "video.join", medium: "video", op: "join", prefix: "JOIN-VIDEO", maxCrossfade: 2 },
  { id: "audio.join", medium: "audio", op: "audio_join", prefix: "JOIN-AUDIO", maxCrossfade: 3 },
] as const;

describe("join tools", () => {
  it("adds the two join operations to the container's list", () => {
    expect(CONTAINER_OPS).toContain("join");
    expect(CONTAINER_OPS).toContain("audio_join");
  });

  it("runs each join in the container on its own operation, from a source of its medium", () => {
    for (const { id, medium, op } of JOINS) {
      const tool = miniToolById(id);
      expect(tool?.source, id).toBe(medium);
      expect(tool?.run, id).toEqual({ kind: "container", op });
    }
  });

  it("takes the clips after the source in one required list slot of the tool's own medium", () => {
    for (const { id, medium } of JOINS) {
      const slots = miniToolById(id)?.slots ?? [];
      expect(slots, id).toHaveLength(1);
      expect(slots[0], id).toMatchObject({ key: "clips", accepts: medium, many: true, required: true });
    }
  });

  it("offers a crossfade from 0 up to 2 s on video and 3 s on audio, in tenths, starting at 0", () => {
    for (const { id, maxCrossfade } of JOINS) {
      const tool = miniToolById(id);
      expect(tool?.params, id).toHaveLength(1);
      expect(tool?.params[0], id).toMatchObject({ kind: "number", key: "crossfade", default: 0, min: 0, max: maxCrossfade, step: 0.1 });
      expect(tool && defaultParamsOf(tool), id).toEqual({ crossfade: 0 });
    }
  });

  it("makes one result of its medium named with its own prefix", () => {
    for (const { id, medium, prefix } of JOINS) {
      const tool = miniToolById(id);
      expect(tool && outputsOf(tool, defaultParamsOf(tool)).map((o) => [o.modality, o.namePrefix]), id).toEqual([[medium, prefix]]);
    }
  });
});

describe("join request schema", () => {
  const base = {
    project_id: "00000000-0000-4000-8000-000000000001",
    space_id: "00000000-0000-4000-8000-000000000002",
    node_ids: ["00000000-0000-4000-8000-000000000003"],
  };
  // A clip in the browser draft remembers the node it came from and that
  // node's name (design 6.5); the request carries only its url and length.
  const clip = (n: number): MiniToolSlotValue => ({
    url: `https://cdn.example.com/clip-${String(n)}.mp4`,
    duration: 4,
    nodeId: `node-${String(n)}`,
    name: `Clip ${String(n)}`,
  });
  const sent = ({ url, duration }: MiniToolSlotValue): { url: string; duration?: number } =>
    duration === undefined ? { url } : { url, duration };

  it("takes a video join with its clips in order", () => {
    const parsed = miniToolRequestSchema.safeParse({
      ...base,
      tool: "video.join",
      source: { url: "https://cdn.example.com/clip-0.mp4", duration: 4 },
      params: { crossfade: 1 },
      slots: { clips: [clip(1), clip(2)].map(sent) },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.slots.clips).toEqual([
      { url: "https://cdn.example.com/clip-1.mp4", duration: 4 },
      { url: "https://cdn.example.com/clip-2.mp4", duration: 4 },
    ]);
  });

  it("holds the crossfade to each medium's range", () => {
    const join = (tool: string, crossfade: number): boolean =>
      miniToolRequestSchema.safeParse({
        ...base,
        tool,
        source: { url: "https://cdn.example.com/clip-0.m4a" },
        params: { crossfade },
        slots: { clips: [{ url: "https://cdn.example.com/clip-1.m4a" }] },
      }).success;
    expect(join("video.join", 2)).toBe(true);
    expect(join("video.join", 2.5)).toBe(false);
    expect(join("audio.join", 3)).toBe(true);
    expect(join("audio.join", 3.5)).toBe(false);
    expect(join("audio.join", -0.1)).toBe(false);
  });
});
