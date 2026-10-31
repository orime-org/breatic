// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';
import type * as Y from 'yjs';

const { sockets, providers, lifetimeMount, lifetimeRelease } = vi.hoisted(() => ({
  sockets: [] as Array<{ destroy: ReturnType<typeof vi.fn> }>,
  providers: [] as Array<{ config: { name: string; document: Y.Doc; websocketProvider: unknown }; destroy: ReturnType<typeof vi.fn> }>,
  lifetimeMount: vi.fn(),
  lifetimeRelease: vi.fn(),
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
    on = vi.fn();
    constructor() { sockets.push(this); }
  },
  HocuspocusProvider: class {
    destroy = vi.fn();
    attach = vi.fn();
    on = vi.fn();
    off = vi.fn();
    synced = false;
    constructor(public config: { name: string; document: Y.Doc; websocketProvider: unknown }) { providers.push(this); }
  },
}));
vi.mock('@web/pages/project/SpaceOutlet', () => ({ SpaceOutlet: (): null => null }));
vi.mock('@web/spaces/canvas/use-publish-activity', () => ({ CanvasActivityPublisher: (): null => null }));
vi.mock('@web/spaces/document/DocumentInterceptGuard', () => ({ DocumentInterceptGuard: (): null => null }));
vi.mock('@web/data/yjs/scene-lifetime', () => ({
  /** Observe the lifetime host's position relative to Activity without replacing the connection being tested. */
  SceneConnectionLifetime: ({ name, readOnly }: { name: string; readOnly?: boolean }): null => {
    React.useEffect(() => {
      lifetimeMount(name, readOnly);
      return () => { lifetimeRelease(name); };
    }, [name, readOnly]);
    return null;
  },
}));

import { CollabSocketProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, hasDoc, _resetForTests } from '@web/data/yjs/manager';
import { OpenSpace, SpaceConnection } from '@web/pages/project/OpenSpace';

const NAME = 'project-p1/3d-s1';

beforeEach(() => {
  vi.useFakeTimers();
  _resetCollabSocketForTests();
  _resetForTests();
  providers.length = 0;
  sockets.length = 0;
  lifetimeMount.mockClear();
  lifetimeRelease.mockClear();
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  vi.useRealTimers();
});

/** Build the real Space connection under the currently resolved account. */
function connection(accountId?: string): React.JSX.Element {
  return <CollabSocketProvider userId={accountId}><SpaceConnection name={NAME}>Scene</SpaceConnection></CollabSocketProvider>;
}

describe('3D Space shared connection lifecycle', () => {
  it('binds the scene connection to the canonical document used by Space consumers', () => {
    const canonical = getDoc(NAME);
    render(connection('account-a'));
    expect(providers).toHaveLength(1);
    expect(providers[0].config.name).toBe(NAME);
    expect(providers[0].config.document).toBe(canonical);
    expect(hasDoc(NAME)).toBe(true);
  });

  it('does not connect before an account is resolved', () => {
    const { rerender } = render(connection());
    expect(providers).toHaveLength(0);
    expect(hasDoc(NAME)).toBe(true);

    rerender(connection('account-a'));

    expect(providers).toHaveLength(1);
    expect(providers[0].config.document).toBe(getDoc(NAME));
    expect(hasDoc(NAME)).toBe(true);
    expect(providers[0].config.name).toBe(NAME);
  });

  it('releases the old document before connecting the next account', () => {
    const oldDoc = getDoc(NAME);
    oldDoc.getMap('objects').set('old-work', 'account-a');
    const { rerender } = render(connection('account-a'));
    rerender(connection('account-b'));
    act(() => vi.runAllTimers());

    expect(providers).toHaveLength(2);
    expect(providers[0].destroy).toHaveBeenCalledOnce();
    expect(providers[1].config.document).toBe(getDoc(NAME));
    expect(providers[1].config.document.getMap('objects').size).toBe(0);
    expect(providers[1].destroy).not.toHaveBeenCalled();
    expect(oldDoc.isDestroyed).toBe(true);
  });

  it('keeps a same-account StrictMode remount on one live provider', () => {
    render(<React.StrictMode>{connection('account-a')}</React.StrictMode>);
    act(() => vi.runAllTimers());
    expect(providers).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(providers[0].destroy).not.toHaveBeenCalled();
  });

  it('closes the old cookie handshake before mounting the next account meta and scene documents', () => {
    /** Keep the same Project mounted while the authenticated account changes. */
    const project = (accountId: string): React.JSX.Element => (
      <CollabSocketProvider userId={accountId}>
        <SpaceConnection name='project-p1/meta'>Meta</SpaceConnection>
        <SpaceConnection name={NAME}>Scene</SpaceConnection>
      </CollabSocketProvider>
    );
    const { rerender } = render(project('account-a'));
    const firstMeta = providers.find((provider) => provider.config.name === 'project-p1/meta')!;
    const firstScene = providers.find((provider) => provider.config.name === NAME)!;
    firstMeta.config.document.getMap('spaces').set('old-account', true);
    firstScene.config.document.getMap('objects').set('pending', 'account-a');
    const destroyOldScene = vi.spyOn(firstScene.config.document, 'destroy');

    rerender(project('account-b'));
    act(() => vi.runAllTimers());

    expect(sockets).toHaveLength(2);
    expect(sockets[0].destroy).toHaveBeenCalledOnce();
    expect(sockets[1].destroy).not.toHaveBeenCalled();
    expect(firstMeta.destroy).toHaveBeenCalledOnce();
    expect(firstScene.destroy).toHaveBeenCalledOnce();
    expect(providers).toHaveLength(4);
    const nextMeta = providers[2];
    const nextScene = providers[3];
    expect(nextMeta.config.document).not.toBe(firstMeta.config.document);
    expect(nextMeta.config.document.getMap('spaces').size).toBe(0);
    expect(nextScene.config.document).toBe(getDoc(NAME));
    expect(nextScene.config.document.getMap('objects').size).toBe(0);
    expect(nextMeta.config.websocketProvider).toBe(sockets[1]);
    expect(nextScene.config.websocketProvider).toBe(sockets[1]);
    expect(destroyOldScene).toHaveBeenCalledOnce();
    expect(firstScene.config.document.isDestroyed).toBe(true);
  });

  it('keeps the scene permission lifetime outside the hidden Activity body', () => {
    const { rerender, unmount } = render(
      <CollabSocketProvider userId='account-a'>
        <OpenSpace projectId='p1' spaceId='s1' type='3d' active visited readOnly />
      </CollabSocketProvider>,
    );
    expect(lifetimeMount).toHaveBeenCalledWith(NAME, true);
    rerender(
      <CollabSocketProvider userId='account-a'>
        <OpenSpace projectId='p1' spaceId='s1' type='3d' active={false} visited readOnly />
      </CollabSocketProvider>,
    );
    expect(lifetimeRelease).not.toHaveBeenCalled();
    expect(lifetimeMount).toHaveBeenCalledTimes(1);
    unmount();
    expect(lifetimeRelease).toHaveBeenCalledOnce();
  });
});
