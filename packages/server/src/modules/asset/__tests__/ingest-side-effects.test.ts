// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing down what registering an upload could not do (#207).
 *
 * Registration runs in a library, which holds no logger, so the things that
 * can fail beside the outcome come back as fields. Each is the only account
 * anybody gets of that failure, and a route that reads the outcome without
 * reading them loses it.
 *
 * One pass over the table that names them, so a lane added later writes down
 * every flag rather than the ones somebody remembered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as coreModule from "@breatic/core";
import type { IngestReportOutcome } from "@breatic/domain";

const error = vi.fn();

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  logger: { error, info: vi.fn(), warn: vi.fn() },
}));

const { noteIngestSideEffects } = await import(
  "@server/modules/asset/ingest-side-effects.js"
);

const KEY = "url/2026-09-14/1_abc.mp4";

beforeEach(() => {
  error.mockReset();
});

describe("noteIngestSideEffects", () => {
  it("says nothing when nothing failed", () => {
    noteIngestSideEffects(KEY, {});

    expect(error).not.toHaveBeenCalled();
  });

  it("names the reclaim job that could not be queued", () => {
    noteIngestSideEffects(KEY, { reclaimQueueFailed: true });

    expect(error).toHaveBeenCalledWith(
      { key: KEY },
      "ingest_report_reclaim_queue_failed",
    );
  });

  it("names counts that never reached the other viewers", () => {
    noteIngestSideEffects(KEY, { countsPublishFailed: true });

    expect(error).toHaveBeenCalledWith(
      { key: KEY },
      "node_task_counts_publish_failed",
    );
  });

  it("names the cover that stands in storage with no row pointing at it", () => {
    noteIngestSideEffects(KEY, { coverRegisterFailed: true });

    expect(error).toHaveBeenCalledWith({ key: KEY }, "ingest_cover_register_failed");
  });

  it("names every one of them when they all failed", () => {
    noteIngestSideEffects(KEY, {
      reclaimQueueFailed: true,
      countsPublishFailed: true,
      activityAppendFailed: true,
      coverRegisterFailed: true,
    });

    // Four, because the table has four entries. A flag added to the library
    // without a line here would leave this at four while five can fail.
    expect(error).toHaveBeenCalledTimes(4);
  });

  it("reads the flags off an outcome exactly as a route hands it over", () => {
    // The routes pass the whole IngestReportOutcome, flags and verdict
    // together. Typed as one here so a field moving out of the union's
    // shared half is a compile error rather than a silent no-op.
    const settled: IngestReportOutcome = {
      status: "rejected",
      reason: "empty",
      countsPublishFailed: true,
    };

    noteIngestSideEffects(KEY, settled);

    expect(error).toHaveBeenCalledWith(
      { key: KEY },
      "node_task_counts_publish_failed",
    );
  });
});
