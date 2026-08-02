// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Undo must never take away what someone else wrote.
 *
 * This is the invariant that makes undo safe to ship in a shared document, and
 * it is not the same as "undo only tracks my transactions". Tracking origins
 * decides WHICH edits go on my stack; it says nothing about what gets destroyed
 * when one of them is rolled back. Two people writing into the same block share
 * a container, and undoing my insert of that container takes their text with
 * it — synced to everyone, and absent from their undo stack, so nobody can get
 * it back.
 *
 * yjs guards this with a delete filter: a container that still holds content is
 * refused to the undo, and only what I put in it comes out. The filter reads a
 * set of node names, and upstream's default holds exactly one — `paragraph` —
 * because it was written for an editor whose documents are only paragraphs.
 * Ours are not.
 *
 * Measured, with the set as the only difference. Alice writes "Plan" in a
 * block, Bob appends " v2-from-bob" to it, Alice presses undo:
 *
 *   paragraph   default set → `<paragraph> v2-from-bob</paragraph>`   Bob's text lives
 *   heading     default set → ``                                      everything gone
 *   blockquote  default set → ``                                      everything gone
 *   codeBlock   default set → ``                                      everything gone
 *
 * The block list below is derived from the SCHEMA rather than written out, so a
 * slice that registers a new block type gets this coverage without anyone
 * remembering to ask for it — which is the only way a guard like this survives
 * a year of new block types.
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { createDocumentUndoManager } from '@web/spaces/document/document-undo';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

/**
 * Every block-level node the document can hold.
 * @returns The block node names, excluding the document root itself.
 */
function blockNodeNames(): string[] {
  const schema = getSchema(
    buildDocumentExtensions({ fragment: new Y.Doc().getXmlFragment('probe') }),
  );
  return Object.values(schema.nodes)
    .filter((node) => node.isBlock && node.name !== 'doc')
    .map((node) => node.name)
    .sort();
}

/**
 * Play out two people writing into one block, then undo the first one's edit.
 * @param blockName - The block type both of them write into.
 * @returns What the shared body holds afterwards.
 */
function undoAfterAPeerAppends(blockName: string): string {
  const doc = new Y.Doc();
  const body = documentBodyFragment(doc);
  const manager = createDocumentUndoManager(doc);

  // Alice, on the origin the sync plugin stamps local edits with.
  doc.transact(() => {
    const block = new Y.XmlElement(blockName);
    block.insert(0, [new Y.XmlText('Plan')]);
    body.push([block]);
  }, ySyncPluginKey);

  // Bob, arriving over the wire — a different origin, so it is not on Alice's
  // stack and undoing it is not something she can do.
  doc.transact(() => {
    const block = body.get(0) as Y.XmlElement;
    (block.get(0) as Y.XmlText).insert(4, ' v2-from-bob');
  }, 'remote-peer');

  manager.undo();
  const after = body.toString();
  manager.destroy();
  doc.destroy();
  return after;
}

describe('undo in a shared document', () => {
  const blocks = blockNodeNames();

  it('has block types to protect at all', () => {
    // Guards the guard: if the schema ever resolves to nothing, every case
    // below would vacuously pass.
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks).toContain('paragraph');
  });

  it.each(blocks)('does not take a collaborator\'s text out of a %s', (block) => {
    const after = undoAfterAPeerAppends(block);
    expect(after).toContain('v2-from-bob');
  });

  it.each(blocks)('still undoes the local edit in a %s', (block) => {
    // The other half: protecting the container must not stop undo from doing
    // its job on what this client actually wrote.
    const after = undoAfterAPeerAppends(block);
    expect(after).not.toContain('Plan');
  });
});
