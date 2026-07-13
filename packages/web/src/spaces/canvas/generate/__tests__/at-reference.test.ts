// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { JSONContent } from '@tiptap/core';
import { describe, it, expect } from 'vitest';

import {
  extractAtMentionedSourceIds,
  planMentionDeletions,
  planChipDisplayUpdates,
} from '@web/spaces/canvas/generate/at-reference';

/** Builds a reference-mention node fixture. */
function mention(sourceNodeId: string): JSONContent {
  return { type: 'referenceMention', attrs: { sourceNodeId } };
}
/** Wraps inline content in a paragraph. */
function para(...content: JSONContent[]): JSONContent {
  return { type: 'paragraph', content };
}
/** Wraps block content in a doc. */
function doc(...content: JSONContent[]): JSONContent {
  return { type: 'doc', content };
}

describe('extractAtMentionedSourceIds', () => {
  it('returns [] for an empty / undefined / text-only doc', () => {
    expect(extractAtMentionedSourceIds(undefined)).toEqual([]);
    expect(extractAtMentionedSourceIds(doc())).toEqual([]);
    expect(
      extractAtMentionedSourceIds(doc(para({ type: 'text', text: 'hello' }))),
    ).toEqual([]);
  });

  it('collects @-mentioned source ids in document order', () => {
    const d = doc(
      para(
        { type: 'text', text: 'use ' },
        mention('a'),
        { type: 'text', text: ' and ' },
        mention('b'),
      ),
    );
    expect(extractAtMentionedSourceIds(d)).toEqual(['a', 'b']);
  });

  it('de-duplicates repeated mentions, keeping first-appearance order', () => {
    const d = doc(para(mention('a'), mention('b'), mention('a')));
    expect(extractAtMentionedSourceIds(d)).toEqual(['a', 'b']);
  });

  it('finds mentions nested across multiple paragraphs', () => {
    const d = doc(
      para(mention('a')),
      para({ type: 'text', text: 'x' }, mention('b')),
    );
    expect(extractAtMentionedSourceIds(d)).toEqual(['a', 'b']);
  });

  it('skips a mention with a missing / non-string sourceNodeId', () => {
    const d = doc(
      para(
        { type: 'referenceMention', attrs: {} },
        { type: 'referenceMention', attrs: { sourceNodeId: 42 as unknown as string } },
        mention('ok'),
      ),
    );
    expect(extractAtMentionedSourceIds(d)).toEqual(['ok']);
  });
});

describe('planMentionDeletions — cascade-clear @ chips when an edge leaves the pool', () => {
  const pool = new Set(['a', 'b']);

  it('returns no deletions when every mention is still in the pool', () => {
    const mentions = [
      { sourceNodeId: 'a', from: 2, to: 3 },
      { sourceNodeId: 'b', from: 5, to: 6 },
    ];
    expect(planMentionDeletions(mentions, pool)).toEqual([]);
  });

  it('deletes mentions whose source left the pool', () => {
    const mentions = [
      { sourceNodeId: 'a', from: 2, to: 3 }, // still connected
      { sourceNodeId: 'gone', from: 5, to: 6 }, // edge removed
    ];
    expect(planMentionDeletions(mentions, pool)).toEqual([{ from: 5, to: 6 }]);
  });

  it('returns stale ranges sorted DESCENDING by `from` (safe sequential delete)', () => {
    // Two stale mentions: deleting the earlier one first would shift the later
    // one's positions, so they must come back highest-position-first.
    const mentions = [
      { sourceNodeId: 'x', from: 2, to: 3 },
      { sourceNodeId: 'a', from: 5, to: 6 }, // kept
      { sourceNodeId: 'y', from: 8, to: 9 },
    ];
    expect(planMentionDeletions(mentions, pool)).toEqual([
      { from: 8, to: 9 },
      { from: 2, to: 3 },
    ]);
  });

  it('deletes ALL mentions when the pool is empty (last edge removed)', () => {
    const mentions = [
      { sourceNodeId: 'a', from: 2, to: 3 },
      { sourceNodeId: 'b', from: 5, to: 6 },
    ];
    expect(planMentionDeletions(mentions, new Set())).toEqual([
      { from: 5, to: 6 },
      { from: 2, to: 3 },
    ]);
  });
});

// The reference-chip live-projection invariant (design 2026-07-12): a chip's
// cheap synced display attrs (name + thumbnail) must track the source node's
// LIVE pool row, for EVERY modality — image thumbnail was synced but text-node
// renames (and any modality's name) were frozen at insert time. This planner is
// modality-agnostic: it diffs each chip's current attrs against the live pool
// and reports only the changed fields. A text chip's thumbnail is null on both
// sides (diff → no thumbnail write); its name still syncs.
describe('planChipDisplayUpdates — sync chip display attrs from the live pool', () => {
  const pool = [
    { sourceNodeId: 'img', sourceNodeName: 'Sunset', thumbnail: 'live.png' },
    { sourceNodeId: 'txt', sourceNodeName: 'Renamed notes', thumbnail: undefined },
  ];

  it('returns no updates when every chip already matches the live pool', () => {
    const chips = [
      { pos: 1, sourceNodeId: 'img', label: 'Sunset', thumbnail: 'live.png' },
      { pos: 3, sourceNodeId: 'txt', label: 'Renamed notes', thumbnail: null },
    ];
    expect(planChipDisplayUpdates(chips, pool)).toEqual([]);
  });

  it('reports a changed thumbnail (image source re-generated / re-uploaded)', () => {
    const chips = [
      { pos: 1, sourceNodeId: 'img', label: 'Sunset', thumbnail: 'stale.png' },
    ];
    expect(planChipDisplayUpdates(chips, pool)).toEqual([
      { pos: 1, thumbnail: 'live.png' },
    ]);
  });

  it('reports a changed label for a TEXT chip (rename) — no thumbnail write', () => {
    const chips = [
      { pos: 3, sourceNodeId: 'txt', label: 'Old name', thumbnail: null },
    ];
    // Text has no thumbnail on either side, so only the name is synced — the
    // modality-agnostic proof that rename tracks for non-image sources too.
    expect(planChipDisplayUpdates(chips, pool)).toEqual([
      { pos: 3, label: 'Renamed notes' },
    ]);
  });

  it('reports both fields when name AND thumbnail changed', () => {
    const chips = [
      { pos: 1, sourceNodeId: 'img', label: 'Old', thumbnail: 'stale.png' },
    ];
    expect(planChipDisplayUpdates(chips, pool)).toEqual([
      { pos: 1, label: 'Sunset', thumbnail: 'live.png' },
    ]);
  });

  it('skips a chip whose source left the pool (cascade-clear removes it)', () => {
    const chips = [
      { pos: 5, sourceNodeId: 'gone', label: 'X', thumbnail: 'x.png' },
    ];
    expect(planChipDisplayUpdates(chips, pool)).toEqual([]);
  });

  it('normalizes an empty live name to null (clears a stale frozen name)', () => {
    const chips = [
      { pos: 1, sourceNodeId: 'img', label: 'Sunset', thumbnail: 'live.png' },
    ];
    const renamedBlank = [
      { sourceNodeId: 'img', sourceNodeName: '', thumbnail: 'live.png' },
    ];
    expect(planChipDisplayUpdates(chips, renamedBlank)).toEqual([
      { pos: 1, label: null },
    ]);
  });
});
