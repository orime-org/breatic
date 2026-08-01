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
// Mutable so a test can put the socket in its pre-sync state. `synced` and
// `hasEverSynced` are separate on purpose: the first answers "in sync right
// now", the second "has the content ever arrived", and the container must read
// the second.
const socketState = {
  synced: true,
  hasEverSynced: true,
  status: 'connected' as 'connected' | 'authFailed' | 'disconnected',
  writeAccess: 'granted' as 'unknown' | 'granted' | 'denied',
  authFailedReason: null as string | null,
};
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: { awareness: unknown };
    synced: boolean;
    hasEverSynced: boolean;
    status: string;
    writeAccess: string;
    authFailedReason: string | null;
  } => ({
    provider: { awareness: socketAwareness },
    synced: socketState.synced,
    hasEverSynced: socketState.hasEverSynced,
    status: socketState.status,
    writeAccess: socketState.writeAccess,
    authFailedReason: socketState.authFailedReason,
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
    socketState.hasEverSynced = true;
    socketState.status = 'connected';
    socketState.writeAccess = 'granted';
    socketState.authFailedReason = null;
  });

  it('says the document could not be opened, instead of loading forever', async () => {
    // A document's own connection can be refused while the project's stays
    // healthy — they are separate documents on the shared socket. The project
    // banner is driven by the project's document, so it stays green and says
    // nothing. Meanwhile this body knew the exact cause and rendered
    // "Loading editor…", which is a lie: nothing is loading and nothing ever
    // will. The user is left with a spinner, no explanation, and no way out.
    socketState.synced = false;
    socketState.hasEverSynced = false;
    socketState.status = 'authFailed';
    socketState.authFailedReason = 'Forbidden';
    render(<DocumentSpace projectId='p1' spaceId='doc-refused' />);

    expect(
      await screen.findByTestId('document-space-unavailable'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('document-space-loading')).toBeNull();
    // And a way out — this is recoverable by reloading in the cases that
    // produce it (a Space deleted in another tab, a claim landing late).
    expect(
      screen.getByTestId('document-space-unavailable-retry'),
    ).toBeInTheDocument();
  });

  it('keeps a refused document on screen, read-only, once its content arrived', async () => {
    // A Space deleted by a collaborator, or access revoked, while this tab has
    // the document open and synced. The refusal is per-document: the shared
    // socket stays open and the project banner — which watches the project's
    // own document — shows nothing.
    //
    // Taking the content off screen would be wrong; it is right there and the
    // user may want to copy it. Leaving it EDITABLE is worse than wrong: every
    // keystroke goes into a local Y.Doc that will never sync, with no error and
    // no disconnect, and none of it is there on reload. So: keep it, stop
    // accepting edits, and say why.
    socketState.hasEverSynced = true;
    socketState.status = 'authFailed';
    socketState.authFailedReason = 'Forbidden';
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-revoked' />);

    // The content stays.
    expect(await screen.findByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('document-space-unavailable')).toBeNull();
    // But it cannot be edited, and the user is told.
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('false'),
    );
    expect(screen.getByTestId('document-space-refused-notice')).toBeInTheDocument();
  });

  it('goes read-only, and says so, when the server refuses writes', async () => {
    // The server authenticates a connection read-only when the user is a
    // viewer OR when they are over the document's connection cap. In the
    // second case the UI believes this member may edit: it renders a live
    // editor, a working toolbar and a caret, while the server discards every
    // update it sends — no error, no disconnect. The document is written and
    // lost, and on reload none of it is there.
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-capped' />);
    await screen.findByTestId('document-toolbar');

    expect(screen.getByTestId('document-space-readonly-notice')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('false'),
    );
  });

  it('does not nag a viewer about being read-only — they already know', async () => {
    // A viewer's read-only is their role, shown by the UI everywhere else. The
    // notice exists for the case the UI is WRONG about, so showing it to a
    // viewer would be noise on every document they ever open.
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-viewer' readOnly />);
    await screen.findByTestId('document-toolbar');

    expect(screen.queryByTestId('document-space-readonly-notice')).toBeNull();
  });

  it('shows the content again immediately after a Space-tab switch', async () => {
    // Switching Space tabs unmounts and remounts this body — `SpaceOutlet` is
    // keyed on the Space id. The content is plainly still there across one: the
    // Y.Doc, the editor and its undo stack are all held elsewhere. So the gate
    // that withholds the editor must not restart from zero here, or the user
    // gets a loading placeholder in front of a document already in memory.
    //
    // Worse while the socket happens to be down — `synced` is false, nothing
    // will set it again until the network returns, and the document stays
    // hidden for the whole outage.
    const { unmount } = render(
      <DocumentSpace projectId='p1' spaceId='doc-tabswitch' />,
    );
    expect(await screen.findByTestId('document-toolbar')).toBeInTheDocument();

    unmount();
    socketState.synced = false;
    render(<DocumentSpace projectId='p1' spaceId='doc-tabswitch' />);

    expect(await screen.findByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('document-space-loading')).toBeNull();
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
    socketState.hasEverSynced = false;
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
