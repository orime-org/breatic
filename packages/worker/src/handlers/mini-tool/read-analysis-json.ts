// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { StudioAssetEntity } from "@breatic/shared";

/** A registered object and its JSON, ready for the operation's content parser. */
export interface RegisteredAnalysisJson { asset: StudioAssetEntity; json: unknown }

/**
 * Read a registered analysis artifact within its original execution budget.
 * @param assetId - The canonical asset returned by the original registration.
 * @param deadlineAt - The original task deadline in epoch milliseconds.
 * @returns The registered facts and parsed JSON without changing their ownership.
 * @throws {Error} When registration, delivery, the original budget or JSON is invalid.
 */
export async function readMiniToolAnalysisJson(assetId: string, deadlineAt: number): Promise<RegisteredAnalysisJson> {
  void assetId; void deadlineAt;
  throw new Error("Registered analysis JSON reader awaits independent RED");
}
