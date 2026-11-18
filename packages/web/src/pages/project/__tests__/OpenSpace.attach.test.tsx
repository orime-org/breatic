// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';

import { SPACE_TASKS_KEY, SPACE_TASKS_VERSION, type SpaceType } from '@breatic/shared';

// Spy transport — record every per-doc HocuspocusProvider + its destroy().
// Teardown is DEFERRED by the manager, so detach assertions run the timers.
const { providerInstances } = vi.hoisted(() => ({
  providerInstances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    synced: boolean;
    config: Record<string, unknown>;
  }>,
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
    on = vi.fn();
  },
  HocuspocusProvider: class {
    destroy = vi.fn();
    attach = vi.fn();
    on = vi.fn();
    off = vi.fn();
    synced = false;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      providerInstances.push(this);
    }
  },
}));

import { CollabSocketProvider } from '@web/data/yjs/collab-socket';
import { OpenSpace } from '@web/pages/project/OpenSpace';
import {
  _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { _resetForTests, getDoc } from '@web/data/yjs/manager';
import { spaceTasksQueryKey } from '@web/data/api/scene';

interface Tab {
  id: string;
  type: SpaceType;
}

/** Render the open-tab attachment list inside a shared-socket provider. */
function tree(tabs: ReadonlyArray<Tab>): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <CollabSocketProvider userId='u1'>
        {tabs.map((t) => (
          <OpenSpace key={t.id} projectId='p1' spaceId={t.id} type={t.type} active={false} visited={false} />
        ))}
      </CollabSocketProvider>
    </QueryClientProvider>
  );
}

/** The page's query cache, which the tabs of Space types that watch their background work read. */
const queryClient = new QueryClient();

describe('OpenSpace — attach lifecycle follows OPEN tabs, not the active tab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCollabSocketForTests();
    _resetForTests();
    providerInstances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches one provider per open canvas tab', () => {
    render(
      tree([
        { id: 'a', type: 'canvas' },
        { id: 'b', type: 'canvas' },
      ]),
    );
    expect(providerInstances).toHaveLength(2);
    expect(providerInstances.map((p) => p.config.name).sort()).toEqual([
      'project-p1/canvas-a',
      'project-p1/canvas-b',
    ]);
  });

  it('attaches Document and Timeline through the same shared socket lifecycle', () => {
    render(
      tree([
        { id: 'd', type: 'document' },
        { id: 't', type: 'timeline' },
      ]),
    );
    expect(providerInstances).toHaveLength(2);
    expect(providerInstances.map((p) => p.config.name).sort()).toEqual([
      'project-p1/document-d',
      'project-p1/timeline-t',
    ]);
    expect(providerInstances[1]!.config.websocketProvider).toBe(providerInstances[0]!.config.websocketProvider);
  });

  it('reads the task lists again when a Motion or Timeline document records a change, and leaves other types alone', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    render(
      tree([
        { id: 'm', type: 'web_animation' },
        { id: 't', type: 'timeline' },
        { id: 'c', type: 'canvas' },
      ]),
    );
    // Collab writes the version, so it reaches the tab as a remote update.
    const fromCollab = new Y.Doc();
    fromCollab.getMap(SPACE_TASKS_KEY).set(SPACE_TASKS_VERSION, '1-0');
    for (const name of ['project-p1/web_animation-m', 'project-p1/timeline-t', 'project-p1/canvas-c']) {
      act(() => { Y.applyUpdate(getDoc(name), Y.encodeStateAsUpdate(fromCollab)); });
    }
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      spaceTasksQueryKey('p1', 'm'),
      spaceTasksQueryKey('p1', 't'),
    ]);
    invalidate.mockRestore();
  });

  it('gives a canvas and a document tab their own separate documents', () => {
    render(
      tree([
        { id: 's', type: 'canvas' },
        { id: 's', type: 'document' },
      ]),
    );
    // Same space id, different kinds — the doc NAME carries the kind, so the
    // two must never collide on one Y.Doc.
    expect(providerInstances.map((p) => p.config.name).sort()).toEqual([
      'project-p1/canvas-s',
      'project-p1/document-s',
    ]);
  });

  it('switching the active tab does NOT detach any open tab (open list unchanged)', () => {
    const tabs: ReadonlyArray<Tab> = [
      { id: 'a', type: 'canvas' },
      { id: 'b', type: 'canvas' },
    ];
    const { rerender } = render(tree(tabs));
    expect(providerInstances).toHaveLength(2);
    // Re-render with the SAME open-tab list (an active-tab switch changes which
    // body renders, NOT the open list) — nothing unmounts, nothing detaches,
    // even after the deferred-teardown timers would have fired.
    rerender(tree(tabs));
    act(() => vi.runAllTimers());
    expect(
      providerInstances.every((p) => p.destroy.mock.calls.length === 0),
    ).toBe(true);
    expect(providerInstances).toHaveLength(2);
  });

  it('closing a tab detaches ONLY that tab (after the deferred tick)', () => {
    const { rerender } = render(
      tree([
        { id: 'a', type: 'canvas' },
        { id: 'b', type: 'canvas' },
      ]),
    );
    const aProvider = providerInstances.find(
      (p) => p.config.name === 'project-p1/canvas-a',
    )!;
    const bProvider = providerInstances.find(
      (p) => p.config.name === 'project-p1/canvas-b',
    )!;
    // Close tab 'a' (drop it from the open list).
    rerender(tree([{ id: 'b', type: 'canvas' }]));
    act(() => vi.runAllTimers());
    expect(aProvider.destroy).toHaveBeenCalledOnce();
    expect(bProvider.destroy).not.toHaveBeenCalled();
  });
});
