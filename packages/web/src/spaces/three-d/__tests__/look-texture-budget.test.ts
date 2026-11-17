// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one budget check for part pictures (inner#1693 design 7): the object's own texture
 * bytes plus each distinct look picture, counted in part order, against the scene limits.
 */

import { describe, expect, it } from 'vitest';

import * as budget from '@web/spaces/three-d/look-texture-budget';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LIMITS = { maxTextureEdge: 8192, maxTextureBytes: 268_435_456 };
/** RGBA with a full mip chain, as the import budget counts it. */
const bytes = (edge: number): number => Math.round((edge * edge * 4 * 4) / 3);

type Check = (input: {
  ownBytes: number;
  clampBytes: Readonly<Record<string, number>>;
  look: Readonly<Record<string, { map?: string; mapRepeat?: number[]; mapOffset?: number[]; mapRotation?: number }>>;
  sizes: ReadonlyMap<string, { width: number; height: number } | null>;
  limits: { maxTextureEdge: number; maxTextureBytes: number };
}) => ReadonlyMap<string, { usable: true } | { usable: false; reason: 'edge' | 'bytes' | 'unknown' }>;

/**
 * The budget function under test.
 * @returns checkLookTextures.
 * @throws {AssertionError} When it is not exported.
 */
function check(): Check {
  const candidate = (budget as Record<string, unknown>).checkLookTextures;
  expect(candidate, 'checkLookTextures must be exported').toBeTypeOf('function');
  return candidate as Check;
}

/** A sizes map from edge lengths. */
function sizes(entries: Record<string, number | null>): Map<string, { width: number; height: number } | null> {
  return new Map(Object.entries(entries).map(([id, edge]) => [id, edge === null ? null : { width: edge, height: edge }]));
}

describe('checkLookTextures', () => {
  it('accepts pictures that fit beside the model textures', () => {
    const result = check()({ ownBytes: bytes(2048), clampBytes: {}, look: { 0: { map: A }, 1: { map: B } }, sizes: sizes({ [A]: 2048, [B]: 1024 }), limits: LIMITS });
    expect(result.get('0')).toEqual({ usable: true });
    expect(result.get('1')).toEqual({ usable: true });
  });

  it('refuses a picture whose longest edge is over the limit, by edge', () => {
    const result = check()({ ownBytes: 0, clampBytes: {}, look: { 0: { map: A } }, sizes: new Map([[A, { width: 9000, height: 100 }]]), limits: LIMITS });
    expect(result.get('0')).toEqual({ usable: false, reason: 'edge' });
  });

  it('counts parts in numeric order with d last, so the later part is the one over', () => {
    const own = LIMITS.maxTextureBytes - bytes(4096) - 10;
    const look = { d: { map: B }, 10: { map: C }, 9: { map: A } };
    const result = check()({ ownBytes: own, clampBytes: {}, look, sizes: sizes({ [A]: 4096, [B]: 4096, [C]: 4096 }), limits: LIMITS });
    expect(result.get('9')).toEqual({ usable: true });
    expect(result.get('10')).toEqual({ usable: false, reason: 'bytes' });
    expect(result.get('d')).toEqual({ usable: false, reason: 'bytes' });
  });

  it('leaves a picture that is over out of the total, so a later small one still fits', () => {
    const own = LIMITS.maxTextureBytes - bytes(4096);
    const result = check()({ ownBytes: own, clampBytes: {}, look: { 0: { map: A }, 1: { map: B } }, sizes: sizes({ [A]: 6000, [B]: 16 }), limits: LIMITS });
    expect(result.get('0')).toEqual({ usable: false, reason: 'bytes' });
    expect(result.get('1')).toEqual({ usable: true });
  });

  it('counts one picture used on two parts once', () => {
    const own = LIMITS.maxTextureBytes - bytes(4096) - 10;
    const result = check()({ ownBytes: own, clampBytes: {}, look: { 0: { map: A }, 1: { map: A } }, sizes: sizes({ [A]: 4096 }), limits: LIMITS });
    expect(result.get('0')).toEqual({ usable: true });
    expect(result.get('1')).toEqual({ usable: true });
  });

  it('leaves a picture of unknown size out of the total and reports it as unknown', () => {
    const own = LIMITS.maxTextureBytes - bytes(4096) - 10;
    const result = check()({ ownBytes: own, clampBytes: {}, look: { 0: { map: A }, 1: { map: B } }, sizes: sizes({ [A]: null, [B]: 4096 }), limits: LIMITS });
    expect(result.get('0')).toEqual({ usable: false, reason: 'unknown' });
    expect(result.get('1')).toEqual({ usable: true });
  });

  it('adds a part\'s clamp bytes when it keeps the model picture but changes its tiling', () => {
    const own = LIMITS.maxTextureBytes - bytes(4096) - 10;
    const clampBytes = { 0: bytes(4096) };
    const tiled = check()({ ownBytes: own, clampBytes, look: { 0: { mapRepeat: [3, 3] }, 1: { map: A } }, sizes: sizes({ [A]: 64 }), limits: LIMITS });
    expect(tiled.get('1')).toEqual({ usable: false, reason: 'bytes' });
    const untiled = check()({ ownBytes: own, clampBytes, look: { 1: { map: A } }, sizes: sizes({ [A]: 64 }), limits: LIMITS });
    expect(untiled.get('1')).toEqual({ usable: true });
    const replaced = check()({ ownBytes: own, clampBytes, look: { 0: { map: B, mapRepeat: [3, 3] }, 1: { map: A } }, sizes: sizes({ [A]: 64, [B]: 64 }), limits: LIMITS });
    expect(replaced.get('1')).toEqual({ usable: true });
  });

  it('skips none and parts without a picture', () => {
    const result = check()({ ownBytes: 0, clampBytes: {}, look: { 0: { map: 'none' }, 1: { mapRotation: 30 } }, sizes: new Map(), limits: LIMITS });
    expect(result.has('0')).toBe(false);
    expect(result.has('1')).toBe(false);
  });

  it('gives the same answer whatever order the look lists its parts in', () => {
    const own = LIMITS.maxTextureBytes - bytes(4096) - 10;
    const input = { ownBytes: own, clampBytes: {}, sizes: sizes({ [A]: 4096, [B]: 4096 }), limits: LIMITS };
    const forward = check()({ ...input, look: { 2: { map: A }, 7: { map: B } } });
    const backward = check()({ ...input, look: { 7: { map: B }, 2: { map: A } } });
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());
  });
});

describe('refusing a write that would make a picture unusable', () => {
  /**
   * The editor-side rule.
   * @returns lookWriteIssue.
   * @throws {AssertionError} When it is not exported.
   */
  function issue(): (before: Parameters<Check>[0], after: Parameters<Check>[0], part: string) => { reason: 'edge' | 'bytes' | 'unknown' } | null {
    const candidate = (budget as Record<string, unknown>).lookWriteIssue;
    expect(candidate, 'lookWriteIssue must be exported').toBeTypeOf('function');
    return candidate as never;
  }

  it('refuses a big picture on a low part that would push a higher part\'s shown picture over', () => {
    // Room for the model's textures, one 4096 picture and one 16 picture.
    const own = LIMITS.maxTextureBytes - bytes(4096) - bytes(16) - 10;
    const base = { ownBytes: own, clampBytes: {}, sizes: sizes({ [A]: 4096, [B]: 16 }), limits: LIMITS };
    const before = { ...base, look: { 5: { map: A } } };
    const after = { ...base, look: { 1: { map: B }, 5: { map: A } } };
    expect(issue()(before, after, '1')).toBeNull();
    const pushed = { ...base, sizes: sizes({ [A]: 4096, [C]: 4096 }), look: { 1: { map: C }, 5: { map: A } } };
    expect(issue()({ ...before, sizes: pushed.sizes }, pushed, '1')).toEqual({ reason: 'bytes' });
  });

  it('allows a write when a picture was already over before it', () => {
    // Room for the model's textures, one 4096 picture and one 16 picture.
    const own = LIMITS.maxTextureBytes - bytes(4096) - bytes(16) - 10;
    const base = { ownBytes: own, clampBytes: {}, sizes: sizes({ [A]: 4096, [B]: 4096, [C]: 16 }), limits: LIMITS };
    const before = { ...base, look: { 1: { map: A }, 2: { map: B } } };
    const after = { ...base, look: { 1: { map: A }, 2: { map: B }, 3: { map: C } } };
    expect(issue()(before, after, '3')).toBeNull();
  });

  it('refuses a new picture of unknown size as unknown', () => {
    const base = { ownBytes: 0, clampBytes: {}, sizes: sizes({ [A]: null }), limits: LIMITS };
    expect(issue()({ ...base, look: {} }, { ...base, look: { 0: { map: A } } }, '0')).toEqual({ reason: 'unknown' });
  });
});
