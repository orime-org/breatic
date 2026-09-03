// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A10: undo never takes away what someone else wrote, and never
 * takes away what made a block that block.
 *
 * Tracking origins decides WHICH edits go on my stack; it says nothing about
 * what is destroyed when one of them is rolled back. Two people writing into
 * the same block share a container, and undoing my insert of that container
 * takes their text with it — synced to everyone, and absent from their undo
 * stack, so nobody can get it back.
 *
 * yjs guards that with a delete filter, and two things about it have to be
 * ours. The filter reads a set of node names and y-prosemirror's default holds
 * one — `paragraph` (`undo-plugin.js:45`). And the filter never sees the
 * container's ATTRIBUTES: an attribute is a map entry, so it fails the test for
 * a `ContentType` and stays deletable, which is how a heading came back without
 * its level and rendered as an h1.
 *
 * The blast radius grew with this migration. Three of the four props a block
 * can carry are new — `quoted`, `numbered`, `number` — and all three are
 * container attributes, so all three ride on this filter.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  createDocumentUndoManager,
  documentUndoExtension,
} from '@web/spaces/document/document-undo-blocknote';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Every block-level node this document can hold.
 * @returns The block node names, excluding the document root itself.
 */
function blockNodeNames(): string[] {
  const { pmSchema } = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  return Object.values(pmSchema.nodes)
    .filter((node) => node.isBlock && node.name !== 'doc')
    .map((node) => node.name)
    .sort();
}

/**
 * Plays out two people writing into one block, then undoes the first's edit.
 *
 * Built at the Yjs layer rather than through the editor, because that is the
 * only way to reach every block name in one loop: a list item holds text but a
 * group holds items, and the fallback block holds nothing at all.
 * @param blockName - The element both of them write into.
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
 * The first text node anywhere under a node, in document order.
 *
 * Found by walking rather than by index, because how deep the text sits
 * depends on the block: BlockNote nests a content node inside a container, and
 * a list item nests further still.
 * @param node - Where to start looking.
 * @returns That text node, or null when the subtree holds none.
 */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < node.length; i += 1) {
    const child: unknown = node.get(i);
    if (child instanceof Y.XmlText) {
      return child;
    }
    if (child instanceof Y.XmlElement) {
      const found = firstText(child);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The same scenario through a real editor, so the document has the shape
 * BlockNote produces — containers, content nodes and props included.
 * @param block - The block the first client writes.
 * @param peerText - What the second client appends into it.
 * @returns The shared body's markup after the first client undoes.
 */
async function undoThroughRealEditor(
  block: Readonly<Record<string, unknown>>,
  peerText: string,
): Promise<string> {
  const doc = new Y.Doc();
  const body = documentBodyFragment(doc);
  const manager = createDocumentUndoManager(doc);
  const editor = buildDocumentEditor({
    fragment: body,
    extensions: [documentUndoExtension(manager)],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);

  editor.replaceBlocks(editor.document, [block] as never);
  await new Promise((r) => setTimeout(r, 40));

  // Close the undo unit, so the peer's edit and the local one cannot be merged
  // into a single entry by the capture timeout.
  manager.stopCapturing();

  const text = firstText(body);
  if (text === null) {
    throw new Error('no text node in the body');
  }
  doc.transact(() => {
    text.insert(text.length, peerText);
  }, 'remote-peer');
  await new Promise((r) => setTimeout(r, 40));

  editor.undo();
  await new Promise((r) => setTimeout(r, 40));
  return body.toString();
}

describe('the set of protected names', () => {
  const blocks = blockNodeNames();

  it('has block types to protect at all', () => {
    // Guards the guard: a schema resolving to nothing would make every case
    // below pass vacuously.
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks).toContain('paragraph');
    expect(blocks).toContain('blockContainer');
  });

  it.each(blocks)('keeps a collaborator’s text inside a %s', (block) => {
    expect(undoAfterAPeerAppends(block)).toContain('v2-from-bob');
  });

  it.each(blocks)('still undoes the local edit inside a %s', (block) => {
    // The other half: protecting the container must not stop undo from doing
    // its job on what this client wrote.
    expect(undoAfterAPeerAppends(block)).not.toContain('Plan');
  });
});

describe('A10 — the block that survives comes back unchanged', () => {
  it('keeps the level of a heading', async () => {
    const after = await undoThroughRealEditor(
      { type: 'heading', props: { level: 3 }, content: 'Plan' },
      ' v2-from-bob',
    );
    expect(after).toContain('v2-from-bob');
    expect(after).toContain('level="3"');
  });

  it('keeps the three props this migration added', async () => {
    const after = await undoThroughRealEditor(
      {
        type: 'heading',
        props: { level: 2, quoted: true, numbered: true, number: 7 },
        content: 'Plan',
      },
      ' v2-from-bob',
    );
    expect(after).toContain('v2-from-bob');
    expect(after).toContain('quoted="true"');
    expect(after).toContain('numbered="true"');
    expect(after).toContain('number="7"');
  });
});
