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

import { describe, it, expect } from "vitest";
import { resolveMiniToolEntry } from "../mini-tool-registry.js";

describe("mini-tool-registry", () => {
  describe("V1 image roster", () => {
    it("image.remove-bg resolves to bg-remover provider", () => {
      expect(resolveMiniToolEntry("image", "remove-bg")).toEqual({
        kind: "provider",
        model: "bg-remover",
      });
    });

    it("image.upscale resolves to topaz-upscale provider", () => {
      expect(resolveMiniToolEntry("image", "upscale")).toEqual({
        kind: "provider",
        model: "topaz-upscale",
      });
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
