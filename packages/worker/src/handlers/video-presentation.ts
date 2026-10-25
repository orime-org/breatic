// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Job } from 'bullmq';
import { logger } from '@breatic/core';
import { videoPresentationService, type VideoPresentationJob } from '@breatic/domain';

/**
 * Run the source's accepted metadata work without opening a billed user task.
 * @param job - The immutable auxiliary admission.
 * @returns Nothing once source and known platform expense facts are retained.
 * @throws {Error} When infrastructure or usage persistence needs a queue retry.
 */
export async function runVideoPresentation(job: Job<VideoPresentationJob>): Promise<void> {
  try {
    const result = await videoPresentationService.runVideoPresentation(job.data);
    if (result.usagePending) throw new Error('Presentation expense receipt is still pending');
    if (result.status === 'failed') logger.warn({ ctx: job.data, errorCode: result.error }, 'video_presentation_preparation_failed');
  } catch (err) {
    logger.error({ err, ctx: job.data }, 'video_presentation_attempt_failed');
    throw err;
  }
}
