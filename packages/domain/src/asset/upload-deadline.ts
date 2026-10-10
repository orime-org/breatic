// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When an upload's two hours run out (inner#1367).
 */

import { getNodeTaskConfig } from "@breatic/core";
import * as nodeTaskService from "@domain/node-task/node-task.service.js";
import { findGrantByKey } from "@domain/asset/upload-grant.repo.js";

/**
 * The deadline of an upload. One on a node ends with its task row, the one
 * the node is judged by; one with no node (a document picture, an
 * attachment, a cover, an avatar) gets the same budget from when its grant
 * was opened.
 * @param storageKey - The key the upload's grant was opened on.
 * @returns The deadline in epoch milliseconds.
 * @throws {Error} When no grant was opened on the key.
 */
export async function uploadDeadline(storageKey: string): Promise<number> {
  const row = await nodeTaskService.findByStorageKey(storageKey);
  if (row !== null) return row.startedAt.getTime() + row.budgetMs;
  const grant = await findGrantByKey(storageKey);
  if (grant === null) throw new Error(`no upload grant on ${storageKey}`);
  return grant.createdAt.getTime() + getNodeTaskConfig().default_budget_ms;
}
