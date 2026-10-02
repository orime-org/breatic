// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The read a cover or an avatar skipped at finish (#299). The handler hands
 * the row to the domain service and writes down a read that found nothing;
 * what to read and what to write lives in the service.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

const readAndFillMedia = vi.hoisted(() => vi.fn());

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, mediaReadService: { ...actual.mediaReadService, readAndFillMedia } };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { logger } from "@breatic/core";
import type { MediaReadJob } from "@breatic/domain";
import { runMediaRead } from "@worker/handlers/media-read.js";

/** One queued read. */
function job(assetId = "asset-1"): Job<MediaReadJob> {
  return { data: { assetId } } as Job<MediaReadJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a media read job", () => {
  it("hands its row to the service", async () => {
    readAndFillMedia.mockResolvedValue("filled");

    await runMediaRead(job("asset-9"));

    expect(readAndFillMedia).toHaveBeenCalledWith("asset-9");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // A6: the row stays without numbers, and this is the one line that says so.
  it("writes down a read that found nothing", async () => {
    readAndFillMedia.mockResolvedValue("nothing_found");

    await runMediaRead(job("asset-9"));

    expect(logger.warn).toHaveBeenCalledWith(
      { assetId: "asset-9" },
      "media_read_nothing_found",
    );
  });

  // The queue retries what throws.
  it("lets a failed read through for the queue to retry", async () => {
    readAndFillMedia.mockRejectedValue(new Error("502"));

    await expect(runMediaRead(job())).rejects.toThrow("502");
  });
});
