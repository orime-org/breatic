// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing a body into a shared document, and reading one back.
 *
 * At the Yjs layer, because these cases open the document the way a client
 * that did not run this test would find it. A block here is a container
 * carrying an id plus the block's own node, all of it inside one top-level
 * group — `@breatic/shared`'s `document-body` carries the shape and why the
 * backend seeds one block rather than none.
 *
 * Node names are camelCase because that is what the editor registers them as.
 * `Y.XmlElement.toString()` lowercases them when printing, so a shape copied
 * out of a probe's output arrives as a name the schema does not know, and the
 * first client to connect deletes what it cannot recognise.
 */

import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

/** The attributes every block node in this schema declares a default for. */
const BLOCK_ATTRS = {
  backgroundColor: 'default',
  textColor: 'default',
  textAlignment: 'left',
} as const;

/**
 * Build one block, ready to go inside the body's group.
 * @param type - The block node's name, e.g. `paragraph`.
 * @param text - The text it holds.
 * @returns The container element.
 */
function buildBlock(type: string, text: string): Y.XmlElement {
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', `seed-${type}-${text || 'empty'}`);
  const content = new Y.XmlElement(type);
  Object.entries(BLOCK_ATTRS).forEach(([name, value]) => {
    content.setAttribute(name, value);
  });
  if (text) {
    content.insert(0, [new Y.XmlText(text)]);
  }
  container.insert(0, [content]);
  return container;
}

/**
 * Write a body of paragraphs into a document, replacing whatever it held.
 * @param doc - The document Space's Y.Doc.
 * @param texts - One paragraph per entry.
 */
export function seedParagraphs(doc: Y.Doc, texts: string[]): void {
  const fragment = documentBodyFragment(doc);
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    const group = new Y.XmlElement('blockGroup');
    group.insert(
      0,
      texts.map((text) => buildBlock('paragraph', text)),
    );
    fragment.insert(0, [group]);
  });
}

/**
 * How many blocks the body holds.
 * @param doc - The document Space's Y.Doc.
 * @returns The count, zero when the body has no group at all.
 */
export function blockCount(doc: Y.Doc): number {
  const group = documentBodyFragment(doc).get(0);
  return group instanceof Y.XmlElement ? group.length : 0;
}

/**
 * The body's text, one entry per block.
 * @param doc - The document Space's Y.Doc.
 * @returns Each block's text in document order.
 */
export function blockTexts(doc: Y.Doc): string[] {
  const group = documentBodyFragment(doc).get(0);
  if (!(group instanceof Y.XmlElement)) {
    return [];
  }
  return group
    .toArray()
    .map((container) =>
      container.toString().replace(/<[^>]*>/g, ''),
    );
}
