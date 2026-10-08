// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Running one media tool as a separate program and feeding it the object.
 *
 * The read and the tool are two halves of one step, so both answer to one
 * signal: when it fires, the read is aborted and the tool is killed together.
 */

import { execFile } from "node:child_process";
import { Readable, pipeline } from "node:stream";

/** What one tool run is given. */
export interface ToolRun {
  /** The most stdout may hold. */
  maxBytes: number;
  /** When it fires, the tool is killed and its input aborted. */
  signal: AbortSignal;
  /** Bytes or a stream to hand the tool on stdin, when it reads from there. */
  input?: Uint8Array | ReadableStream<Uint8Array>;
}

/**
 * Run one tool and collect what it wrote.
 *
 * A source that breaks off kills the tool: a decoder fed a short picture
 * still writes one, grey where the bytes stopped. A tool that stops reading
 * early ends the input, and its own exit says how it went.
 * @param program - `ffprobe`, `ffmpeg` or `vips`.
 * @param args - Its argument list.
 * @param run - Its output ceiling, its signal and its input.
 * @returns What it wrote, or null when it failed, was cut off or produced
 *   nothing.
 */
export async function runTool(
  program: string,
  args: string[],
  run: ToolRun,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let inputBroke = false;
    const child = execFile(
      program,
      args,
      { encoding: "buffer", maxBuffer: run.maxBytes, signal: run.signal },
      (error, stdout) => {
        if (inputBroke) {
          resolve(null);
          return;
        }
        if (error !== null) {
          // The upload succeeds either way, so this is the only place the
          // reason exists: without it a video with no cover and a video whose
          // ffmpeg was killed look the same from outside. `signal` or an
          // AbortError names a deadline the tool was cut off at, `code` a
          // refusal it decided on its own, and neither is on the Worker's
          // side of the wire.
          console.error("media_tool_failed", {
            program,
            signal: error.signal ?? null,
            code: error.code ?? null,
            err: error.message,
          });
          resolve(null);
          return;
        }
        if (stdout.length === 0) {
          console.error("media_tool_wrote_nothing", { program });
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
    if (run.input === undefined || child.stdin === null) return;
    const source =
      run.input instanceof Uint8Array
        ? Readable.from([run.input])
        : Readable.fromWeb(run.input);
    // Once the tool has closed its stdin (EPIPE comes before the close),
    // pipeline destroys the source with that error: it is not the source
    // breaking off.
    let toolStoppedReading = false;
    const stopped = (): void => {
      toolStoppedReading = true;
    };
    child.stdin.once("error", stopped);
    child.stdin.once("close", stopped);
    source.once("error", (err) => {
      // The signal aborts the read as it kills the tool, and the tool's exit
      // above already names that.
      if (toolStoppedReading || run.signal.aborted) return;
      inputBroke = true;
      console.error("media_tool_input_failed", { program, err: err.message });
      child.kill();
    });
    // Either end failing tears both down. A tool that exits before reading
    // everything closes its stdin, which lands here too, and its exit above
    // already says how it went.
    pipeline(source, child.stdin, () => {});
  });
}

/**
 * Open the stored object as a stream, for a tool that reads stdin.
 * @param objectUrl - Where to read it.
 * @param signal - The run's signal, shared with the tool that reads it.
 * @returns The body, or null when it could not be opened.
 */
export async function openObject(
  objectUrl: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res = await fetch(objectUrl, { signal });
    if (res.ok && res.body !== null) return res.body;
    console.error("media_object_open_failed", { status: res.status });
    await res.body?.cancel();
    return null;
  } catch (err) {
    console.error("media_object_open_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
