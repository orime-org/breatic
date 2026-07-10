// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { JSONContent } from '@tiptap/core';
import { describe, it, expect } from 'vitest';

import { extractAtMentionedSourceIds } from '@web/spaces/canvas/generate/at-reference';

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
