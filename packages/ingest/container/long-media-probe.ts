// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { PROBE_MAX_BYTES, probeArgs } from "@ingest/probe-command.js";
import { runTool } from "./run-tool.js";

/** The Container's fenced request to inspect one immutable source. */
export interface LongMediaProbeRunRequest {
  objectUrl: string;
  reportUrl: string;
  deadlineAt: number;
}

/** Dependencies that let the long-media probe protocol run without a real Container. */
export interface LongMediaProbeRunDeps {
  execute(objectUrl: string, signal: AbortSignal): Promise<string | null>;
  report(reportUrl: string, result: LongMediaProbeRunResult): Promise<void>;
  now(): number;
}

/** A complete probe answer or a controlled execution failure. */
export type LongMediaProbeRunResult = { stdout: string } | { failure: "probe_failed" };

/**
 * Probe one source and return the raw measured facts to the Worker.
 * @param request - The source, report endpoint and absolute operation deadline.
 * @param deps - The process, network and clock dependencies.
 * @returns Nothing; the report is delivered to the fenced callback.
 * @throws {Error} When the deadline has passed, probing fails or reporting is refused.
 */
export async function runLongMediaProbe(
  request: LongMediaProbeRunRequest,
  deps: LongMediaProbeRunDeps = LONG_MEDIA_PROBE_DEPS,
): Promise<void> {
  const remainingMs = request.deadlineAt - deps.now();
  if (remainingMs <= 0) {
    await deps.report(request.reportUrl, { failure: "probe_failed" });
    return;
  }
  let stdout: string | null;
  try {
    stdout = await deps.execute(request.objectUrl, AbortSignal.timeout(remainingMs));
  } catch {
    await deps.report(request.reportUrl, { failure: "probe_failed" });
    return;
  }
  await deps.report(request.reportUrl, stdout === null ? { failure: "probe_failed" } : { stdout });
}

const LONG_MEDIA_PROBE_DEPS: LongMediaProbeRunDeps = {
  execute: async (objectUrl, signal) => {
    const result = await runTool("ffprobe", probeArgs(objectUrl), { maxBytes: PROBE_MAX_BYTES, signal });
    return result?.toString("utf8") ?? null;
  },
  report: async (reportUrl, result) => {
    const response = await fetch(reportUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The long media probe report was answered ${response.status}`);
  },
  now: () => Date.now(),
};
