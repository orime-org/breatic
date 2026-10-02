// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import {
  resolveRestore,
  resolveTaskReplace,
} from '@web/spaces/canvas/history/restore-node-content';

type EntrySlice = Pick<
  NodeHistoryEntry,
  'status' | 'content' | 'thumbnailUrl' | 'mediaWidth' | 'mediaHeight' | 'duration' | 'mimeType' | 'size'
>;

/**
 * Builds the restorable slice of a history entry.
 * @param over - Field overrides.
 * @returns The entry slice consumed by resolveRestore.
 */
function entry(over: Partial<EntrySlice> = {}): EntrySlice {
  return {
    status: 'success',
    content: 'result.png',
    thumbnailUrl: null,
    mediaWidth: null,
    mediaHeight: null,
    duration: null,
    mimeType: null,
    size: null,
    ...over,
  };
}

/** A row written before #2184, or a medium with none of the numbers. */
const NO_NUMBERS = { width: null, height: null, duration: null, mimeType: null, size: null };

/**
 * The task-list slice for a finished result.
 * @param content - The result's content.
 * @param coverUrl - The result's cover.
 * @returns The task slice consumed by resolveTaskReplace.
 */
function task(content: string | null, coverUrl: string | null) {
  return { content, coverUrl, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null };
}

describe('resolveRestore (#1619 restore invariants, 关键路径)', () => {
  it('INV-9: readOnly → noop', () => {
    expect(
      resolveRestore({
        readOnly: true,
        entry: entry(),
        modality: 'image',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('INV-4: a failed / content-less entry → noop', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ status: 'failed', content: null }),
        modality: 'image',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('INV-1: a locked node → blocked with the locked toast', () => {
    const d = resolveRestore({
      readOnly: false,
      entry: entry(),
      modality: 'image',
      gateState: { locked: true },
    });
    expect(d).toEqual({ kind: 'blocked', toastKey: 'canvas.gate.locked' });
  });

  it('INV-2: a node with a task running restores anyway (#186 §3.5.1)', () => {
    // Restoring is the user putting back something this node held before, and
    // the task writing to it right now will land whatever it lands. Last write
    // wins either way, and both results stay reachable — the history entry
    // here, the task's own result in the task list.
    const d = resolveRestore({
      readOnly: false,
      entry: entry({ content: 'result.png' }),
      modality: 'image',
      gateState: { locked: false },
    });
    expect(d).toMatchObject({ kind: 'write', content: 'result.png' });
  });

  it('INV-3 + INV-8: image restore takes the cover off, as a landed image result does', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'img.png', thumbnailUrl: 'thumb.png' }),
        modality: 'image',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'write', content: 'img.png', media: { coverUrl: null, ...NO_NUMBERS } });
  });

  it('INV-8: video restore writes content + coverUrl from the thumbnail', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'clip.mp4', thumbnailUrl: 'cover.jpg' }),
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'write', content: 'clip.mp4', media: { coverUrl: 'cover.jpg', ...NO_NUMBERS } });
  });

  it('INV-8: video restore with no thumbnail → coverUrl null (clears stale poster)', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'clip.mp4', thumbnailUrl: null }),
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'write', content: 'clip.mp4', media: { coverUrl: null, ...NO_NUMBERS } });
  });

  it('audio restore takes the cover off, as a landed audio result does', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'song.mp3', thumbnailUrl: null }),
        modality: 'audio',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'write', content: 'song.mp3', media: { coverUrl: null, ...NO_NUMBERS } });
  });
});

describe('resolveTaskReplace — the task list puts one result back', () => {
  it('clears the poster when a video result carries no cover', () => {
    // Two uploads onto one node: the first video's cover extraction worked,
    // the second's did not. Replacing with the second has to take the first
    // one's poster off, or the new clip renders under the old thumbnail.
    expect(
      resolveTaskReplace({
        readOnly: false,
        task: task('https://cdn.invalid/b.mp4', null),
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toEqual({
      kind: 'write',
      content: 'https://cdn.invalid/b.mp4',
      media: { coverUrl: null, ...NO_NUMBERS },
    });
  });

  it('carries the cover a video result does have', () => {
    expect(
      resolveTaskReplace({
        readOnly: false,
        task: task('https://cdn.invalid/b.mp4', 'https://cdn.invalid/b.png'),
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toMatchObject({ media: { coverUrl: 'https://cdn.invalid/b.png' } });
  });

  it('takes the cover off an image node, as a landed image result does', () => {
    expect(
      resolveTaskReplace({
        readOnly: false,
        task: task('https://cdn.invalid/b.png', 'https://cdn.invalid/b.png'),
        modality: 'image',
        gateState: { locked: false },
      }),
    ).toMatchObject({ media: { coverUrl: null } });
  });

  it('refuses a row with no result', () => {
    expect(
      resolveTaskReplace({
        readOnly: false,
        task: task(null, null),
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('is blocked by the lock on the node itself', () => {
    expect(
      resolveTaskReplace({
        readOnly: false,
        task: task('https://cdn.invalid/b.mp4', null),
        modality: 'video',
        gateState: { locked: true },
      }),
    ).toMatchObject({ kind: 'blocked' });
  });
});

describe('restore carries the numbers the result landed with (#2184)', () => {
  const NUMBERS = {
    mediaWidth: 1920,
    mediaHeight: 1080,
    duration: 5.04,
    mimeType: 'video/mp4',
    size: 734_003,
  };
  const ON_NODE = { width: 1920, height: 1080, duration: 5.04, mimeType: 'video/mp4', size: 734_003 };

  it('a history row hands its numbers to the node', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'clip.mp4', thumbnailUrl: 'cover.jpg', ...NUMBERS }),
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toEqual({ kind: 'write', content: 'clip.mp4', media: { coverUrl: 'cover.jpg', ...ON_NODE } });
  });

  it('the task list hands over the same numbers for the same row', () => {
    expect(
      resolveTaskReplace({
        readOnly: false,
        task: { ...task('clip.mp4', 'cover.jpg'), ...NUMBERS },
        modality: 'video',
        gateState: { locked: false },
      }),
    ).toEqual(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'clip.mp4', thumbnailUrl: 'cover.jpg', ...NUMBERS }),
        modality: 'video',
        gateState: { locked: false },
      }),
    );
  });
});
