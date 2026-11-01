// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * S6b encoding and carrier configuration (inner#1306, test plan §88; frames-split
 * design §5.4 chunk share, parallel cap, throughput and per-job outputs, §5.1
 * copy disk margin, §5.3 model input preparation class, §4.3 and §8.2 carrier
 * settings).
 *
 * Values the design gives are asserted (design 0fbbe4e0 §5.4 配置初值 and 估算 rows):
 * chunk share 0.5, parallel chunk cap 8, `max_outputs_per_job` 8, the remove-bg
 * preparation on standard-4 with precheck 300 s, an encoded carrier on standard-4
 * with short side at most 1080 and SDR BT.709 labels, the 8-bit SDR throughputs
 * (standard-4 19.9 × 8294400, basic 4.8 × 2073600 output pixels per second), and
 * a copy disk margin equal to the configured full plus compact byte caps. The
 * 10-bit and HDR throughputs and the per-job fixed seconds are not measured yet,
 * so only their presence and sign are asserted.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { MINI_TOOL_JOB_MAX_OUTPUTS } from '@breatic/shared';
import { MONOREPO_ROOT } from '../env.js';
import { getMiniToolsConfig, miniToolsConfigSchema } from '../mini-tools.js';

const CARRIER = { container_class: 'MiniToolContainerStd4', max_short_side: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } };

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
      chunk_share: 0.25, max_parallel_chunks: 3,
      throughput_pixels_per_second: {
        MediaContainer: { sdr_8bit: 1000, sdr_10bit: 900, hdr_8bit: 800, hdr_10bit: 700 },
        MiniToolContainerStd4: { sdr_8bit: 9000, sdr_10bit: 8000, hdr_8bit: 7000, hdr_10bit: 6000 },
      },
      job_fixed_seconds: { MediaContainer: 11, MiniToolContainerStd4: 13 },
    },
    presentation: { ...current.presentation, carrier: { container_class: 'MiniToolContainerStd4', max_short_side: 720, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } } },
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

const THROUGHPUT_KEYS = ['sdr_8bit', 'sdr_10bit', 'hdr_8bit', 'hdr_10bit'] as const;

describe('EC S6b encoding and carrier configuration', () => {
  it('EC01 the shipped YAML, the getter and the loader defaults give the design values', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, Record<string, unknown>>;
    const expected = {
      encoding: { chunk_share: 0.5, max_parallel_chunks: 8, throughput_pixels_per_second: { MiniToolContainerStd4: { sdr_8bit: 165_058_560 }, MediaContainer: { sdr_8bit: 9_953_280 } } },
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
    omitted = patched(omitted, ['executions', 'video.split', 'max_outputs_per_job'], undefined);
    omitted = patched(omitted, ['executions', 'video.extract-frames', 'max_outputs_per_job'], undefined);
    omitted = patched(omitted, ['executions', 'video.remove-bg', 'preparation'], undefined);
    expect(miniToolsConfigSchema.parse(omitted)).toMatchObject({
      encoding: { chunk_share: 0.5, max_parallel_chunks: 8 }, presentation: { carrier: CARRIER },
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

  it('EC04 the shipped configuration sets every throughput and per-job fixed cost as a positive number', () => {
    const encoding = (getMiniToolsConfig() as unknown as { encoding: { throughput_pixels_per_second: Record<string, Record<string, number>>; job_fixed_seconds: Record<string, number> } }).encoding;
    for (const containerClass of ['MediaContainer', 'MiniToolContainerStd4']) {
      for (const key of THROUGHPUT_KEYS) expect(encoding.throughput_pixels_per_second[containerClass]![key]).toBeGreaterThan(0);
      expect(encoding.job_fixed_seconds[containerClass]).toBeGreaterThan(0);
    }
  });

  it.each([
    ['a zero chunk share', ['encoding', 'chunk_share'], 0], ['a negative chunk share', ['encoding', 'chunk_share'], -0.5],
    ['a chunk share above the whole budget', ['encoding', 'chunk_share'], 1.5], ['a non-finite chunk share', ['encoding', 'chunk_share'], Number.NaN],
    ['a zero parallel cap', ['encoding', 'max_parallel_chunks'], 0], ['a fractional parallel cap', ['encoding', 'max_parallel_chunks'], 1.5],
    ['a zero throughput', ['encoding', 'throughput_pixels_per_second', 'MiniToolContainerStd4', 'sdr_8bit'], 0],
    ['a missing HDR 10-bit throughput', ['encoding', 'throughput_pixels_per_second', 'MiniToolContainerStd4', 'hdr_10bit'], undefined],
    ['a throughput for a 12-bit source', ['encoding', 'throughput_pixels_per_second', 'MiniToolContainerStd4', 'sdr_12bit'], 100],
    ['a throughput for an undeclared class', ['encoding', 'throughput_pixels_per_second', 'UndeclaredContainer'], { sdr_8bit: 1, sdr_10bit: 1, hdr_8bit: 1, hdr_10bit: 1 }],
    ['a negative per-job fixed cost', ['encoding', 'job_fixed_seconds', 'MiniToolContainerStd4'], -1],
    ['a per-job fixed cost for an undeclared class', ['encoding', 'job_fixed_seconds', 'UndeclaredContainer'], 10],
    ['a carrier on an undeclared class', ['presentation', 'carrier', 'container_class'], 'UndeclaredContainer'],
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
