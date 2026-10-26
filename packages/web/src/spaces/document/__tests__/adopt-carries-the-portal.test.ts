// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1202: the block strip is gone after switching Space tabs and back.
 *
 * BlockNote's floating UI — the block strip among it — portals into the
 * element wrapping the editor's own DOM (`usePortalElement`,
 * `PortalElementOverride.tsx`). A Space-tab switch hands the surface to a new
 * container without mounting again, so that element has to travel with it:
 * left behind, it leaves the page with the old container and everything drawn
 * into it is drawn off the page.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { adoptDocumentEditor } from '@web/spaces/document/document-editor-cache';

const editors: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.replaceChildren();
});

/** A fresh container attached to the page. */
function container(): HTMLElement {
  const next = document.createElement('div');
  document.body.appendChild(next);
  return next;
}

/** An editor over a fresh document and the surface it is shown on. */
function showable(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  surface: HTMLElement;
  } {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [],
  });
  editors.push(editor);
  return { editor, surface: document.createElement('div') };
}

/**
 * Where the editor's floating UI is drawn: the element wrapping its DOM.
 * @param handle - The editor and its surface.
 * @returns That element, or null before the editor has mounted.
 */
function portalOf(handle: ReturnType<typeof showable>): HTMLElement | null {
  return handle.editor.domElement?.parentElement ?? null;
}

describe('handing the editor to another container', () => {
  it('puts the floating UI portal in the first container', () => {
    const handle = showable();
    const first = container();
    adoptDocumentEditor(handle, first);

    expect(first.contains(portalOf(handle))).toBe(true);
  });

  it('moves the floating UI portal along with the surface', () => {
    const handle = showable();
    const first = container();
    adoptDocumentEditor(handle, first);
    first.remove();

    const second = container();
    adoptDocumentEditor(handle, second);

    expect(portalOf(handle)?.isConnected).toBe(true);
    expect(second.contains(portalOf(handle))).toBe(true);
    expect(Array.from(second.children)).toEqual([handle.surface]);
  });

  it('leaves the container unchanged when adopted into it twice', () => {
    const handle = showable();
    const first = container();
    adoptDocumentEditor(handle, first);
    adoptDocumentEditor(handle, first);

    expect(Array.from(first.children)).toEqual([handle.surface]);
  });

  it('does not take the surface off the page when it is already in place', async () => {
    // A Space shown again adopts into the container that already holds the
    // editor. Taking the surface out and putting it back resets every scroll
    // position inside it — a wide table's frame among them (inner#1235 A1).
    const handle = showable();
    const first = container();
    adoptDocumentEditor(handle, first);
    const moves: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => moves.push(...records));
    watcher.observe(first, { childList: true });

    adoptDocumentEditor(handle, first);
    await Promise.resolve();
    watcher.disconnect();

    expect(moves).toEqual([]);
  });
});
