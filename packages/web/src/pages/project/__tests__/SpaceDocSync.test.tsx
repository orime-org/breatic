// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import * as React from 'react';

import type { SpaceType } from '@web/spaces';

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
import { SpaceDocSync } from '@web/pages/project/SpaceDocSync';
import {
  _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { _resetForTests } from '@web/data/yjs/manager';

interface Tab {
  id: string;
  type: SpaceType;
}

/** Render the open-tab attachment list inside a shared-socket provider. */
function tree(tabs: ReadonlyArray<Tab>): React.JSX.Element {
  return (
    <CollabSocketProvider userId='u1'>
      {tabs.map((t) => (
        <SpaceDocSync key={t.id} projectId='p1' spaceId={t.id} type={t.type} />
      ))}
    </CollabSocketProvider>
  );
}

describe('SpaceDocSync — attach lifecycle follows OPEN tabs, not the active tab', () => {
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

  it('does NOT attach for non-canvas tabs (document / timeline have no Yjs doc yet)', () => {
    render(
      tree([
        { id: 'd', type: 'document' },
        { id: 't', type: 'timeline' },
      ]),
    );
    expect(providerInstances).toHaveLength(0);
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
