// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Plain text to shared body and back (#1774, design section 9.2).
 *
 * A text node's body is a `Y.XmlFragment` shared through Yjs, but three of the
 * write paths hand us a plain string: extracting a dropped file, pasting text,
 * and copying a node. Those conversions have to be exact in both directions,
 * because the third design review found two ways to get them wrong that only
 * show up on real content:
 *
 * - Reading a multi-paragraph body through a node's `textContent` drops every
 *   line break, because the blocks carry no newline character between them.
 * - Writing a blank line as a paragraph holding an empty text node throws:
 *   ProseMirror's schema does not allow empty text nodes, and the fragment we
 *   build has to satisfy the same schema the editor binds to.
 *
 * The body invariant from the document editor also applies here: a body always
 * holds at least one block, so even the empty string produces one paragraph.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { bodyToPlainText, writePlainTextIntoBody } from '@web/data/yjs/text-body';

/**
 * Build a detached fragment holding `text`, the way every plain-text write
 * path will.
 * @param text - The plain text to write.
 * @returns A fragment whose content came from `text`.
 */
function bodyFrom(text: string): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('body');
  writePlainTextIntoBody(fragment, text);
  return fragment;
}

/**
 * Write `text` into a body and read it straight back out.
 * @param text - The plain text to round-trip.
 * @returns What reading the body returns.
 */
function roundTrip(text: string): string {
  return bodyToPlainText(bodyFrom(text));
}

describe('text body conversion (#1774 section 9.2)', () => {
  describe('round trip', () => {
    const cases: ReadonlyArray<readonly [name: string, text: string]> = [
      ['a single line', 'hello'],
      ['two lines', 'first line\nsecond line'],
      ['many lines', 'a\nb\nc\nd\ne'],
      ['a blank line in the middle', 'before\n\nafter'],
      ['consecutive blank lines', 'before\n\n\n\nafter'],
      ['a leading blank line', '\nafter'],
      ['a trailing blank line', 'before\n'],
      ['only whitespace', '   '],
      ['a line of only whitespace between two lines', 'a\n   \nb'],
      ['characters that are special in XML', 'a < b && c > d "quoted" \'single\''],
      ['a long line', 'x'.repeat(5000)],
      ['many lines of content', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')],
    ];

    it.each(cases)('survives %s', (_name, text) => {
      expect(roundTrip(text)).toBe(text);
    });
  });

  describe('the body invariant: always at least one block', () => {
    it('gives the empty string one paragraph, not an empty fragment', () => {
      const body = bodyFrom('');
      expect(body.length).toBe(1);
      expect(bodyToPlainText(body)).toBe('');
    });

    it('gives every line its own block', () => {
      expect(bodyFrom('a\nb\nc').length).toBe(3);
    });

    it('gives a blank line a block with no children rather than an empty text node', () => {
      const blank = bodyFrom('a\n\nb').get(1) as Y.XmlElement;
      expect(blank.nodeName).toBe('paragraph');
      expect(blank.length).toBe(0);
    });
  });

  describe('writing over existing content', () => {
    it('replaces rather than appends, so two drops never splice together', () => {
      const doc = new Y.Doc();
      const body = doc.getXmlFragment('body');
      writePlainTextIntoBody(body, 'from the first file');
      writePlainTextIntoBody(body, 'from the second file');
      expect(bodyToPlainText(body)).toBe('from the second file');
    });

    it('keeps the invariant when overwritten with the empty string', () => {
      const doc = new Y.Doc();
      const body = doc.getXmlFragment('body');
      writePlainTextIntoBody(body, 'something');
      writePlainTextIntoBody(body, '');
      expect(body.length).toBe(1);
      expect(bodyToPlainText(body)).toBe('');
    });
  });

  describe('reading a body the editor produced', () => {
    it('joins blocks with a newline, which is what a node textContent read would drop', () => {
      const doc = new Y.Doc();
      const body = doc.getXmlFragment('body');
      const first = new Y.XmlElement('paragraph');
      first.insert(0, [new Y.XmlText('first')]);
      const second = new Y.XmlElement('paragraph');
      second.insert(0, [new Y.XmlText('second')]);
      body.insert(0, [first, second]);

      expect(bodyToPlainText(body)).toBe('first\nsecond');
      expect(bodyToPlainText(body)).not.toBe('firstsecond');
    });

    it('reads a paragraph split across several text nodes as one line', () => {
      const doc = new Y.Doc();
      const body = doc.getXmlFragment('body');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('typed '), new Y.XmlText('in two goes')]);
      body.insert(0, [paragraph]);

      expect(bodyToPlainText(body)).toBe('typed in two goes');
    });

    it('reads an empty fragment as the empty string instead of throwing', () => {
      expect(bodyToPlainText(new Y.Doc().getXmlFragment('body'))).toBe('');
    });
  });

  describe('what two clients see', () => {
    it('merges rather than picks a winner, which is why the mutual exclusion lives a layer up', () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

      writePlainTextIntoBody(docA.getXmlFragment('body'), 'the whole of file A');
      writePlainTextIntoBody(docB.getXmlFragment('body'), 'the whole of file B');

      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

      const settled = bodyToPlainText(docA.getXmlFragment('body'));
      expect(bodyToPlainText(docB.getXmlFragment('body'))).toBe(settled);

      // Both sides agree, and what they agree on is the two files spliced
      // together. A sequence CRDT cannot do "one of these two, whole": each
      // side clears what IT can see (nothing, since neither update has landed)
      // and inserts, so both insertions survive. Picking a winner is what the
      // handling lease is for — it is a single map key, so its own last-write
      // -wins does converge on one value, and `completeNodeHandling` turns that
      // into a rejection for whoever lost. This test pins the boundary: the
      // exclusion is NOT here, so nobody later mistakes this merge for a bug in
      // this module and "fixes" it with something that cannot work.
      expect(settled).toContain('the whole of file A');
      expect(settled).toContain('the whole of file B');
    });
  });
});
