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
 * refused to the undo, and only what I put in it comes out. Two things about
 * that have to be ours. The filter reads a set of node names, and upstream's
 * default holds exactly one — `paragraph` — because it was written for an
 * editor whose documents are only paragraphs; ours are not. And upstream's
 * filter never sees the container's ATTRIBUTES, so a heading that survived
 * came back without its level and rendered as an h1.
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
import { Editor, getSchema } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { createDocumentUndoManager } from '@web/spaces/document/document-undo';
import { documentBodyFragment } from '@breatic/shared';

/**
 * Every block-level node the document can hold.
 * @returns The block node names, excluding the document root itself.
 */
function blockNodeNames(): string[] {
  const schema = getSchema(
    buildDocumentExtensions({ fragment: new Y.Doc().getXmlFragment('probe') }),
  );
  return Object.values(schema.nodes)
    // `title` is a block by ProseMirror's reckoning but never a BODY block —
    // it exists once, at the front, and cannot be created anywhere these
    // cases would put one. Its own protections live in `document-title`.
    .filter((node) => node.isBlock && node.name !== 'doc' && node.name !== 'title')
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

/**
 * The same scenario through a REAL editor, so the document has the shape
 * ProseMirror actually produces — nesting and attributes included.
 *
 * The coverage above is deliberately built by hand at the Yjs layer, because
 * that is the only way to reach EVERY block name in one loop: a list holds list
 * items rather than text, and a horizontal rule holds nothing at all. What it
 * cannot show is anything about attributes, since a hand-built element has
 * none — which is exactly where the container-survives-but-comes-back-changed
 * defect lives.
 * @param html - What the first client writes.
 * @param peerText - What the second client appends into that same block.
 * @returns The shared body's markup after the first client undoes.
 */
async function undoThroughRealEditor(
  html: string,
  peerText: string,
): Promise<string> {
  const doc = new Y.Doc();
  const body = documentBodyFragment(doc);
  const undoManager = createDocumentUndoManager(doc);
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: body, undoManager }),
  });
  try {
    // The document opens with a title, so the block under test is the SECOND
    // child. Set both in one go: handing `setContent` a bare block would let
    // the schema fold it into the title slot instead.
    editor.commands.setContent(
      `<h1 class="doc-title">Storyboard v3</h1>${html}`,
    );
    await new Promise((r) => setTimeout(r, 40));
    // Close the undo unit, so the peer's edit and the local one cannot be
    // merged into a single entry by the capture timeout.
    undoManager.stopCapturing();

    doc.transact(() => {
      const block = body.get(1) as Y.XmlElement;
      const text = block.get(0) as Y.XmlText;
      text.insert(text.length, peerText);
    }, 'remote-peer');
    await new Promise((r) => setTimeout(r, 40));

    editor.commands.undo();
    await new Promise((r) => setTimeout(r, 40));
    return body.toString();
  } finally {
    editor.destroy();
    undoManager.destroy();
    doc.destroy();
  }
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

  describe('the block that survives comes back unchanged', () => {
    // Saving the container is not enough if it comes back stripped of what
    // made it that block. A heading without its level renders as an h1, a code
    // block without its language loses syntax highlighting, an ordered list
    // without its start renumbers from 1 — each is a silent change to
    // everyone's document, and the collaborator whose text triggered it cannot
    // undo it because it is not on their stack.
    it.each([
      ['a heading keeps its level', '<h3>Plan</h3>', 'level="3"'],
      [
        'a code block keeps its language',
        '<pre><code class="language-python">Plan</code></pre>',
        'language="python"',
      ],
    ])('%s', async (_what, html, attribute) => {
      const after = await undoThroughRealEditor(html, ' v2-from-bob');
      expect(after).toContain('v2-from-bob');
      expect(after).toContain(attribute);
    });

    it('and undoing an attribute change still restores the old value', async () => {
      // The other direction: when the local edit WAS the attribute change,
      // undo has to put the old value back. The filter does get asked about
      // that item and does refuse it — measured — so the old value comes back
      // through some other part of yjs's redo path. What that part is, I have
      // not traced; this test is here so the behaviour is pinned regardless.
      const doc = new Y.Doc();
      const body = documentBodyFragment(doc);
      const undoManager = createDocumentUndoManager(doc);
      const editor = new Editor({
        extensions: buildDocumentExtensions({ fragment: body, undoManager }),
      });
      try {
        editor.commands.setContent(
          '<h1 class="doc-title">Storyboard v3</h1><h1>Plan</h1>',
        );
        await new Promise((r) => setTimeout(r, 40));
        undoManager.stopCapturing();

        editor.commands.setTextSelection(
          editor.state.doc.child(0).nodeSize + 1,
        );
        editor.chain().focus().setNode('heading', { level: 3 }).run();
        await new Promise((r) => setTimeout(r, 40));
        expect(body.toString()).toContain('level="3"');
        undoManager.stopCapturing();

        doc.transact(() => {
          const block = body.get(1) as Y.XmlElement;
          const text = block.get(0) as Y.XmlText;
          text.insert(text.length, ' BOB');
        }, 'remote-peer');
        await new Promise((r) => setTimeout(r, 40));

        editor.commands.undo();
        await new Promise((r) => setTimeout(r, 40));

        expect(body.toString()).toContain('level="1"');
        expect(body.toString()).toContain('BOB');
      } finally {
        editor.destroy();
        undoManager.destroy();
        doc.destroy();
      }
    });
  });
});
