// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Retained-object checks shared by signed preview and approval requests. */
import { logger, type MaintenanceStorage } from "@breatic/core";

/** Exact request and candidate context for one physical retained-key lookup. */
export interface KeptHeadContext {
  stage: "preview" | "submit";
  requestedBy: string;
  operationKey: string | null;
  previewId: string | null;
  candidateIds: string[];
  storageKeys: string[];
  keptStorageKey: string;
}

/**
 * Check one retained object and keep its original failure in application logs.
 * The finite reason is the existing business response; SDK details stay here.
 * @param storage - The direct physical HEAD port.
 * @param context - Signed request and all candidates sharing this retained key.
 * @returns Null when present, or the existing missing/storage failure reason.
 */
export async function checkKeptHead(storage: MaintenanceStorage, context: KeptHeadContext): Promise<"kept_missing" | "storage_error" | null> {
  try {
    return await storage.head(context.keptStorageKey) === "present" ? null : "kept_missing";
  } catch (err) {
    logger.error({ err, ...context }, "maintenance_kept_head_failed");
    return "storage_error";
  }
}
