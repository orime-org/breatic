// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the mini-tool container posts when its run ends (inner#888 §8.1 step 4),
 * and how the Durable Object reads it.
 */

import { CONTAINER_FAILURES, type ContainerFailure } from "@shared/mini-tools/types.js";

/** The numbers ffprobe read inside the container, per main output. */
export interface MediaOfOutput {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  cover: { width: number | null; height: number | null } | null;
}

/** What the container reports. */
export interface ContainerReportBody {
  ok: boolean;
  cpuUsec: number | null;
  media: Record<string, MediaOfOutput>;
  /** Why a failed run failed, when the container could name it. */
  reason?: ContainerFailure;
}

/**
 * Read a report the container posted. A cause this side does not know is
 * dropped, and the failure stays unnamed.
 * @param body - The parsed JSON body.
 * @returns The report, or null when it has no `ok`.
 */
export function readContainerReport(body: unknown): ContainerReportBody | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.ok !== "boolean") return null;
  const reason = CONTAINER_FAILURES.find((known) => known === raw.reason);
  return {
    ok: raw.ok,
    cpuUsec: typeof raw.cpuUsec === "number" ? raw.cpuUsec : null,
    media: typeof raw.media === "object" && raw.media !== null ? (raw.media as Record<string, MediaOfOutput>) : {},
    ...(reason !== undefined && { reason }),
  };
}
