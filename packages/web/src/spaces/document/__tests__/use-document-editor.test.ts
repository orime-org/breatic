// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's Yjs binding and its undo semantics.
 *
 * Undo in a collaborative document is per-client: it must roll back what THIS
 * user did and leave everyone else's edits alone. Getting that wrong is worse
 * than having no undo at all — one person pressing Cmd+Z would silently delete
 * a paragraph someone else is still writing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';

import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** Reads a fragment's plain text, paragraphs joined by a newline. */
function textOf(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/g, ''))
    .join('\n');
}

/**
 * Applies `source`'s state to `target` tagged with a REMOTE origin — the shape
 * a peer's edit arrives in. The origin is what keeps it out of the local undo
 * stack, so tests must not skip it.
 */
function syncAsRemote(target: Y.Doc, source: Y.Doc): void {
  Y.applyUpdate(
    target,
    Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)),
    'remote-peer',
  );
}

describe('useDocumentEditor — Yjs binding', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });
  afterEach(() => {
    doc.destroy();
    vi.restoreAllMocks();
  });

  it('binds the editor to the document body fragment', async () => {
    const fragment = doc.getXmlFragment('content');
    const { result } = renderHook(() => useDocumentEditor({ fragment }));

    await waitFor(() => expect(result.current).not.toBeNull());

    act(() => {
      result.current?.commands.setContent('<p>hello</p>');
    });

    expect(textOf(fragment)).toContain('hello');
  });

  it('reflects a remote peer edit in the local editor', async () => {
    const fragment = doc.getXmlFragment('content');
    const { result } = renderHook(() => useDocumentEditor({ fragment }));
    await waitFor(() => expect(result.current).not.toBeNull());

    const peer = new Y.Doc();
    const peerFragment = peer.getXmlFragment('content');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('from the other side')]);
    peerFragment.push([para]);

    act(() => syncAsRemote(doc, peer));

    await waitFor(() =>
      expect(result.current?.getText()).toContain('from the other side'),
    );
    peer.destroy();
  });
});

describe('useDocumentEditor — undo is per-client', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });
  afterEach(() => {
    doc.destroy();
  });

  it('starts with nothing to undo', async () => {
    const fragment = doc.getXmlFragment('content');
    const { result } = renderHook(() => useDocumentEditor({ fragment }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(result.current?.can().undo()).toBe(false);
  });

  it('rolls back this client’s own edit', async () => {
    const fragment = doc.getXmlFragment('content');
    const { result } = renderHook(() => useDocumentEditor({ fragment }));
    await waitFor(() => expect(result.current).not.toBeNull());

    act(() => {
      result.current?.commands.setContent('<p>mine</p>');
    });
    await waitFor(() => expect(textOf(fragment)).toContain('mine'));

    act(() => {
      result.current?.commands.undo();
    });

    expect(textOf(fragment)).not.toContain('mine');
  });

  it('does NOT roll back a peer’s edit — that is the whole point', async () => {
    const fragment = doc.getXmlFragment('content');
    const { result } = renderHook(() => useDocumentEditor({ fragment }));
    await waitFor(() => expect(result.current).not.toBeNull());

    // This client writes something of its own first, so there IS a local entry
    // on the stack — otherwise undo would be a no-op and the test would pass
    // for the wrong reason.
    act(() => {
      result.current?.commands.setContent('<p>mine</p>');
    });
    await waitFor(() => expect(textOf(fragment)).toContain('mine'));

    // A peer appends their own paragraph and it syncs in.
    const peer = new Y.Doc();
    syncAsRemote(peer, doc);
    const peerFragment = peer.getXmlFragment('content');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('theirs')]);
    peerFragment.push([para]);
    act(() => syncAsRemote(doc, peer));
    await waitFor(() => expect(textOf(fragment)).toContain('theirs'));

    act(() => {
      result.current?.commands.undo();
    });

    expect(textOf(fragment)).not.toContain('mine');
    expect(textOf(fragment)).toContain('theirs');
    peer.destroy();
  });
});
