// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A finish the queue failed without running it settles its grant as the
 * Worker having given no answer (inner#1367 §4.2a).
 */

import { describe, it, expect, vi } from "vitest";
import { INGEST_NO_ANSWER } from "@breatic/shared";

const applyIngestReport = vi.fn().mockResolvedValue({ status: "voided" });
vi.mock("@domain/asset/ingest-report.service.js", () => ({ applyIngestReport }));
vi.mock("@domain/asset/asset.service.js", () => ({ mediaLimits: vi.fn() }));
vi.mock("@domain/asset/media-read.service.js", () => ({}));
vi.mock("@domain/asset/upload-deadline.js", () => ({ uploadDeadlineByKey: vi.fn() }));
vi.mock("@breatic/core", () => ({ coverKeyFor: vi.fn(), env: {} }));

const { settleStalledFinish } = await import("@domain/asset/upload-finish.service.js");

describe("settleStalledFinish", () => {
  it("voids the grant as the Worker having given no answer", async () => {
    await expect(settleStalledFinish("image/2026-10-11/k.png")).resolves.toEqual({ status: "voided" });
    expect(applyIngestReport).toHaveBeenCalledWith({
      storageKey: "image/2026-10-11/k.png",
      outcome: "aborted",
      reason: INGEST_NO_ANSWER,
    });
  });
});
