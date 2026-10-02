// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read a project cover's or a studio avatar's media numbers after its upload
 * returned (#299). What to read and what to write is the domain service's;
 * this hands it the row and writes down a read that found nothing.
 */

import type { Job } from "bullmq";
import { logger } from "@breatic/core";
import { mediaReadService, type MediaReadJob } from "@breatic/domain";

/**
 * Read one row's stored object and fill the row.
 * @param job - The queued read.
 * @returns Nothing once the row is settled.
 * @throws {unknown} When the ingest Worker refused or could not be reached, so
 *   the queue tries again.
 */
export async function runMediaRead(job: Job<MediaReadJob>): Promise<void> {
  const { assetId } = job.data;
  const result = await mediaReadService.readAndFillMedia(assetId);
  if (result === "nothing_found") {
    logger.warn({ assetId }, "media_read_nothing_found");
  }
}
