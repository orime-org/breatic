// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

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

    expect(await screen.findByTestId('document-editor-content')).toBeInTheDocument();
    expect(screen.queryByTestId('document-space-unavailable')).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('true'),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('leaves the degrade notice to the outlet, and still takes typing', async () => {
    // Changed 2026-08-14 (#88). This used to raise a toast here. A degrade is a
    // STATE — it holds for as long as this connection does — and a toast is
    // for events: it goes away after four seconds, and whoever missed them
    // finds out by watching their edits fail to stick. It is now announced by
    // `SpaceReadOnlyNotice`, inside the Space, for as long as it lasts, and
    // every Space type gets it from the outlet rather than each writing one.
    //
    // What this Space still owns is the REFUSAL (the case above). And the
    // editor stays editable either way — enforcing read-only in the frontend
    // is a separate piece of work, deliberately not in this change.
    socketState.writeAccess = 'denied';
    render(<DocumentSpace projectId='p1' spaceId='doc-capped' />);
    await screen.findByTestId('document-editor-content');

    expect(toast.warning).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('true'),
    );
  });

  // Removed 2026-08-14 (#88): "does not nag a viewer about being read-only".
  // It guarded the `!readOnly` term of a toast this Space no longer raises, so
  // it had become true no matter what the code did, and the case above already
  // asserts the same silence under weaker conditions. The rule it protected did
  // not go away — it moved with the notice, and is asserted where the notice
  // now lives (`SpaceReadOnlyNotice.test.tsx`, "says nothing to a viewer"),
  // where deleting the role term does turn it red.

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
    expect(await screen.findByTestId('document-editor-content')).toBeInTheDocument();

    unmount();
    socketState.synced = false;
    render(<DocumentSpace projectId='p1' spaceId='doc-tabswitch' />);

    expect(await screen.findByTestId('document-editor-content')).toBeInTheDocument();
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
    expect(await screen.findByTestId('document-editor-content')).toBeInTheDocument();

    socketState.synced = false;
    rerender(<DocumentSpace projectId='p1' spaceId='doc-reconnect' />);

    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
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
    expect(screen.queryByTestId('document-editor-content')).toBeNull();
  });

  it('renders the editor mount', async () => {
    render(<DocumentSpace projectId='p1' spaceId='doc-1' />);
    expect(await screen.findByTestId('document-space')).toBeInTheDocument();
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
  });

  it('forwards projectId / spaceId via data attributes', async () => {
    render(<DocumentSpace projectId='alpha' spaceId='beta' />);
    const root = await screen.findByTestId('document-space');
    expect(root.getAttribute('data-project-id')).toBe('alpha');
    expect(root.getAttribute('data-space-id')).toBe('beta');
  });

  it('gets the whole-document entry onto the screen', async () => {
    // This Space is what mounts the entry in production: not arriving here
    // means nobody sees it. What the entry opens onto is pinned a layer down in
    // `document-menu-entry.test`. Both layers matter — a control can be fine
    // inside its own component and never make it through this container.
    //
    // This counted the toolbar's eight buttons until #129 removed it. What
    // arrives through the container now is the entry; the bubble bar needs a
    // selection, and its arrival is pinned in `selection-bubble-bar.test`.
    render(<DocumentSpace projectId='p' spaceId='s' />);
    await screen.findByTestId('document-editor-content');
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
  });

  it('binds the editor to THIS Space’s document, not some other doc', async () => {
    render(<DocumentSpace projectId='proj' spaceId='space-7' />);
    await screen.findByTestId('document-editor-content');

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
    await screen.findByTestId('document-editor-content');

    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('false'),
    );
  });
});

describe('正文还没到之前', () => {
  afterEach(() => {
    socketState.hasEverSynced = true;
  });

  it('编辑器一次都不被建出来', async () => {
    // 编辑器不能先建、再等内容 —— 内容一到，y-tiptap 就把这份 Yjs 文档转成
    // ProseMirror 文档，而那一步会把它表示不了的东西**从共享文档里删掉**。
    // 删除发生在 Yjs 的类型 observer 里，早于 `doc.on('update')`，所以拦截
    // 判定去数「有几个不认识的名字」时，名字已经没了 —— 它永远看不见自己
    // 本该拦住的那次破坏。
    //
    // 所以顺序必须是：内容先到 → 判定 → 再决定建不建。
    socketState.hasEverSynced = false;
    const cache = await import('@web/spaces/document/document-editor-cache');
    const spy = vi.spyOn(cache, 'getDocumentEditor');

    render(<DocumentSpace projectId='p-sync' spaceId='s-sync' />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(spy).not.toHaveBeenCalled();
    expect(document.querySelector('.ProseMirror')).toBeNull();
    spy.mockRestore();
  });
});
