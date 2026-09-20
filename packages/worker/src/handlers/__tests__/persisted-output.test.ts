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
import { nodeResultsFrom, storedAsOutput } from "@worker/handlers/persisted-output.js";
import type { StoredAsset } from "@breatic/domain";

const STORED: StoredAsset = {
  assetId: "asset-1",
  fileUrl: "https://our-bucket/video/2026-09-11/1_out.mp4",
  kind: "video",
  coverUrl: "https://our-bucket/video/2026-09-11/1_out_cover.png",
  width: 1920,
  height: 1080,
  durationSeconds: 12.25,
  mimeType: "video/mp4",
  sizeBytes: 4_194_304,
};

describe("an output built from the row its bytes registered as", () => {
  it("carries the cover and what the ledger settled, not just the URL", () => {
    expect(storedAsOutput(STORED)).toEqual({
      url: STORED.fileUrl,
      cover_url: STORED.coverUrl,
      width: 1920,
      height: 1080,
      duration_seconds: 12.25,
      mime_type: "video/mp4",
      size_bytes: 4_194_304,
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

describe("what each node this run wrote to receives", () => {
  // Three deliveries read this: a run finishing, a redelivery after the
  // provider already answered, and the net that picks up a crashed run. Each
  // is the only delivery its node gets, so a field this drops is a field that
  // node never learns.
  it("carries every field the stored output holds", () => {
    const [result] = nodeResultsFrom(
      ["node-1"],
      [
        {
          url: "https://our-bucket/video/a.mp4",
          cover_url: "https://our-bucket/video/a_cover.png",
          width: 1920,
          height: 1080,
          duration_seconds: 12.25,
          mime_type: "video/mp4",
          size_bytes: 4_194_304,
        },
      ],
    );

    expect(result).toEqual({
      nodeId: "node-1",
      content: "https://our-bucket/video/a.mp4",
      coverUrl: "https://our-bucket/video/a_cover.png",
      width: 1920,
      height: 1080,
      duration: 12.25,
      mimeType: "video/mp4",
      size: 4_194_304,
    });
  });

  // A reading produces words, not a file: it answers with `content` and no
  // URL at all. This is the one line carrying a reading to its node.
  it("carries words when the run produced words", () => {
    const [result] = nodeResultsFrom(
      ["node-1"],
      [{ content: "A cat asleep on a windowsill." }],
    );

    expect(result?.content).toBe("A cat asleep on a windowsill.");
  });

  // Both are present on a run that filed a result and described it in the
  // same breath; the words are what the node shows.
  it("prefers what the run said over where it was filed", () => {
    const [result] = nodeResultsFrom(
      ["node-1"],
      [{ content: "what it says", url: "https://our-bucket/x.txt" }],
    );

    expect(result?.content).toBe("what it says");
  });

  // One row per node named, always: a node with no output still gets its
  // delivery, which is what settles its row rather than leaving it running.
  it("answers for a node the run produced nothing for", () => {
    const results = nodeResultsFrom(["node-1", "node-2"], [{ url: "https://our-bucket/x.png" }]);

    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({
      nodeId: "node-2",
      content: undefined,
      coverUrl: undefined,
      width: null,
      height: null,
      duration: null,
      mimeType: null,
      size: null,
    });
  });
});
