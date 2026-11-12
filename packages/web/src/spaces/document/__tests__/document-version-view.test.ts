// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The snapshot preview (inner#1129 design §7.3, §7.4): a separate read-only
 * editor driven by BlockNote's versioning controller over our storage, with
 * comparisons marked in place and unchanged stretches folded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, type DocumentVersion } from '@breatic/shared';

import { documentsApi } from '@web/data/api/documents';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { openVersionFold, versionFolds } from '@web/spaces/document/document-version-fold';
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

/** Mounts an editor in the page. */
function mount<E extends Editor>(editor: E): E {
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/** Keeps a snapshot of a body under an id, as the server would. */
function keep(id: string, blocks: unknown[]): void {
  const source = mount(buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) }));
  source.replaceBlocks(source.document, blocks as never);
  rows.set(id, snapshotOf(source.prosemirrorState.doc).content);
}

/** A live body and its preview, wired as the panel wires them. */
function open(blocks: unknown[]) {
  const doc = new Y.Doc();
  const { manager, extension } = createDocumentUndo(doc);
  const live = mount(buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] }));
  live.replaceBlocks(live.document, blocks as never);
  manager.clear();
  const shown: ShownRef = { current: null };
  const onShow = vi.fn();
  const storage = createDocumentVersionStorage({
    scope: { projectId: 'p', spaceId: 's' },
    shown,
    apply: (content) => (typeof restoreSnapshot({ editor: live, undoManager: manager, content, threads: null, space: null }) === 'string' ? 'written' : 'refused'),
    report: vi.fn(),
  });
  const preview = mount(buildVersionPreview({ live: () => live.prosemirrorState.doc, storage, shown, onShow }));
  return { live, preview, versioning: versioningOf(preview), shown, onShow, undo: manager };
}

const text = (editor: Editor): string => editor.prosemirrorState.doc.textContent;

/** The comparison marks on screen, by kind and the words they cover. */
function changes(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name.startsWith('y-attributed-')) out.push(`${mark.type.name.slice('y-attributed-'.length)}:${node.text ?? node.type.name}`);
    }
    return true;
  });
  return out;
}

// A snapshot and the body it came from share block ids, so ids follow position.
const paragraphs = (words: string[]): unknown[] => words.map((content, i) => ({ id: `block-${String(i)}`, type: 'paragraph', content }));

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

describe('snapshot preview', () => {
  it('opens on the current content and leaves the live body alone', async () => {
    const { live, preview, versioning, shown } = open(paragraphs(['live words']));

    await versioning.open();

    expect(text(preview)).toBe('live words');
    expect(shown.current?.id).toBeNull();
    expect(preview.isEditable).toBe(false);
    expect(text(live)).toBe('live words');
  });

  it('shows a snapshot without its comment highlights', async () => {
    keep('v1', paragraphs(['old words']));
    const commented = rows.get('v1')!;
    rows.set('v1', JSON.parse(JSON.stringify(commented).replace('"text":"old words"', '"text":"old words","marks":[{"type":"comment","attrs":{"threadId":"t","orphan":false}}]')) as Json);
    const { live, preview, versioning, shown } = open(paragraphs(['live words']));
    await versioning.open();

    await versioning.select({ type: 'snapshot', id: 'v1' });

    expect(text(preview)).toBe('old words');
    expect(JSON.stringify(preview.prosemirrorState.doc.toJSON())).not.toContain('"comment"');
    expect(shown.current).toEqual({ id: 'v1', content: rows.get('v1') });
    expect(text(live)).toBe('live words');
  });

  it('marks what changed from the older to the newer, without scrolling the page', async () => {
    keep('v1', paragraphs(['Hello world']));
    const { preview, versioning, onShow } = open(paragraphs(['Hello brave world', 'added line']));
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    // jsdom lays nothing out; the library only scrolls to a change that has a box.
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 10, 10));
    await versioning.open();

    await versioning.select({ type: 'current' }, { compareTo: 'v1' });
    // The library would scroll 200 ms after drawing (SCROLL_TO_FIRST_CHANGE_DELAY_MS).
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(changes(preview)).toEqual(expect.arrayContaining([expect.stringMatching(/^insert:.*brave/), expect.stringMatching(/^insert:/)]));
    expect(changes(preview).some((c) => c.includes('added line'))).toBe(true);
    expect(onShow).toHaveBeenLastCalledWith(true);
    expect(scroll).not.toHaveBeenCalled();
    scroll.mockRestore();
    box.mockRestore();
  });

  it('restores the snapshot on screen into the live body and closes', async () => {
    keep('v1', paragraphs(['old words']));
    const { live, versioning, undo } = open(paragraphs(['live words']));
    await versioning.open();
    await versioning.select({ type: 'snapshot', id: 'v1' });

    expect(await versioning.restore('v1')).toEqual({ status: 'done' });

    expect(text(live)).toBe('old words');
    expect(versioning.store.state.mode).toBe('live');
    live.undo();
    expect(text(live)).toBe('live words');
    expect(undo.undoStack.length).toBe(0);
  });
});

describe('folding unchanged stretches', () => {
  const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

  /** Compares the current body with a snapshot of `before`. */
  async function compare(before: string[], after: string[]) {
    keep('v1', paragraphs(before));
    const opened = open(paragraphs(after));
    await opened.versioning.open();
    await opened.versioning.select({ type: 'current' }, { compareTo: 'v1' });
    return opened;
  }

  it('keeps one block beside each change and folds runs of three or more', async () => {
    const after = [...ten];
    after[4] = 'changed';
    const { preview } = await compare(ten, after);

    expect(versionFolds(preview.prosemirrorState).map((fold) => fold.count)).toEqual([3, 4]);
    expect(preview.prosemirrorView!.dom.querySelectorAll('.doc-version-folded').length).toBe(7);
    expect(preview.prosemirrorView!.dom.querySelectorAll('[data-version-fold]').length).toBe(2);
  });

  it('does not fold two unchanged blocks, and folds nothing outside a comparison', async () => {
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'G'];
    const { preview, versioning } = await compare(['a', 'b', 'c', 'd', 'e', 'f', 'g'], after);
    // b and g changed: of c to f, c and f stay beside the changes, leaving two.
    expect(versionFolds(preview.prosemirrorState)).toEqual([]);

    await versioning.select({ type: 'current' });
    expect(versionFolds(preview.prosemirrorState)).toEqual([]);
    expect(preview.prosemirrorView!.dom.querySelectorAll('.doc-version-folded').length).toBe(0);
  });

  it('opens a fold for good until the comparison changes', async () => {
    const after = [...ten];
    after[9] = 'changed';
    const { preview, versioning } = await compare(ten, after);
    const [fold] = versionFolds(preview.prosemirrorState);
    expect(fold?.count).toBe(8);

    preview.prosemirrorView!.dispatch(openVersionFold(preview.prosemirrorState, fold!.key));
    expect(versionFolds(preview.prosemirrorState)).toEqual([]);
    preview.prosemirrorView!.dispatch(preview.prosemirrorState.tr);
    expect(versionFolds(preview.prosemirrorState)).toEqual([]);

    await versioning.select({ type: 'snapshot', id: 'v1' });
    await versioning.select({ type: 'current' }, { compareTo: 'v1' });
    expect(versionFolds(preview.prosemirrorState).map((f) => f.count)).toEqual([8]);
  });
});
