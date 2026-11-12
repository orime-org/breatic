// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web preview instance pool (inner#1711 design §7.4): which loaded page shows which web copy, as a pure function
 * of the previous pool and the current document, frame and limits.
 *
 * The API this file pins, in `@web/spaces/timeline/web-instance-pool`:
 * - `EMPTY_WEB_INSTANCE_POOL`, the pool of a freshly opened Timeline.
 * - `allocateWebInstances(previous, input)` returning the next pool, whose `assignments` list every instance the pool
 *   holds after this allocation: `{ key, sourceVersionId, role, clipId, targetFrame }`, where `role` is `visible`,
 *   `premount` or `idle`, `clipId` is null only for `idle`, and `targetFrame` is the premounted copy's first visible
 *   frame (null otherwise). The pool may carry private bookkeeping (ordinals, idle order) beside `assignments`.
 * - `input`: `{ document, readyClipIds, frame, premountFrames, idleInstancesMax, sourceOf, failedKeys }`; `sourceOf`
 *   gives a web copy's resolved source version (null for a placeholder), `failedKeys` the instances the host failed.
 *
 * Keys are `sourceVersionId:n`; n counts up per source version for the life of the pool and is never reused.
 */

import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineDocumentV1, TimelineWebAnimationClip } from '@breatic/shared';
import { MAIN, V2, V3, cid, clip, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { SRC_A, SRC_B, boundTo, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';
import {
  EMPTY_WEB_INSTANCE_POOL, allocateWebInstances, type WebInstanceAssignment, type WebInstancePool,
} from '@web/spaces/timeline/web-instance-pool';

// Two seconds at the fixtures' 24 fps, the default lead.
const LEAD = 48;
const IDLE_MAX = 8;
const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2)];

/**
 * A document with three visual tracks holding these clips.
 * @param clips - The clips.
 * @returns The document.
 * @throws {Error} When the fixture is invalid.
 */
function docOf(clips: TimelineClip[]): TimelineDocumentV1 {
  return timeline(clips, TRACKS);
}

/** One allocation's case: the document, the frame and the limits. */
interface Step { document: TimelineDocumentV1; frame: number; premountFrames?: number; idleInstancesMax?: number; failedKeys?: ReadonlySet<string> }

/**
 * Allocate against the previous pool with every clip ready and every bound copy resolved to its bound source.
 * @param previous - The pool before.
 * @param step - The case.
 * @returns The pool after.
 * @throws {Error} When allocation fails.
 */
function allocate(previous: WebInstancePool, step: Step): WebInstancePool {
  return allocateWebInstances(previous, {
    document: step.document,
    readyClipIds: new Set(Object.keys(step.document.clips)),
    frame: step.frame,
    premountFrames: step.premountFrames ?? LEAD,
    idleInstancesMax: step.idleInstancesMax ?? IDLE_MAX,
    sourceOf: (copy: TimelineWebAnimationClip) => copy.contentBinding.baseSourceResultId,
    failedKeys: step.failedKeys ?? new Set(),
  });
}

/**
 * The assignment of one copy.
 * @param pool - The pool.
 * @param clipId - The copy.
 * @returns Its assignment, if it has one.
 * @throws {never} Never.
 */
function of(pool: WebInstancePool, clipId: string): WebInstanceAssignment | undefined {
  return pool.assignments.find((assignment) => assignment.clipId === clipId);
}

/**
 * Every key the pool holds, sorted.
 * @param pool - The pool.
 * @returns The keys.
 * @throws {never} Never.
 */
function keys(pool: WebInstancePool): string[] {
  return pool.assignments.map((assignment) => assignment.key).sort();
}

describe('roles', () => {
  it('premounts a ready copy whose first visible frame lies in (frame, frame + lead], targeting that frame, and nothing beyond the lead', () => {
    const later = webClip(cid(101), V2, 72, 48);
    const document = docOf([clip(cid(1), MAIN, 0, 240), later]);
    expect(of(allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 24 }), later.id))
      .toEqual({ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'premount', clipId: later.id, targetFrame: 72 });
    expect(of(allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 23 }), later.id)).toBeUndefined();
    expect(allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 72 }).assignments)
      .toEqual([{ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'visible', clipId: later.id, targetFrame: null }]);
  });

  it('gives a copy under a higher video a visible instance, since layers are no longer hidden by the video above (breatic#1410 §6.1)', () => {
    const under = webClip(cid(101), V2, 0, 240);
    const visible = { key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'visible', clipId: under.id, targetFrame: null };
    for (const frame of [20, 30]) {
      expect(allocate(EMPTY_WEB_INSTANCE_POOL, { document: docOf([clip(cid(1), V3, 0, 72), under]), frame }).assignments, `frame ${frame}`).toEqual([visible]);
    }
    // A video over it past the lead does not hide it either.
    expect(allocate(EMPTY_WEB_INSTANCE_POOL, { document: docOf([clip(cid(1), V3, 0, 200), under]), frame: 30 }).assignments).toEqual([visible]);
  });

  it('premounts nothing without a lead, as before the Timeline limits arrive', () => {
    const later = webClip(cid(101), V2, 72, 48);
    const document = docOf([clip(cid(1), MAIN, 0, 240), later]);
    expect(allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 71, premountFrames: 0 }).assignments).toEqual([]);
  });

  it('gives a placeholder copy, which has no source yet, no instance', () => {
    const placeholder = webClip(cid(101), V2, 0, 48, { baseSourceResultId: null, operationId: '90000000-0000-4000-8000-000000000001' });
    expect(allocate(EMPTY_WEB_INSTANCE_POOL, { document: docOf([placeholder]), frame: 0 }).assignments).toEqual([]);
  });
});

describe('allocation rules', () => {
  it('allocates visible copies bottom-up before premounted ones', () => {
    const lower = webClip(cid(101), V2, 0, 48);
    const higher = webClip(cid(102), V3, 0, 48);
    const next = webClip(cid(103), V2, 60, 48);
    const pool = allocate(EMPTY_WEB_INSTANCE_POOL, { document: docOf([lower, higher, next]), frame: 20 });
    expect(of(pool, lower.id)).toMatchObject({ key: `${SRC_A}:0`, role: 'visible' });
    expect(of(pool, higher.id)).toMatchObject({ key: `${SRC_A}:1`, role: 'visible' });
    expect(of(pool, next.id)).toMatchObject({ key: `${SRC_A}:2`, role: 'premount', targetFrame: 60 });
  });

  it('keeps the instance a copy already has, even when a lower copy of its source appears later', () => {
    const higher = webClip(cid(102), V3, 0, 48);
    const lower = webClip(cid(101), V2, 10, 38);
    const document = docOf([higher, lower]);
    const first = allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 0, premountFrames: 0 });
    expect(of(first, higher.id)).toMatchObject({ key: `${SRC_A}:0` });
    const second = allocate(first, { document, frame: 10, premountFrames: 0 });
    expect(of(second, higher.id)).toMatchObject({ key: `${SRC_A}:0`, role: 'visible' });
    expect(of(second, lower.id)).toMatchObject({ key: `${SRC_A}:1`, role: 'visible' });
  });

  it('turns a premounted copy visible on the same instance, and the instance of a copy that left idle', () => {
    const later = webClip(cid(101), V2, 72, 48);
    const document = docOf([clip(cid(1), MAIN, 0, 240), later]);
    const premounted = allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 30 });
    const shown = allocate(premounted, { document, frame: 72 });
    expect(shown.assignments).toEqual([{ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'visible', clipId: later.id, targetFrame: null }]);
    const left = allocate(shown, { document, frame: 130 });
    expect(left.assignments).toEqual([{ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'idle', clipId: null, targetFrame: null }]);
    // Replayed from the start, the copy takes its own idle instance again when it comes within the lead.
    const replay = allocate(allocate(left, { document, frame: 0 }), { document, frame: 30 });
    expect(replay.assignments).toEqual([{ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'premount', clipId: later.id, targetFrame: 72 }]);
  });

  it('lets a copy without an instance claim an idle instance of its own source before a new one is made, visible copies first', () => {
    const first = webClip(cid(101), V2, 0, 24);
    const shown = webClip(cid(102), V2, 48, 24);
    const coming = webClip(cid(103), V2, 60, 24);
    const other = webClip(cid(104), V3, 48, 24, boundTo(SRC_B));
    const document = docOf([first, shown, coming, other]);
    const start = allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 0, premountFrames: 0 });
    const idle = allocate(start, { document, frame: 30, premountFrames: 0 });
    expect(idle.assignments).toEqual([{ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'idle', clipId: null, targetFrame: null }]);
    const claimed = allocate(idle, { document, frame: 48 });
    expect(of(claimed, shown.id)).toMatchObject({ key: `${SRC_A}:0`, role: 'visible' });
    expect(of(claimed, coming.id)).toMatchObject({ key: `${SRC_A}:1`, role: 'premount', targetFrame: 60 });
    expect(of(claimed, other.id)).toMatchObject({ key: `${SRC_B}:0`, role: 'visible' });
    expect(keys(claimed)).toEqual([`${SRC_A}:0`, `${SRC_A}:1`, `${SRC_B}:0`]);
  });

  it('hands a leaving copy\'s instance to a same-source copy entering at that frame', () => {
    const left = webClip(cid(101), V2, 0, 24);
    const right = webClip(cid(102), V2, 24, 24, boundTo(SRC_A), { sourceInFrame: 24 });
    const document = docOf([left, right]);
    const before = allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 23, premountFrames: 0 });
    expect(of(before, left.id)).toMatchObject({ key: `${SRC_A}:0` });
    const after = allocate(before, { document, frame: 24, premountFrames: 0 });
    expect(after.assignments).toEqual([{ key: `${SRC_A}:0`, sourceVersionId: SRC_A, role: 'visible', clipId: right.id, targetFrame: null }]);
  });

  it('unloads the earliest-idled instance beyond the idle cap and never reuses its number', () => {
    const early = webClip(cid(101), V2, 0, 24);
    const late = webClip(cid(102), V3, 0, 48);
    const lower = webClip(cid(103), V2, 60, 24);
    const upper = webClip(cid(104), V3, 60, 24);
    const document = docOf([early, late, lower, upper]);
    const step = { document, premountFrames: 0, idleInstancesMax: 1 };
    const both = allocate(EMPTY_WEB_INSTANCE_POOL, { ...step, frame: 0 });
    expect(of(both, early.id)).toMatchObject({ key: `${SRC_A}:0` });
    expect(of(both, late.id)).toMatchObject({ key: `${SRC_A}:1` });
    const oneIdle = allocate(both, { ...step, frame: 30 });
    expect(keys(oneIdle)).toEqual([`${SRC_A}:0`, `${SRC_A}:1`]);
    // :0 went idle first, so it is the one unloaded when :1 joins it over the cap of one.
    const overCap = allocate(oneIdle, { ...step, frame: 50 });
    expect(overCap.assignments).toEqual([{ key: `${SRC_A}:1`, sourceVersionId: SRC_A, role: 'idle', clipId: null, targetFrame: null }]);
    const reused = allocate(overCap, { ...step, frame: 60 });
    expect(of(reused, lower.id)).toMatchObject({ key: `${SRC_A}:1`, role: 'visible' });
    expect(of(reused, upper.id)).toMatchObject({ key: `${SRC_A}:2`, role: 'visible' });
  });

  it('never idles a failed instance: it is unloaded when its copy leaves, and a same-source copy in that allocation gets a new key', () => {
    const left = webClip(cid(101), V2, 0, 24);
    const right = webClip(cid(102), V2, 24, 24, boundTo(SRC_A), { sourceInFrame: 24 });
    const document = docOf([left, right]);
    const before = allocate(EMPTY_WEB_INSTANCE_POOL, { document, frame: 23, premountFrames: 0 });
    expect(of(before, left.id)).toMatchObject({ key: `${SRC_A}:0` });
    const failedKeys = new Set([`${SRC_A}:0`]);
    // Still assigned, a failed instance stays with its copy for the retry.
    expect(of(allocate(before, { document, frame: 22, premountFrames: 0, failedKeys }), left.id)).toMatchObject({ key: `${SRC_A}:0` });
    const after = allocate(before, { document, frame: 24, premountFrames: 0, failedKeys });
    expect(after.assignments).toEqual([{ key: `${SRC_A}:1`, sourceVersionId: SRC_A, role: 'visible', clipId: right.id, targetFrame: null }]);
    const gone = allocate(allocate(before, { document, frame: 30, premountFrames: 0, failedKeys }), { document, frame: 30, premountFrames: 0, failedKeys });
    expect(gone.assignments.some((assignment) => assignment.key === `${SRC_A}:0`)).toBe(false);
  });
});
