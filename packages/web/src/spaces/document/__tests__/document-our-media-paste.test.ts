// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One of our media pasted or dropped into a body enters this Project the way a canvas paste does (inner#2171 design
 * §5.2): it becomes a pending block whose upload is handed over as `{ kind: 'ours', url }`, so the batch asks
 * `canvasApi.paste` for this Project's address and the relation is written then.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

import { drop, pasteFormats, type Editor } from './paste-harness';

const OURS = 'https://cdn.example/';
const HOME = 'project-p/document-d';
const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => editor.unmount());
});

/**
 * An editor on one empty line, handing uploads to `start`.
 * @param start - Where uploads go.
 * @returns The editor.
 */
function open(start: ReturnType<typeof vi.fn>): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    media: { assetUrlPrefix: () => OURS, onLeftOut: vi.fn(), start, docName: HOME, onStillUploading: vi.fn() },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph' }] as never);
  editor.setTextCursorPosition((editor.document[0] as { id: string }).id, 'start');
  editor.prosemirrorView!.focus();
  return editor;
}

/**
 * The media blocks of a body.
 * @param editor - The editor.
 * @returns Their address, upload and home.
 */
function media(editor: Editor): Array<{ url: string; uploadId: string; uploadHome: unknown }> {
  const out: Array<{ url: string; uploadId: string; uploadHome: unknown }> = [];
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (['image', 'video', 'audio'].includes(node.type.name)) out.push({ url: node.attrs['url'], uploadId: node.attrs['uploadId'], uploadHome: node.attrs['uploadHome'] });
    return true;
  });
  return out;
}

/** Let the paste finish and its uploads start. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('our media pasted into a body (inner#2171)', () => {
  it('becomes a pending block whose upload carries our address', async () => {
    const start = vi.fn();
    const editor = open(start);
    const url = `${OURS}image/2026-11-26/a.png`;

    pasteFormats(editor, { 'text/html': `<p>x</p><img src="${url}">` });
    await settled();

    const [block] = media(editor);
    expect(block).toMatchObject({ url: '', uploadHome: HOME });
    expect(block!.uploadId).not.toBe('');
    expect(start.mock.calls).toEqual([[block!.uploadId, { kind: 'ours', url }]]);
  });

  it('does the same for a drop', async () => {
    const start = vi.fn();
    const editor = open(start);
    const url = `${OURS}image/2026-11-26/b.png`;

    drop(editor, 1, `<img src="${url}">`, '');
    await settled();

    const [block] = media(editor);
    expect(block?.url).toBe('');
    expect(start.mock.calls).toEqual([[block!.uploadId, { kind: 'ours', url }]]);
  });

  it('hands our addresses as ours and an outside one as an address to fetch', async () => {
    const start = vi.fn();
    const editor = open(start);
    const ours = [1, 2, 3].map((n) => `${OURS}image/2026-11-26/${n}.png`);
    const outside = 'https://elsewhere.example/x.png';

    pasteFormats(editor, { 'text/html': `<p>x</p>${[...ours, outside].map((src) => `<img src="${src}">`).join('')}` });
    await settled();

    const handed = start.mock.calls.map(([, source]) => source as { kind: string; url: string });
    expect(handed.filter((source) => source.kind === 'ours').map((source) => source.url).sort()).toEqual([...ours].sort());
    expect(handed.filter((source) => source.kind === 'address').map((source) => source.url)).toEqual([outside]);
  });
});
