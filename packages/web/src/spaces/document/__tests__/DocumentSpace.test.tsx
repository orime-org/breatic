// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import * as React from 'react';

import { toast } from '@web/lib/toast';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { DocumentSpace } from '@web/spaces/document/DocumentSpace';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@breatic/shared';
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
    degraded: boolean;
    authFailedReason: string | null;
  } => ({
    provider: { awareness: socketAwareness },
    synced: socketState.synced,
    hasEverSynced: socketState.hasEverSynced,
    status: socketState.status,
    writeAccess: socketState.writeAccess,
    // Derived the same way the real hook derives it, because that is what this
    // double stands in for: 'denied' covers both a degrade and a refusal, and
    // only a refusal also sets `authFailed`.
    degraded:
      socketState.writeAccess === 'denied' &&
      socketState.status !== 'authFailed',
    authFailedReason: socketState.authFailedReason,
  }),
}));

// Captures what the container hands the editor chrome. The toolbar's own
// `disabled` cannot answer this in jsdom (see the degrade case below), so the
// wiring is asserted where it is decided.
const editorProps: { readOnly?: boolean } = {};
vi.mock('@web/spaces/document/DocumentEditor', async (importActual) => {
  const actual =
    await importActual<typeof import('@web/spaces/document/DocumentEditor')>();
  return {
    ...actual,
    DocumentEditor: (
      props: Parameters<typeof actual.DocumentEditor>[0],
    ): React.JSX.Element => {
      editorProps.readOnly = props.readOnly;
      return React.createElement(actual.DocumentEditor, props);
    },
  };
});

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

describe('DocumentSpace', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
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
    // The real hook always pairs these: a refusal costs write access. Leaving
    // `writeAccess` at its default would set up a combination `useSocket` can
    // no longer produce, and a test built on an impossible state proves nothing
    // about the real one.
    socketState.writeAccess = 'denied';
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

  it('tells the user a refused document was refused, and keeps it editable', async () => {
    // A Space deleted by a collaborator, or access revoked, while this tab has
    // the document open and synced. The refusal is per-document: the shared
    // socket stays open and the project banner — which watches the project's
    // own document — shows nothing.
    //
    // The editor stays editable ON PURPOSE (decision 2026-08-02). A document
    // that still takes typing while a message says the server refused it tells
    // the user exactly where the fault is. One that goes dead tells them only
    // that something broke — and takes away the content they might want to
    // copy out.
    socketState.hasEverSynced = true;
    socketState.status = 'authFailed';
    socketState.authFailedReason = 'Forbidden';
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-revoked' />);

    expect(await screen.findByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('document-space-unavailable')).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('true'),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('stops taking typing when the server degrades the connection to read-only', async () => {
    // Changed 2026-08-14 (user, #88): this used to say so and leave the editor
    // alone. Read-only means the server's data cannot change, and the canvas
    // enforces exactly that — two Spaces giving opposite answers to one server
    // signal is a difference that drifts.
    //
    // The refusal case above is NOT this case and keeps its 2026-08-02
    // behaviour: a refused document stays editable so its content can still be
    // copied out. Told apart by `status === 'authFailed'`, which a degrade
    // never sets.
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-capped' />);
    await screen.findByTestId('document-toolbar');

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('false'),
    );
  });

  it('shuts the formatting toolbar on a degraded connection too', async () => {
    // Stopping the keyboard is not enough. Every toolbar command runs
    // `editor.chain().focus().toggleX().run()`, which dispatches into the same
    // shared Y.Doc whether or not the editor is editable — @tiptap/core's
    // `createChain` has no editability test. A degraded person who cannot type
    // could otherwise still bold, quote, list, undo and redo, and the server
    // would drop every one of those in silence.
    //
    // Asserted on the PROP rather than on `disabled`, because in jsdom the
    // buttons are disabled anyway: `state.available` comes from
    // `tool.canRun(editor)`, which is false on an empty document with no
    // selection. A `toBeDisabled()` assertion here passes with or without the
    // gate — it was written that way first, and the control case that was
    // supposed to keep it honest failed, which is what exposed it.
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-capped' />);
    await screen.findByTestId('document-toolbar');
    await waitFor(() => expect(editorProps.readOnly).toBe(true));
  });

  it('leaves the formatting toolbar alone on a healthy connection', async () => {
    // The control for the case above: without it, "readOnly is true" could be
    // the component's default rather than the degrade's doing.
    render(<DocumentSpace projectId='p1' spaceId='doc-healthy' />);
    await screen.findByTestId('document-toolbar');
    await waitFor(() => expect(editorProps.readOnly).toBe(false));
  });

  it('does not nag a viewer about being read-only — they already know', async () => {
    // A viewer's read-only is their role, shown by the UI everywhere else, so
    // announcing it would be noise on every document they ever open.
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-viewer' readOnly />);
    await screen.findByTestId('document-toolbar');

    expect(toast.warning).not.toHaveBeenCalled();
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
    // The whole set, not a sample: this Space is what mounts the toolbar in
    // production, so a control that stops reaching the screen here reaches
    // nobody. `DocumentEditor.test` pins the same list one layer down; both
    // matter, because a control can exist in the toolbar component and still
    // fail to arrive through this container.
    render(<DocumentSpace projectId='p' spaceId='s' />);
    await screen.findByTestId('document-toolbar');
    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-tool-', ''));
    expect(ids.sort()).toEqual([
      'bold',
      'bullet-list',
      'italic',
      'ordered-list',
      'quote',
      'redo',
      'strike',
      'undo',
    ]);
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
