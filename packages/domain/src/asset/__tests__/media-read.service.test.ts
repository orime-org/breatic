// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a cover's or an avatar's media numbers after its upload returns
 * (#299, design §5.6).
 *
 * Two decisions live here: whether a finished upload gets a read job, and what
 * the job does with the row it names. The queue, the ledger and the Worker are
 * stood in; what is pinned is the decision.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";

const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));
const readStoredMediaAtIngest = vi.fn();
const findById = vi.fn();
const fillMediaNumbers = vi.fn();

const LIMITS = { runDeadlineMs: 150_000, toolTimeoutMs: 60_000 };

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createQueue: () => ({ add: queueAdd }),
  defaultJobOpts: () => ({
    attempts: 5,
    backoff: { type: "jitter" },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400, count: 1000 },
  }),
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.example" },
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  readStoredMediaAtIngest,
}));
vi.mock("@domain/asset/asset.repo.js", () => ({ findById, fillMediaNumbers }));
// Real but for the deadlines, so the rule deciding what a picture is stays the
// one the ledger files kinds by.
vi.mock("@domain/asset/asset.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mediaLimits: () => LIMITS,
}));

const {
  MEDIA_READ_QUEUE,
  readsMediaAtFinish,
  purposeAccepts,
  storedTypeAccepted,
  scheduleMediaRead,
  readAndFillMedia,
} = await import("@domain/asset/media-read.service.js");

/** A finish that registered a row of this upload's own, with no numbers. */
function registered(over: Partial<Record<string, unknown>> = {}): IngestReportOutcome {
  return {
    status: "registered",
    assetId: "asset-1",
    fileUrl: "https://bucket/image/k.jpg",
    kind: "image",
    coverUrl: null,
    width: null,
    height: null,
    durationSeconds: null,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ownRow: true,
    ...over,
  };
}

/** A stored row as the ledger answers it. */
function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "asset-1",
    storageKey: "image/2026-10-01/1_cover.jpg",
    mimeType: "image/jpeg",
    width: null,
    height: null,
    durationSeconds: null,
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  queueAdd.mockClear();
  readStoredMediaAtIngest.mockReset();
  findById.mockReset();
  fillMediaNumbers.mockReset();
});

describe("which uploads read their media later", () => {
  it.each([
    ["a project cover", "project_cover", false],
    ["a studio avatar", "studio_avatar", false],
    ["a canvas upload", null, true],
    ["an upload filed as one", "upload", true],
    ["a generation's output", "ai", true],
    ["a video's cover frame", "cover", true],
  ] as const)("%s reads at finish: %s", (_case, source, atFinish) => {
    expect(readsMediaAtFinish(source)).toBe(atFinish);
  });
});

// A cover or an avatar can only ever be pointed at a picture, and its read is
// deferred on the strength of that. Both checks say the same thing at the two
// moments a type is known: the one the ticket names, and the one the stored
// bytes read as.
describe("what a purpose takes", () => {
  it.each([
    ["a picture", "image/jpeg", true],
    ["a film", "video/mp4", false],
    ["a recording", "audio/mpeg", false],
    ["a document", "application/pdf", false],
  ])("a purpose takes %s: %s", (_case, contentType, accepted) => {
    expect(purposeAccepts(contentType)).toBe(accepted);
  });

  it.each([
    ["a cover whose bytes are a picture", "project_cover", "image/png", true],
    ["a cover whose bytes are a film", "project_cover", "video/mp4", false],
    ["an avatar whose bytes are a recording", "studio_avatar", "audio/mpeg", false],
    ["a canvas upload of a film", null, "video/mp4", true],
    ["a generation's audio", "ai", "audio/mpeg", true],
  ] as const)("keeps %s: %s", (_case, source, contentType, accepted) => {
    expect(storedTypeAccepted(source, contentType)).toBe(accepted);
  });
});

describe("whether a finished upload gets a read job", () => {
  it("queues one for a cover's own new row with no numbers, keyed by the row", async () => {
    const queued = await scheduleMediaRead(registered(), "project_cover");

    expect(queued).toBe(true);
    expect(queueAdd).toHaveBeenCalledWith(
      "read",
      { assetId: "asset-1" },
      expect.objectContaining({ jobId: "media-read-asset-1" }),
    );
  });

  // A read that fails is thrown, and the queue's own retries are what try it
  // again (A6): the shared attempts and backoff, not a one-off.
  it("queues it with the shared retries", async () => {
    await scheduleMediaRead(registered(), "studio_avatar");

    expect(queueAdd).toHaveBeenCalledWith(
      "read",
      expect.anything(),
      expect.objectContaining({ attempts: 5, backoff: { type: "jitter" } }),
    );
  });

  // A re-delivered finish answers out of the row the first one wrote. When
  // the first one's job was lost, this is the one chance left to queue it;
  // when it was not, the job id makes the second one the same job.
  it("queues one for a re-delivered finish of the upload's own row", async () => {
    const queued = await scheduleMediaRead(
      registered({ status: "already_registered" }),
      "studio_avatar",
    );

    expect(queued).toBe(true);
  });

  // A7: a cover whose bytes the studio already held lands on somebody else's
  // row. That row stays as it is, numbers or not.
  it("queues none when the upload landed on a row it did not write", async () => {
    const queued = await scheduleMediaRead(registered({ ownRow: false }), "project_cover");

    expect(queued).toBe(false);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("queues none for a row that already has its numbers", async () => {
    const queued = await scheduleMediaRead(
      registered({ width: 800, height: 450 }),
      "project_cover",
    );

    expect(queued).toBe(false);
  });

  it("queues none for an upload that read at finish", async () => {
    const queued = await scheduleMediaRead(registered(), null);

    expect(queued).toBe(false);
  });

  it.each([
    ["rejected", { status: "rejected", reason: "empty" }],
    ["voided", { status: "voided" }],
    ["stale", { status: "stale" }],
  ])("queues none for a %s finish", async (_case, outcome) => {
    const queued = await scheduleMediaRead(
      outcome as IngestReportOutcome,
      "project_cover",
    );

    expect(queued).toBe(false);
  });

  it("travels on the media-read queue", () => {
    expect(MEDIA_READ_QUEUE).toBe("media-read");
  });
});

describe("what a read job does with its row", () => {
  it("reads the object with the type the ledger recorded, and fills the row", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockResolvedValue({ width: 800, height: 450, durationSeconds: null });
    fillMediaNumbers.mockResolvedValue(true);

    const result = await readAndFillMedia("asset-1");

    expect(result).toBe("filled");
    expect(readStoredMediaAtIngest).toHaveBeenCalledWith("https://ingest.example", "secret", {
      storageKey: "image/2026-10-01/1_cover.jpg",
      contentType: "image/jpeg",
      limits: LIMITS,
    });
    expect(fillMediaNumbers).toHaveBeenCalledWith("asset-1", {
      width: 800,
      height: 450,
      durationSeconds: null,
    });
  });

  it.each([
    ["a row that is gone", null],
    ["a row deleted since", row({ deletedAt: new Date() })],
  ])("reads nothing for %s", async (_case, found) => {
    findById.mockResolvedValue(found);

    const result = await readAndFillMedia("asset-1");

    expect(result).toBe("gone");
    expect(readStoredMediaAtIngest).not.toHaveBeenCalled();
  });

  it("reads nothing for a row that already has a number", async () => {
    findById.mockResolvedValue(row({ width: 800 }));

    const result = await readAndFillMedia("asset-1");

    expect(result).toBe("already_measured");
    expect(readStoredMediaAtIngest).not.toHaveBeenCalled();
  });

  // A6: nothing came back, and the row stays as a container timeout leaves it.
  it("writes nothing when the read found no number", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockResolvedValue({ width: null, height: null, durationSeconds: null });

    const result = await readAndFillMedia("asset-1");

    expect(result).toBe("nothing_found");
    expect(fillMediaNumbers).not.toHaveBeenCalled();
  });

  // The queue retries what throws, so a refusal or a dead network has to.
  it("lets a refusal from the Worker through", async () => {
    findById.mockResolvedValue(row());
    readStoredMediaAtIngest.mockRejectedValue(new Error("502"));

    await expect(readAndFillMedia("asset-1")).rejects.toThrow("502");
    expect(fillMediaNumbers).not.toHaveBeenCalled();
  });
});
