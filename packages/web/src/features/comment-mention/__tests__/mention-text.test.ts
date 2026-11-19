// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { CommentMention } from '@breatic/shared';
import {
  insertMention,
  mentionQueryAt,
  settleMentions,
} from '@web/features/comment-mention/mention-text';

const mention = (userId: string, label: string, mentionedAt = 1): CommentMention => ({
  userId,
  projectId: 'p1',
  mentionedAt,
  label,
});

describe('mentionQueryAt', () => {
  it('finds the @ the caret is typing after', () => {
    expect(mentionQueryAt('hi @Al', 6)).toEqual({ start: 3, query: 'Al' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('opens on a new line as on a space', () => {
    expect(mentionQueryAt('a\n@b', 4)).toEqual({ start: 2, query: 'b' });
  });

  it('ignores an @ inside a word, such as an email address', () => {
    expect(mentionQueryAt('mail a@b', 8)).toBeNull();
  });

  it('closes once a space follows the query', () => {
    expect(mentionQueryAt('@Al ', 4)).toBeNull();
  });

  it('reads only up to the caret', () => {
    expect(mentionQueryAt('@Alice and more', 3)).toEqual({ start: 0, query: 'Al' });
  });
});

describe('insertMention', () => {
  it('replaces the typed query with the label and a space, caret after it', () => {
    expect(insertMention('hi @Al there', { start: 3, query: 'Al' }, 6, '@Alice')).toEqual({
      text: 'hi @Alice  there',
      caret: 10,
    });
  });
});

describe('settleMentions', () => {
  const names = new Map([['u1', 'Alice'], ['u2', 'Bob']]);
  const nameOf = (id: string): string | undefined => names.get(id);

  it('keeps a member whose label is still in the text', () => {
    expect(settleMentions('ask @Alice', [mention('u1', '@Alice')], nameOf)).toEqual([mention('u1', '@Alice')]);
  });

  it('keeps a member renamed since, while the old label is still there', () => {
    expect(settleMentions('ask @Al', [mention('u1', '@Al')], nameOf)).toEqual([mention('u1', '@Al')]);
  });

  it('keeps a member whose current name is written though the label is gone', () => {
    expect(settleMentions('ask @Alice', [mention('u1', '@Al')], nameOf)).toEqual([mention('u1', '@Al')]);
  });

  it('drops a member when neither the label nor the current name is in the text', () => {
    expect(settleMentions('ask nobody', [mention('u1', '@Alice')], nameOf)).toEqual([]);
  });

  it('keeps the first mention of a member picked twice', () => {
    expect(
      settleMentions('@Bob @Bob', [mention('u2', '@Bob', 5), mention('u2', '@Bob', 9)], nameOf),
    ).toEqual([mention('u2', '@Bob', 5)]);
  });

  it('never keeps a member whose label and name are both absent from the text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const kept = settleMentions(text, [mention('u1', '@Alice'), mention('u2', '@Bob')], nameOf);
        for (const m of kept) {
          expect(text.includes(m.label) || text.includes(`@${names.get(m.userId) ?? ''}`)).toBe(true);
        }
      }),
    );
  });
});
