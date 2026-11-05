// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { probe } = vi.hoisted(() => ({
  probe: { mounts: 0, providers: [] as unknown[] },
}));

vi.mock('@web/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));
vi.mock('@web/spaces/canvas/use-publish-activity', () => ({ CanvasActivityPublisher: (): null => null }));
// The Space body is replaced by a probe that counts its mounts and reads the
// connection it is given; the connection itself (`SpaceConnection`, `useSocket`,
// the provider registry) is the real one under test.
vi.mock('@web/pages/project/SpaceOutlet', async () => {
  const { useSpaceConnection } = await import('@web/data/yjs/space-connection');
  const { useEffect } = await import('react');
  return {
    SpaceOutlet: function SpaceOutletProbe(): null {
      const { provider } = useSpaceConnection();
      useEffect(() => { probe.mounts += 1; }, []);
      useEffect(() => { probe.providers.push(provider); }, [provider]);
      return null;
    },
  };
});

import { latestProvider, refuse, resetProviderSpies, runTimers } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { CollabSocketProvider, readDocConnection, readDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { _resetForTests } from '@web/data/yjs/manager';
import { OpenSpace } from '@web/pages/project/OpenSpace';

const NAME = 'project-p1/canvas-s1';

beforeEach(() => {
  resetProviderSpies();
  probe.mounts = 0;
  probe.providers.length = 0;
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('OpenSpace after a size refusal (W-120)', () => {
  it('W-120 remounts the Space subtree on the rebuilt connection and the old unmount leaves it alone', async () => {
    render(
      <CollabSocketProvider userId='u1'>
        <OpenSpace projectId='p1' spaceId='s1' type='canvas' active visited />
      </CollabSocketProvider>,
    );
    await waitFor(() => expect(probe.mounts).toBe(1));
    const old = latestProvider(NAME);
    await waitFor(() => expect(probe.providers.at(-1)).toBe(old));

    refuse(old);
    await waitFor(() => expect(probe.mounts).toBe(2));
    const next = latestProvider(NAME);
    expect(next).not.toBe(old);
    await waitFor(() => expect(probe.providers.at(-1)).toBe(next));

    await runTimers();
    await act(async () => { await Promise.resolve(); });
    expect(readDocProvider(NAME)).toBe(next);
    expect(readDocConnection(NAME)).not.toBeNull();
    expect(next.destroy).toHaveBeenCalledTimes(0);
  });
});
