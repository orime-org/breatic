// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A slot's pick converges as ONE value (#1918, Gate 2 round 1).
 *
 * The driving-video slot holds two things at once: the video that goes
 * upstream, and the poster shown for it, because an `<img>` cannot paint a
 * video URL. Held as two node fields they are two independent LWW registers
 * — Yjs decides each key's winner on its own — so two clients picking
 * different videos can converge to one client's video wearing the other's
 * poster. That is not a display nit: the poster is the only thing telling the
 * user which video the slot holds, on a path that spends credits.
 *
 * Worse, a delete cannot even compete. Writing `null` for "no poster" is a
 * no-op on a client that has no such key yet, so that client's pick leaves
 * the other's poster completely unopposed — measured, not assumed: an
 * unconditional `Y.Map.delete` on a missing key produces no operation at all.
 *
 * So the fix is structural rather than a rule to remember: one key holds the
 * whole pick, and last-writer-wins then applies to the pick as a unit.
 *
 * Replays a true offline divergence through the REAL public write API, the
 * same shape as the focus-crop concurrency suite next door: capture a
 * baseline, let A write on it, rebuild B from the same baseline as a fresh
 * doc (a different clientID), let B write, then merge both ways and assert
 * both replicas agree — and agree on a pick that some client actually made.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode } from '@web/data/yjs/canvas-space';
import { fillSlot } from '@web/spaces/canvas/generate/slot-write';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';

const PID = 'p1';
const SID = 's1';

/** A video node with a poster — what a healthy upload or generation leaves. */
const WITH_COVER = {
  type: 'video',
  data: { content: 'https://cdn/with-cover.mp4', coverUrl: 'https://cdn/with-cover.png' },
};

/**
 * A video node with NO poster. Reachable: the worker's cover extraction
 * returns undefined when ffmpeg fails on that output, and the node is written
 * with whatever came back.
 */
const NO_COVER = { type: 'video', data: { content: 'https://cdn/no-cover.mp4' } };

/**
 * The generative node the picks land on.
 * @returns A complete CanvasNodeFields object for node `gen`.
 */
function genNode(): CanvasNodeFields {
  return {
    id: 'gen',
    type: 'video',
    position: { x: 0, y: 0 },
    data: {
      name: 'V',
      createdAt: 1,
      createdBy: 'u1',
      locked: false,
      state: 'idle',
      attachments: [],
    },
  } as CanvasNodeFields;
}

/**
 * The live registry doc for the test project/space.
 * @returns The cached canvas-space Y.Doc.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * Snapshots the registry doc as a Yjs update.
 * @returns The full-state update.
 */
function stateOf(): Uint8Array {
  return Y.encodeStateAsUpdate(doc());
}

/**
 * Resets the registry to a fresh doc (a new clientID) seeded from a captured
 * update — the "second client" of the replay.
 * @param update - The baseline state to replay, if any.
 */
function resetTo(update: Uint8Array | null): void {
  _resetForTests();
  if (update) Y.applyUpdate(doc(), update);
}

/**
 * What node `gen` currently holds in the driving-video slot, as plain JSON.
 * @returns The stored pick, whatever shape it is stored in.
 */
function drivingPick(): unknown {
  const nodes = doc().getMap('nodesMap');
  const data = (nodes.get('gen') as Y.Map<unknown>).get('data') as Y.Map<unknown>;
  const raw = data.get(VIDEO_SLOTS.drivingVideo.field);
  return raw instanceof Y.Map ? raw.toJSON() : raw;
}

/**
 * Runs two picks as clients diverging OFFLINE, merges both orders, asserts
 * the replicas converge, and returns the converged pick.
 * @param writeA - Client A's pick.
 * @param writeB - Client B's concurrent pick.
 * @returns The converged value of the driving-video slot.
 */
function concurrently(writeA: () => void, writeB: () => void): unknown {
  const baseline = stateOf();
  writeA();
  const afterA = stateOf();
  resetTo(baseline);
  writeB();
  const afterB = stateOf();
  resetTo(afterA);
  Y.applyUpdate(doc(), afterB);
  const ab = drivingPick();
  resetTo(afterB);
  Y.applyUpdate(doc(), afterA);
  const ba = drivingPick();
  expect(ab, 'replicas disagree after merging in the two orders').toEqual(ba);
  return ab;
}

describe('a slot pick converges as one value (#1918)', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, genNode());
  });

  it('never lands one client video wearing the other client poster', () => {
    const converged = concurrently(
      () => fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, WITH_COVER),
      () => fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, NO_COVER),
    );
    // Whichever client wins, what survives has to be a pick SOMEONE made:
    // either the cover-less video on its own, or the other video with its
    // own poster. The pair that must never appear is the cover-less video
    // carrying the other one's frame.
    expect([
      { url: NO_COVER.data.content },
      { url: WITH_COVER.data.content, cover: WITH_COVER.data.coverUrl },
    ]).toContainEqual(converged);
  });

  it('keeps a replacement whole when two clients replace at once', () => {
    // Same question one step later: the slot already holds a pick, and both
    // clients replace it. A poster left over from the previous pick is the
    // same defect — it just has a longer path to it.
    fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, WITH_COVER);
    const converged = concurrently(
      () =>
        fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, {
          type: 'video',
          data: { content: 'https://cdn/a2.mp4', coverUrl: 'https://cdn/a2.png' },
        }),
      () => fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, NO_COVER),
    );
    expect([
      { url: NO_COVER.data.content },
      { url: 'https://cdn/a2.mp4', cover: 'https://cdn/a2.png' },
    ]).toContainEqual(converged);
  });
});
