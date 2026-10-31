// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  LongMediaInputSchema,
  LongMediaStreamSchema,
  LongMediaProbeReportSchema,
  MediaInputDescriptorSchema,
  type LongMediaProbeReport,
} from "@shared/media/long-media-schema.js";

export { LongMediaInputSchema, LongMediaProbeReportSchema, LongMediaStreamSchema, MediaInputDescriptorSchema };
export type { LongMediaInput, LongMediaStream } from "@shared/media/long-media-schema.js";

/** The validated probe report for one complete media file. */
export type { LongMediaProbeReport } from "@shared/media/long-media-schema.js";

/**
 * Validate probe output before it can define a source file's time range.
 * @param value - The decoded Container response.
 * @returns The probe facts for one complete source file.
 * @throws {Error} When stream identity, media kind or the full source range is invalid.
 */
export function readLongMediaProbeReport(value: unknown): LongMediaProbeReport {
  return LongMediaProbeReportSchema.parse(value);
}
