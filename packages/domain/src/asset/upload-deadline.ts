// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When an upload's two hours run out (inner#1367).
 */

import { budgetDeadlineFrom } from "@breatic/core";
import * as nodeTaskService from "@domain/node-task/node-task.service.js";
import { findGrantByKey } from "@domain/asset/upload-grant.repo.js";

/**
 * The deadline of an upload. One on a node ends with its task row, the one
 * the node is judged by; one with no node (a document picture, an
 * attachment, a cover, an avatar) gets the same budget from when its grant
 * was opened.
 * @param grant - The upload's grant.
 * @param grant.storageKey - The key it was opened on.
 * @param grant.createdAt - When it was opened.
 * @returns The deadline in epoch milliseconds.
 */
export async function uploadDeadline(grant: { storageKey: string; createdAt: Date }): Promise<number> {
  const row = await nodeTaskService.findByStorageKey(grant.storageKey);
  if (row !== null) return row.startedAt.getTime() + row.budgetMs;
  return budgetDeadlineFrom(grant.createdAt.getTime());
}

/**
 * The same, for a caller that holds only the key.
 * @param storageKey - The key the upload's grant was opened on.
 * @returns The deadline in epoch milliseconds.
 * @throws {Error} When no grant was opened on the key.
 */
export async function uploadDeadlineByKey(storageKey: string): Promise<number> {
  const grant = await findGrantByKey(storageKey);
  if (grant === null) throw new Error(`no upload grant on ${storageKey}`);
  return uploadDeadline(grant);
}
