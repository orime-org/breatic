// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { DocumentSpace } from '@web/spaces/document/DocumentSpace';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';
import { useCurrentUserStore } from '@web/stores/current-user';

// The editor is only built once its caret wiring exists — both the provider and
// the identity are baked in at construction. A container test therefore has to
// supply a provider; without one the body correctly renders its loading state.
const socketAwareness = new Awareness(new Y.Doc());
// Mutable so a test can put the socket in its pre-sync state.
const socketState = { synced: true };
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: { awareness: unknown };
    synced: boolean;
    status: 'connected';
    authFailedReason: null;
  } => ({
    provider: { awareness: socketAwareness },
    synced: socketState.synced,
    status: 'connected',
    authFailedReason: null,
  }),
}));

describe('DocumentSpace', () => {
  beforeEach(() => {
    useCurrentUserStore.setState({
      user: {
        id: 'user-1',
        name: 'Tester',
        email: 'tester@example.com',
      } as ReturnType<typeof useCurrentUserStore.getState>['user'],
    });
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    _resetForTests();
    useCurrentUserStore.setState({ user: null });
    socketState.synced = true;
  });

  it('keeps the editor through a reconnect once the content has arrived', async () => {
    // `synced` reports whether the socket is in sync RIGHT NOW — it goes false
    // on any routine close (wifi switch, laptop wake, a collab redeploy). What
    // the gate below actually needs to know is whether the real content has
    // EVER arrived, because once it has, the local document holds it and
    // offline edits merge cleanly on reconnect. Confusing the two tears the
    // mounted editor out of the DOM on every blip, taking the caret, the
    // in-flight IME composition and the scroll position with it.
    const { rerender } = render(
      <DocumentSpace projectId='p1' spaceId='doc-reconnect' />,
    );
    expect(await screen.findByTestId('document-toolbar')).toBeInTheDocument();

    socketState.synced = false;
    rerender(<DocumentSpace projectId='p1' spaceId='doc-reconnect' />);

    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('document-space-loading')).toBeNull();
  });

  it('does not offer the editor until the document has synced', async () => {
    // Editing a document whose real content has not arrived is not a smaller
    // version of editing it — it is editing a different document. Anything
    // typed lands beside the server's content once that turns up rather than
    // in it, and undoing back to empty in that window destroys the redo stack,
    // because the paragraph that keeps Yjs and ProseMirror agreeing is only
    // seeded after a sync. Measured, both of them.
    socketState.synced = false;
    render(<DocumentSpace projectId='p1' spaceId='doc-unsynced' />);

    expect(await screen.findByTestId('document-space')).toBeInTheDocument();
    expect(screen.getByTestId('document-space-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('document-toolbar')).toBeNull();
    expect(screen.queryByTestId('document-editor-content')).toBeNull();
  });

  it('renders the editor mount and the toolbar', async () => {
    render(<DocumentSpace projectId='p1' spaceId='doc-1' />);
    expect(await screen.findByTestId('document-space')).toBeInTheDocument();
    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
  });

  it('forwards projectId / spaceId via data attributes', async () => {
    render(<DocumentSpace projectId='alpha' spaceId='beta' />);
    const root = await screen.findByTestId('document-space');
    expect(root.getAttribute('data-project-id')).toBe('alpha');
    expect(root.getAttribute('data-space-id')).toBe('beta');
  });

  it('exposes history and formatting controls in the toolbar', async () => {
    render(<DocumentSpace projectId='p' spaceId='s' />);
    await screen.findByTestId('document-toolbar');
    for (const id of ['undo', 'redo', 'bold', 'italic', 'strike']) {
      expect(screen.getByTestId(`doc-tool-${id}`)).toBeInTheDocument();
    }
  });

  it('binds the editor to THIS Space’s document, not some other doc', async () => {
    render(<DocumentSpace projectId='proj' spaceId='space-7' />);
    await screen.findByTestId('document-toolbar');

    // Reach the very document the container resolved — the manager hands out
    // one Y.Doc per name, so this is the same instance the editor is bound to.
    const fragment = documentBodyFragment(
      getDoc(docName.documentSpace('proj', 'space-7')),
    );
    act(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('written straight into the Y.Doc')]);
      fragment.push([para]);
    });

    // If the container had resolved the wrong document (or built its own), the
    // text would never reach the editor.
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.textContent ?? '',
      ).toContain('written straight into the Y.Doc'),
    );
  });

  it('renders read-only for a viewer', async () => {
    render(<DocumentSpace projectId='p' spaceId='s' readOnly />);
    await screen.findByTestId('document-toolbar');

    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('false'),
    );
  });
});
