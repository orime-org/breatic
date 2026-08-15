// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpaceReadOnlyNotice } from '@web/pages/project/SpaceReadOnlyNotice';
import { setLocale } from '@breatic/shared';
import { _resetForTests } from '@web/data/yjs/manager';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// Keyed on the DOCUMENT name, which is the whole point: the seat ceiling counts
// writable connections to one document, so a full canvas says nothing about the
// document Space beside it. A stub returning one flag for everything could not
// tell a correct component from one that reports the wrong Space's state.
//
// The stub hands over the RAW facts the server sends — what it granted, and
// which lifecycle state the socket is in — never a ready-made verdict. That is
// deliberate: the verdict is what this component computes, and a stub that
// computed it too would leave the real derivation untested (Gate 2 round 4
// found exactly that).
//
// It carries ALL FOUR values of `ConnectionStatus`, not just the two the happy
// path visits. Round 5 measured why: with only `connected` and `authFailed` in
// play, narrowing the guard to `status === 'connected'` — which kills the
// notice for the whole of every reconnect — left all eight tests green.
type Fake = {
  writeAccess: 'unknown' | 'granted' | 'denied';
  status: 'connecting' | 'connected' | 'authFailed' | 'disconnected';
};
const GRANTED: Fake = { writeAccess: 'granted', status: 'connected' };
const socketByDoc = new Map<string, Fake>();

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: ({ name }: { name: string }) => {
    const fake = socketByDoc.get(name) ?? GRANTED;
    return {
      provider: null,
      synced: fake.status === 'connected',
      hasEverSynced: true,
      status: fake.status,
      writeAccess: fake.writeAccess,
      authFailedReason: fake.status === 'authFailed' ? 'Forbidden' : null,
    };
  },
}));

/** The server denied writes to this document and the socket is healthy. */
function degrade(name: string): void {
  socketByDoc.set(name, { writeAccess: 'denied', status: 'connected' });
}

describe('SpaceReadOnlyNotice', () => {
  beforeEach(() => {
    socketByDoc.clear();
    _resetForTests();
  });

  it('says so when the server degraded this connection to read-only', () => {
    degrade('project-p1/canvas-s1');
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' />);
    const notice = screen.getByTestId('space-read-only-notice');
    expect(notice).toBeInTheDocument();
    // Announced without stealing focus: this arrives while the user is working,
    // and an alert would interrupt whatever they are doing to say "wait".
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('aria-live', 'polite');
  });

  it('stays out of the way while this connection may write', () => {
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' />);
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  it('says nothing to a viewer — being read-only is their role, not a degrade', () => {
    // The server sends one flag for three different causes: this document is
    // meta, this member is a viewer, or the document is at its ceiling
    // (collab hooks/auth.ts). A viewer is read-only everywhere, always, and
    // telling them their editing was taken away describes something that never
    // happened. The role is the caller's to supply — the connection does not
    // carry it.
    degrade('project-p1/canvas-s1');
    render(
      <SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' readOnly />,
    );
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  it('keeps saying so while the socket is away reconnecting', () => {
    // `useSocket` deliberately does NOT clear `writeAccess` when the socket
    // closes (see its `onClose`), so a degraded document sits at denied +
    // disconnected for the whole reconnect window — seconds at least, and the
    // client gives up and redials before the server times the old seat out.
    // The state has not changed and neither should the notice.
    //
    // This case is why the guard is `status !== 'authFailed'` and not
    // `status === 'connected'`. Round 5 measured that swap: with no test
    // visiting this state, it killed the notice on every reconnect and left
    // the whole suite green.
    socketByDoc.set('project-p1/canvas-s1', {
      writeAccess: 'denied',
      status: 'disconnected',
    });
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' />);
    expect(screen.getByTestId('space-read-only-notice')).toBeInTheDocument();
  });

  it('waits for the server to answer before claiming anything', () => {
    // Every connection starts here: `writeAccess: 'unknown'` means the
    // handshake has not come back yet, which is not the same as being denied.
    // Treating "not granted" as "denied" would flash the capsule at the top of
    // every Space on every page load, and the two look identical until the
    // answer lands.
    socketByDoc.set('project-p1/canvas-s1', {
      writeAccess: 'unknown',
      status: 'connecting',
    });
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' />);
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  it('says nothing when the server REFUSED the document', () => {
    // Deleted Space, revoked membership, expired session. Writes are denied
    // here too, but "wait for a seat, or reconnect" is advice this person
    // cannot act on — each Space says that one its own way.
    socketByDoc.set('project-p1/canvas-s1', {
      writeAccess: 'denied',
      status: 'authFailed',
    });
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' />);
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  it('reports per document — a full canvas is silent in the document Space', () => {
    // Same Space id, different kinds. The doc name carries the kind, so these
    // are two separate documents with two separate ceilings.
    degrade('project-p1/canvas-s1');
    const { unmount } = render(
      <SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='canvas' />,
    );
    expect(screen.getByTestId('space-read-only-notice')).toBeInTheDocument();
    unmount();

    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='document' />);
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  it('renders nothing for a Space type that has no document of its own', () => {
    // Timeline has no Yjs document yet, so there is no connection to report on.
    //
    // What this pins is the OUTCOME — nothing rendered, nothing thrown. It does
    // NOT pin the two-component split that keeps the hooks unconditional:
    // measured in round 5, inlining them past the early return leaves this
    // green, because React only objects once the hook count actually changes
    // between renders of the same element. `react-hooks/rules-of-hooks`
    // (error, `packages/web/eslint.config.mts:65`) is what catches that, and it
    // catches it at author time rather than here.
    expect(() =>
      render(
        <SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='timeline' />,
      ),
    ).not.toThrow();
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  // Reconnecting is the ONLY way out: the connection's read-only flag is fixed
  // for its whole life (collab sets it once, at the handshake) and nothing
  // tells a connected client that a seat has come free.
  it('offers a reconnect control, the only way out of a degrade', () => {
    degrade('project-p1/document-s2');
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s2' type='document' />);
    expect(
      screen.getByTestId('space-read-only-notice-reconnect'),
    ).toBeInstanceOf(HTMLButtonElement);
  });

  it('shows this catalog its own words, in every locale we ship', () => {
    // Asserts what the component PUTS ON SCREEN against each catalog, not that
    // two named keys exist. The difference is measurable: round 5 pointed the
    // component at `spaces.document.loading` — so the capsule read "Loading
    // editor…" — and the key-existence version of this test stayed green in all
    // five languages. Reading the expected text out of the catalog rather than
    // hard-coding it keeps this from becoming a second place to edit the copy.
    try {
      for (const [tag, catalog] of LOCALE_CATALOGS) {
        setLocale(tag);
        degrade('project-p1/canvas-locale');
        const { unmount } = render(
          <SpaceReadOnlyNotice
            projectId='p1'
            spaceId='locale'
            type='canvas'
          />,
        );
        const notice = screen.getByTestId('space-read-only-notice');
        expect(
          notice.textContent,
          `${tag}: the notice's sentence`,
        ).toContain(readPath(catalog, 'spaces.readOnlyNotice'));
        expect(
          screen.getByTestId('space-read-only-notice-reconnect').textContent,
          `${tag}: the reconnect button`,
        ).toBe(readPath(catalog, 'spaces.readOnlyReconnect'));
        unmount();
        socketByDoc.clear();
      }
    } finally {
      // Back to what `vitest.setup.ts` selects, so the next file is unaffected.
      setLocale('en');
    }
  });
});
