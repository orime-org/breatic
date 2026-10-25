// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Commit-time proposal facts and actual output traces (inner#1619).
 * Expectations come from the approved landing design and inner#1509 A6,
 * sections 5.4 and 5.5. These tests call production landing, conversion,
 * table normalization, block writes and undo over real Yjs documents.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { deriveId, documentBodyFragment, type DocumentProposal } from '@breatic/shared';

import { assetsApi, type UploadConfig } from '@web/data/api/assets';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { landedAt, landProposal } from '@web/spaces/document/document-proposal-landing';
import * as documentMarkdown from '@web/spaces/document/document-markdown';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { blockInTableCell } from '@web/spaces/document/document-table-nodes';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Context = 'root' | 'cell' | 'header' | 'deep';
type Kind = 'insert' | 'rewrite';
type Client = {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly undoManager: Y.UndoManager;
};

const clients: Client[] = [];
const TABLE_BODY = '| AgentCol |\n| --- |\n| AGENT_CELL |';
const UPLOAD_CONFIG: UploadConfig = {
  assetUrlPrefix: 'https://assets.example.invalid/',
  maxUploadBytes: 1024,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 500,
  uploadIdleTimeoutMs: 60000,
  uploadStatusPollSeconds: 5,
};

/** Builds and mounts the real document editor and its production undo. */
function mount(doc: Y.Doc): Client {
  const { manager, extension } = createDocumentUndo(doc);
  let editor!: ReturnType<typeof buildDocumentEditor>;
  act(() => {
    editor = buildDocumentEditor({
      fragment: documentBodyFragment(doc),
      extensions: [extension],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
  });
  const client = { doc, editor, undoManager: manager };
  clients.push(client);
  return client;
}

/** Builds a target surrounded by existing styled content and a legal table. */
function open(context: Context): Client {
  const client = mount(new Y.Doc());
  const { editor, undoManager } = client;
  act(() => {
    const table = {
      ...tableBlock({
        headerRows: context === 'header' ? 1 : 0,
        rows: [{
          cells: [{
            blocks: [{
              id: 'cell-list',
              type: 'bulletListItem',
              content: 'LIST',
              children: [{ id: 'cell-anchor', type: 'paragraph', content: 'ANCHOR' }],
            }],
          }, 'OTHER'],
        }],
      }),
      id: 'host-table',
    };
    editor.replaceBlocks(editor.document, [
      {
        id: 'target',
        type: 'paragraph',
        content: [{ type: 'text', text: 'TARGET', styles: { bold: true } }],
      },
      table,
      {
        id: 'tail',
        type: 'heading',
        props: { level: 3 },
        content: [{ type: 'text', text: 'TAIL', styles: { italic: true } }],
      },
    ] as never);
    if (context !== 'root') {
      const anchor = rowById(editor.prosemirrorState.doc, context === 'deep' ? 'cell-anchor' : 'cell-list')!;
      moveRowTo(editor.prosemirrorView, 'target', context === 'deep' ? anchor.to : anchor.from);
    }
  });
  editor.prosemirrorState.doc.check();
  undoManager.clear();
  return client;
}

/** Creates a proposal whose original words name the unchanged target. */
function proposal(kind: Kind, body = TABLE_BODY): DocumentProposal {
  return {
    proposalId: '33333333-3333-4333-8333-333333333333',
    spaceId: '44444444-4444-4444-8444-444444444444',
    spaceName: 'Storyboard',
    kind,
    blockId: 'target',
    body,
    title: 'Suggestion',
    heading: '',
    original: 'TARGET',
    blockType: 'paragraph',
    lossy: false,
  };
}

/** Reads the exact document tree, including IDs, attributes and marks. */
function snapshot(client: Client): unknown {
  const doc = client.editor.prosemirrorState.doc;
  doc.check();
  return doc.toJSON();
}

/** Names the actual root output that carries the published trace. */
function outputId(p: DocumentProposal, index: number): string {
  return deriveId(`document-proposal:${p.proposalId}:${String(index)}`);
}

/** Reads every assigned output in the order its stable IDs specify. */
function outputs(client: Client, p: DocumentProposal, count: number): Array<{ id: string; type: string; text: string }> {
  return Array.from({ length: count }, (_, index) => {
    const id = outputId(p, index);
    const row = rowById(client.editor.prosemirrorState.doc, id);
    return {
      id,
      type: row?.node.type.name === 'blockContainer' ? row.node.firstChild!.type.name : row?.node.type.name ?? 'missing',
      text: row === undefined ? '' : blockPlainText(row.node),
    };
  });
}

/** Waits on an explicit event rather than an elapsed delay. */
function gate(): { readonly wait: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

beforeEach(() => {
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue(UPLOAD_CONFIG);
});

afterEach(() => {
  act(() => {
    for (const client of clients.splice(0)) {
      client.editor.unmount();
      client.undoManager.destroy();
      client.doc.destroy();
    }
    document.body.innerHTML = '';
  });
  vi.restoreAllMocks();
});

const SHAPES = [
  { name: 'table first', body: `${TABLE_BODY}\n\nAFTER`, root: ['AgentCol\nAGENT_CELL', 'AFTER'], cell: ['AgentCol', 'AGENT_CELL', 'AFTER'] },
  { name: 'table last', body: `BEFORE\n\n${TABLE_BODY}`, root: ['BEFORE', 'AgentCol\nAGENT_CELL'], cell: ['BEFORE', 'AgentCol', 'AGENT_CELL'] },
  { name: 'table between paragraphs', body: `BEFORE\n\n${TABLE_BODY}\n\nAFTER`, root: ['BEFORE', 'AgentCol\nAGENT_CELL', 'AFTER'], cell: ['BEFORE', 'AgentCol', 'AGENT_CELL', 'AFTER'] },
  { name: 'consecutive tables', body: `${TABLE_BODY}\n\n| SecondCol |\n| --- |\n| SECOND_CELL |`, root: ['AgentCol\nAGENT_CELL', 'SecondCol\nSECOND_CELL'], cell: ['AgentCol', 'AGENT_CELL', 'SecondCol', 'SECOND_CELL'] },
] as const;

describe.each(['root', 'cell', 'header', 'deep'] as const)('proposal output in %s', (context) => {
  for (const kind of ['insert', 'rewrite'] as const) {
    for (const shape of SHAPES) {
      it(`${kind} with ${shape.name} tracks actual output, repeats once and undoes completely`, async () => {
        const client = open(context);
        const p = proposal(kind, shape.body);
        const before = snapshot(client);
        const oldTable = rowById(client.editor.prosemirrorState.doc, 'host-table')!.node.toJSON();
        const tail = rowById(client.editor.prosemirrorState.doc, 'tail')!.node.toJSON();
        let result: Awaited<ReturnType<typeof landProposal>> | undefined;
        await act(async () => {
          result = await landProposal(client, p, 'write', true);
        });

        expect(result).toEqual({ outcome: 'applied', how: 'write', blockId: outputId(p, 0) });
        expect(landedAt(client, p)).toEqual({ how: 'write', blockId: outputId(p, 0) });
        const texts = context === 'root' ? shape.root : shape.cell;
        const written = outputs(client, p, texts.length);
        expect(written.map((block) => block.text)).toEqual(texts);
        expect(written.map((block) => block.type)).toEqual(texts.map((text) => context === 'root' && text.includes('\n') ? 'docTable' : 'paragraph'));
        expect(rowById(client.editor.prosemirrorState.doc, 'tail')!.node.toJSON()).toEqual(tail);
        if (context === 'root') expect(rowById(client.editor.prosemirrorState.doc, 'host-table')!.node.toJSON()).toEqual(oldTable);
        expect(rowById(client.editor.prosemirrorState.doc, 'target') === undefined).toBe(kind === 'rewrite');
        const writtenTree = snapshot(client);
        expect(client.undoManager.undoStack).toHaveLength(1);

        act(() => {
          client.undoManager.undo();
        });
        expect(snapshot(client)).toEqual(before);
        expect(landedAt(client, p)).toBeNull();
        act(() => {
          client.undoManager.redo();
        });
        expect(snapshot(client)).toEqual(writtenTree);
        expect(landedAt(client, p)).toEqual({ how: 'write', blockId: outputId(p, 0) });

        await act(async () => {
          expect(await landProposal(client, p, 'write', true)).toEqual(result);
        });
        expect(snapshot(client)).toEqual(writtenTree);
        expect(client.undoManager.undoStack).toHaveLength(1);
        const replicaDoc = new Y.Doc();
        Y.applyUpdate(replicaDoc, Y.encodeStateAsUpdate(client.doc));
        const replica = mount(replicaDoc);
        expect(snapshot(replica)).toEqual(writtenTree);
        expect(landedAt(replica, p)).toEqual({ how: 'write', blockId: outputId(p, 0) });
      });
    }
  }
});

describe.each(['insert', 'rewrite'] as const)('%s commit after asynchronous preparation', (kind) => {
  for (const change of ['edit', 'remove', 'readOnly'] as const) {
    it(`reports current ${change} without writing or adding an undo item`, async () => {
      const client = open('root');
      const p = proposal(kind, `${TABLE_BODY}\n\n![outside](https://outside.example.invalid/image.png)`);
      const entered = gate();
      const release = gate();
      vi.mocked(assetsApi.fetchUploadConfig).mockImplementation(async () => {
        entered.release();
        await release.wait;
        return UPLOAD_CONFIG;
      });
      let pending!: ReturnType<typeof landProposal>;
      await act(async () => {
        pending = landProposal(client, p, 'write', true);
        await entered.wait;
      });
      act(() => {
        if (change === 'edit') {
          const target = rowById(client.editor.prosemirrorState.doc, 'target')!;
          client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('UPDATED', target.from + 2, target.from + 8));
        } else if (change === 'remove') {
          client.editor.removeBlocks(['target']);
        } else {
          client.editor.isEditable = false;
        }
      });
      const beforeCompletion = snapshot(client);
      const undoItems = client.undoManager.undoStack.length;
      release.release();
      await act(async () => {
        await expect(pending).resolves.toEqual({ outcome: change === 'edit' ? 'changed' : change === 'remove' ? 'blockGone' : 'readOnly' });
      });
      expect(snapshot(client)).toEqual(beforeCompletion);
      expect(client.undoManager.undoStack).toHaveLength(undoItems);
      expect(landedAt(client, p)).toBeNull();
    });
  }

  for (const direction of ['into cell', 'out of cell'] as const) {
    it(`normalizes against the current target after it moves ${direction}`, async () => {
      const client = open(direction === 'into cell' ? 'root' : 'deep');
      const p = proposal(kind);
      const entered = gate();
      const release = gate();
      vi.mocked(assetsApi.fetchUploadConfig).mockImplementation(async () => {
        entered.release();
        await release.wait;
        return UPLOAD_CONFIG;
      });
      let pending!: ReturnType<typeof landProposal>;
      await act(async () => {
        pending = landProposal(client, p, 'write', true);
        await entered.wait;
      });
      act(() => {
        const anchor = rowById(client.editor.prosemirrorState.doc, direction === 'into cell' ? 'cell-anchor' : 'tail')!;
        moveRowTo(client.editor.prosemirrorView, 'target', direction === 'into cell' ? anchor.to : anchor.from);
      });
      expect(blockInTableCell(client.editor.prosemirrorState.doc, 'target')).toBe(direction === 'into cell');
      const beforeCompletion = snapshot(client);
      client.undoManager.clear();
      release.release();
      await act(async () => {
        await expect(pending).resolves.toEqual({ outcome: 'applied', how: 'write', blockId: outputId(p, 0) });
      });
      expect(outputs(client, p, direction === 'into cell' ? 2 : 1).map((block) => ({ type: block.type, text: block.text }))).toEqual(
        direction === 'into cell'
          ? [{ type: 'paragraph', text: 'AgentCol' }, { type: 'paragraph', text: 'AGENT_CELL' }]
          : [{ type: 'docTable', text: 'AgentCol\nAGENT_CELL' }],
      );
      expect(client.undoManager.undoStack).toHaveLength(1);
      act(() => {
        client.undoManager.undo();
      });
      expect(snapshot(client)).toEqual(beforeCompletion);
    });
  }
});

describe.each(['insert', 'rewrite'] as const)('%s parsed rich table payload', (kind) => {
  it('preserves surviving attributes, marks, empty blocks and nested child IDs', async () => {
    const client = open('deep');
    const p = proposal(kind);
    // Isolate Markdown parsing to supply legal parser output that Markdown
    // cannot express: multiple rich and empty blocks in one table cell.
    // Production media filtering, schema conversion and writes remain real.
    const parsed = tableBlock({ rows: [{ cells: [{ blocks: [
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'HEADING', styles: { bold: true } }] },
      { type: 'codeBlock', props: { language: 'javascript' }, content: 'const answer = 42;' },
      { type: 'paragraph' },
      { type: 'heading', props: { level: 3 } },
      { type: 'codeBlock', props: { language: 'typescript' } },
      { type: 'image', props: { url: `${UPLOAD_CONFIG.assetUrlPrefix}kept.png`, name: 'Kept image' } },
      { type: 'image', props: { url: 'https://outside.example.invalid/removed.png' } },
      { type: 'bulletListItem', content: 'ITEM', children: [{ id: 'parsed-child', type: 'paragraph', content: 'CHILD' }] },
    ] }] }] });
    vi.spyOn(documentMarkdown, 'markdownBlocks').mockResolvedValue([{ block: parsed as never, text: 'Parsed rich table' }]);
    const before = snapshot(client);
    await act(async () => {
      expect(await landProposal(client, p, 'write', true)).toEqual({ outcome: 'applied', how: 'write', blockId: outputId(p, 0), leftOut: 1 });
    });

    expect(outputs(client, p, 7).map((block) => ({ type: block.type, text: block.text }))).toEqual([
      { type: 'heading', text: 'HEADING' },
      { type: 'codeBlock', text: 'const answer = 42;' },
      { type: 'paragraph', text: '' },
      { type: 'heading', text: '' },
      { type: 'codeBlock', text: '' },
      { type: 'image', text: '\n' },
      { type: 'bulletListItem', text: 'ITEM\nCHILD' },
    ]);
    const doc = client.editor.prosemirrorState.doc;
    expect(rowById(doc, outputId(p, 0))!.node.firstChild!.attrs['level']).toBe(2);
    expect(rowById(doc, outputId(p, 0))!.node.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['bold']);
    expect(rowById(doc, outputId(p, 1))!.node.firstChild!.attrs['language']).toBe('javascript');
    expect(rowById(doc, outputId(p, 3))!.node.firstChild!.attrs['level']).toBe(3);
    expect(rowById(doc, outputId(p, 4))!.node.firstChild!.attrs['language']).toBe('typescript');
    expect(rowById(doc, outputId(p, 5))!.node.firstChild!.attrs['url']).toBe(`${UPLOAD_CONFIG.assetUrlPrefix}kept.png`);
    expect(rowById(doc, 'parsed-child')!.node.textContent).toBe('CHILD');
    const committed = snapshot(client);
    act(() => {
      client.undoManager.undo();
    });
    expect(snapshot(client)).toEqual(before);
    act(() => {
      client.undoManager.redo();
    });
    expect(snapshot(client)).toEqual(committed);
  });
});
