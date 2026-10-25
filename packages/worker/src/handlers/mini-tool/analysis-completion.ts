// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { getStreamRedis } from "@breatic/core";
import type { miniToolAnalysisService } from "@breatic/domain";

/**
 * Commit the observed analysis outcome and publish its original host's task counts.
 * @param taskId - The immutable accepted analysis.
 * @param completion - The computation outcome and actual identity knowledge.
 * @param streamRedis - The application's task-event stream connection.
 * @returns Nothing after the committed host notification succeeds.
 * @throws {Error} When metadata persistence or host notification fails.
 */
export async function finishMiniToolAnalysisAndNotify(
  taskId: string,
  completion: miniToolAnalysisService.MiniToolAnalysisCompletion,
  streamRedis: ReturnType<typeof getStreamRedis>,
): Promise<void> {
  void taskId; void completion; void streamRedis;
  throw new Error("Analysis completion notification awaits independent RED");
}
