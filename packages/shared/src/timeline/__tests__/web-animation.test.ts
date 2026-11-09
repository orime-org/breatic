// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web-animation contracts both sides compute the same way (inner#1711 design §3.6, §4, §7.1): the source Manifest,
 * the create-execution input and the preview path token.
 */

import { describe, expect, it } from "vitest";

import {
  TimelineExecutionCreateInputSchema, WEB_ANIMATION_RUNTIME, WebAnimationManifestSchema, decodePreviewToken,
  encodePreviewToken, matchWebAnimationManifest,
} from "../web-animation.js";

const manifest = {
  schemaVersion: 1 as const,
  entrypoint: "index.html" as const,
  viewport: { width: 1920, height: 1080 },
  fps: { num: 24, den: 1 },
  durationFrames: 96,
  resources: [{ kind: "font-set" as const, version: 1 }],
  runtime: { id: "hyperframes" as const, version: "0.8.186" },
};
const expected = { viewport: { width: 1920, height: 1080 }, fps: { num: 24, den: 1 }, durationFrames: 96, fontSetVersion: 1 };

describe("WebAnimationManifestSchema", () => {
  it("accepts the one manifest shape the runner writes", () => {
    expect(WebAnimationManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("pins the runtime it is packaged with", () => {
    expect(WEB_ANIMATION_RUNTIME).toEqual({ id: "hyperframes", version: "0.8.186" });
    expect(WebAnimationManifestSchema.safeParse({ ...manifest, runtime: { id: "hyperframes", version: "0.9.0" } }).success).toBe(false);
  });

  it("refuses any resource other than the font set", () => {
    const withAudio = { ...manifest, resources: [{ kind: "audio", url: "https://example.com/a.mp3" }] };
    expect(WebAnimationManifestSchema.safeParse(withAudio).success).toBe(false);
  });

  it("refuses an entrypoint other than index.html", () => {
    expect(WebAnimationManifestSchema.safeParse({ ...manifest, entrypoint: "main.html" }).success).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(WebAnimationManifestSchema.safeParse({ ...manifest, audio: true }).success).toBe(false);
  });
});

describe("matchWebAnimationManifest", () => {
  it("answers null when the manifest matches the accepted input", () => {
    expect(matchWebAnimationManifest(manifest, expected)).toBeNull();
  });

  it("names the first field that differs", () => {
    expect(matchWebAnimationManifest({ ...manifest, viewport: { width: 1080, height: 1920 } }, expected)).toBe("viewport_mismatch");
    expect(matchWebAnimationManifest({ ...manifest, fps: { num: 30, den: 1 } }, expected)).toBe("fps_mismatch");
    expect(matchWebAnimationManifest({ ...manifest, durationFrames: 95 }, expected)).toBe("duration_mismatch");
    expect(matchWebAnimationManifest({ ...manifest, resources: [{ kind: "font-set", version: 2 }] }, expected)).toBe("font_set_mismatch");
  });

  it("compares rates by value, so 48/2 equals 24/1", () => {
    expect(matchWebAnimationManifest({ ...manifest, fps: { num: 48, den: 2 } }, expected)).toBeNull();
  });
});

describe("TimelineExecutionCreateInputSchema", () => {
  const input = {
    spaceId: "70000000-0000-4000-8000-000000000001",
    actionId: "50000000-0000-4000-8000-000000000001",
    prompt: "A red square slides from left to right",
    engine: "deepseek" as const,
    aspect: "16:9" as const,
    durationSeconds: 4,
    fps: { num: 24, den: 1 },
  };

  it("accepts the dialog's frozen input with the document fps", () => {
    expect(TimelineExecutionCreateInputSchema.parse(input)).toEqual(input);
  });

  it("accepts only the engines and aspects this task ships", () => {
    expect(TimelineExecutionCreateInputSchema.safeParse({ ...input, engine: "codex" }).success).toBe(false);
    expect(TimelineExecutionCreateInputSchema.safeParse({ ...input, aspect: "4:3" }).success).toBe(false);
    for (const aspect of ["16:9", "9:16", "1:1"]) expect(TimelineExecutionCreateInputSchema.safeParse({ ...input, aspect }).success).toBe(true);
  });

  it("requires whole positive seconds and the fps", () => {
    expect(TimelineExecutionCreateInputSchema.safeParse({ ...input, durationSeconds: 2.5 }).success).toBe(false);
    expect(TimelineExecutionCreateInputSchema.safeParse({ ...input, durationSeconds: 0 }).success).toBe(false);
    const { fps: _fps, ...withoutFps } = input;
    expect(TimelineExecutionCreateInputSchema.safeParse(withoutFps).success).toBe(false);
  });

  it("refuses an empty prompt", () => {
    expect(TimelineExecutionCreateInputSchema.safeParse({ ...input, prompt: "" }).success).toBe(false);
  });
});

describe("preview path token", () => {
  const signed = "eyJzb3VyY2VWZXJzaW9uSWQiOiJhYmMifQ==+/x.c2lnbmF0dXJlKy8/==";

  it("carries a signed payload in one path segment", () => {
    const token = encodePreviewToken(signed);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes back to the signed payload", () => {
    expect(decodePreviewToken(encodePreviewToken(signed))).toBe(signed);
  });

  it("answers null for a token that is not base64url", () => {
    expect(decodePreviewToken("has/slash")).toBeNull();
    expect(decodePreviewToken("")).toBeNull();
  });
});
