// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Encoding and carrier configuration (inner#1306; frames-split design §5.4 chunk share, parallel cap, throughput, estimate
 * row and per-job outputs, §4.2 edit tiers, §4.3 and §8.2 carrier settings).
 *
 * Values the design gives are asserted: chunk share 0.5, parallel chunk cap 8, `max_outputs_per_job` 8, an encoded carrier on standard-4 with short side at most 1080 and SDR
 * BT.709 labels, and the rate table the estimate reads, which runs only on standard-4: start 3 s, the encode rate, one
 * decode rate per source decode key, the HDR tone-map rate, and an encode and a decode rate per edit-file tier.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { MINI_TOOL_JOB_MAX_OUTPUTS, SOURCE_DECODE_KEYS } from '@breatic/shared';
import { MONOREPO_ROOT } from '../env.js';
import { getMiniToolsConfig, miniToolsConfigSchema } from '../mini-tools.js';

// The five edit-file tiers (frames-split §4.2), each with an encode and a decode rate.
const TIER_KEYS = ['edit_h264_intra_8bit_420', 'edit_h264_intra_10bit_420', 'edit_h264_intra_8bit_444', 'edit_h264_intra_10bit_444', 'edit_prores'] as const;
/**
 * One rate per edit-file tier.
 * @param rate - The first tier's rate; each next tier one less.
 * @returns The tier rates.
 */
const TIERS = (rate: number): Record<string, number> => Object.fromEntries(TIER_KEYS.map((tier, index) => [`${tier}_pixels_per_second`, rate - index]));
// S6e E1 (§90): the carrier names no class; standard-4 is encoding.encoder.container_class alone.
const CARRIER = { max_short_side: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } };

/**
 * The current configuration with explicit test values for every S6b key.
 * @returns A complete raw configuration.
 */
function configured(): Record<string, unknown> {
  const current = structuredClone(getMiniToolsConfig()) as unknown as Record<string, Record<string, unknown>>;
  const executions = current.executions as Record<string, Record<string, unknown>>;
  return {
    ...current,
    encoding: {
      chunk_share: 0.25, max_parallel_chunks: 3, chunk_retries: 2,
      encoder: { ...TIERS(700), container_class: 'MiniToolContainerStd4', start_seconds: 2, encode_pixels_per_second: 9000,
        decode_convert_pixels_per_second: Object.fromEntries(SOURCE_DECODE_KEYS.map((key, index) => [key, 8000 - index])), tonemap_pixels_per_second: 3000 },
      decoder: TIERS(900),
    },
    presentation: { ...current.presentation, policy_version: 1, carrier: { max_short_side: 720, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } } },
    executions: {
      ...executions,
      'video.extract-frames': { ...executions['video.extract-frames'], max_outputs_per_job: 2 },
      'video.split': { ...executions['video.split'], max_outputs_per_job: 3 },
    },
  };
}

/**
 * Copy a value and replace one nested field.
 * @param value - The source value.
 * @param path - Keys from the root to the field.
 * @param replacement - The new value; `undefined` deletes the key.
 * @returns The patched copy.
 */
function patched(value: Record<string, unknown>, path: readonly string[], replacement: unknown): Record<string, unknown> {
  const copy = structuredClone(value);
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  if (replacement === undefined) delete parent[path.at(-1)!];
  else parent[path.at(-1)!] = replacement;
  return copy;
}

const ENCODER = {
  container_class: 'MiniToolContainerStd4', start_seconds: 3, encode_pixels_per_second: 248_000_000,
  // frames-split §5.4: each source decode key's slowest covered codec, 4-thread maintainer readings.
  decode_convert_pixels_per_second: {
    sdr_8bit: 910_000_000, sdr_10bit: 810_000_000, sdr_12bit: 690_000_000, sdr_alpha_layer: 600_000_000, sdr_prores: 820_000_000, sdr_dnx: 735_000_000,
    sdr_av1_8bit: 740_000_000, sdr_av1_10bit: 570_000_000, sdr_av1_12bit: 610_000_000, sdr_jpeg2000: 25_000_000, sdr_ffv1: 75_000_000, sdr_png: 340_000_000,
    sdr_other: 1_080_000_000,
  },
  tonemap_pixels_per_second: 420_000_000,
  edit_h264_intra_8bit_420_pixels_per_second: 300_000_000, edit_h264_intra_10bit_420_pixels_per_second: 250_000_000,
  edit_h264_intra_8bit_444_pixels_per_second: 200_000_000, edit_h264_intra_10bit_444_pixels_per_second: 180_000_000, edit_prores_pixels_per_second: 400_000_000,
};
const DECODER = {
  edit_h264_intra_8bit_420_pixels_per_second: 1_500_000_000, edit_h264_intra_10bit_420_pixels_per_second: 1_200_000_000,
  edit_h264_intra_8bit_444_pixels_per_second: 1_100_000_000, edit_h264_intra_10bit_444_pixels_per_second: 900_000_000, edit_prores_pixels_per_second: 950_000_000,
};

describe('EC encoding and carrier configuration', () => {
  it('EC01 the shipped YAML, the getter and the loader defaults give the design values', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, Record<string, unknown>>;
    const expected = {
      encoding: { chunk_share: 0.5, max_parallel_chunks: 8, encoder: ENCODER, decoder: DECODER },
      presentation: { carrier: CARRIER },
      executions: { 'video.extract-frames': { max_outputs_per_job: 8 }, 'video.split': { max_outputs_per_job: 8 } },
    };
    expect(raw).toMatchObject(expected);
    expect(getMiniToolsConfig()).toMatchObject(expected);
    expect(MINI_TOOL_JOB_MAX_OUTPUTS).toBe(8);
    let omitted = patched(configured(), ['encoding', 'chunk_share'], undefined);
    omitted = patched(omitted, ['encoding', 'max_parallel_chunks'], undefined);
    omitted = patched(omitted, ['presentation', 'carrier'], undefined);
    omitted = patched(omitted, ['encoding', 'encoder'], undefined);
    omitted = patched(omitted, ['encoding', 'decoder'], undefined);
    omitted = patched(omitted, ['executions', 'video.split', 'max_outputs_per_job'], undefined);
    omitted = patched(omitted, ['executions', 'video.extract-frames', 'max_outputs_per_job'], undefined);
    expect(miniToolsConfigSchema.parse(omitted)).toMatchObject({
      encoding: { chunk_share: 0.5, max_parallel_chunks: 8, encoder: ENCODER, decoder: DECODER }, presentation: { carrier: CARRIER },
      executions: { 'video.extract-frames': { max_outputs_per_job: 8 }, 'video.split': { max_outputs_per_job: 8 } },
    });
  });

  it('EC02 keeps every configured value', () => {
    const input = configured();
    const parsed = miniToolsConfigSchema.parse(input) as unknown as Record<string, Record<string, unknown>>;
    expect(parsed.encoding).toMatchObject(input.encoding as Record<string, unknown>);
    expect(parsed.presentation!.carrier).toEqual((input.presentation as Record<string, unknown>).carrier);
    expect(parsed.executions).toEqual(input.executions);
  });

  it('EC03 decodes by exactly the source decode keys and rates every edit tier on both sides', () => {
    const { encoder, decoder } = getMiniToolsConfig().encoding;
    expect(Object.keys(encoder.decode_convert_pixels_per_second).sort()).toEqual([...SOURCE_DECODE_KEYS].sort());
    for (const tier of TIER_KEYS) {
      expect((encoder as unknown as Record<string, number>)[`${tier}_pixels_per_second`]).toBeGreaterThan(0);
      expect((decoder as unknown as Record<string, number>)[`${tier}_pixels_per_second`]).toBeGreaterThan(0);
    }
  });

  it('EC04 encoder rates exist only for standard-4: basic only probes and copies', () => {
    const encoding = (getMiniToolsConfig() as unknown as { encoding: Record<string, unknown> }).encoding;
    expect(Object.keys(encoding).sort()).toEqual(['chunk_retries', 'chunk_share', 'decoder', 'encoder', 'max_parallel_chunks']);
    expect((encoding.encoder as Record<string, unknown>).container_class).toBe('MiniToolContainerStd4');
  });

  it.each([
    ['a zero chunk share', ['encoding', 'chunk_share'], 0], ['a negative chunk share', ['encoding', 'chunk_share'], -0.5],
    ['a chunk share above the whole budget', ['encoding', 'chunk_share'], 1.5], ['a non-finite chunk share', ['encoding', 'chunk_share'], Number.NaN],
    ['a zero parallel cap', ['encoding', 'max_parallel_chunks'], 0], ['a fractional parallel cap', ['encoding', 'max_parallel_chunks'], 1.5],
    ['an encoder on the basic class', ['encoding', 'encoder', 'container_class'], 'MediaContainer'],
    ['a zero encode rate', ['encoding', 'encoder', 'encode_pixels_per_second'], 0],
    ['a zero decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'sdr_8bit'], 0],
    ['a missing AV1 10-bit decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'sdr_av1_10bit'], undefined],
    ['a missing ProRes decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'sdr_prores'], undefined],
    ['a decode-convert rate for a removed HDR key', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'hdr_10bit'], 100],
    ['a zero tone-map rate', ['encoding', 'encoder', 'tonemap_pixels_per_second'], 0],
    ['a missing edit-tier encode rate', ['encoding', 'encoder', 'edit_prores_pixels_per_second'], undefined],
    ['a zero edit-tier decode rate', ['encoding', 'decoder', 'edit_h264_intra_8bit_420_pixels_per_second'], 0],
    ['an unknown edit tier', ['encoding', 'decoder', 'edit_hevc_pixels_per_second'], 100],
    ['a configured copy disk margin', ['encoding', 'copy_disk_margin_bytes'], 100],
    ['negative start seconds', ['encoding', 'encoder', 'start_seconds'], -1],
    ['a download rate', ['encoding', 'encoder', 'download_bytes_per_second'], 100],
    ['a zero carrier short side', ['presentation', 'carrier', 'max_short_side'], 0], ['a fractional carrier short side', ['presentation', 'carrier', 'max_short_side'], 1080.5],
    ['an empty carrier transfer', ['presentation', 'carrier', 'color', 'transfer'], ''],
    ['zero outputs per job', ['executions', 'video.split', 'max_outputs_per_job'], 0],
    ['more outputs per job than the job contract allows', ['executions', 'video.split', 'max_outputs_per_job'], MINI_TOOL_JOB_MAX_OUTPUTS + 1],
    ['fractional outputs per job', ['executions', 'video.extract-frames', 'max_outputs_per_job'], 1.5],
  ] as const)('EC05 rejects %s after accepting the complete valid configuration', (_, path, value) => {
    expect(miniToolsConfigSchema.safeParse(configured()).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(patched(configured(), path, value)).success).toBe(false);
  });
});

describe('EC retry cap (frames-split §5.4 configuration row)', () => {
  it('EC06 the YAML, the getter and the loader default give chunk_retries 3', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(raw.encoding!.chunk_retries).toBe(3);
    expect(getMiniToolsConfig().encoding.chunk_retries).toBe(3);
    expect(miniToolsConfigSchema.parse(patched(configured(), ['encoding', 'chunk_retries'], undefined))).toMatchObject({ encoding: { chunk_retries: 3 } });
  });

  it('EC07 keeps a configured cap, zero included', () => {
    expect(miniToolsConfigSchema.parse(patched(configured(), ['encoding', 'chunk_retries'], 0))).toMatchObject({ encoding: { chunk_retries: 0 } });
  });

  it.each([
    ['a negative chunk_retries', ['encoding', 'chunk_retries'], -1], ['a fractional chunk_retries', ['encoding', 'chunk_retries'], 1.5],
  ] as const)('EC08 rejects %s after accepting the valid configuration', (_, path, value) => {
    expect(miniToolsConfigSchema.safeParse(configured()).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(patched(configured(), path, value)).success).toBe(false);
  });
});
