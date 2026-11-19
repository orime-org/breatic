// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { MiniToolsConfig } from "@breatic/core";
import { EDIT_FILE_TIERS, type EditFileTier, type VideoEncoderRates } from "@breatic/shared/mini-tools";

/**
 * The encoder rates of a configuration snapshot (frames-split §5.4 estimate row): the original's decode rate per source
 * decode key and the edit file's per tier (`encoding.decoder.edit_*`), the playback and per-tier encode rates and the
 * tone-map rate. Presentation admission and run admission freeze the same table.
 * @param config - The snapshot.
 * @returns The rates.
 * @throws {never} Never.
 */
export function videoEncoderRates(config: MiniToolsConfig): VideoEncoderRates {
  const { encoder, decoder } = config.encoding;
  /**
   * One rate per edit tier from a `<tier>_pixels_per_second` table.
   * @param table - The configured table.
   * @returns The rates by tier.
   * @throws {never} Never.
   */
  const byTier = (table: Record<`${EditFileTier}_pixels_per_second`, number>): Record<EditFileTier, number> =>
    Object.fromEntries(EDIT_FILE_TIERS.map((tier) => [tier, table[`${tier}_pixels_per_second`]])) as Record<EditFileTier, number>;
  return {
    startSeconds: encoder.start_seconds, encodePixelsPerSecond: encoder.encode_pixels_per_second, tonemapPixelsPerSecond: encoder.tonemap_pixels_per_second,
    decodeConvertPixelsPerSecond: { ...encoder.decode_convert_pixels_per_second, ...byTier(decoder) }, editEncodePixelsPerSecond: byTier(encoder),
  };
}
