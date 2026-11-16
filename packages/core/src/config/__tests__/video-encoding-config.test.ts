// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6b encoding and carrier configuration (inner#1306, test plan §88; frames-split
 * design §5.4 chunk share, parallel cap, throughput and per-job outputs, §5.1
 * copy disk margin, §5.3 model input preparation class, §4.3 and §8.2 carrier
 * settings).
 *
 * Values the design gives are asserted (design 0fbbe4e0 §5.4 配置初值, 430a4894 and
 * 7e5f20ae 估算): chunk share 0.5, parallel chunk cap 8, `max_outputs_per_job` 8,
 * the remove-bg preparation on standard-4 with precheck 300 s, an encoded carrier
 * on standard-4 with short side at most 1080 and SDR BT.709 labels, a copy disk
 * margin equal to the configured full plus compact byte caps, and the encoder,
 * which runs only on standard-4: start 3 s, encode 163,000,000 output pixels per
 * second, decode-convert 1,950,000,000 / 705,000,000 / 152,000,000 / 103,000,000
 * source pixels per second for 8-bit SDR / 10-bit SDR / 8-bit HDR / 10-bit HDR.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { MINI_TOOL_JOB_MAX_OUTPUTS } from '@breatic/shared';
import { MONOREPO_ROOT } from '../env.js';
import { getMiniToolsConfig, miniToolsConfigSchema } from '../mini-tools.js';

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
      encoder: { container_class: 'MiniToolContainerStd4', start_seconds: 2, encode_pixels_per_second: 9000, decode_convert_pixels_per_second: { sdr_8bit: 8000, sdr_10bit: 7000, sdr_12bit: 6500, hdr_8bit: 6000, hdr_10bit: 5000, hdr_12bit: 4500, sdr_16bit: 4200, hdr_16bit: 4000 } },
    },
    presentation: { ...current.presentation, policy_version: 1, carrier: { max_short_side: 720, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } } },
    executions: {
      ...executions,
      'video.remove-bg': { ...executions['video.remove-bg'], preparation: { container_class: 'MiniToolContainerStd4', precheck_seconds: 41 } },
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
  // S6d D1-3 (§91): all rates re-measured under one condition, nproc 4 as on standard-4 (encode-throughput nproc4 and 12-bit runs).
  decode_convert_pixels_per_second: { sdr_8bit: 2_200_000_000, sdr_10bit: 1_310_000_000, sdr_12bit: 816_000_000, hdr_8bit: 106_000_000, hdr_10bit: 102_000_000, hdr_12bit: 109_000_000, sdr_16bit: 294_000_000, hdr_16bit: 71_900_000 },
};

describe('EC S6b encoding and carrier configuration', () => {
  it('EC01 the shipped YAML, the getter and the loader defaults give the design values', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, Record<string, unknown>>;
    const expected = {
      encoding: { chunk_share: 0.5, max_parallel_chunks: 8, encoder: ENCODER },
      presentation: { carrier: CARRIER },
      executions: {
        'video.remove-bg': { preparation: { container_class: 'MiniToolContainerStd4', precheck_seconds: 300 } },
        'video.extract-frames': { max_outputs_per_job: 8 }, 'video.split': { max_outputs_per_job: 8 },
      },
    };
    expect(raw).toMatchObject(expected);
    expect(getMiniToolsConfig()).toMatchObject(expected);
    expect(MINI_TOOL_JOB_MAX_OUTPUTS).toBe(8);
    let omitted = patched(configured(), ['encoding', 'chunk_share'], undefined);
    omitted = patched(omitted, ['encoding', 'max_parallel_chunks'], undefined);
    omitted = patched(omitted, ['presentation', 'carrier'], undefined);
    omitted = patched(omitted, ['encoding', 'encoder'], undefined);
    omitted = patched(omitted, ['executions', 'video.split', 'max_outputs_per_job'], undefined);
    omitted = patched(omitted, ['executions', 'video.extract-frames', 'max_outputs_per_job'], undefined);
    omitted = patched(omitted, ['executions', 'video.remove-bg', 'preparation'], undefined);
    expect(miniToolsConfigSchema.parse(omitted)).toMatchObject({
      encoding: { chunk_share: 0.5, max_parallel_chunks: 8, encoder: ENCODER }, presentation: { carrier: CARRIER },
      executions: { 'video.remove-bg': { preparation: { container_class: 'MiniToolContainerStd4', precheck_seconds: 300 } }, 'video.extract-frames': { max_outputs_per_job: 8 }, 'video.split': { max_outputs_per_job: 8 } },
    });
  });

  it('EC02 keeps every configured S6b value', () => {
    const input = configured();
    const parsed = miniToolsConfigSchema.parse(input) as unknown as Record<string, Record<string, unknown>>;
    expect(parsed.encoding).toMatchObject(input.encoding as Record<string, unknown>);
    expect(parsed.presentation!.carrier).toEqual((input.presentation as Record<string, unknown>).carrier);
    expect(parsed.executions).toEqual(input.executions);
  });

  it('EC03 the copy disk margin is the configured full plus compact byte caps, read from the same configuration', () => {
    const config = getMiniToolsConfig() as unknown as { encoding: { copy_disk_margin_bytes: number }; presentation: { source_ledger: { max_bytes: number } } };
    // One `max_bytes` caps the full ledger and the compact table alike, so their sum is twice it.
    expect(config.encoding.copy_disk_margin_bytes).toBe(config.presentation.source_ledger.max_bytes + config.presentation.source_ledger.max_bytes);
    const custom = patched(configured(), ['presentation', 'source_ledger', 'max_bytes'], 1000);
    expect((miniToolsConfigSchema.parse(custom) as unknown as { encoding: { copy_disk_margin_bytes: number } }).encoding.copy_disk_margin_bytes).toBe(2000);
  });

  it('EC04 encoder rates exist only for standard-4: basic only probes and copies', () => {
    const encoding = (getMiniToolsConfig() as unknown as { encoding: Record<string, unknown> }).encoding;
    expect(Object.keys(encoding).sort()).toEqual(['chunk_retries', 'chunk_share', 'copy_disk_margin_bytes', 'encoder', 'max_parallel_chunks', 'raw_disk_share', 'reverse_buffer_bytes']);
    expect((encoding.encoder as Record<string, unknown>).container_class).toBe('MiniToolContainerStd4');
  });

  it.each([
    ['a zero chunk share', ['encoding', 'chunk_share'], 0], ['a negative chunk share', ['encoding', 'chunk_share'], -0.5],
    ['a chunk share above the whole budget', ['encoding', 'chunk_share'], 1.5], ['a non-finite chunk share', ['encoding', 'chunk_share'], Number.NaN],
    ['a zero parallel cap', ['encoding', 'max_parallel_chunks'], 0], ['a fractional parallel cap', ['encoding', 'max_parallel_chunks'], 1.5],
    ['an encoder on the basic class', ['encoding', 'encoder', 'container_class'], 'MediaContainer'],
    ['a zero encode rate', ['encoding', 'encoder', 'encode_pixels_per_second'], 0],
    ['a zero decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'sdr_8bit'], 0],
    ['a missing HDR 10-bit decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'hdr_10bit'], undefined],
    ['a missing SDR 12-bit decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'sdr_12bit'], undefined],
    ['a missing HDR 12-bit decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'hdr_12bit'], undefined],
    ['a missing SDR 16-bit decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'sdr_16bit'], undefined],
    ['a missing HDR 16-bit decode-convert rate', ['encoding', 'encoder', 'decode_convert_pixels_per_second', 'hdr_16bit'], undefined],
    ['negative start seconds', ['encoding', 'encoder', 'start_seconds'], -1],
    ['a download rate', ['encoding', 'encoder', 'download_bytes_per_second'], 100],
    ['a zero carrier short side', ['presentation', 'carrier', 'max_short_side'], 0], ['a fractional carrier short side', ['presentation', 'carrier', 'max_short_side'], 1080.5],
    ['an empty carrier transfer', ['presentation', 'carrier', 'color', 'transfer'], ''],
    ['zero outputs per job', ['executions', 'video.split', 'max_outputs_per_job'], 0],
    ['more outputs per job than the job contract allows', ['executions', 'video.split', 'max_outputs_per_job'], MINI_TOOL_JOB_MAX_OUTPUTS + 1],
    ['fractional outputs per job', ['executions', 'video.extract-frames', 'max_outputs_per_job'], 1.5],
    ['a preparation outside standard-4', ['executions', 'video.remove-bg', 'preparation', 'container_class'], 'MiniToolContainerStd1'],
    ['a zero preparation precheck', ['executions', 'video.remove-bg', 'preparation', 'precheck_seconds'], 0],
  ] as const)('EC05 rejects %s after accepting the complete valid configuration', (_, path, value) => {
    expect(miniToolsConfigSchema.safeParse(configured()).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(patched(configured(), path, value)).success).toBe(false);
  });
});

describe('EC S6c retry caps (design aed2b550 §5.4 配置初值, §7.1, §7.1.1)', () => {
  it('EC06 the YAML, the getter and the loader default give chunk_retries 3 and max_auto_repairs 3', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
    expect(raw.encoding!.chunk_retries).toBe(3);
    expect(raw.presentation!.source_ledger!.max_auto_repairs).toBe(3);
    const config = getMiniToolsConfig() as unknown as { encoding: { chunk_retries: number }; presentation: { source_ledger: { max_auto_repairs: number } } };
    expect(config.encoding.chunk_retries).toBe(3);
    expect(config.presentation.source_ledger.max_auto_repairs).toBe(3);
    const omitted = patched(patched(configured(), ['encoding', 'chunk_retries'], undefined), ['presentation', 'source_ledger', 'max_auto_repairs'], undefined);
    expect(miniToolsConfigSchema.parse(omitted)).toMatchObject({ encoding: { chunk_retries: 3 }, presentation: { source_ledger: { max_auto_repairs: 3 } } });
  });

  it('EC07 keeps configured caps, zero included', () => {
    const input = patched(patched(configured(), ['encoding', 'chunk_retries'], 0), ['presentation', 'source_ledger', 'max_auto_repairs'], 5);
    expect(miniToolsConfigSchema.parse(input)).toMatchObject({ encoding: { chunk_retries: 0 }, presentation: { source_ledger: { max_auto_repairs: 5 } } });
  });

  it.each([
    ['a negative chunk_retries', ['encoding', 'chunk_retries'], -1], ['a fractional chunk_retries', ['encoding', 'chunk_retries'], 1.5],
    ['a negative max_auto_repairs', ['presentation', 'source_ledger', 'max_auto_repairs'], -1], ['a fractional max_auto_repairs', ['presentation', 'source_ledger', 'max_auto_repairs'], 2.5],
  ] as const)('EC08 rejects %s after accepting the valid configuration', (_, path, value) => {
    expect(miniToolsConfigSchema.safeParse(configured()).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(patched(configured(), path, value)).success).toBe(false);
  });
});

