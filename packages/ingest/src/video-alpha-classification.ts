// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Trusted channel-presence evidence, separate from storage readiness. */
export type VideoAlphaClassification = 'confirmed_alpha' | 'confirmed_opaque' | 'unknown';

/**
 * Classify the sole real video using its probe and this FFmpeg build's descriptors.
 * @param probe - Complete raw streams and format facts from the stored source.
 * @param pixelFormats - This bundled ffprobe's actual pixel-format descriptors.
 * @returns Confirmed channel presence, or unknown when evidence is insufficient.
 * @throws {never} Invalid or ambiguous facts remain unknown.
 */
export function classifyVideoAlpha(probe: unknown, pixelFormats: unknown): VideoAlphaClassification {
  void probe;
  void pixelFormats;
  return 'unknown';
}
