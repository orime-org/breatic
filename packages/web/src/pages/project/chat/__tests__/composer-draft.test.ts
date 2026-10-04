// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// The chat draft is kept as one string; the box shows it as paragraphs with
// reference blocks. These two have to turn into each other without loss.

import { afterEach, describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { attachmentMarker } from '@breatic/shared';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { composerExtensions } from '@web/pages/project/chat/composer-extensions';
import { draftContent, draftOf } from '@web/pages/project/chat/composer-draft';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/**
 * An editor holding a draft.
 * @param draft - The draft string.
 * @returns The editor.
 */
function holding(draft: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: composerExtensions({ placeholder: () => '' }),
    content: draftContent(draft, (id) => `name-${id}`),
  });
  return editor;
}

describe('the chat draft', () => {
  it('reads back exactly as it was written', () => {
    const draft = `look at ${attachmentMarker('a')} and\n${attachmentMarker('b')}${attachmentMarker('c')} closely\n\nend`;

    expect(draftOf(holding(draft).state.doc)).toBe(draft);
  });

  it('shows each reference as a block carrying its id and name', () => {
    const e = holding(`x ${attachmentMarker('a')}`);
    const blocks: { id: unknown; label: unknown }[] = [];
    e.state.doc.descendants((n) => {
      if (n.type.name === REFERENCE_MENTION_NODE) {
        blocks.push({ id: n.attrs[MENTION_SOURCE_ID_ATTR], label: n.attrs.label });
      }
    });

    expect(blocks).toEqual([{ id: 'a', label: 'name-a' }]);
  });

  it('is empty for an empty box', () => {
    expect(draftOf(holding('').state.doc)).toBe('');
  });
});
