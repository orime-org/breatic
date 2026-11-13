// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A12, design §6.7: a formula in the snapshot comparison.
 *
 * A formula holds its source in a prop, so a formula whose source changed
 * renders as the new formula, marked the way any block whose props changed is
 * (`doc-version-format`). A formula that did not change renders once,
 * unmarked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, type DocumentVersion } from '@breatic/shared';

import { documentsApi } from '@web/data/api/documents';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { restoreSnapshot, snapshotOf } from '@web/spaces/document/document-version-restore';
import { createDocumentVersionStorage, type ShownRef } from '@web/spaces/document/document-version-storage';
import { buildVersionPreview, versioningOf } from '@web/spaces/document/document-version-view';

vi.mock('@web/data/api/documents', () => ({
  documentsApi: { list: vi.fn(), get: vi.fn(), rename: vi.fn(), remove: vi.fn(), save: vi.fn() },
}));

type Editor = ReturnType<typeof buildDocumentEditor>;
type Json = Record<string, unknown>;

const api = vi.mocked(documentsApi);
const mounted: Editor[] = [];
const rows = new Map<string, Json>();

/**
 * Mounts an editor in the page.
 * @param editor - The editor.
 * @returns The same editor.
 */
function mount<E extends Editor>(editor: E): E {
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/**
 * Keeps a snapshot of a body under an id, as the server would.
 * @param id - The snapshot's id.
 * @param blocks - The body.
 */
function keep(id: string, blocks: unknown[]): void {
  const source = mount(buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) }));
  source.replaceBlocks(source.document, blocks as never);
  rows.set(id, snapshotOf(source.prosemirrorState.doc).content);
}

/**
 * A live body and its preview, wired as the panel wires them.
 * @param blocks - The live body.
 * @returns The preview and its versioning controller.
 */
function open(blocks: unknown[]): { preview: Editor; versioning: ReturnType<typeof versioningOf> } {
  const doc = new Y.Doc();
  const { manager, extension } = createDocumentUndo(doc);
  const live = mount(buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] }));
  live.replaceBlocks(live.document, blocks as never);
  manager.clear();
  const shown: ShownRef = { current: null };
  const storage = createDocumentVersionStorage({
    scope: { projectId: 'p', spaceId: 's' },
    shown,
    apply: (content) =>
      typeof restoreSnapshot({ editor: live, undoManager: manager, content, threads: null, space: null }) === 'string'
        ? 'applied'
        : 'refused',
    report: vi.fn(),
  });
  const preview = mount(buildVersionPreview({ live: () => live.prosemirrorState.doc, storage, shown, onShow: vi.fn() }));
  return { preview, versioning: versioningOf(preview) };
}

/**
 * The TeX sources of every display formula the preview draws, in order.
 * @param preview - The preview editor.
 * @returns The sources, read from KaTeX's own annotation.
 */
function drawnSources(preview: Editor): string[] {
  const dom = preview.prosemirrorView!.dom;
  return [...dom.querySelectorAll('.katex-display annotation[encoding="application/x-tex"]')].map(
    (node) => node.textContent ?? '',
  );
}

beforeEach(() => {
  rows.clear();
  api.get.mockImplementation(async (_scope, id) => {
    const content = rows.get(id);
    if (!content) throw new Error(`no row ${id}`);
    return { version: { id } as DocumentVersion, content };
  });
  api.list.mockImplementation(async () => ({ versions: [], nextCursor: null }));
});

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

describe('a formula in the comparison', () => {
  it('renders a changed formula as the new one, marked as changed', async () => {
    keep('v1', [{ id: 'block-0', type: 'mathBlock', props: { source: 'a+b' } }]);
    const { preview, versioning } = open([{ id: 'block-0', type: 'mathBlock', props: { source: 'a+c' } }]);
    await versioning.open();

    await versioning.select({ type: 'current' }, { compareTo: 'v1' });

    await vi.waitFor(() => {
      expect(drawnSources(preview)).toEqual(['a+c']);
    });
    expect(preview.prosemirrorView!.dom.querySelector('[class*="doc-version-format"] .doc-math')).not.toBeNull();
  });

  it('marks an inline formula whose source changed', async () => {
    keep('v1', [{ id: 'block-0', type: 'paragraph', content: ['a ', { type: 'math', props: { source: 'x' } }] }]);
    const { preview, versioning } = open([
      { id: 'block-0', type: 'paragraph', content: ['a ', { type: 'math', props: { source: 'y' } }] },
    ]);
    await versioning.open();

    await versioning.select({ type: 'current' }, { compareTo: 'v1' });

    await vi.waitFor(() => {
      expect(preview.prosemirrorView!.dom.querySelector('[class*="doc-version-format"] .doc-math')).not.toBeNull();
    });
  });

  it('renders an unchanged formula once', async () => {
    keep('v1', [
      { id: 'block-0', type: 'mathBlock', props: { source: 'x^2' } },
      { id: 'block-1', type: 'paragraph', content: 'old words' },
    ]);
    const { preview, versioning } = open([
      { id: 'block-0', type: 'mathBlock', props: { source: 'x^2' } },
      { id: 'block-1', type: 'paragraph', content: 'new words' },
    ]);
    await versioning.open();

    await versioning.select({ type: 'current' }, { compareTo: 'v1' });

    await vi.waitFor(() => {
      expect(drawnSources(preview)).toEqual(['x^2']);
    });
  });
});
