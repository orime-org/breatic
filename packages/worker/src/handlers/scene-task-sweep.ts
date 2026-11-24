// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The sweep that judges 3D Space task rows dead when they outran their budget (inner#2061): a deadline is judged on
 * the server and announced through each Space's document, so a tab spinner or a Tasks count clears with nobody reading
 * the list. Rows waiting for a running slot have no deadline yet and are the slot-wait sweep's.
 */

import { announceSceneTasksChange, logger } from "@breatic/core";
import { sceneTaskService } from "@breatic/domain";

/**
 * One round of the sweep.
 * @returns Once every Space whose rows it expired has been told; one whose announcement fails is logged.
 * @throws {Error} When the overdue rows cannot be expired.
 */
export async function sweepSceneTasks(): Promise<void> {
  for (const { projectId, spaceId } of await sceneTaskService.harvestExpiredScenes()) {
    try {
      await announceSceneTasksChange({ projectId, spaceId });
    } catch (err) {
      logger.error({ err, projectId, spaceId }, "scene_task_sweep_publish_failed");
    }
  }
}
