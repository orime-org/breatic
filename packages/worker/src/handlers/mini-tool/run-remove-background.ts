// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { StudioAssetEntity } from "@breatic/shared";

/**
 * Resume one SQL-owned video removal and recover its registered canonical rows.
 * @param taskId - The original accepted planned task, never a replacement job body.
 * @param deadlineAt - Its original outer task deadline; an existing step keeps its stored deadline.
 * @param retryStarting - The existing pickup retry fact, without another retry or fee policy.
 * @returns The actual registered winner and its live cover, without prescribing a final manifest.
 * @throws {Error} When the persisted lane, planning, provider or canonical receipt cannot advance.
 */
export async function runMiniToolRemoveBackground(
  taskId: string,
  deadlineAt: number,
  retryStarting: boolean,
): Promise<{ asset: StudioAssetEntity; cover: StudioAssetEntity | null }> {
  void taskId; void deadlineAt; void retryStarting;
  throw new Error("Planned video removal execution is not implemented");
}
