// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { spawn } from "node:child_process";

/** The frozen per-attempt process IO bounds and original lifetime. */
export interface PlanCommandOptions { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }
/**
 * Run one directly spawned plan program through actual close/reap.
 * @param program - A repository-selected executable.
 * @param args - Its owned argument vector.
 * @param options - The original lifetime and frozen IO limits.
 * @returns Its complete bounded stdout, including valid empty output.
 * @throws {Error} When spawn, IO bounds or the program's exit fail.
 * @throws {DOMException} When the original job lifetime is cancelled.
 */
export async function runPlanCommand(program: string, args: readonly string[], options: PlanCommandOptions): Promise<Buffer> {
  if (options.signal.aborted) throw new DOMException("Planned command was cancelled", "AbortError");
  if (![options.stdoutBytes, options.stderrTailBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("Planned process IO bounds must be positive safe integers");
  }
  const child = spawn(program, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let firstFailure: unknown;

  /**
   * Preserve the first cause and stop only this invocation's own process.
   * @param error - The observed failure.
   * @throws {never} Never.
   */
  const fail = (error: unknown): void => {
    if (firstFailure !== undefined) return;
    firstFailure = error;
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  /**
   * Apply only the caller's original lifetime to the owned process.
   * @throws {never} Never.
   */
  const onAbort = (): void => { fail(new DOMException("Planned command was cancelled", "AbortError")); };

  child.stdout.on("data", (chunk: Buffer) => {
    if (firstFailure !== undefined) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > options.stdoutBytes) fail(new Error(`${program} stdout exceeded its frozen byte limit`));
    else stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const limit = options.stderrTailBytes;
    stderr = Buffer.from(chunk.length >= limit ? chunk.subarray(-limit) : Buffer.concat([stderr, chunk]).subarray(-limit));
  });
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.on("error", fail);
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal.aborted) onAbort();
    await new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (code !== 0 && firstFailure === undefined) firstFailure = new Error(`${program} exited ${code ?? signal}: ${stderr.toString("utf8")}`);
        resolve();
      });
    });
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
  if (firstFailure !== undefined) throw firstFailure;
  return Buffer.concat(stdout, stdoutBytes);
}
