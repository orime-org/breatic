// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a placed proposal leaves in the prompt box (#229).
 *
 * The prompt is written straight into the Yjs types, without an editor, so
 * every case here reads it back through a real prompt editor bound to the same
 * fragment. That is the only thing standing between a hand-built shape and one
 * ProseMirror's schema rejects the moment the reader opens the panel -- and a
 * mention whose attrs the schema does not recognise contributes nothing to
 * generation while still looking like a chip.
 */

import { describe, it, expect } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import * as Y from 'yjs';

import type { PromptSegment } from '@breatic/shared';

import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
  extractAtMentionedSourceIds,
} from '@web/spaces/canvas/generate/at-reference';
import {
  MENTION_KIND_ATTR,
  ReferenceMention,
  serializePromptText,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import {
  writeProposalPrompt,
  type ProposalSource,
} from '@web/spaces/canvas/generate/proposal-prompt';

/**
 * Write a prompt, then read it back through an editor bound to the fragment.
 * @param segments - The prompt as the model sent it.
 * @param sources - The empty nodes the asset spots mention.
 * @param upstream - The nodes already carrying work that ref spots mention.
 * @returns What the editor makes of it, its plain text, and the string that
 *   would be sent to generation.
 */
function roundTrip(
  segments: readonly PromptSegment[],
  sources: readonly ProposalSource[] = [],
  upstream: readonly ProposalSource[] = [],
): { json: JSONContent; text: string; sent: string } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  writeProposalPrompt(fragment, segments, { sources, upstream });

  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: '',
          noMatchLabel: '',
        }),
      }),
      Collaboration.configure({ fragment }),
    ],
  });
  const read = {
    json: editor.getJSON(),
    text: editor.getText(),
    sent: serializePromptText(editor, []),
  };
  editor.destroy();
  return read;
}

describe('a prompt with nothing left for the reader', () => {
  it('reaches the editor as the words the model wrote', () => {
    const { text } = roundTrip([{ text: 'a still life on a white ground' }]);

    expect(text).toBe('a still life on a white ground');
  });
});

describe('a spot the reader has to change', () => {
  it('stands in the prompt bracketed, where it belongs', () => {
    const { text } = roundTrip([
      { text: 'a hummingbird, ' },
      { slot: { kind: 'tweak', label: 'cyberpunk', note: 'swap the style' } },
      { text: ', shallow focus' },
    ]);

    expect(text).toBe('a hummingbird, [✏️ cyberpunk], shallow focus');
  });
});

describe('a spot the reader has to fill with their own material', () => {
  const SEGMENTS: PromptSegment[] = [
    { text: 'white ground, ' },
    {
      slot: {
        kind: 'asset',
        label: 'your product photo',
        note: 'Put it in the node on the left',
      },
    },
    { text: ' centred' },
  ];
  const SOURCES: ProposalSource[] = [{ id: 'n-empty', kind: 'image' }];

  it('is bracketed too, and the words on either side of it survive', () => {
    const { sent } = roundTrip(SEGMENTS, SOURCES);

    // Read as generation reads it: an image chip contributes no words there --
    // it feeds the source image instead -- so what is left is the sentence.
    // The gap after the bracket is the chip's own: every chip keeps one
    // ordinary space on each side so the caret has somewhere to land
    // (reference-mention-whitespace.ts), and the editor adds them on binding.
    expect(sent).toBe('white ground, [📎 your product photo]  centred');
  });

  it('carries the mention of the empty node, so generation reaches it', () => {
    const { json } = roundTrip(SEGMENTS, SOURCES);

    expect(extractAtMentionedSourceIds(json)).toEqual(['n-empty']);
  });

  it('leaves the chip to follow the node rather than freezing its look', () => {
    const { json } = roundTrip(SEGMENTS, SOURCES);

    const mention = json.content?.[0]?.content?.find(
      (n) => n.type === REFERENCE_MENTION_NODE,
    );
    expect(mention?.attrs?.[MENTION_SOURCE_ID_ATTR]).toBe('n-empty');
    expect(mention?.attrs?.[MENTION_KIND_ATTR]).toBe('image');
    // The projection fills these in from the live node.
    expect(mention?.attrs?.['label']).toBeNull();
    expect(mention?.attrs?.['thumbnail']).toBeNull();
  });
});

describe('a prompt written across more than one line', () => {
  it('becomes one block per line, which is what the schema allows', () => {
    const { json } = roundTrip([{ text: 'first line\nsecond line' }]);

    expect(json.content).toHaveLength(2);
    expect(json.content?.[0]?.content?.[0]?.text).toBe('first line');
    expect(json.content?.[1]?.content?.[0]?.text).toBe('second line');
  });
});

describe('a spot that points at the node upstream', () => {
  const UPSTREAM: ProposalSource[] = [{ id: 'n-first', kind: 'image' }];

  it('writes the mention and no bracket of its own', () => {
    const { sent } = roundTrip(
      [
        { text: 'in the same light as ' },
        { slot: { kind: 'ref', label: 'the first shot', note: 'Nothing to do' } },
        { text: ', from the side' },
      ],
      [],
      UPSTREAM,
    );

    // An image chip contributes no words to generation, so what is left is
    // the sentence around it -- with the chip's own spaces on either side.
    expect(sent).toBe('in the same light as  , from the side');
  });

  it('reaches generation as a mention of that node', () => {
    const { json } = roundTrip(
      [{ text: 'in the same light as ' }, { slot: { kind: 'ref', label: 'the first shot', note: 'x' } }],
      [],
      UPSTREAM,
    );

    expect(extractAtMentionedSourceIds(json)).toEqual(['n-first']);
  });

  it('takes its node from the upstream list, not the empty one', () => {
    const { json } = roundTrip(
      [
        { slot: { kind: 'asset', label: 'your photo', note: 'x' } },
        { text: ' in the light of ' },
        { slot: { kind: 'ref', label: 'the first shot', note: 'x' } },
      ],
      [{ id: 'n-empty', kind: 'image' }],
      UPSTREAM,
    );

    expect(extractAtMentionedSourceIds(json)).toEqual(['n-empty', 'n-first']);
  });

  it('mentions a text node upstream by its own kind', () => {
    const { json } = roundTrip(
      [{ text: 'follow ' }, { slot: { kind: 'ref', label: 'the copy', note: 'x' } }],
      [],
      [{ id: 'n-copy', kind: 'text' }],
    );

    const mention = json.content?.[0]?.content?.find(
      (n) => n.type === REFERENCE_MENTION_NODE,
    );
    expect(mention?.attrs?.[MENTION_KIND_ATTR]).toBe('text');
  });
});
