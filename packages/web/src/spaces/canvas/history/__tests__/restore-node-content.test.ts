// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import { resolveRestore } from '@web/spaces/canvas/history/restore-node-content';

/**
 * Builds the restorable slice of a history entry.
 * @param over - Field overrides.
 * @returns The entry slice consumed by resolveRestore.
 */
function entry(
  over: Partial<Pick<NodeHistoryEntry, 'status' | 'content' | 'thumbnailUrl'>> = {},
): Pick<NodeHistoryEntry, 'status' | 'content' | 'thumbnailUrl'> {
  return { status: 'success', content: 'result.png', thumbnailUrl: null, ...over };
}

describe('resolveRestore (#1619 restore invariants, 关键路径)', () => {
  it('INV-9: readOnly → noop', () => {
    expect(
      resolveRestore({
        readOnly: true,
        entry: entry(),
        modality: 'image',
        gateState: { locked: false, handling: false },
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('INV-4: a failed / content-less entry → noop', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ status: 'failed', content: null }),
        modality: 'image',
        gateState: { locked: false, handling: false },
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('INV-1: a locked node → blocked with the locked toast', () => {
    const d = resolveRestore({
      readOnly: false,
      entry: entry(),
      modality: 'image',
      gateState: { locked: true, handling: false },
    });
    expect(d).toEqual({ kind: 'blocked', toastKey: 'canvas.gate.locked' });
  });

  it('INV-2: a handling / live-lease node → blocked with the handling toast', () => {
    const d = resolveRestore({
      readOnly: false,
      entry: entry(),
      modality: 'image',
      // The caller ORs isNodeHandling with the live-lease read into `handling`.
      gateState: { locked: false, handling: true },
    });
    expect(d).toEqual({ kind: 'blocked', toastKey: 'canvas.gate.handling' });
  });

  it('INV-3 + INV-8: image restore writes content, no coverUrl', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'img.png', thumbnailUrl: 'thumb.png' }),
        modality: 'image',
        gateState: { locked: false, handling: false },
      }),
    ).toEqual({ kind: 'write', content: 'img.png', coverUrl: undefined });
  });

  it('INV-8: video restore writes content + coverUrl from the thumbnail', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'clip.mp4', thumbnailUrl: 'cover.jpg' }),
        modality: 'video',
        gateState: { locked: false, handling: false },
      }),
    ).toEqual({ kind: 'write', content: 'clip.mp4', coverUrl: 'cover.jpg' });
  });

  it('INV-8: video restore with no thumbnail → coverUrl null (clears stale poster)', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'clip.mp4', thumbnailUrl: null }),
        modality: 'video',
        gateState: { locked: false, handling: false },
      }),
    ).toEqual({ kind: 'write', content: 'clip.mp4', coverUrl: null });
  });

  it('audio restore writes content, coverUrl untouched (undefined)', () => {
    expect(
      resolveRestore({
        readOnly: false,
        entry: entry({ content: 'song.mp3', thumbnailUrl: null }),
        modality: 'audio',
        gateState: { locked: false, handling: false },
      }),
    ).toEqual({ kind: 'write', content: 'song.mp3', coverUrl: undefined });
  });
});
