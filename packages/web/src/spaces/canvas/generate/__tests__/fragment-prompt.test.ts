// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A shot's words read straight off its fragment at submit (#2218, design
 * §5.4): the same text the editor serializes, and the sources it mentions.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  mentionedSourceIds,
  serializePromptFragment,
} from '@web/spaces/canvas/generate/fragment-prompt';

/**
 * A mention chip as the editor writes one.
 * @param id - The source node id.
 * @param kind - The source kind.
 * @returns The element.
 */
function chip(id: string, kind: string): Y.XmlElement {
  const element = new Y.XmlElement('referenceMention');
  element.setAttribute('sourceNodeId', id);
  element.setAttribute('kind', kind);
  element.setAttribute('label', id);
  return element;
}

/**
 * A fragment of paragraphs, attached to a document so it can be read.
 * @param blocks - Each paragraph's children.
 * @returns The fragment.
 */
function fragmentOf(...blocks: Array<Array<string | Y.XmlElement>>): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('shot');
  fragment.insert(
    0,
    blocks.map((children) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, children.map((c) => (typeof c === 'string' ? new Y.XmlText(c) : c)));
      return paragraph;
    }),
  );
  return fragment;
}

const pool = [
  { sourceNodeId: 't1', sourceNodeType: 'text', textContent: 'a red boat' },
  { sourceNodeId: 'i1', sourceNodeType: 'image' },
] as unknown as ReferenceRailItem[];

describe('a shot read off its fragment', () => {
  it('says what it mentions, each once, in order', () => {
    const shot = fragmentOf(['Use ', chip('i1', 'image'), ' then ', chip('i2', 'image')], [chip('i1', 'image')]);
    expect(mentionedSourceIds(shot)).toEqual(['i1', 'i2']);
  });

  it('writes a media chip as its token and a text chip as its source words', () => {
    const shot = fragmentOf(['Show ', chip('i1', 'image'), ' with ', chip('t1', 'text')], ['slowly']);
    expect(serializePromptFragment(shot, pool, { i1: 'Element 1' })).toBe(
      'Show Element 1 with a red boat\n\nslowly',
    );
  });

  it('writes a chip with no token as nothing', () => {
    expect(serializePromptFragment(fragmentOf(['See ', chip('v9', 'video')]), pool, {})).toBe('See ');
  });
});
