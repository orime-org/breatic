// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A self-hosted deployment opened over plain http on a LAN address is not a
 * secure context, and browsers leave `crypto.randomUUID` out there: every way
 * media come into the body still lands its pending blocks (inner#1351 +
 * inner#1390).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { serializeClipboard, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { createFileUploads } from '@web/spaces/document/document-uploads';

import { TABLE, caretIn, open, paste, pasteFormats, settled, shape, unmountAll } from './paste-harness';

afterEach(() => {
  vi.unstubAllGlobals();
  unmountAll();
});

/** Takes `crypto.randomUUID` away, the way a page that is not a secure context has it. */
function insecure(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
}

describe('a page that is not a secure context', () => {
  it('lands an outside picture pasted from the web as a pending block', async () => {
    const { editor, sink } = open([{ type: 'paragraph', content: 'lead' }]);
    caretIn(editor, 0);
    insecure();

    paste(editor, '<p>a</p><img src="https://e.example/a.png"><p>b</p>', 'a b');
    await settled();

    expect(shape(editor)).toContain('image[pending|]');
    expect(sink.start).toHaveBeenCalledTimes(1);
  });

  it('lands the picture of web content pasted in a table cell under the table', async () => {
    const { editor } = open([TABLE]);
    caretIn(editor, 0);
    insecure();

    paste(editor, '<p>w</p><img src="https://e.example/a.png">', 'w');
    await settled();

    expect(shape(editor)).toEqual(['table', 'image[pending|]']);
  });

  it('lands a canvas paste of a picture and words', async () => {
    const canvas = { start: vi.fn(), notPasted: vi.fn() };
    const { editor } = open([{ type: 'paragraph', content: 'lead' }], { onCanvasPaste: canvas });
    caretIn(editor, 0);
    insecure();

    pasteFormats(editor, {
      'text/plain': serializeClipboard({
        version: 2,
        picked: ['i', 't'],
        nodes: [
          { id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Hero', content: 'https://e.example/a.png' } },
          { id: 't', type: 'text', position: { x: 0, y: 100 }, data: { name: 'Note', content: 'hello' } },
        ],
        edges: [],
      } as unknown as ClipboardPayload),
    });
    await settled();

    expect(shape(editor).some((label) => label.startsWith('image['))).toBe(true);
    expect(canvas.start).toHaveBeenCalled();
  });

  it('admits a pasted or dropped file as a pending block', () => {
    const files = createFileUploads({ maxUploadBytes: () => Infinity, refuse: vi.fn(), start: vi.fn() });
    insecure();

    const prepared = files.prepare([new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' })]);

    expect(prepared?.blocks[0]?.props.uploadId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
