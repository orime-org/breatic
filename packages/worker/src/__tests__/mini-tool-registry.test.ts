// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Registry tests — guard the V1 image mini-tool roster.
 *
 * Per `design/project/02-mini-tool-system.md` §2.2 V1 ships
 * remove-bg / upscale (+ inpaint when its overlay-driven param UI
 * lands). Every other image entry was trimmed in B5. Tests below
 * pin both halves so accidental re-introduction or accidental
 * deletion of the survivors trips CI.
 *
 * No storage / HTTP / FFmpeg touched — pure map lookups.
 */

import { initCore } from "@breatic/core";
import { getFullModelConfig } from "@breatic/domain";
import { beforeAll, describe, it, expect } from "vitest";

import { MINI_TOOL_REGISTRY, resolveMiniToolEntry } from "../mini-tool-registry.js";

beforeAll(() => {
  // The catalog loads through core; nothing here opens the database.
  initCore({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://localhost:5432/breatic_test" });
});

/** Each provider slot and the model the design fixes for it (#2156, design §7). */
const PROVIDER_SLOTS: ReadonlyArray<readonly [string, string, string]> = [
  ["image", "remove-bg", "bria-remove-background"],
  ["image", "upscale", "crystal-upscaler"],
  ["video", "upscale", "seedvr2-video"],
  ["video", "interpolate", "rife-interpolation"],
  ["video", "extend", "seedance-2.5-video-extend"],
  ["video", "edit", "wan-3.0-video-edit"],
  ["video", "motion", "kling-v3-pro-motion"],
  ["video", "animate", "wan-2.2-animate-2"],
  ["video", "talking-head", "omnihuman-1.5"],
  ["audio", "sfx", "sfx-1.6-text-to-audio"],
  ["audio", "separate", "vocal-remover"],
  ["audio", "extend", "sfx-1.6-extend-audio"],
  ["tts", "tts", "realtime-tts-2"],
  ["tts", "voice-clone", "minimax-voice-clone"],
];

describe("mini-tool-registry", () => {
  describe("provider slots", () => {
    it.each(PROVIDER_SLOTS)("%s.%s runs on %s", (taskType, tool, model) => {
      expect(resolveMiniToolEntry(taskType, tool)).toEqual({ kind: "provider", model });
    });

    it("points every provider slot at a model the catalog serves", () => {
      // A slot naming a model the catalog dropped fails on every call.
      const served = new Set(
        ["image", "video", "audio", "tts"].flatMap((bucket) =>
          getFullModelConfig(bucket).models.map((m) => m.name),
        ),
      );
      const named = Object.values(MINI_TOOL_REGISTRY).flatMap((tools) =>
        Object.values(tools).flatMap((entry) => (entry.kind === "provider" ? [entry.model] : [])),
      );
      expect(named.filter((model) => !served.has(model))).toEqual([]);
      expect(named).toHaveLength(PROVIDER_SLOTS.length);
    });
  });

  describe("trimmed entries", () => {
    // Category A (sub-100 ms Canvas operations — frontend per
    // `feedback_frontend_backend_boundary`) plus B5 removals
    // (sharpen / denoise / restore / upscale-creative / adjust /
    // relight / multi-angle / edit / graffiti). Each entry below is a
    // guard against accidental re-introduction without re-opening the
    // frontend/backend boundary or the V1 roster discussion.
    it.each([
      ["crop"],
      ["flipRotate"],
      ["manual-adjust"],
      ["sharpen"],
      ["denoise"],
      ["restore"],
      ["upscale-creative"],
      ["adjust"],
      ["relight"],
      ["multi-angle"],
      ["edit"],
      ["graffiti"],
    ])("image.%s is no longer registered", (toolName) => {
      expect(() => resolveMiniToolEntry("image", toolName)).toThrow(
        /Unknown mini-tool/,
      );
    });
  });

  describe("kept entries (regression guard)", () => {
    it("video.crop still resolves as a local FFmpeg handler", () => {
      expect(resolveMiniToolEntry("video", "crop")).toEqual({
        kind: "local",
        handler: "video/crop",
      });
    });
  });

  describe("unknown inputs", () => {
    it("unknown task type throws", () => {
      expect(() => resolveMiniToolEntry("nope", "crop")).toThrow(
        /No mini-tool registry for task type/,
      );
    });

    it("unknown tool name throws", () => {
      expect(() => resolveMiniToolEntry("image", "not-a-real-tool")).toThrow(
        /Unknown mini-tool/,
      );
    });
  });
});
