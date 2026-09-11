// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a local mini-tool answers with (#209 + #210).
 *
 * Its output is already ours: the temp file went through the ingest Worker to
 * be filed, so the cover was cut and the numbers read on the way in. Both of
 * the dispatcher's lanes skip an output whose URL is already in our bucket, so
 * this is the only place those can reach the node — an output built from the
 * URL alone leaves a cropped video showing the film icon.
 */

import { describe, it, expect } from "vitest";
import { storedAsOutput } from "@worker/handlers/persisted-output.js";
import type { StoredAsset } from "@breatic/domain";

const STORED: StoredAsset = {
  assetId: "asset-1",
  fileUrl: "https://our-bucket/video/2026-09-11/1_out.mp4",
  kind: "video",
  coverUrl: "https://our-bucket/video/2026-09-11/1_out_cover.png",
  width: 1920,
  height: 1080,
  durationSeconds: 12.25,
};

describe("an output built from the row its bytes registered as", () => {
  it("carries the cover and the three numbers, not just the URL", () => {
    expect(storedAsOutput(STORED)).toEqual({
      url: STORED.fileUrl,
      cover_url: STORED.coverUrl,
      width: 1920,
      height: 1080,
      duration_seconds: 12.25,
    });
  });

  it("leaves the cover off a row that has none", () => {
    const output = storedAsOutput({ ...STORED, coverUrl: null });

    expect(output).not.toHaveProperty("cover_url");
    expect(output.width).toBe(1920);
  });

  it("carries no number the container could not read", () => {
    const output = storedAsOutput({
      ...STORED,
      width: null,
      height: null,
      durationSeconds: null,
    });

    expect(output).toMatchObject({
      width: null,
      height: null,
      duration_seconds: null,
    });
  });
});
