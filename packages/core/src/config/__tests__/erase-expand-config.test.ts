// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Erase, expand and tracking configuration (inner#1306 execution design §10.6): `config/mini-tools.yaml` carries the tracking
 * profile's default prompt and its standard-4 preparation, the erase block with Bria's grid, duration bounds and
 * asynchronous rejection field and the composite matte, and the expand block with VACE's windows and the source limits.
 * The schema keeps every field.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { MONOREPO_ROOT } from '../env.js';
import { miniToolsConfigSchema } from '../mini-tools.js';

const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, unknown>;
const parsed = (): Record<string, Record<string, unknown>> & { analyses: Record<string, Record<string, unknown>> } => {
  const config = miniToolsConfigSchema.parse(raw);
  return { ...(config.executions as unknown as Record<string, Record<string, unknown>>), analyses: config.analyses };
};

describe('erase, expand and tracking configuration (execution design §10.6)', () => {
  it('EX01 the tracking profile has its default prompt and a standard-4 preparation', () => {
    const tracked = parsed().analyses.tracked_mask!;
    expect(tracked.profile).toMatchObject({ params: { default_prompt: 'object' } });
    expect(tracked.preparation).toMatchObject({ container_class: 'MiniToolContainerStd4' });
    expect((tracked.preparation as { precheck_seconds: number }).precheck_seconds).toBeGreaterThan(0);
  });

  it('EX02 the erase block names Bria with its grid, its 1–5 s bounds, its rejection code and the matte', () => {
    const erase = parsed()['video.erase']!;
    expect(erase).toMatchObject({ container_class: 'MiniToolContainerStd4', max_outputs: 1,
      model: { name: 'bria-video-eraser-mask', min_seconds: 1, max_seconds: 5, max_grid_fps: 30, async_rejection: { path: 'code', equals: 1401 } } });
    const matte = erase.matte as { dilate: number; feather: number };
    expect(matte.dilate).toBeGreaterThanOrEqual(0);
    expect(matte.feather).toBeGreaterThanOrEqual(0);
  });

  it('EX03 the expand block names VACE with its windows and the source limits', () => {
    expect(parsed()['video.expand']).toMatchObject({ container_class: 'MiniToolContainerStd4', max_outputs: 1,
      model: { name: 'wan-2.1-14b-vace', max_window_seconds: 10, overlap_seconds: 0.625, model_fps: 16 }, max_duration_seconds: 180, max_target_side: 4096 });
  });

  it('EX04 the schema refuses an erase block without its model', () => {
    const broken = structuredClone(raw) as { executions: Record<string, Record<string, unknown>> };
    delete broken.executions['video.erase']!.model;
    expect(miniToolsConfigSchema.safeParse(broken).success).toBe(false);
  });
});
