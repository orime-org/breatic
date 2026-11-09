// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The key a Timeline execution's usage rows and charge are recorded under (inner#1711). The worker records and
 * charges under it and the server sums the execution list's usage under it, so both read it from here.
 * @param executionId - The execution.
 * @returns The key; it is also the execution's container job id.
 * @throws {never} Never.
 */
export function timelineOperationKey(executionId: string): string {
  return `timeline:${executionId}`;
}
