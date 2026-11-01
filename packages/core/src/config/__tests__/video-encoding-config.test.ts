// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * S6b encoding and carrier configuration (inner#1306, test plan §88; frames-split
 * design §5.4 chunk share, parallel cap, throughput and per-job outputs, §5.1
 * copy disk margin, §5.3 model input preparation class, §4.3 and §8.2 carrier
 * settings).
 *
 * Values the design gives are asserted as defaults: chunk share 0.5, an encoded
 * carrier on standard-4 with short side at most 1080 and SDR BT.709 labels. Values
 * the design leaves to measurement (throughput, parallel cap, copy margin,
 * per-job outputs, preparation precheck) are asserted only as validated,
 * configured numbers; test plan §88 lists them under 需要确认.
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
    encoding: { chunk_share: 0.25, max_parallel_chunks: 3, copy_disk_margin_bytes: 1024, throughput_pixels_per_second: { MediaContainer: 1000, MiniToolContainerStd4: 9000 } },
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

describe('EC S6b encoding and carrier configuration', () => {
  it('EC01 the shipped YAML, the getter and the loader default give chunk share 0.5 and the standard-4 SDR BT.709 carrier capped at 1080', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as { encoding: Record<string, unknown>; presentation: Record<string, unknown> };
    expect(raw.encoding.chunk_share).toBe(0.5);
    expect(raw.presentation.carrier).toEqual(CARRIER);
    expect(getMiniToolsConfig()).toMatchObject({ encoding: { chunk_share: 0.5 }, presentation: { carrier: CARRIER } });
    const withoutDefaults = patched(patched(configured(), ['encoding', 'chunk_share'], undefined), ['presentation', 'carrier'], undefined);
    expect(miniToolsConfigSchema.parse(withoutDefaults)).toMatchObject({ encoding: { chunk_share: 0.5 }, presentation: { carrier: CARRIER } });
  });

  it('EC02 keeps every configured S6b value', () => {
    const input = configured();
    const parsed = miniToolsConfigSchema.parse(input) as unknown as Record<string, unknown>;
    expect(parsed.encoding).toEqual(input.encoding);
    expect((parsed.presentation as Record<string, unknown>).carrier).toEqual((input.presentation as Record<string, unknown>).carrier);
    expect(parsed.executions).toEqual(input.executions);
  });

  it('EC03 the shipped configuration sets each measured value as a validated positive number', () => {
    const config = getMiniToolsConfig() as unknown as {
      encoding: { max_parallel_chunks: number; copy_disk_margin_bytes: number; throughput_pixels_per_second: Record<string, number> };
      executions: Record<string, { max_outputs_per_job?: number; preparation?: { container_class: string; precheck_seconds: number } }>;
    };
    expect(Number.isSafeInteger(config.encoding.max_parallel_chunks) && config.encoding.max_parallel_chunks > 0).toBe(true);
    expect(Number.isSafeInteger(config.encoding.copy_disk_margin_bytes) && config.encoding.copy_disk_margin_bytes >= 0).toBe(true);
    expect(config.encoding.throughput_pixels_per_second.MiniToolContainerStd4).toBeGreaterThan(0);
    for (const tool of ['video.extract-frames', 'video.split']) {
      const perJob = config.executions[tool]!.max_outputs_per_job!;
      expect(Number.isSafeInteger(perJob) && perJob >= 1 && perJob <= MINI_TOOL_JOB_MAX_OUTPUTS).toBe(true);
    }
    expect(config.executions['video.remove-bg']!.preparation).toMatchObject({ container_class: 'MiniToolContainerStd4', precheck_seconds: expect.any(Number) as number });
  });

  it.each([
    ['a zero chunk share', ['encoding', 'chunk_share'], 0], ['a negative chunk share', ['encoding', 'chunk_share'], -0.5],
    ['a chunk share above the whole budget', ['encoding', 'chunk_share'], 1.5], ['a non-finite chunk share', ['encoding', 'chunk_share'], Number.NaN],
    ['a zero parallel cap', ['encoding', 'max_parallel_chunks'], 0], ['a fractional parallel cap', ['encoding', 'max_parallel_chunks'], 1.5],
    ['a negative copy margin', ['encoding', 'copy_disk_margin_bytes'], -1], ['a fractional copy margin', ['encoding', 'copy_disk_margin_bytes'], 1.5],
    ['a zero throughput', ['encoding', 'throughput_pixels_per_second', 'MiniToolContainerStd4'], 0],
    ['a throughput for an undeclared class', ['encoding', 'throughput_pixels_per_second', 'UndeclaredContainer'], 100],
    ['a carrier on an undeclared class', ['presentation', 'carrier', 'container_class'], 'UndeclaredContainer'],
    ['a zero carrier short side', ['presentation', 'carrier', 'max_short_side'], 0], ['a fractional carrier short side', ['presentation', 'carrier', 'max_short_side'], 1080.5],
    ['an empty carrier transfer', ['presentation', 'carrier', 'color', 'transfer'], ''],
    ['zero outputs per job', ['executions', 'video.split', 'max_outputs_per_job'], 0],
    ['more outputs per job than the job contract allows', ['executions', 'video.split', 'max_outputs_per_job'], MINI_TOOL_JOB_MAX_OUTPUTS + 1],
    ['fractional outputs per job', ['executions', 'video.extract-frames', 'max_outputs_per_job'], 1.5],
    ['a preparation outside standard-4', ['executions', 'video.remove-bg', 'preparation', 'container_class'], 'MiniToolContainerStd1'],
    ['a zero preparation precheck', ['executions', 'video.remove-bg', 'preparation', 'precheck_seconds'], 0],
  ] as const)('EC04 rejects %s after accepting the complete valid configuration', (_, path, value) => {
    expect(miniToolsConfigSchema.safeParse(configured()).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(patched(configured(), path, value)).success).toBe(false);
  });
});
