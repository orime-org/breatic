// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A note at the top of a shot's prompt is not sent (inner#977): read without
 * an editor, the shot reads exactly as it would with the note deleted, so a
 * model that takes all the shots in one prompt gets no stray blank line.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { StoryboardSpec } from '@breatic/shared';

import { serializePromptFragment } from '@web/spaces/canvas/generate/fragment-prompt';
import { storyboardRun } from '@web/spaces/canvas/generate/storyboard-run';

/**
 * A prompt fragment holding a note above some words, or the words alone.
 * @param words - The words.
 * @param withNote - Whether a note sits above them.
 * @returns The fragment, attached to a document.
 */
function shotPrompt(words: string, withNote: boolean): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  const blocks: Y.XmlElement[] = [];
  if (withNote) {
    const note = new Y.XmlElement('promptNote');
    note.setAttribute('label', 'Pick the first frame in the panel');
    blocks.push(note);
  }
  const line = new Y.XmlElement('paragraph');
  line.insert(0, [new Y.XmlText(words)]);
  blocks.push(line);
  fragment.insert(0, blocks);
  return fragment;
}

describe('a prompt with a note at the top, read without an editor', () => {
  it('reads the same as with the note deleted', () => {
    expect(serializePromptFragment(shotPrompt('She walks in.', true), [], {})).toBe(
      serializePromptFragment(shotPrompt('She walks in.', false), [], {}),
    );
  });

  it('leaves no blank line after the shot label when every shot goes in one prompt', () => {
    const spec: StoryboardSpec = {
      shotsParam: 'shots',
      fixed: {},
      secondsField: 'duration',
      totalParam: undefined,
      maxShots: 6,
      maxChars: undefined,
      intoPrompt: 'Shot {n} [{start}-{end}s]: {prompt}',
    };
    const run = storyboardRun(spec, [{ prompt: shotPrompt('She walks in.', true), duration: 3 }], 3, [], {});
    expect(run.writtenPrompt).toBeDefined();
    expect(run.writtenPrompt).not.toMatch(/:\s*\n/);
  });
});
