// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The key a canvas task's usage rows and its operation ledger row are
 * recorded under (inner#1968). The server admits and releases under it, the
 * worker records usage, counts and releases under it, so all read it from here.
 * @param taskId - The task.
 * @returns The key; it is also the task's container job id.
 * @throws {never} Never.
 */
export function taskOperationKey(taskId: string): string {
  return `task:${taskId}`;
}
