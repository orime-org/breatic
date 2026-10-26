// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Exact physical video facts retain their original selected stream and integer clock. */
export interface PhysicalVideoProbe {
  streamIndex: number;
  trackId: number;
  sourceTimeBase: { numerator: string; denominator: string };
  frames: { rawDecodeOrdinal: number; ptsTicks: string }[];
}

/**
 * Read original physical FFprobe bytes without rounding integer PTS or applying edits.
 * @param _metadata - Original stream metadata from the same immutable source.
 * @param _physicalFrameBytes - Complete physical v:0 frame JSON stdout.
 * @throws {Error} When the selected stream, track, source clock or frame facts are invalid.
 */
export function parsePhysicalVideoProbe(_metadata: unknown, _physicalFrameBytes: Buffer): PhysicalVideoProbe {
  throw new Error("Physical video probe parsing is not implemented");
}
