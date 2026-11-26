// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The keys a container job writes, by the modality of each output (inner#888
 * §8.1, inner#1305 §7.1): a video gets an .mp4 and a cover key, an audio
 * result an .m4a with no cover.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const issueUploadGrant = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  coverKeyFor: (key: string) => `${key}.cover.png`,
  getStorageConfig: () => ({ upload: { max_upload_bytes: 2_147_483_648 } }),
}));
vi.mock("@domain/asset/upload-grant.service.js", () => ({ issueUploadGrant }));

import { openContainerOutputs } from "@domain/asset/container-outputs.service.js";

const RUN = { projectId: "p1", actingUserId: "u1", taskId: "t1", deadlineAt: 1_900_000_000_000 };

beforeEach(() => {
  issueUploadGrant.mockReset().mockImplementation(async ({ ext }: { ext: string }) => ({ key: `out/abc${ext}` }));
});

describe("openContainerOutputs", () => {
  it("opens an audio result as an m4a, with no cover", async () => {
    const opened = await openContainerOutputs({ ...RUN, outputs: [{ modality: "audio", namePrefix: "DENOISE" }] });
    expect(issueUploadGrant.mock.calls[0]?.[0]).toMatchObject({ taskType: "audio", ext: ".m4a" });
    expect(opened).toEqual([{ storageKey: "out/abc.m4a", contentType: "audio/mp4" }]);
  });

  it("opens a video result as an mp4 with a cover key", async () => {
    const opened = await openContainerOutputs({ ...RUN, outputs: [{ modality: "video", namePrefix: "CUT" }] });
    expect(opened).toEqual([
      { storageKey: "out/abc.mp4", contentType: "video/mp4", coverKey: "out/abc.mp4.cover.png" },
    ]);
  });

  // §93 D5-12 (frames-split design §7.17 segment row 「透明源输出VP9+透明+Opus的WebM」, §4.3): a transparent split output is a WebM,
  // so its grant names a .webm key and video/webm. This round's choice of the input (may be vetoed): `container: "webm"`.
  it("opens a WebM video result as a .webm with a cover key", async () => {
    const outputs = [{ modality: "video", namePrefix: "SPLIT", container: "webm" }] as unknown as Parameters<typeof openContainerOutputs>[0]["outputs"];
    const opened = await openContainerOutputs({ ...RUN, outputs });
    expect(issueUploadGrant.mock.calls[0]?.[0]).toMatchObject({ taskType: "video", ext: ".webm" });
    expect(opened).toEqual([{ storageKey: "out/abc.webm", contentType: "video/webm", coverKey: "out/abc.webm.cover.png" }]);
  });
});

