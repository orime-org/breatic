// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the media container cuts its preview from, and whether there is time to
 * (inner#1320, design §5.1).
 *
 * The Worker gives up on the whole answer at its deadline, and the width, the
 * height and the cover go with it. So the preview, which nothing depends on,
 * is cut only when it still fits before that instant.
 */

import { describe, it, expect } from "vitest";
import { previewSource, PREVIEW_MARGIN_MS } from "@ingest/preview-step.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const STILL: ProbeReport = {
  durationSeconds: null,
  streams: [
    { index: 0, codecType: "video", codecName: "png", width: 1200, height: 800, attachedPic: false },
  ],
};

const NOW = 1_000_000;
const PLENTY = { deadlineAt: NOW + 60_000, previewTimeoutMs: 10_000, now: NOW };

describe("what the preview is cut from", () => {
  it("cuts a still picture's preview from the object", () => {
    expect(
      previewSource({ wantPreview: true, wantCover: false, cover: null, report: STILL, ...PLENTY }),
    ).toBe("object");
  });

  it("cuts a video's preview from the cover it just cut", () => {
    expect(
      previewSource({
        wantPreview: true,
        wantCover: true,
        cover: new Uint8Array([1]),
        report: STILL,
        ...PLENTY,
      }),
    ).toBe("cover");
  });

  it("cuts nothing for a video whose cover did not come out", () => {
    expect(
      previewSource({ wantPreview: true, wantCover: true, cover: null, report: STILL, ...PLENTY }),
    ).toBeNull();
  });

  it("cuts nothing for an animated PNG", () => {
    const apng: ProbeReport = {
      ...STILL,
      streams: [{ ...STILL.streams[0]!, codecName: "apng" }],
    };
    expect(
      previewSource({ wantPreview: true, wantCover: false, cover: null, report: apng, ...PLENTY }),
    ).toBeNull();
  });

  it("cuts nothing when none was asked for", () => {
    expect(
      previewSource({ wantPreview: false, wantCover: false, cover: null, report: STILL, ...PLENTY }),
    ).toBeNull();
  });
});

describe("whether there is time to cut it", () => {
  const ask = { wantPreview: true, wantCover: false, cover: null, report: STILL };

  it("cuts it when the preview time and the margin fit before the deadline", () => {
    expect(
      previewSource({
        ...ask,
        previewTimeoutMs: 10_000,
        now: NOW,
        deadlineAt: NOW + 10_000 + PREVIEW_MARGIN_MS,
      }),
    ).toBe("object");
  });

  // A cold start spends the window before the container sees the request, and
  // the deadline is an instant so that spending shows here.
  it("skips it when a cold start has spent the window", () => {
    expect(
      previewSource({
        ...ask,
        previewTimeoutMs: 10_000,
        now: NOW,
        deadlineAt: NOW + 10_000 + PREVIEW_MARGIN_MS - 1,
      }),
    ).toBe("late");
  });

  it("says nothing about time when no preview was asked for", () => {
    expect(
      previewSource({ ...ask, wantPreview: false, previewTimeoutMs: 10_000, now: NOW, deadlineAt: NOW }),
    ).toBeNull();
  });
});
