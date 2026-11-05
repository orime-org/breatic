// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import { push, resetProviderSpies, type ProviderSpy } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { F_FULL } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';
import { readDocSize } from '@web/data/yjs/doc-size';
import { writeSnapshotNodes } from '@web/data/yjs/canvas-space';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';

const NAME = 'project-p1/canvas-s1';
const N9 = { id: 'n9', type: 'image', position: { x: 0, y: 0 }, data: {} };

beforeEach(() => {
  resetProviderSpies();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
});

// The gate for a live Space sits in the caller's runCanvasUndoBatch (W-64 to W-69).
describe('writeSnapshotNodes on its own does not check the size (W-137)', () => {
  it('W-137a writes into a full live Space document without a toast', () => {
    const doc = getDoc(NAME);
    const provider = acquireDocProvider(NAME, doc) as unknown as ProviderSpy;
    push(provider, F_FULL);
    expect(readDocSize(NAME).phase).toBe('full');
    writeSnapshotNodes(doc, [N9], []);
    expect(doc.getMap('nodesMap').has('n9')).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(0);
  });

  it('W-137b writes into a throwaway document that has no provider', () => {
    const tmp = new Y.Doc();
    try {
      writeSnapshotNodes(tmp, [N9], []);
      expect(tmp.getMap('nodesMap').has('n9')).toBe(true);
      expect(toast.warning).toHaveBeenCalledTimes(0);
    } finally { tmp.destroy(); }
  });
});
