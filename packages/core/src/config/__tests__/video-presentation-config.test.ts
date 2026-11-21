// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { MONOREPO_ROOT } from '../env.js';
import { getMiniToolsConfig, miniToolsConfigSchema } from '../mini-tools.js';
import { getStorageConfig, storageConfigSchema } from '../storage.js';
import { editFileSizeFailure } from '@breatic/shared/mini-tools';


describe('platform presentation container configuration (inner#1306)', () => {
  it('records the actual basic instance size used by the canonical metadata container', () => {
    const config = getMiniToolsConfig() as unknown as Record<string, unknown>;
    // Design §3.2 item 1 (S6e E1): the target policy version is presentation.policy_version, initial 1.
    expect(config.presentation).toEqual({ container_class: 'MediaContainer', policy_version: 1,
      // S6d D1 (§91 D-6): one sampled frame classified every measured fixture; §4.2.1 single-frame default 5 s.
      probe_sample_frames: 1, single_frame_duration_ms: 5000,
      // frames-split §4.1 rate cap, §4.3 playback keyframe interval, §5.1 step 2 probe output cap.
      max_fps: 120, playback_gop_seconds: 2, probe_output_max_bytes: 67108864,
      max_source_bytes: getStorageConfig().upload.max_upload_bytes, max_packed_bytes: 1073741824, crf: 18, preset: 'medium',
      // frames-split §4.2 and §8.2: the edit file's size cap and encode settings.
      max_edit_bytes: 16000000000, edit: { crf: 15, preset: 'medium', prores_profile: '4444', bytes_per_pixel: 0.5 },
    // Design §4.3 and §8.2 (S6b): short side at most 1080, SDR BT.709 labels. The standard-4 class is
    // encoding.encoder.container_class alone (S6e E1): one key per fact.
    carrier: { max_short_side: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } } });
    expect(getMiniToolsConfig().classes.MediaContainer).toEqual({ instance_type: 'basic', vcpu: 0.25, memory_gib: 1, disk_gb: 4 });
  });

  it.each([
    ['a zero sample count', { probe_sample_frames: 0 }],
    ['a fractional sample count', { probe_sample_frames: 1.5 }],
    ['a zero single-frame duration', { single_frame_duration_ms: 0 }],
  ])('S6d-C01 rejects %s', (_name, change) => {
    const config = getMiniToolsConfig();
    // The valid values parse, so the refusal below is about the value, not an unknown key.
    expect(miniToolsConfigSchema.safeParse({ ...config, presentation: { ...config.presentation, probe_sample_frames: 1, single_frame_duration_ms: 5000 } }).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse({ ...config, presentation: { ...config.presentation, ...change } }).success).toBe(false);
  });

  it('S6d-C02 defaults the sample count to 1 and the single-frame duration to 5000 ms when the YAML omits them', () => {
    const config = structuredClone(getMiniToolsConfig()) as unknown as { presentation: Record<string, unknown> };
    delete config.presentation.probe_sample_frames;
    delete config.presentation.single_frame_duration_ms;
    expect(miniToolsConfigSchema.parse(config).presentation).toMatchObject({ probe_sample_frames: 1, single_frame_duration_ms: 5000 });
  });

  // frames-split §4.1, §7.11: there is no identity route and no frame table, so their blocks are not configuration.
  it.each([
    ['an identity format table', { identity_formats: [] }], ['a source ledger block', { source_ledger: { max_bytes: 1 } }],
    ['a zero rate cap', { max_fps: 0 }], ['a fractional rate cap', { max_fps: 59.94 }], ['a zero keyframe interval', { playback_gop_seconds: 0 }],
    ['a zero probe output cap', { probe_output_max_bytes: 0 }], ['a zero edit size cap', { max_edit_bytes: 0 }],
    ['an edit crf above 51', { edit: { crf: 52, preset: 'medium', prores_profile: '4444', bytes_per_pixel: 0.5 } }],
    ['an unknown edit preset', { edit: { crf: 15, preset: 'turbo', prores_profile: '4444', bytes_per_pixel: 0.5 } }],
    ['a zero edit size factor', { edit: { crf: 15, preset: 'medium', prores_profile: '4444', bytes_per_pixel: 0 } }],
  ])('FG-C01 rejects a presentation block with %s', (_name, change) => {
    const config = getMiniToolsConfig();
    expect(miniToolsConfigSchema.safeParse(config).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse({ ...config, presentation: { ...config.presentation, ...change } }).success).toBe(false);
  });

  it('FG-C02 defaults the rate cap, keyframe interval, probe cap and edit settings when the YAML omits them', () => {
    const config = structuredClone(getMiniToolsConfig()) as unknown as { presentation: Record<string, unknown> };
    for (const key of ['max_fps', 'playback_gop_seconds', 'probe_output_max_bytes', 'max_edit_bytes', 'edit']) delete config.presentation[key];
    expect(miniToolsConfigSchema.parse(config).presentation).toMatchObject({ max_fps: 120, playback_gop_seconds: 2, probe_output_max_bytes: 67108864,
      max_edit_bytes: 16000000000, edit: { crf: 15, preset: 'medium', prores_profile: '4444', bytes_per_pixel: 0.5 } });
  });

  // ING-3: the edit stitch downloads every edit chunk and a later tool run downloads the whole edit file, both on the standard-4
  // disk (20 GB, decimal); the cap leaves that disk a 4 GB working margin, so an edit file that passes admission also fits there.
  it('FG-C03 caps the edit file at the standard-4 disk less its 4 GB working margin, and refuses a larger estimate up front', () => {
    const config = getMiniToolsConfig();
    const disk = config.classes.MiniToolContainerStd4!.disk_gb * 1_000_000_000;
    expect(config.presentation.max_edit_bytes).toBe(disk - 4_000_000_000);
    // A 1080p edit file of 17,400 frames (about 9.7 minutes at 30 fps) is estimated at 18.04 GB: under 20 GiB, over the cap.
    const estimate = { frameCount: 17_400, width: 1920, height: 1080, bytesPerPixel: config.presentation.edit.bytes_per_pixel, measuredBytes: null };
    expect(editFileSizeFailure({ ...estimate, maxEditBytes: config.presentation.max_edit_bytes })).toBe('edit_over_cap');
    expect(editFileSizeFailure({ ...estimate, frameCount: 15_000, maxEditBytes: config.presentation.max_edit_bytes }), 'an estimate under the cap is admitted').toBeNull();
  });

  // Every video execution, every analysis and the encoder read the tool source whole, and the tool source is the edit file
  // when there is one, so each of their classes must hold a capped edit file plus the cap's 4 GB working margin.
  it('FG-C04 runs every operation that reads the edit file whole on a class whose disk holds the cap and its margin', () => {
    const config = getMiniToolsConfig();
    const readers = [
      ...Object.entries(config.executions).map(([name, spec]) => [`executions.${name}`, spec.container_class] as const),
      ...Object.entries(config.analyses).map(([name, spec]) => [`analyses.${name}`, spec.container_class] as const),
      ['encoding.encoder', config.encoding.encoder.container_class] as const,
    ];
    const short = readers.filter(([, name]) => config.classes[name]!.disk_gb * 1_000_000_000 < config.presentation.max_edit_bytes + 4_000_000_000);
    expect(short, 'operations whose class cannot hold a capped edit file').toEqual([]);
  });

  it('rejects a presentation class whose actual instance size is not configured', () => {
    expect(miniToolsConfigSchema.safeParse({ ...getMiniToolsConfig(), presentation: { container_class: 'UnlistedClass' } }).success).toBe(false);
  });

  // inner#1306 §77 C01: every uploadable video gets a presentation,
  // so the presentation source cap is the upload cap, in the shipped YAML and in
  // the loader default alike.
  it('C01 aligns the presentation source cap with the upload cap in the YAML, the getter and the default', () => {
    const read = (name: string): Record<string, unknown> => parse(readFileSync(resolve(MONOREPO_ROOT, `config/${name}`), 'utf8')) as Record<string, unknown>;
    const uploadCap = (read('storage.yaml').upload as Record<string, unknown>).max_upload_bytes;
    expect((read('mini-tools.yaml').presentation as Record<string, unknown>).max_source_bytes).toBe(uploadCap);
    expect(getMiniToolsConfig().presentation.max_source_bytes).toBe(getStorageConfig().upload.max_upload_bytes);
    const { presentation: _omitted, ...legacy } = structuredClone(getMiniToolsConfig());
    expect(miniToolsConfigSchema.parse(legacy).presentation.max_source_bytes).toBe(storageConfigSchema.parse({}).upload.max_upload_bytes);
  });

  // inner#1306 §90 E1 (design §3.2 item 1): the target policy version every
  // admission freezes is a required positive integer in the presentation block.
  it('PV01 reads presentation.policy_version, 1, from the YAML through the getter', () => {
    const presentation = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')).presentation as Record<string, unknown>;
    expect(presentation.policy_version).toBe(1);
    expect((getMiniToolsConfig().presentation as unknown as Record<string, unknown>).policy_version).toBe(1);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1'],
  ])('PV02 rejects a presentation block whose policy_version is %s', (_name, value) => {
    const base = structuredClone(getMiniToolsConfig()) as unknown as { presentation: Record<string, unknown> };
    expect(miniToolsConfigSchema.safeParse({ ...base, presentation: { ...base.presentation, policy_version: 1 } }).success).toBe(true);
    const presentation: Record<string, unknown> = { ...base.presentation, policy_version: value };
    if (value === undefined) delete presentation.policy_version;
    expect(miniToolsConfigSchema.safeParse({ ...base, presentation }).success).toBe(false);
  });

  // inner#1306 §90 E1: presentation.carrier.container_class duplicated encoding.encoder.container_class; the carrier key goes.
  it('CA01 the carrier block no longer accepts a container_class', () => {
    const base = structuredClone(getMiniToolsConfig()) as unknown as { presentation: { carrier: Record<string, unknown> } & Record<string, unknown> };
    const { container_class: _dropped, ...carrier } = base.presentation.carrier;
    const without = { ...base, presentation: { ...base.presentation, policy_version: 1, carrier } };
    expect(miniToolsConfigSchema.safeParse(without).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse({ ...without, presentation: { ...without.presentation, carrier: { ...carrier, container_class: 'MiniToolContainerStd4' } } }).success).toBe(false);
  });
});
