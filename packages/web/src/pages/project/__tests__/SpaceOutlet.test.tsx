// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { encodeInitialSpaceContent } from '@breatic/shared';

import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';

const queryClients: QueryClient[] = [];
const SYNCED: SocketState = {
  provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
};

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  _resetForTests();
});

/**
 * Apply the backend's actual initial content to the manager-owned Space doc.
 * @param projectId - The Project whose body must be selected by the outlet.
 * @param spaceId - The Timeline identity passed through the outlet.
 * @returns The same document read by the real Timeline component.
 * @throws {Error} When the shared seed cannot be encoded or applied.
 */
function seedTimeline(projectId: string, spaceId: string): Y.Doc {
  const doc = getDoc(docName.timelineSpace(projectId, spaceId));
  Y.applyUpdate(doc, encodeInitialSpaceContent('timeline', { width: 1920, height: 1080, fps: { num: 24, den: 1 } }), 'server');
  return doc;
}

// Stubbed to expose what it was HANDED, which is the only thing this file can
// answer for. Whether the notice then uses the role correctly is asserted in
// its own tests, against the real component.
//
// The role reaching it is load-bearing and easy to drop silently: the notice
// fires on the server's read-only flag, which is also set for every viewer, so
// an outlet that forgets to pass the role shows every viewer a warning that
// their editing was taken away. That is exactly what shipped in this branch
// before Gate 2 round 4 caught it, and nothing failed at the time.
vi.mock('@web/pages/project/SpaceReadOnlyNotice', () => ({
  SpaceReadOnlyNotice: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid='notice-stub' data-readonly={String(readOnly)} />
  ),
}));

/**
 * Mounts the outlet with a query client around it, the way the real app does
 * (`App.tsx` wraps everything in one).
 *
 * Takes the element rather than its props, so every call site keeps writing
 * the props it means and this only owns the wrapper. A fresh client per mount
 * keeps one test's cached catalog out of the next one's gate — a constraint
 * that lives in one place here instead of being restated at every call.
 * @param element - The outlet to mount, with whatever props the case needs.
 * @param connection - The Timeline tab's actual content-connection facts.
 * @returns The render result.
 */
function renderOutlet(element: React.JSX.Element, connection?: SocketState): ReturnType<typeof render> {
  const client = new QueryClient();
  queryClients.push(client);
  return render(
    <QueryClientProvider client={client}>
      {connection === undefined ? element : <SpaceConnectionContext.Provider value={connection}>{element}</SpaceConnectionContext.Provider>}
    </QueryClientProvider>,
  );
}

describe('SpaceOutlet', () => {
  it('points the body at THIS Space of THIS project', () => {
    // Round 6 measured that swapping these two on the body was invisible to
    // every test in this directory — the existing body cases only ask WHICH
    // component rendered. A body pointed at the wrong document silently shows
    // another Space's content.
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    const body = screen.getByTestId('canvas-space');
    expect(body).toHaveAttribute('data-project-id', 'p');
    expect(body).toHaveAttribute('data-space-id', 's');
  });

  it('hands the viewer role to the read-only notice, not just to the body', () => {
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='canvas' readOnly />);
    expect(screen.getByTestId('notice-stub')).toHaveAttribute(
      'data-readonly',
      'true',
    );
  });

  it('tells the notice an editor is an editor', () => {
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    // `undefined`, not `false`: the outlet forwards its own optional prop
    // untouched and the notice defaults it. Asserting the string keeps this
    // honest about which side owns the default.
    expect(screen.getByTestId('notice-stub')).toHaveAttribute(
      'data-readonly',
      'undefined',
    );
  });

  it('renders the canvas body for type=canvas', () => {
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
  });

  it('renders the document body for type=document', () => {
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='document' />);
    expect(screen.getByTestId('document-space')).toBeInTheDocument();
  });

  it('renders the timeline body for type=timeline (empty state)', () => {
    const doc = seedTimeline('p', 's');
    const before = Y.encodeStateAsUpdate(doc);
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='timeline' />, SYNCED);
    expect(screen.getByTestId('timeline-space-empty')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-space')).toHaveAttribute('data-project-id', 'p');
    expect(screen.getByTestId('timeline-space')).toHaveAttribute('data-space-id', 's');
    expect(screen.queryByTestId('timeline-space-loading')).toBe(null);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('keeps a seeded Timeline loading until its Space connection has first synced', () => {
    const doc = seedTimeline('p', 's-before-sync');
    const before = Y.encodeStateAsUpdate(doc);
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s-before-sync' type='timeline' />, {
      ...SYNCED, synced: false, hasEverSynced: false, status: 'connecting', writeAccess: 'unknown',
    });
    expect(screen.getByTestId('timeline-space-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-space-empty')).toBe(null);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('forwards readOnly to the space body (viewer gate reaches the canvas)', () => {
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='canvas' readOnly />);
    expect(screen.getByTestId('canvas-space')).toHaveAttribute(
      'data-readonly',
      'true',
    );
  });

  it('omits the read-only marker for editors', () => {
    renderOutlet(<SpaceOutlet projectId='p' spaceId='s' type='canvas' />);
    expect(screen.getByTestId('canvas-space')).not.toHaveAttribute(
      'data-readonly',
    );
  });
});
