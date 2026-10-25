// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The frozen per-attempt process IO bounds and original lifetime. */
export interface PlanCommandOptions { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }
/**
 * Run one directly spawned plan program through actual close/reap.
 * @param _program - A repository-selected executable.
 * @param _args - Its owned argument vector.
 * @param _options - The original lifetime and frozen IO limits.
 * @returns Its complete bounded stdout.
 * @throws {Error} Until the planned process owner is implemented.
 */
export async function runPlanCommand(_program: string, _args: readonly string[], _options: PlanCommandOptions): Promise<Buffer> {
  throw new Error("Planned command execution is not implemented");
}
