// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import * as ProviderModule from '@hocuspocus/provider';
import {
  confirmLatest, flush, handshake, resetProviderSpies, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { bindDocSync } from '@web/data/yjs/doc-sync-binding';
import { acquireDocProvider, hasProjectUnsyncedEdits, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';

beforeEach(() => {
  resetProviderSpies();
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('bindDocSync versions() (W-124)', () => {
  it('W-124 reports local and confirmed versions as a read-only snapshot', async () => {
    const name = 'project-p1/canvas-s1';
    const doc = new Y.Doc();
    const socket = new ProviderModule.HocuspocusProviderWebsocket({ url: 'ws://test' });
    const provider = new ProviderModule.HocuspocusProvider({ name, document: doc, websocketProvider: socket });
    const spy = provider as unknown as ProviderSpy;
    spy.isAttached = true;
    const binding = bindDocSync(name, doc, provider as HocuspocusProvider, () => undefined);
    try {
      expect(binding.versions()).toEqual({ localVersion: 0, confirmedVersion: 0 });
      await handshake(name, spy);
      act(() => { doc.getMap('nodesMap').set('n1', 1); });
      await flush();
      expect(binding.versions()).toEqual({ localVersion: 1, confirmedVersion: 0 });
      await confirmLatest(spy);
      const v2 = binding.versions();
      expect(v2).toEqual({ localVersion: 1, confirmedVersion: 1 });
      Reflect.set(v2, 'localVersion', 99);
      expect(binding.versions()).toEqual({ localVersion: 1, confirmedVersion: 1 });
    } finally {
      binding.dispose();
      doc.destroy();
    }
  });
});

describe('3D documents have no receipts (W-126)', () => {
  it('W-126 a 3D edit sends no sync:confirm and does not mark the Project unsynced', async () => {
    const name = 'project-p1/3d-s4';
    const doc = getDoc(name);
    const provider = acquireDocProvider(name, doc) as unknown as ProviderSpy;
    await handshake(name, provider);
    act(() => { doc.getMap('objects').set('o1', 1); });
    await flush();
    expect(provider.sendStateless).toHaveBeenCalledTimes(0);
    expect(hasProjectUnsyncedEdits('p1')).toBe(false);
  });
});
