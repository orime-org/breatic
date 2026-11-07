// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import {
  flush, handshake, resetProviderSpies, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { acquireDocProvider, hasProjectUnsyncedEdits, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';

beforeEach(() => {
  resetProviderSpies();
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
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
