// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The CPU time the container used, as its cgroup reports it (inner#1664). */

/**
 * The `usage_usec` line of a cgroup v2 `cpu.stat`.
 * @param cpuStat - The file's text.
 * @returns The microseconds of CPU used, or null when the file does not say.
 * @throws {never} Never.
 */
export function cpuUsecOf(cpuStat: string): number | null {
  const found = /^usage_usec (\d+)$/m.exec(cpuStat);
  return found === null ? null : Number(found[1]);
}
