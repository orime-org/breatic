// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import {
  resolveRestore,
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
