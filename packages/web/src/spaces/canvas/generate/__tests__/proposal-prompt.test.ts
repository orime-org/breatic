// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a placed proposal or a picked template leaves in the prompt box
 * (#229, inner#977).
 *
 * The prompt is written straight into the Yjs types, without an editor, so
 * every case here reads it back through a real prompt editor bound to the same
 * fragment: a hand-built shape the schema rejects would vanish the moment the
 * user opens the panel. A proposal's ref lands as the same mention the
 * user would insert with @ (inner#1315); the marks only tell them what to do.
 */

import { describe, it, expect } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import * as Y from 'yjs';

import type { PromptSegment } from '@breatic/shared';

import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE, PromptDocument, PromptNote } from '@web/features/prompt-note/prompt-note';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { ReferenceMention, serializePromptText } from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { writeProposalPrompt, type ProposalMention } from '@web/spaces/canvas/generate/proposal-prompt';

/**
 * Write a prompt, then read it back through an editor bound to the fragment.
 * @param segments - The prompt as the model sent it.
 * @param mentionOf - What each ref @s, by proposal index.
 * @param pool - The reference pool generation reads the mentions against.
 * @returns What the editor makes of it and the string generation would get.
 */
function roundTrip(
  segments: readonly PromptSegment[],
  mentionOf: (index: number) => ProposalMention | undefined = () => undefined,
  pool: ReferenceRailItem[] = [],
): { json: JSONContent; sent: string } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  writeProposalPrompt(fragment, segments, mentionOf);

  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      PromptDocument,
      Paragraph,
      Text,
      PromptNote,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({ getPool: () => [], emptyLabel: '' }),
      }),
      Collaboration.configure({ fragment }),
    ],
  });
  const read = { json: editor.getJSON(), sent: serializePromptText(editor, pool) };
  editor.destroy();
  return read;
}

/**
 * Every node type in the document, depth first.
 * @param node - Where to start.
 * @returns The type names.
 */
function typesIn(node: JSONContent): string[] {
  return [node.type ?? '', ...(node.content ?? []).flatMap(typesIn)];
}

describe('words with nothing left for the user', () => {
  it('reach the editor as the model wrote them', () => {
    expect(roundTrip([{ text: 'a still life on a white ground' }]).sent).toBe('a still life on a white ground');
  });

  it('start a new block at each line break', () => {
    const { json } = roundTrip([{ text: 'first line\nsecond line' }]);
    expect(json.content?.map((block) => block.content?.[0]?.text)).toEqual(['first line', 'second line']);
  });
});

describe('a reference and a fill-in', () => {
  const SEGMENTS: PromptSegment[] = [
    { slot: { kind: 'asset', label: 'the uploaded photo', note: '@ the photo' } },
    { text: ' at night, ' },
    { slot: { kind: 'tweak', label: 'the mood', note: 'write the mood' } },
  ];

  it('stand in the prompt as words telling the user what to do', () => {
    expect(roundTrip(SEGMENTS).sent).toBe('[📎 Use @ to pick the uploaded photo] at night, {✏️ the mood}');
  });

  it('@ nothing for the user', () => {
    expect(typesIn(roundTrip(SEGMENTS).json)).not.toContain(REFERENCE_MENTION_NODE);
  });
});

describe('a note', () => {
  const SEGMENTS: PromptSegment[] = [
    { text: 'She walks forward.' },
    { slot: { kind: 'note', label: 'Pick the first frame in the panel' } },
    { slot: { kind: 'note', label: 'Upload the voice first' } },
  ];

  it('lands as its own blocks at the top, one per note, in the order written', () => {
    const { json } = roundTrip(SEGMENTS);
    expect(json.content?.slice(0, 2).map((block) => [block.type, block.attrs?.[PROMPT_NOTE_LABEL_ATTR]])).toEqual([
      [PROMPT_NOTE_NODE, 'Pick the first frame in the panel'],
      [PROMPT_NOTE_NODE, 'Upload the voice first'],
    ]);
  });

  it('is left out of what generation gets', () => {
    expect(roundTrip(SEGMENTS).sent).toBe('She walks forward.');
  });

  it('leaves a line below it to write in when it is all there is', () => {
    const { json } = roundTrip([{ slot: { kind: 'note', label: 'Pick the first frame in the panel' } }]);
    expect(json.content?.map((block) => block.type)).toEqual([PROMPT_NOTE_NODE, 'paragraph']);
  });
});

describe('a ref to another proposed node', () => {
  const SCRIPT: ProposalMention = { sourceNodeId: 'n-script', label: 'Script', kind: 'text' };
  const PHOTO: ProposalMention = { sourceNodeId: 'n-photo', label: 'Photo', kind: 'image', thumbnail: 'https://r2.example/p.png' };
  const mentionOf = (index: number): ProposalMention | undefined => [SCRIPT, PHOTO][index];

  it('lands as the mention the user would insert with @, in the line where it was written', () => {
    const { json } = roundTrip([{ text: 'Repaint ' }, { ref: 1 }, { text: ' as a watercolour.' }], mentionOf);
    const line = json.content?.[0]?.content ?? [];
    expect(line.map((part) => part.type)).toEqual(['text', REFERENCE_MENTION_NODE, 'text']);
    expect(line[1]?.attrs).toMatchObject({ sourceNodeId: 'n-photo', label: 'Photo', kind: 'image', thumbnail: 'https://r2.example/p.png' });
  });

  it('sends a text node\'s words in its place when the run starts', () => {
    const pool: ReferenceRailItem[] = [
      { refId: 'e1', sourceNodeId: 'n-script', sourceNodeType: 'text', sourceNodeName: 'Script', textContent: 'Hello there.' },
    ];
    // The editor keeps a space after a chip ending a line, as it does for one
    // picked with @ (reference-mention-caret.ts).
    expect(roundTrip([{ text: 'Read: ' }, { ref: 0 }], mentionOf, pool).sent).toBe('Read: Hello there. ');
  });

  it('leaves a ref to a node that was not placed out of the prompt', () => {
    const { json } = roundTrip([{ text: 'Repaint ' }, { ref: 5 }], mentionOf);
    expect(typesIn(json)).not.toContain(REFERENCE_MENTION_NODE);
  });
});

describe('a ref to an optional input (inner#1811, CAP-9)', () => {
  const PRODUCT: ProposalMention = { sourceNodeId: 'n-product', label: 'Product', kind: 'image' };
  const PERSON: ProposalMention = { sourceNodeId: 'n-person', label: 'Person', kind: 'image' };
  const mentionOf = (index: number): ProposalMention | undefined => [PRODUCT, PERSON][index];
  /**
   * The product ad's words: the person in a paragraph of its own between two others.
   * @param optional - Whether the person ref is marked optional.
   * @returns The segments.
   */
  const words = (optional = true): PromptSegment[] => [
    { text: 'An ad for ' },
    { ref: 0 },
    { text: '.\nThe person looks like ' },
    optional ? { ref: 1, optional: true } : { ref: 1 },
    { text: '.\nLit softly.' },
  ];
  /**
   * The pool, the product holding a picture and the person as given.
   * @param personPicture - The person's picture, or none.
   * @returns The rows.
   */
  const pool = (personPicture?: string): ReferenceRailItem[] => [
    { refId: 'e0', sourceNodeId: 'n-product', sourceNodeType: 'image', sourceNodeName: 'Product', mediaUrl: 'https://r2.example/product.png' },
    { refId: 'e1', sourceNodeId: 'n-person', sourceNodeType: 'image', sourceNodeName: 'Person', ...(personPicture === undefined ? {} : { mediaUrl: personPicture }) },
  ];

  it('lands as a mention carrying optional, and only that one', () => {
    const { json } = roundTrip(words(), mentionOf);
    const mentions = (json.content ?? []).flatMap((block) => (block.content ?? []).filter((part) => part.type === REFERENCE_MENTION_NODE));
    expect(mentions.map((mention) => [mention.attrs?.['sourceNodeId'], mention.attrs?.['optional'] ?? null])).toEqual([
      ['n-product', null],
      ['n-person', true],
    ]);
  });

  it('leaves its paragraph out of what generation gets while the person holds no picture', () => {
    const { sent } = roundTrip(words(), mentionOf, pool());
    expect(sent).toContain('An ad for');
    expect(sent).toContain('Lit softly.');
    expect(sent).not.toContain('The person looks like');
    expect(sent.split('\n\n')).toHaveLength(2);
  });

  it('sends its paragraph once the person holds a picture', () => {
    const { sent } = roundTrip(words(), mentionOf, pool('https://r2.example/person.png'));
    expect(sent).toContain('The person looks like');
    expect(sent.split('\n\n')).toHaveLength(3);
  });

  it('keeps the sentence of a mention the user picked, its empty node read as nothing', () => {
    const { sent } = roundTrip(words(false), mentionOf, pool());
    expect(sent).toContain('The person looks like');
  });
});
