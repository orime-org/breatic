// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One run that turns a picture upright (inner#1367 §4.4).
 *
 * The turned picture is probed and previewed where it lies in the container,
 * and written back last with the pixel size measured on it. So by the time
 * the copy exists in R2 its size is on it, and a re-delivery of the finish
 * answers the copy's size from the object without turning it again; it starts
 * a run only to cut a preview that is missing.
 */

import { pickMediaMetadata, NOTHING_FOUND, type ProbeReport } from "@ingest/media-metadata.js";
import {
  PREVIEW_MAX_BYTES,
  PROBE_MAX_BYTES,
  previewArgs,
  probeArgs,
  readProbeOutput,
} from "@ingest/probe-command.js";
import { previewSource } from "@ingest/preview-step.js";
import {
  UPRIGHT_HEIGHT_HEADER,
  UPRIGHT_WIDTH_HEADER,
  uprightArgs,
  type UprightOrder,
  type UprightOutcome,
} from "@ingest/upright-run.js";
import type { ToolRun } from "./run-tool.js";

/** What one upright run reaches out to. */
export interface UprightDeps {
  /** Open the stored picture as a stream. */
  openObject: (objectUrl: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>;
  /** Run one tool and collect what it wrote. */
  runTool: (program: string, args: string[], run: ToolRun) => Promise<Buffer | null>;
  /** Put bytes in a file of the container's own, for ffprobe to read. */
  writeTemp: (bytes: Uint8Array) => Promise<{ path: string; remove: () => Promise<void> }>;
  /** PUT the turned picture; answers the status. */
  put: (url: string, headers: Record<string, string>, body: Uint8Array) => Promise<number>;
}

/** What one upright run answers with. */
export interface UprightRan {
  report: ProbeReport;
  preview: Uint8Array | null;
  outcome: UprightOutcome;
}

/**
 * Turn the picture upright, probe and preview the turned picture, and write it
 * back with its pixel size.
 * @param objectUrl - Where the stored picture is read.
 * @param order - How to encode it and where to write it.
 * @param asked - Whether a preview is wanted, and when the run's time is up.
 * @param asked.wantPreview - Whether the caller asked for a preview.
 * @param asked.deadlineAt - When the task runs out, in epoch ms.
 * @param signal - The run's deadline, every tool held to it.
 * @param deps - The tools, the file and the write.
 * @returns The report on the turned picture, its preview, and how it ended.
 */
export async function runUpright(
  objectUrl: string,
  order: UprightOrder,
  asked: { wantPreview: boolean; deadlineAt: number },
  signal: AbortSignal,
  deps: UprightDeps,
): Promise<UprightRan> {
  const failedTurn: UprightRan = {
    report: NOTHING_FOUND,
    preview: null,
    outcome: { state: "failed", step: "turn" },
  };
  const args = uprightArgs(order);
  if (args === null) return failedTurn;
  const input = await deps.openObject(objectUrl, signal);
  if (input === null) return failedTurn;
  const turned = await deps.runTool("vips", args, { maxBytes: order.maxBytes, signal, input });
  if (turned === null) return failedTurn;

  const file = await deps.writeTemp(turned);
  try {
    const probed = await deps.runTool("ffprobe", probeArgs(file.path, "own-file"), {
      maxBytes: PROBE_MAX_BYTES,
      signal,
    });
    const report = probed === null ? NOTHING_FOUND : readProbeOutput(probed.toString("utf8"));

    const source = previewSource({
      wantPreview: asked.wantPreview,
      wantCover: false,
      cover: null,
      report,
      deadlineAt: asked.deadlineAt,
      now: Date.now(),
    });
    const cut =
      source === "object"
        ? await deps.runTool("vips", previewArgs(), { maxBytes: PREVIEW_MAX_BYTES, signal, input: turned })
        : null;

    const { width, height } = pickMediaMetadata(report);
    const status = await deps.put(
      order.writeUrl,
      {
        ...(width !== null && { [UPRIGHT_WIDTH_HEADER]: String(width) }),
        ...(height !== null && { [UPRIGHT_HEIGHT_HEADER]: String(height) }),
      },
      turned,
    );
    return {
      report,
      preview: cut === null ? null : new Uint8Array(cut),
      outcome: status === 200 ? { state: "written" } : { state: "failed", step: "write" },
    };
  } finally {
    await file.remove();
  }
}
