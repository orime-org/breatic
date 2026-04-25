/**
 * Registry tests — guard both additions (graffiti provider) and
 * deletions (image crop / flipRotate / manual-adjust local handlers)
 * from the t3-phase4c pivot.
 *
 * No storage / HTTP / FFmpeg touched — pure map lookups.
 */

import { describe, it, expect } from "vitest";
import { resolveMiniToolEntry } from "../mini-tool-registry.js";

describe("mini-tool-registry", () => {
  describe("graffiti (phase4c addition)", () => {
    it("image.graffiti resolves to nano-banana-2-edit provider", () => {
      const entry = resolveMiniToolEntry("image", "graffiti");
      expect(entry).toEqual({ kind: "provider", model: "nano-banana-2-edit" });
    });
  });

  describe("image local handlers (phase4c removal)", () => {
    // These were registered in phase4a; they were sub-100ms Canvas
    // operations that had no business round-tripping through the
    // Worker. Each removal below is a guard against accidental
    // reintroduction without re-opening the frontend/backend boundary
    // discussion.
    it.each([
      ["crop"],
      ["flipRotate"],
      ["manual-adjust"],
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

    it("image.edit still resolves as nano-banana-2-edit provider", () => {
      expect(resolveMiniToolEntry("image", "edit")).toEqual({
        kind: "provider",
        model: "nano-banana-2-edit",
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
