// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A document proposal landing (inner#1509): checked against the document as
 * it is when the reader presses, written (a rewrite or an insert as one undo
 * step, a comment off the undo stack), and recognised as
 * landed from the marks it left -- a thread carrying its id, or a block whose
 * id was derived from it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodeInitialSpaceContent } from '@breatic/shared';
import { Awareness } from 'y-protocols/awareness';
import { deriveId, type DocumentProposal } from '@breatic/shared';

import { assetsApi } from '@web/data/api/assets';
import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { commentsOn } from '@web/spaces/document/document-comment-extension';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { landedAt, landProposal } from '@web/spaces/document/document-proposal-landing';

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

/**
 * A mounted document holding some Markdown, with comments and undo wired the
 * way a document Space gets them.
 * @param markdown - What it holds.
 * @returns The handle.
 */
async function open(markdown: string): Promise<DocumentEditorHandle> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'reader-1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  const { editor } = handle;
  editor.replaceBlocks(editor.document, await editor.tryParseMarkdownToBlocks(markdown));
  handle.undoManager.clear();
  return handle;
}

/**
 * The top-level blocks: id and plain text.
 * @param handle - The document.
 * @returns The blocks.
 */
function blocks(handle: DocumentEditorHandle): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  handle.editor.prosemirrorState.doc.firstChild?.forEach((node) => {
    out.push({ id: String(node.attrs.id), text: blockPlainText(node) });
  });
  return out;
}

/**
 * Every comment mark in the body, with the words it covers.
 * @param handle - The document.
 * @returns The marked words, by thread.
 */
function marked(handle: DocumentEditorHandle): Array<{ threadId: string; text: string }> {
  const found: Array<{ threadId: string; text: string }> = [];
  handle.editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') found.push({ threadId: String(mark.attrs.threadId), text: node.text ?? '' });
    }
    return true;
  });
  return found;
}

/**
 * Joins a top-level block onto the end of the one above it, the way Backspace
 * at its start does: the boundary between the two goes, and the block below
 * with its id goes with it.
 * @param handle - The document.
 * @param index - The block to join upward.
 */
function mergeIntoAbove(handle: DocumentEditorHandle, index: number): void {
  const view = handle.editor.prosemirrorView;
  const group = view.state.doc.firstChild!;
  let pos = 1;
  const starts: number[] = [];
  group.forEach((node) => {
    starts.push(pos);
    pos += node.nodeSize;
  });
  const above = group.child(index - 1);
  const contentEnd = starts[index - 1] + 1 + above.firstChild!.nodeSize - 1;
  view.dispatch(view.state.tr.delete(contentEnd, starts[index] + 2));
}

/**
 * The threads in the document's comment store.
 * @param handle - The document.
 * @returns The threads.
 */
function threads(handle: DocumentEditorHandle): Array<{ id: string; metadata: unknown; comments: Array<{ userId: string; metadata: unknown; body: unknown }> }> {
  return [...(commentsOn(handle.editor)?.threadStore.getThreads().values() ?? [])] as never;
}

/**
 * A proposal on one of the document's blocks.
 * @param handle - The document.
 * @param index - Which top-level block.
 * @param fields - What else it says.
 * @returns The proposal.
 */
function proposalOn(handle: DocumentEditorHandle, index: number | null, fields: Partial<DocumentProposal>): DocumentProposal {
  const target = index === null ? undefined : blocks(handle)[index];
  return {
    proposalId: '33333333-3333-4333-8333-333333333333',
    spaceId: '44444444-4444-4444-8444-444444444444',
    spaceName: 'Storyboard',
    kind: 'insert',
    blockId: target?.id ?? null,
    body: 'x',
    title: 't',
    heading: '',
    original: target?.text ?? '',
    blockType: target === undefined ? null : 'paragraph',
    lossy: false,
    ...fields,
  };
}

describe('a comment', () => {
  it('hangs on the quoted words, written by the reader and marked as from the Agent', async () => {
    const handle = await open('The hero arrives at the gate.');
    const proposal = proposalOn(handle, 0, { kind: 'comment', quote: 'the gate', body: 'Which gate?' });

    const result = await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    const [thread] = threads(handle);
    expect(result).toEqual({ outcome: 'applied', how: 'comment', blockId: blocks(handle)[0].id, threadId: thread.id });
    expect(thread?.metadata).toEqual({ proposalId: proposal.proposalId });
    expect(thread?.comments[0]).toMatchObject({ userId: 'reader-1', metadata: { fromAgent: true } });
    expect(marked(handle)).toEqual([{ threadId: thread.id, text: 'the gate' }]);
  });

  it('hangs on words that run across table cells, one stretch per cell', async () => {
    const handle = await open('| Shot | Action |\n| --- | --- |\n| Close | She turns |');
    const proposal = proposalOn(handle, 0, { kind: 'comment', quote: 'Close\nShe turns', body: 'Why close?' });

    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    expect(marked(handle).map((m) => m.text)).toEqual(['Close', 'She turns']);
  });

  it('from a rewrite card carries the rewritten words with no Markdown in them', async () => {
    const handle = await open('Morning light falls on the table.');
    const proposal = proposalOn(handle, 0, { kind: 'rewrite', body: 'Morning **light**.\n\n## Then' });

    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    const body = JSON.stringify(threads(handle)[0]?.comments[0]?.body);
    expect(body).toContain('"Morning light."');
    expect(body).toContain('"Then"');
    expect(body).not.toMatch(/\*\*|##/);
    expect(marked(handle).map((m) => m.text)).toEqual(['Morning light falls on the table.']);
  });
});

describe('a rewrite put on as a comment (review round 4)', () => {
  it('carries only the parts of the rewrite that hold words', async () => {
    const handle = await open('Morning light falls on the table.');

    await landProposal(handle, proposalOn(handle, 0, { kind: 'rewrite', body: 'Light on the table.\n\n---' }), 'comment', () => ({ available: true, writeAccess: 'granted' }));

    const body = threads(handle)[0]?.comments[0]?.body as Array<{ content: Array<{ text: string }> }>;
    expect(body.map((p) => p.content.map((c) => c.text).join(''))).toEqual(['Light on the table.']);
  });
});

describe('a rewrite', () => {
  it('replaces the block with the body, and one undo puts it back', async () => {
    const handle = await open('Before.\n\nMorning light falls on the table.\n\nAfter.');
    const proposal = proposalOn(handle, 1, { kind: 'rewrite', body: 'Light on the table.\n\nThe coffee is cold.' });

    await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));
    expect(blocks(handle).map((b) => b.text)).toEqual(['Before.', 'Light on the table.', 'The coffee is cold.', 'After.']);

    handle.undoManager.undo();
    expect(blocks(handle).map((b) => b.text)).toEqual(['Before.', 'Morning light falls on the table.', 'After.']);
  });
});

describe('one undo step', () => {
  it('takes back the landing and leaves what the reader typed just before it', async () => {
    const handle = await open('Typed here.\n\nTarget.');
    const proposal = proposalOn(handle, 1, { kind: 'rewrite', body: 'Rewritten.' });
    const view = handle.editor.prosemirrorView;
    view.dispatch(view.state.tr.insertText(' More', 3 + 'Typed here.'.length));

    await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));
    handle.undoManager.undo();

    expect(blocks(handle).map((b) => b.text)).toEqual(['Typed here. More', 'Target.']);
  });
});

describe('an insert', () => {
  it('goes after its block, keeping a table a table, and one undo takes it out', async () => {
    const handle = await open('Scene 3.\n\nAfter.');
    const proposal = proposalOn(handle, 0, { body: '| Shot | Size |\n|---|---|\n| 1 | Wide |' });

    await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));
    expect(blocks(handle).map((b) => b.text)).toEqual(['Scene 3.', 'Shot\nSize\n1\nWide', 'After.']);
    expect((handle.editor.document[1] as { type?: string } | undefined)?.type).toBe('docTable');

    handle.undoManager.undo();
    expect(blocks(handle).map((b) => b.text)).toEqual(['Scene 3.', 'After.']);
  });

  it('goes at the end when it names no block', async () => {
    const handle = await open('One.\n\nTwo.');

    await landProposal(handle, proposalOn(handle, null, { body: '## Scene 4' }), 'write', () => ({ available: true, writeAccess: 'granted' }));

    expect(blocks(handle).map((b) => b.text)).toEqual(['One.', 'Two.', 'Scene 4']);
  });
});

describe('what is checked before anything is written', () => {
  it('writes nothing on a connection that is read only', async () => {
    const handle = await open('One.');

    expect(await landProposal(handle, proposalOn(handle, 0, { kind: 'rewrite', body: 'Two.' }), 'write', () => ({ available: true, writeAccess: 'denied' }))).toEqual({ outcome: 'readOnly' });
    expect(blocks(handle).map((b) => b.text)).toEqual(['One.']);
  });

  it('says the block is gone when it was deleted', async () => {
    const handle = await open('One.\n\nTwo.');
    const proposal = proposalOn(handle, 1, { kind: 'rewrite', body: 'Three.' });
    handle.editor.removeBlocks([proposal.blockId!]);

    expect(await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }))).toEqual({ outcome: 'blockGone' });
  });

  it('says the block changed when its words are not the ones proposed on', async () => {
    const handle = await open('One.');
    const proposal = proposalOn(handle, 0, { kind: 'rewrite', body: 'Two.', original: 'Something else.' });

    expect(await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }))).toEqual({ outcome: 'changed' });
    expect(blocks(handle).map((b) => b.text)).toEqual(['One.']);
  });

  it('creates no comment on a block with no words, and says nothing landed (review round 2)', async () => {
    const handle = await open('Before.\n\n```\n```');
    const proposal = proposalOn(handle, 1, { kind: 'rewrite', body: 'Something.' });
    expect(proposal.original).toBe('');

    expect(await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }))).toEqual({ outcome: 'changed' });
    expect(threads(handle)).toHaveLength(0);
  });

  it('says the block changed when the quoted words no longer appear once', async () => {
    const handle = await open('She turns.');
    const proposal = { ...proposalOn(handle, 0, { kind: 'comment', quote: 'turns', body: 'Why?' }), original: 'She turns.' };
    handle.editor.insertInlineContent(' She turns again.');
    const now = blocks(handle)[0].text;

    expect(await landProposal(handle, { ...proposal, original: now }, 'comment', () => ({ available: true, writeAccess: 'granted' }))).toEqual({ outcome: 'changed' });
    expect(threads(handle)).toHaveLength(0);
  });
});

describe('knowing a proposal has landed', () => {
  it('lands once: pressed again, it is already there and nothing more is written', async () => {
    const handle = await open('One.\n\nTwo.');
    const insert = proposalOn(handle, 0, { body: 'New.' });
    await landProposal(handle, insert, 'write', () => ({ available: true, writeAccess: 'granted' }));

    expect(await landProposal(handle, insert, 'write', () => ({ available: true, writeAccess: 'granted' }))).toEqual({
      outcome: 'applied',
      how: 'write',
      blockId: deriveId(`document-proposal:${insert.proposalId}:0`),
    });
    expect(blocks(handle).map((b) => b.text)).toEqual(['One.', 'New.', 'Two.']);
  });

  it('is not fooled by a rewrite that only changes how the words look', async () => {
    const handle = await open('Scene 1');
    const proposal = proposalOn(handle, 0, { kind: 'rewrite', body: '## Scene 1' });

    expect(landedAt(handle, proposal)).toBeNull();
    await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));
    expect(landedAt(handle, proposal)).toEqual({ how: 'write', blockId: deriveId(`document-proposal:${proposal.proposalId}:0`) });
    expect((handle.editor.document[0] as { type?: string } | undefined)?.type).toBe('heading');
  });

  it('knows a rewrite into several blocks landed', async () => {
    const handle = await open('One long paragraph.');
    const proposal = proposalOn(handle, 0, { kind: 'rewrite', body: 'One.\n\nLong paragraph.' });

    await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));

    expect(landedAt(handle, proposal)).toEqual({ how: 'write', blockId: deriveId(`document-proposal:${proposal.proposalId}:0`) });
  });

  it('knows a rewrite card whose words went on as a comment', async () => {
    const handle = await open('One.');
    const proposal = proposalOn(handle, 0, { kind: 'rewrite', body: 'Two.' });

    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    expect(landedAt(handle, proposal)).toEqual({ how: 'comment', blockId: proposal.blockId, threadId: threads(handle)[0].id });
  });

  it('names the thread a comment landed as, for the panel to open on it', async () => {
    const handle = await open('The hero arrives.');
    const proposal = proposalOn(handle, 0, { kind: 'comment', quote: 'hero', body: 'Who?' });

    const result = await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    expect(result).toEqual({ outcome: 'applied', how: 'comment', blockId: proposal.blockId, threadId: threads(handle)[0].id });
  });

  it('does not count a comment whose words have gone', async () => {
    const handle = await open('The hero arrives.');
    const proposal = proposalOn(handle, 0, { kind: 'comment', quote: 'hero', body: 'Who?' });
    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));
    handle.editor.removeBlocks([blocks(handle)[0].id]);

    expect(threads(handle)).toHaveLength(1);
    expect(landedAt(handle, proposal)).toBeNull();
  });
});

describe('the block a landed proposal is shown at (inner#1509 review round 1)', () => {
  it('is the first block a rewrite wrote, when pressed again after it landed', async () => {
    const handle = await open('One.');
    const proposal = proposalOn(handle, 0, { kind: 'rewrite', body: 'Two.' });
    await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));

    const again = await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }));

    expect(again).toEqual({ outcome: 'applied', how: 'write', blockId: deriveId(`document-proposal:${proposal.proposalId}:0`) });
    expect(blocks(handle).map((b) => b.id)).toContain(again.outcome === 'applied' ? again.blockId : '');
  });

  it('is the commented block, when a comment is pressed again after it landed', async () => {
    const handle = await open('The hero arrives.');
    const proposal = proposalOn(handle, 0, { kind: 'comment', quote: 'hero', body: 'Who?' });
    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    expect(await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }))).toEqual({
      outcome: 'applied',
      how: 'comment',
      blockId: proposal.blockId,
      threadId: threads(handle)[0].id,
    });
  });

  it('is the block the comment is in now, after its own block was merged into the one above (review round 2)', async () => {
    const handle = await open('Scene two opens.\n\nThe hero arrives.');
    const [above] = blocks(handle);
    const proposal = proposalOn(handle, 1, { kind: 'comment', quote: 'hero', body: 'Who?' });
    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));

    mergeIntoAbove(handle, 1);

    expect(blocks(handle).map((b) => b.text)).toEqual(['Scene two opens.The hero arrives.']);
    const threadId = threads(handle)[0].id;
    expect(landedAt(handle, proposal)).toEqual({ how: 'comment', blockId: above.id, threadId });
    expect(await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }))).toEqual({ outcome: 'applied', how: 'comment', blockId: above.id, threadId });
  });
});

describe('a comment that lands', () => {
  it('stays off the undo stack, like a comment the reader writes', async () => {
    const handle = await open('Alpha bravo.');
    const before = handle.undoManager.undoStack.length;

    await landProposal(handle, proposalOn(handle, 0, { kind: 'comment', quote: 'Alpha', body: 'A?' }), 'comment', () => ({ available: true, writeAccess: 'granted' }));

    expect(handle.undoManager.undoStack.length).toBe(before);
    expect(marked(handle).map((m) => m.text)).toEqual(['Alpha']);
  });
});

describe('media in a proposal (review round 3)', () => {
  it('lands only the media at our addresses, writing the rest of the body', async () => {
    const handle = await open('One.');

    const proposal = proposalOn(handle, 0, { body: 'Two.\n\n![shot](https://elsewhere.example/a.png)' });

    expect(await landProposal(handle, proposal, 'write', () => ({ available: true, writeAccess: 'granted' }))).toEqual({
      outcome: 'applied',
      how: 'write',
      blockId: deriveId(`document-proposal:${proposal.proposalId}:0`),
      leftOut: 1,
    });
    expect(blocks(handle).map((b) => b.text)).toEqual(['One.', 'Two.']);
    expect((handle.editor.document as Array<{ type: string }>).some((b) => b.type === 'image')).toBe(false);
  });
});

describe('a proposal of nothing but outside media (inner#1509, design §5.7)', () => {
  it('writes nothing and says how many were left out', async () => {
    const handle = await open('One.');

    expect(await landProposal(handle, proposalOn(handle, 0, { body: '![x](https://elsewhere.example/a.png)' }), 'write', () => ({ available: true, writeAccess: 'granted' }))).toEqual({
      outcome: 'mediaOnly',
      leftOut: 1,
    });
    expect(blocks(handle).map((b) => b.text)).toEqual(['One.']);
  });
});

describe('our own media in a proposal (review round 4)', () => {
  it('lands once our address is known, even when it was not known yet at the press', async () => {
    const ours = 'https://cdn.example/';
    const spy = vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({ assetUrlPrefix: ours } as never);
    try {
      const handle = await open('One.');

      await landProposal(
        handle,
        proposalOn(handle, 0, { body: `![own](${ours}a.png)\n\n![x](https://elsewhere.example/b.png)` }),
        'write',
        () => ({ available: true, writeAccess: 'granted' }),
      );

      const images = (handle.editor.document as Array<{ type: string; props: { url?: string } }>).filter((b) => b.type === 'image');
      expect(images.map((b) => b.props.url)).toEqual([`${ours}a.png`]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('headings deeper than the body has (review round 4)', () => {
  it('land at the deepest level the body shows, keeping the levels above them', async () => {
    const handle = await open('One.');

    await landProposal(handle, proposalOn(handle, 0, { body: '# Act\n\n## Scene\n\n#### Shot 1\n\n###### Note' }), 'write', () => ({ available: true, writeAccess: 'granted' }));

    const headings = (handle.editor.document as Array<{ type: string; props: { level?: number } }>).filter((b) => b.type === 'heading');
    expect(headings.map((b) => b.props.level)).toEqual([1, 2, 3, 3]);
  });

  it('are held to the levels of the body inside nested blocks too', async () => {
    const handle = await open('One.');

    await landProposal(handle, proposalOn(handle, 0, { body: '- Item\n\n  #### Under it' }), 'write', () => ({ available: true, writeAccess: 'granted' }));

    const levels: number[] = [];
    handle.editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'heading') levels.push(Number(node.attrs.level));
    });
    expect(levels.every((level) => level <= 3)).toBe(true);
  });
});

describe('an insert at the end', () => {
  it('takes the place of an empty last paragraph, so no blank line is left above it', async () => {
    const handle = await open('');

    await landProposal(handle, proposalOn(handle, null, { body: '## Outline' }), 'write', () => ({ available: true, writeAccess: 'granted' }));

    expect(blocks(handle).map((b) => b.text)).toEqual(['Outline']);
  });

  it('goes after a last paragraph that holds words', async () => {
    const handle = await open('One.');

    await landProposal(handle, proposalOn(handle, null, { body: 'Two.' }), 'write', () => ({ available: true, writeAccess: 'granted' }));

    expect(blocks(handle).map((b) => b.text)).toEqual(['One.', 'Two.']);
  });
});
