// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readAnalysisFrames } from "@ingest/container/analysis-frame-reader.js";

/** A directly spawned internal program; no shell command is accepted. */
export interface AnalysisProgram { program: string; args: readonly string[] }
/** Frozen frame geometry and the caller's resource limits for one pipeline. */
export interface AnalysisPipelineRequest {
  decoder: AnalysisProgram;
  processor: AnalysisProgram;
  width: number;
  height: number;
  expectedFrameCount: number;
  signal: AbortSignal;
  limits: { stdoutBytes: number; stderrTailBytes: number };
}
/** Final process observations, including diagnostics independent of the first failure. */
export interface AnalysisProcessDiagnostic {
  stage: "decoder" | "processor";
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderrTail: string;
}
/** Resources retained only by the invocation that created them. */
interface OwnedAnalysisProcess {
  child: ChildProcessWithoutNullStreams;
  stage: AnalysisProcessDiagnostic["stage"];
  close: Promise<void>;
  stderrTail: Buffer;
}
/** An analysis failure reported only after its owned children have closed. */
export class AnalysisPipelineError extends Error {
  /**
   * Preserve the first failure and final process diagnostics.
   * @param cause - The first observed failure.
   * @param diagnostics - Final observations for each spawned child.
   * @throws {never} Never.
   */
  constructor(cause: unknown, readonly diagnostics: AnalysisProcessDiagnostic[]) {
    super(`Analysis pipeline failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = cause instanceof Error && cause.name === "AbortError" ? "AbortError" : "AnalysisPipelineError";
  }
}
/**
 * Pump exact frames through two owned programs and await complete process cleanup.
 * @param request - Internal programs, frozen geometry and this operation's lifetime.
 * @returns The processor's original stdout, for validation by the caller.
 * @throws {AnalysisPipelineError} When input, processes, IO limits or cancellation fail.
 */
export async function runAnalysisPipeline(request: AnalysisPipelineRequest): Promise<string> {
  const owned: OwnedAnalysisProcess[] = [];
  const lifetime = new AbortController();
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let firstFailure: unknown;
  let inputComplete = false;
  let settled = false;

  /**
   * Preserve the first failure and wake IO before waiting for actual closes.
   * @param error - The first failing event, or a later cleanup consequence.
   * @throws {never} Never.
   */
  const fail = (error: unknown): void => {
    if (settled || firstFailure !== undefined) return;
    firstFailure = error;
    lifetime.abort();
    for (const { child } of owned) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };

  /**
   * Cancel this invocation without affecting another invocation's children.
   * @throws {never} Never.
   */
  const onAbort = (): void => { fail(new DOMException("Analysis pipeline was cancelled", "AbortError")); };

  /**
   * Start and retain one program, draining diagnostics from its first byte.
   * @param program - An internal executable and argument vector.
   * @param stage - The role used in final diagnostics.
   * @returns The spawned process, or null after a failed start.
   * @throws {Error} When spawn rejects its synchronous arguments.
   */
  const start = async (program: AnalysisProgram, stage: AnalysisProcessDiagnostic["stage"]): Promise<OwnedAnalysisProcess | null> => {
    if (firstFailure !== undefined) return null;
    const child = spawn(program.program, [...program.args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const item: OwnedAnalysisProcess = { child, stage, close: Promise.resolve(), stderrTail: Buffer.alloc(0) };
    owned.push(item);
    item.close = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (code !== 0) fail(new Error(`${stage} exited ${code ?? signal}`));
        else if (stage === "processor" && !inputComplete) fail(new Error("Analysis processor closed before its complete input"));
        resolve();
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const cap = request.limits.stderrTailBytes;
      if (cap === 0) return;
      const tail = chunk.length >= cap ? chunk.subarray(chunk.length - cap) : Buffer.concat([item.stderrTail, chunk]).subarray(-cap);
      item.stderrTail = Buffer.from(tail);
    });
    if (stage === "processor") child.stdout?.on("data", (chunk: Buffer) => {
      if (firstFailure !== undefined) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.limits.stdoutBytes) {
        fail(new Error(`Analysis stdout exceeded ${request.limits.stdoutBytes} bytes`));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stdin?.on("error", fail);
    child.stdout?.on("error", fail);
    child.stderr?.on("error", fail);
    const started = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => { resolve(true); });
      child.once("error", (error) => { fail(error); resolve(false); });
    });
    return started ? item : null;
  };

  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.signal.aborted) onAbort();
    if (!Object.values(request.limits).every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new RangeError("Analysis IO byte limits must be nonnegative safe integers");
    }
    const decoder = await start(request.decoder, "decoder");
    if (decoder !== null && firstFailure === undefined) {
      decoder.child.stdin.end();
      const processor = await start(request.processor, "processor");
      if (processor !== null && firstFailure === undefined) {
        /**
         * Mark complete only after natural EOF validates the frozen frame ledger.
         * @returns Complete owned frames in their source order.
         * @throws {Error} When reading fails or the operation is cancelled.
         */
        const frames = async function* (): AsyncGenerator<Buffer, void> {
          for await (const frame of readAnalysisFrames({
            source: decoder.child.stdout, width: request.width, height: request.height,
            expectedFrameCount: request.expectedFrameCount, signal: lifetime.signal,
          })) yield frame.bytes;
          inputComplete = true;
        };
        await pipeline(Readable.from(frames(), { objectMode: false }), processor.child.stdin, { signal: lifetime.signal });
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    await Promise.all(owned.map(({ close }) => close));
    settled = true;
    request.signal.removeEventListener("abort", onAbort);
  }
  if (firstFailure !== undefined) throw new AnalysisPipelineError(firstFailure, owned.map(({ child, stage, stderrTail }) => ({
    stage, exitCode: child.exitCode, signalCode: child.signalCode, stderrTail: stderrTail.toString("utf8"),
  })));
  return Buffer.concat(stdout, stdoutBytes).toString("utf8");
}
