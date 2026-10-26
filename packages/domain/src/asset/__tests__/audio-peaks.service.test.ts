// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an audio row's peaks after it registers (inner#1305 §4.4).
 *
 * Two decisions live here: which registered rows get a peaks job, and what the
 * job does with the row it names. The queue, the ledger and the Worker are
 * stood in; what is pinned is the decision.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";

const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));
const readStoredMediaAtIngest = vi.fn();
const findById = vi.fn();

/** When the job reading runs out. */
const DEADLINE_AT = Date.now() + 7_200_000;

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createQueue: () => ({ add: queueAdd }),
  defaultJobOpts: () => ({ attempts: 3, backoff: { type: "jitter" } }),
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.example" },
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  readStoredMediaAtIngest,
}));
vi.mock("@domain/asset/asset.repo.js", () => ({ findById }));

const { AUDIO_PEAKS_QUEUE, AudioPeaksReadFailed, scheduleAudioPeaks, readAudioPeaks } = await import(
  "@domain/asset/audio-peaks.service.js"
);

/** A finish that registered a row of this upload's own. */
function registered(over: Partial<Record<string, unknown>> = {}): IngestReportOutcome {
  return {
    status: "registered",
    assetId: "asset-1",
    fileUrl: "https://bucket/audio/k.mp3",
    kind: "audio",
    coverUrl: null,
    width: null,
    height: null,
    durationSeconds: 61,
    mimeType: "audio/mpeg",
    sizeBytes: 1024,
    ownRow: true,
    ...over,
  };
}

/** A stored row as the ledger answers it. */
function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "asset-1",
    storageKey: "audio/2026-10-21/1_song.mp3",
    mimeType: "audio/mpeg",
    deletedAt: null,
    ...over,
  };
}

/** A finish refused for its size. */
const REFUSED: IngestReportOutcome = { status: "rejected", reason: "over_cap" };

beforeEach(() => {
  queueAdd.mockClear();
  readStoredMediaAtIngest.mockReset();
  findById.mockReset();
});

describe("which registered rows get a peaks job", () => {
  it("travels on the audio-peaks queue", () => {
    expect(AUDIO_PEAKS_QUEUE).toBe("audio-peaks");
  });

  it("queues one for an upload's own new audio row, keyed by the row, with the shared retries", async () => {
    expect(await scheduleAudioPeaks(registered())).toBe(true);
    expect(queueAdd).toHaveBeenCalledWith(
      "read",
      { assetId: "asset-1" },
      expect.objectContaining({ jobId: "audio-peaks-asset-1", attempts: 3 }),
    );
  });

  it("queues one for a re-delivered finish of the upload's own row", async () => {
    expect(await scheduleAudioPeaks(registered({ status: "already_registered" }))).toBe(true);
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a row the studio already held", registered({ ownRow: false })],
    ["a picture", registered({ mimeType: "image/png", kind: "image" })],
    ["a video", registered({ mimeType: "video/mp4", kind: "video" })],
    ["a refusal", REFUSED],
  ])("queues none for %s", async (_case, outcome) => {
    expect(await scheduleAudioPeaks(outcome)).toBe(false);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe("what a peaks job does with its row", () => {
  it("asks for peaks with the type the ledger recorded and the job's deadline", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockResolvedValue({ width: null, height: null, durationSeconds: 61, peaks: "generated" });

    expect(await readAudioPeaks("asset-1", DEADLINE_AT)).toBe("generated");
    expect(readStoredMediaAtIngest).toHaveBeenCalledWith("https://ingest.example", "secret", {
      storageKey: "audio/2026-10-21/1_song.mp3",
      contentType: "audio/mpeg",
      deadlineAt: DEADLINE_AT,
      wantPeaks: true,
    });
  });

  it.each(["existing", "none"] as const)("answers %s as it came", async (peaks) => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockResolvedValue({ width: null, height: null, durationSeconds: 61, peaks });

    expect(await readAudioPeaks("asset-1", DEADLINE_AT)).toBe(peaks);
  });

  // The queue retries what throws, and /media answers a run that came back
  // without peaks as 200 with `failed`.
  it("throws when the peaks came back failed, so the queue retries", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockResolvedValue({ width: null, height: null, durationSeconds: 61, peaks: "failed" });

    await expect(readAudioPeaks("asset-1", DEADLINE_AT)).rejects.toBeInstanceOf(AudioPeaksReadFailed);
  });

  it("throws when the answer named no peaks outcome", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockResolvedValue({ width: null, height: null, durationSeconds: 61 });

    await expect(readAudioPeaks("asset-1", DEADLINE_AT)).rejects.toBeInstanceOf(AudioPeaksReadFailed);
  });

  it("lets a refusal from the Worker through", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockRejectedValue(new Error("502"));

    await expect(readAudioPeaks("asset-1", DEADLINE_AT)).rejects.toThrow("502");
  });

  it.each([
    ["a row that is gone", null],
    ["a row deleted since", row({ deletedAt: new Date() })],
  ])("reads nothing for %s", async (_case, found) => {
    findById.mockResolvedValue(found);

    expect(await readAudioPeaks("asset-1", DEADLINE_AT)).toBe("gone");
    expect(readStoredMediaAtIngest).not.toHaveBeenCalled();
  });
});
