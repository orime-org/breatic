// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The CPU time the reader's container used (inner#1664). */

/**
 * The `usage_usec` a cgroup v2 `cpu.stat` file reports.
 * @param cpuStat - The file's contents.
 * @returns Microseconds, or null when the line is missing or unreadable.
 * @throws {Error} Always, until implemented.
 */
export function cpuUsecOf(cpuStat: string): number | null {
  void cpuStat;
  throw new Error("not implemented: cpuUsecOf");
}
