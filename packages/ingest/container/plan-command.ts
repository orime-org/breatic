// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** A plan program that ran to its end and exited with a non-zero code; a signal is not an exit. */
export class PlanCommandExit extends Error {
  /**
   * Name the exit.
   * @param program - The program.
   * @param exitCode - Its exit code.
   * @param stderr - Its stderr tail.
   */
  constructor(readonly program: string, readonly exitCode: number, stderr: string) { super(`${program} exited ${exitCode}: ${stderr}`); this.name = 'PlanCommandExit'; }
}

/** The frozen per-attempt process IO bounds and original lifetime. */
export interface PlanCommandOptions { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }
/**
 * Run one directly spawned plan program through actual close/reap.
 * @param program - A repository-selected executable.
 * @param args - Its owned argument vector.
 * @param options - The original lifetime and frozen IO limits.
 * @returns Its complete bounded stdout, including valid empty output.
 * @throws {PlanCommandExit} When the program exits with a non-zero code.
 * @throws {RangeError} When an IO bound is not a positive safe integer.
 * @throws {Error} When spawn or IO bounds fail, or a signal ends the program.
 * @throws {DOMException} When the original job lifetime is cancelled.
 */
export async function runPlanCommand(program: string, args: readonly string[], options: PlanCommandOptions): Promise<Buffer> {
  const pipe = startPlanCommand(program, args, options, { stdout: true });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  // The first failure seen while reading: the stdout bound or a read error; it outranks the exit the stop then causes.
  let failure: unknown;
  /**
   * Keep the first read failure and stop the program.
   * @param error - The failure.
   * @throws {never} Never.
   */
  const fail = (error: unknown): void => { failure ??= error; pipe.stop(); };
  pipe.stdout!.on("data", (chunk: Buffer) => {
    if (failure !== undefined) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > options.stdoutBytes) fail(new Error(`${program} stdout exceeded its frozen byte limit`));
    else stdout.push(Buffer.from(chunk));
  });
  pipe.stdout!.on("error", fail);
  await pipe.done.catch((error: unknown) => { throw failure ?? error; });
  if (failure !== undefined) throw failure;
  return Buffer.concat(stdout, stdoutBytes);
}

/**
 * Run one plan program that reports on stderr (FFmpeg's seek warnings): its stdout and its stderr tail.
 * @param program - A repository-selected executable.
 * @param args - Its owned argument vector.
 * @param options - The original lifetime and frozen IO limits.
 * @returns Its bounded stdout and the kept stderr tail.
 * @throws {PlanCommandExit} When the program exits with a non-zero code.
 * @throws {Error} When spawn or IO bounds fail, or a signal ends the program.
 */
export async function runPlanCommandWithStderr(program: string, args: readonly string[], options: PlanCommandOptions): Promise<{ stdout: Buffer; stderr: string }> {
  const pipe = startPlanCommand(program, args, options, { stdout: true });
  const stdout: Buffer[] = [];
  let bytes = 0;
  pipe.stdout!.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.stdoutBytes) pipe.stop();
    else stdout.push(Buffer.from(chunk));
  });
  await pipe.done;
  if (bytes > options.stdoutBytes) throw new Error(`${program} stdout exceeded its frozen byte limit`);
  return { stdout: Buffer.concat(stdout), stderr: pipe.stderr() };
}

/** A spawned plan program whose stdin or stdout its caller streams; `done` settles once the process has closed. */
export interface PlanPipe { stdin: Writable | null; stdout: Readable | null; done: Promise<void>; stop(): void; stderr(): string }

/**
 * Start one directly spawned plan program whose stdin or stdout the caller streams (execution design paragraph before
 * §9.4: lip-sync frames move through pipes, never all at once).
 * @param program - A repository-selected executable.
 * @param args - Its owned argument vector.
 * @param options - The original lifetime and the IO bounds.
 * @param options.signal - The lifetime; aborting kills the program.
 * @param options.stderrTailBytes - The stderr tail kept for the exit error.
 * @param options.stdoutBytes - The stdout bound a caller collecting stdout enforces, checked here with the tail bound.
 * @param pipes - Which of stdin and stdout the caller streams.
 * @param pipes.stdin - Whether the caller writes its stdin.
 * @param pipes.stdout - Whether the caller reads its stdout.
 * @returns The streams, `done` (rejected with PlanCommandExit, an AbortError or the spawn error) and `stop`, which kills it.
 * @throws {DOMException} When the lifetime is already cancelled.
 * @throws {RangeError} When an IO bound is not a positive safe integer.
 */
export function startPlanCommand(program: string, args: readonly string[], options: { signal: AbortSignal; stderrTailBytes: number; stdoutBytes?: number },
  pipes: { stdin?: boolean; stdout?: boolean }): PlanPipe {
  if (options.signal.aborted) throw new DOMException("Planned command was cancelled", "AbortError");
  if (![options.stderrTailBytes, options.stdoutBytes ?? 1].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("Planned process IO bounds must be positive safe integers");
  }
  const child = spawn(program, [...args], { stdio: [pipes.stdin === true ? "pipe" : "ignore", pipes.stdout === true ? "pipe" : "ignore", "pipe"], shell: false });
  let stderr = Buffer.alloc(0);
  let failure: unknown;
  /**
   * Kill this invocation's own process while it runs and drop its unread output: a child closes only once its stdout ends,
   * which a paused stream holding unread bytes never does.
   * @throws {never} Never.
   */
  const stop = (): void => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdout?.destroy();
  };
  /**
   * Record the cancellation and stop the process.
   * @throws {never} Never.
   */
  const onAbort = (): void => { failure ??= new DOMException("Planned command was cancelled", "AbortError"); stop(); };
  child.stderr?.on("data", (chunk: Buffer) => {
    const limit = options.stderrTailBytes;
    stderr = Buffer.from(chunk.length >= limit ? chunk.subarray(-limit) : Buffer.concat([stderr, chunk]).subarray(-limit));
  });
  child.on("error", (error) => { failure ??= error; });
  child.stderr?.on("error", (error) => { failure ??= error; });
  // The caller sees a broken pipe through its own write or read; the exit below carries the cause.
  child.stdin?.on("error", () => undefined);
  options.signal.addEventListener("abort", onAbort, { once: true });
  const done = new Promise<void>((resolve, reject) => {
    child.once("close", (code, signal) => {
      options.signal.removeEventListener("abort", onAbort);
      if (failure !== undefined) reject(failure);
      else if (code === 0) resolve();
      else reject(code === null ? new Error(`${program} exited ${signal}: ${stderr.toString("utf8")}`) : new PlanCommandExit(program, code, stderr.toString("utf8")));
    });
  });
  // A caller that stops early awaits `done` after `stop`; until then a rejection is not unhandled.
  done.catch(() => undefined);
  return { stdin: child.stdin, stdout: child.stdout, done, stop, stderr: () => stderr.toString("utf8") };
}
