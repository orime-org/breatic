// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An upload finish or a pasted link whose worker went away is settled when
 * the queue fails its job, since the handler never runs again for it
 * (inner#1367).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const h = vi.hoisted(() => ({ applyIngestReport: vi.fn() }));

vi.mock("@breatic/domain", () => ({
  ingestReportService: { applyIngestReport: h.applyIngestReport },
}));
vi.mock("@worker/handlers/side-effects.js", () => ({ noteSideEffects: vi.fn() }));

const { settleStalledIngest } = await import("@worker/handlers/abort-ingest.js");

/** An ingest job, failed the way the queue says. */
function job(deferredFailure: string | undefined): Job<{ storageKey: string }> {
  return { data: { storageKey: "k-1" }, deferredFailure } as unknown as Job<{
    storageKey: string;
  }>;
}

beforeEach(() => {
  h.applyIngestReport.mockReset().mockResolvedValue({ status: "voided" });
});

describe("an ingest job the queue failed", () => {
  it("settles the grant and the row as aborted when its process went away", async () => {
    const settled = await settleStalledIngest(job("job stalled more than allowable limit"));

    expect(settled).toBe(true);
    expect(h.applyIngestReport).toHaveBeenCalledWith({
      storageKey: "k-1",
      outcome: "aborted",
      reason: "ingest_no_answer",
    });
  });

  it("leaves a job its handler ran to the handler's own settling", async () => {
    const settled = await settleStalledIngest(job(undefined));

    expect(settled).toBe(false);
    expect(h.applyIngestReport).not.toHaveBeenCalled();
  });
});
