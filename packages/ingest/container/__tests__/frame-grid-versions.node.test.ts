// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Producer and profile versions as sha256 digests, and the reuse route they decide (inner#1306 test plan §65.2 V01–V05;
 * frames-split design §3.2 身份表, §3.5 编辑用文件回执 row, §7.1 路线表 复用载体 and 复用编辑用文件 rows, §10.12
 * presentation-run.ts and video-encode-plan.ts rows).
 *
 * - producer version = sha256 over {the fixed FFmpeg version, the playback command builder module's source digest};
 * - playback profile version = sha256 over the frozen playback encode values (crf, preset, gop seconds, carrier);
 * - edit profile version = sha256 over {the values the chosen tier's encoder reads, the edit builder module's source
 *   digest}; FFmpeg is not in it, and `presentation.edit.bytes_per_pixel` is in none of them.
 *
 * The versions feed `chooseVideoCarrierRoute`, which takes the new job's identity and the latest published version V's.
 * Exports are read at call time so a missing one fails each case on its own.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as plan from '@shared/mini-tools/video-encode-plan.js';
import * as run from '@ingest/container/presentation-run.js';

type EditTier = 'edit_h264_intra_8bit_420' | 'edit_h264_intra_10bit_420' | 'edit_h264_intra_8bit_444' | 'edit_h264_intra_10bit_444' | 'edit_prores';
interface VersionInput {
  ffmpegVersion: string; playbackBuilderSha256: string; editBuilderSha256: string;
  playback: { crf: number; preset: string; playbackGopSeconds: number; carrier: { maxShortSide: number } };
  edit: { crf: number; preset: string; proresProfile: string; bytesPerPixel: number };
  editTier: EditTier | null;
}
interface Versions { producerVersion: string; profileVersion: string; editProfileVersion: string | null }
interface Identity extends Versions { planSha256: string }
type Route = 'encode' | 'edit' | 'reuse_edit' | 'reuse';
type ChooseRoute = (input: { plan: Identity; reuseFrom: { identity: Identity; ready: boolean } | null }) => Route;

const HEX = /^[a-f0-9]{64}$/u;
const PLAN = 'd'.repeat(64);
// The two builder modules the design separates (§3.5): playback commands, and edit-file commands with the tone-map chain.
const PLAYBACK_BUILDER = resolve(__dirname, '../../container/playback-command.ts');
const EDIT_BUILDER = resolve(__dirname, '../../container/edit-command.ts');

const BASE: VersionInput = {
  ffmpegVersion: 'ffmpeg version 8.0.1 libx264 164 libvpx 1.15.2', playbackBuilderSha256: 'a'.repeat(64), editBuilderSha256: 'b'.repeat(64),
  playback: { crf: 18, preset: 'medium', playbackGopSeconds: 2, carrier: { maxShortSide: 1080 } },
  edit: { crf: 15, preset: 'medium', proresProfile: '4444', bytesPerPixel: 0.5 },
  editTier: 'edit_h264_intra_8bit_420',
};

/**
 * The versions of a frozen configuration and runtime facts, from the presentation run.
 * @param input - The facts.
 * @returns The three versions.
 */
async function versions(input: VersionInput): Promise<Versions> {
  const compute = (run as Record<string, unknown>).presentationVersions;
  expect(compute, 'presentationVersions is exported from @ingest/container/presentation-run.js').toBeTypeOf('function');
  return (compute as (input: VersionInput) => Promise<Versions>)(input);
}

/**
 * The route chooser taking the new job's and V's identities.
 * @returns It.
 */
function chooseRoute(): ChooseRoute {
  return plan.chooseVideoCarrierRoute;
}

/**
 * The route of a new job against V published with the base configuration, P ready.
 * @param changed - The new job's configuration.
 * @param editFile - Whether the source needs an edit file (both V and the new job).
 * @returns The route.
 */
async function routeAfter(changed: VersionInput, editFile: boolean): Promise<Route> {
  const of = (input: VersionInput): VersionInput => ({ ...input, editTier: editFile ? input.editTier ?? 'edit_h264_intra_8bit_420' : null });
  const v = { ...await versions(of(BASE)), planSha256: PLAN };
  const job = { ...await versions(of(changed)), planSha256: PLAN };
  return chooseRoute()({ plan: job, reuseFrom: { identity: v, ready: true } });
}

/**
 * A sha256 of text, as the container build digests a builder module.
 * @param text - The source.
 * @returns The hex digest.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('versions are sha256 digests of what produced the bytes (design §3.2, §7.1 复用载体 row)', () => {
  it('the three versions are lowercase sha256 hex; no edit file has a null edit profile version', async () => {
    const withEdit = await versions(BASE);
    expect(withEdit.producerVersion).toMatch(HEX);
    expect(withEdit.profileVersion).toMatch(HEX);
    expect(withEdit.editProfileVersion).toMatch(HEX);
    expect((await versions({ ...BASE, editTier: null })).editProfileVersion).toBeNull();
  });

  it('V01 only presentation.edit.crf changes: the edit profile version changes, producer and playback profile do not', async () => {
    const before = await versions(BASE);
    const after = await versions({ ...BASE, edit: { ...BASE.edit, crf: 16 } });
    expect(after.editProfileVersion).not.toBe(before.editProfileVersion);
    expect(after.producerVersion).toBe(before.producerVersion);
    expect(after.profileVersion).toBe(before.profileVersion);
  });

  it('V01 a value the tier\'s encoder does not read is not in its version: crf for ProRes, the ProRes profile for H.264', async () => {
    const prores = { ...BASE, editTier: 'edit_prores' as const };
    expect((await versions({ ...prores, edit: { ...prores.edit, crf: 16 } })).editProfileVersion).toBe((await versions(prores)).editProfileVersion);
    expect((await versions({ ...prores, edit: { ...prores.edit, proresProfile: '4444xq' } })).editProfileVersion).not.toBe((await versions(prores)).editProfileVersion);
    expect((await versions({ ...BASE, edit: { ...BASE.edit, proresProfile: '4444xq' } })).editProfileVersion).toBe((await versions(BASE)).editProfileVersion);
  });

  it('V01 only presentation.edit.crf changes: the edit file is not reused, the route encodes a new edit file', async () => {
    expect(await routeAfter({ ...BASE, edit: { ...BASE.edit, crf: 16 } }, true)).toBe('edit');
  });

  it('V02 only presentation.edit.bytes_per_pixel changes: no version changes and the carrier is reused', async () => {
    const changed = { ...BASE, edit: { ...BASE.edit, bytesPerPixel: 0.75 } };
    expect(await versions(changed)).toEqual(await versions(BASE));
    expect(await routeAfter(changed, true)).toBe('reuse');
  });

  it('V03 only the playback crf changes: the playback profile version changes, producer and edit profile do not', async () => {
    const before = await versions(BASE);
    const after = await versions({ ...BASE, playback: { ...BASE.playback, crf: 20 } });
    expect(after.profileVersion).not.toBe(before.profileVersion);
    expect(after.producerVersion).toBe(before.producerVersion);
    expect(after.editProfileVersion).toBe(before.editProfileVersion);
  });

  it('V03 only the playback crf changes: with an edit file it is reused; without one everything is encoded again; never the carrier', async () => {
    const changed = { ...BASE, playback: { ...BASE.playback, crf: 20 } };
    expect(await routeAfter(changed, true)).toBe('reuse_edit');
    expect(await routeAfter(changed, false)).toBe('encode');
  });

  it('V05 only FFmpeg is upgraded: the producer version changes, the edit profile version does not', async () => {
    const before = await versions(BASE);
    const after = await versions({ ...BASE, ffmpegVersion: 'ffmpeg version 8.1 libx264 165 libvpx 1.16.0' });
    expect(after.producerVersion).not.toBe(before.producerVersion);
    expect(after.editProfileVersion).toBe(before.editProfileVersion);
    expect(after.profileVersion).toBe(before.profileVersion);
  });

  it('V05 only FFmpeg is upgraded: with an edit file it is reused; without one everything is encoded again', async () => {
    const changed = { ...BASE, ffmpegVersion: 'ffmpeg version 8.1 libx264 165 libvpx 1.16.0' };
    expect(await routeAfter(changed, true)).toBe('reuse_edit');
    expect(await routeAfter(changed, false)).toBe('encode');
  });
});

describe('V04 a change to a builder module\'s code changes its version (design §3.5, §7.1 复用载体 row)', () => {
  it('V04 the playback and edit command builders are two separate modules; only the edit one holds the tone-map chain', () => {
    expect(existsSync(PLAYBACK_BUILDER), `${PLAYBACK_BUILDER} exists`).toBe(true);
    expect(existsSync(EDIT_BUILDER), `${EDIT_BUILDER} exists`).toBe(true);
    expect(readFileSync(EDIT_BUILDER, 'utf8')).toContain('tonemap=hable');
    expect(readFileSync(PLAYBACK_BUILDER, 'utf8')).not.toContain('tonemap');
  });

  it('V04 one literal changed in the playback builder changes the producer version and leaves the edit profile version', async () => {
    const source = readFileSync(PLAYBACK_BUILDER, 'utf8');
    const literal = /'[^']+'/u.exec(source)?.[0];
    expect(literal, 'the playback builder has a string literal').toBeDefined();
    const edited = source.replace(literal!, `'${literal!.slice(1, -1)}x'`);
    const before = await versions({ ...BASE, playbackBuilderSha256: sha256(source) });
    const after = await versions({ ...BASE, playbackBuilderSha256: sha256(edited) });
    expect(after.producerVersion).not.toBe(before.producerVersion);
    expect(after.editProfileVersion).toBe(before.editProfileVersion);
  });

  it('V04 one branch changed in the edit builder changes the edit profile version and leaves the producer version', async () => {
    const source = readFileSync(EDIT_BUILDER, 'utf8');
    expect(source, 'the edit builder has a branch').toMatch(/ \? /u);
    const edited = source.replace(' ? ', ' && false ? ');
    const before = await versions({ ...BASE, editBuilderSha256: sha256(source) });
    const after = await versions({ ...BASE, editBuilderSha256: sha256(edited) });
    expect(after.editProfileVersion).not.toBe(before.editProfileVersion);
    expect(after.producerVersion).toBe(before.producerVersion);
  });
});
