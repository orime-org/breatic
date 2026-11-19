// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lip-sync execution configuration (inner#1306 test plan §97 D11-5; execution design §9.1, §9.3; canvas design §4 lip-sync
 * row): `executions.video.lip-sync` lists the selectable models (default first, `sync-lipsync-3`), each with its schema
 * fingerprint, duration range, crop size and whether it accepts the sync_mode field, an optional asynchronous rejection field, the tracking
 * model with its own duration range, and the caps of two people and eight dialogue rows. The schema keeps every field.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { MONOREPO_ROOT } from '../env.js';
import { miniToolsConfigSchema } from '../mini-tools.js';

type Model = { name: string; schema_fingerprint: string; min_duration_seconds: number; max_duration_seconds: number; crop_size: number; accepts_sync_mode: boolean; async_rejection?: { path: string; equals: unknown } };
type LipSync = { models: Model[]; tracking: { model: string; min_duration_seconds: number; max_duration_seconds: number }; max_people: number; max_dialogues: number };
const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as Record<string, unknown>;
const parsed = (): LipSync => (miniToolsConfigSchema.parse(raw).executions as unknown as Record<string, LipSync>)['video.lip-sync']!;

describe('lip-sync execution configuration (§97 D11-5)', () => {
  it('LC01 lists the selectable models, the default first, each with its contract fields', () => {
    const { models } = parsed();
    expect(models[0]?.name).toBe('sync-lipsync-3');
    for (const model of models) {
      expect(model.schema_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(model.min_duration_seconds).toBeGreaterThan(0);
      expect(model.max_duration_seconds).toBeGreaterThan(model.min_duration_seconds);
      expect(Number.isInteger(model.crop_size) && model.crop_size > 0).toBe(true);
      // §97 (execution design §9.3): whether the request carries sync_mode: "cut_off"; a boolean, not a list of modes.
      expect(typeof model.accepts_sync_mode).toBe('boolean');
      if (model.async_rejection !== undefined) expect(typeof model.async_rejection.path).toBe('string');
    }
  });

  it('LC02 names the tracking model with its duration range and caps two people and eight dialogues', () => {
    const lipSync = parsed();
    expect(lipSync.tracking.model.length).toBeGreaterThan(0);
    expect(lipSync.tracking.max_duration_seconds).toBeGreaterThan(lipSync.tracking.min_duration_seconds);
    expect([lipSync.max_people, lipSync.max_dialogues]).toEqual([2, 8]);
  });
});
