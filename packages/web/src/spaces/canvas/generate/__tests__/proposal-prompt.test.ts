// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a placed proposal or a picked template leaves in the prompt box
 * (#229, inner#977).
 *
 * The prompt is written straight into the Yjs types, without an editor, so
 * every case here reads it back through a real prompt editor bound to the same
 * fragment: a hand-built shape the schema rejects would vanish the moment the
 * reader opens the panel. Nothing is @'d for the reader; the marks only tell
 * them what to do.
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
import { writeProposalPrompt } from '@web/spaces/canvas/generate/proposal-prompt';

/**
 * Write a prompt, then read it back through an editor bound to the fragment.
 * @param segments - The prompt as the model sent it.
 * @returns What the editor makes of it and the string generation would get.
 */
function roundTrip(segments: readonly PromptSegment[]): { json: JSONContent; sent: string } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  writeProposalPrompt(fragment, segments);

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
  const read = { json: editor.getJSON(), sent: serializePromptText(editor, []) };
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

describe('words with nothing left for the reader', () => {
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

  it('stand in the prompt as words telling the reader what to do', () => {
    expect(roundTrip(SEGMENTS).sent).toBe('[📎 Use @ to pick the uploaded photo] at night, {✏️ the mood}');
  });

  it('@ nothing for the reader', () => {
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
