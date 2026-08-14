// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpaceReadOnlyNotice } from '@web/pages/project/SpaceReadOnlyNotice';
import { _resetForTests } from '@web/data/yjs/manager';
import { expectEveryLocaleRenders } from '@web/test-utils/i18n-keys';

// Keyed on the DOCUMENT name, which is the whole point: the seat ceiling counts
// writable connections to one document, so a full canvas says nothing about the
// document Space beside it. A stub returning one flag for everything could not
// tell a correct component from one that reports the wrong Space's state.
const degradedDocs = new Set<string>();

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: ({ name }: { name: string }) => ({
    provider: null,
    synced: true,
    hasEverSynced: true,
    status: 'connected',
    writeAccess: degradedDocs.has(name) ? 'denied' : 'granted',
    degraded: degradedDocs.has(name),
    authFailedReason: null,
  }),
}));

describe('SpaceReadOnlyNotice', () => {
  beforeEach(() => {
    degradedDocs.clear();
    _resetForTests();
  });

  it('says so when the server degraded this connection to read-only', () => {
    degradedDocs.add('project-p1/canvas-s1');
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

  it('reports per document — a full canvas is silent in the document Space', () => {
    // Same Space id, different kinds. The doc name carries the kind, so these
    // are two separate documents with two separate ceilings.
    degradedDocs.add('project-p1/canvas-s1');
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
    // Timeline has no Yjs document yet, so there is no connection to report on
    // — and no hook may be called for it either. A crash here is the failure
    // this guards, not a missing notice.
    expect(() =>
      render(
        <SpaceReadOnlyNotice projectId='p1' spaceId='s1' type='timeline' />,
      ),
    ).not.toThrow();
    expect(
      screen.queryByTestId('space-read-only-notice'),
    ).not.toBeInTheDocument();
  });

  it('offers a reconnect control, because a degrade clears when a seat frees', () => {
    degradedDocs.add('project-p1/document-s2');
    render(<SpaceReadOnlyNotice projectId='p1' spaceId='s2' type='document' />);
    expect(
      screen.getByTestId('space-read-only-notice-reconnect'),
    ).toBeInstanceOf(HTMLButtonElement);
  });

  it('resolves its text in every locale we ship', () => {
    expectEveryLocaleRenders([
      { key: 'spaces.readOnlyNotice' },
      { key: 'spaces.readOnlyReconnect' },
    ]);
  });
});
