// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
    expect(mentionedSourceIds(shot, [])).toEqual(['i1', 'i2']);
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

describe('a shot holding an optional mention (inner#1811, CAP-9)', () => {
  /**
   * A chip of an optional input.
   * @param id - The source node id.
   * @returns The element.
   */
  const optional = (id: string): Y.XmlElement => {
    const element = chip(id, 'image');
    element.setAttribute('optional', true as unknown as string);
    return element;
  };
  /**
   * The pool with the person as given.
   * @param personPicture - The person's picture, or none.
   * @returns The rows.
   */
  const rows = (personPicture?: string): ReferenceRailItem[] => [
    { refId: 'e0', sourceNodeId: 'i1', sourceNodeType: 'image', sourceNodeName: 'Product', mediaUrl: 'https://r2.example/product.png' },
    { refId: 'e1', sourceNodeId: 'p1', sourceNodeType: 'image', sourceNodeName: 'Person', ...(personPicture === undefined ? {} : { mediaUrl: personPicture }) },
  ];
  const shot = (): Y.XmlFragment =>
    fragmentOf(['Show ', chip('i1', 'image')], ['Held by ', optional('p1'), ' and ', chip('i1', 'image')], ['slowly']);

  it('leaves out the paragraph of an optional mention whose source holds no picture', () => {
    expect(serializePromptFragment(shot(), rows(), { i1: 'Element 1', p1: 'Element 2' })).toBe('Show Element 1\n\nslowly');
  });

  it('sends it once the source holds a picture', () => {
    expect(serializePromptFragment(shot(), rows('https://r2.example/p.png'), { i1: 'Element 1', p1: 'Element 2' })).toBe(
      'Show Element 1\n\nHeld by Element 2 and Element 1\n\nslowly',
    );
  });

  it('mentions only what the paragraphs it sends hold', () => {
    expect(mentionedSourceIds(shot(), rows())).toEqual(['i1']);
    expect(mentionedSourceIds(fragmentOf(['Held by ', optional('p1'), ' with ', chip('t1', 'text')]), rows())).toEqual([]);
    expect(mentionedSourceIds(shot(), rows('https://r2.example/p.png'))).toEqual(['i1', 'p1']);
  });
});
