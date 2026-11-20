// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { SCENE_LOOK_SETTLED_SIGNAL } from '@breatic/shared';

const settled = vi.fn();
vi.mock('@web/spaces/three-d/scene-look-uploads', () => ({ pageSceneLookUploads: () => ({ settled }) }));

const { useSceneLookSettlements } = await import('@web/pages/project/use-scene-look-settlements');

const PROJECT = 'p-1';
const ME = 'u-1';

/**
 * A meta-doc provider double that hands its listener to the test.
 * @returns The provider and a sender.
 */
function providerDouble(): { provider: { on: (e: string, f: (d: { payload: string }) => void) => void; off: (e: string, f: (d: { payload: string }) => void) => void }; send: (payload: unknown) => void } {
  const listeners = new Set<(d: { payload: string }) => void>();
  return {
    provider: { on: (_event, f) => { listeners.add(f); }, off: (_event, f) => { listeners.delete(f); } },
    send: (payload) => { for (const listener of listeners) listener({ payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }); },
  };
}

/**
 * Mount the hook over a provider double.
 * @param provider - The double.
 * @returns The rendered hook.
 */
function mount(provider: ReturnType<typeof providerDouble>['provider']): ReturnType<typeof renderHook> {
  const client = new QueryClient();
  return renderHook(() => useSceneLookSettlements(PROJECT, provider as never, ME), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

describe('handing the uploader how collab settled their part picture (inner#1693 design 6.3)', () => {
  const settlement = { projectId: PROJECT, spaceId: 's-1', objectId: 'o-1', part: '3', picture: 'a-1', userId: ME, outcome: 'partChanged' };

  it('hands this user\'s settlements in this project to the page\'s uploads, and no other signal', () => {
    settled.mockClear();
    const { provider, send } = providerDouble();
    mount(provider);

    send({ t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement });
    send({ t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement, userId: 'someone-else' });
    send({ t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement, projectId: 'other' });
    send({ t: 'space-tasks:changed', projectId: PROJECT, spaceId: 's-1' });
    send('not json');

    send({ t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement, outcome: 'written', picture: 'a-2' });
    send({ t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement, outcome: 'unknown' });

    expect(settled.mock.calls).toEqual([
      [{ spaceId: 's-1', objectId: 'o-1', part: '3', picture: 'a-1', outcome: 'partChanged' }],
      [{ spaceId: 's-1', objectId: 'o-1', part: '3', picture: 'a-2', outcome: 'written' }],
    ]);
  });

  it('stops listening when unmounted', () => {
    settled.mockClear();
    const { provider, send } = providerDouble();
    const { unmount } = mount(provider);
    unmount();
    send({ t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement });
    expect(settled).not.toHaveBeenCalled();
  });
});
