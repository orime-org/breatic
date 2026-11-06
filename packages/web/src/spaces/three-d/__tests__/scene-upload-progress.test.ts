// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneUploadEntry, SceneUploads } from '@web/spaces/three-d/scene-uploads';
import { publishUploadProgress } from '@web/spaces/three-d/scene-upload-progress';

/**
 * A page store whose entries the case sets directly.
 * @returns The store and a setter that notifies its listeners.
 */
function store(): { uploads: SceneUploads; set: (entries: Partial<SceneUploadEntry>[]) => void } {
  let entries: SceneUploadEntry[] = [];
  const listeners = new Set<() => void>();
  return {
    uploads: {
      start: vi.fn(), retry: vi.fn(), reconcile: vi.fn(), get: vi.fn(),
      list: (spaceId) => entries.filter((entry) => entry.spaceId === spaceId),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      getVersion: () => 0,
    },
    set: (next) => {
      entries = next.map((entry) => ({ taskId: 't', projectId: 'p', spaceId: 's', label: 'L', file: new File([], 'f'), phase: 'uploading', percent: 0, ...entry }));
      listeners.forEach((listener) => listener());
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('sharing this page\'s upload progress with a 3D Space (inner#1690)', () => {
  it('shares only this Space\'s sending uploads, no more often than the gap, ending on the latest value', () => {
    const { uploads, set } = store();
    const session = { setUploadProgress: vi.fn() };
    const stop = publishUploadProgress(uploads, session, 's', 1000);
    vi.advanceTimersByTime(0);
    expect(session.setUploadProgress).toHaveBeenLastCalledWith({});

    set([{ taskId: 'a', percent: 10 }, { taskId: 'b', spaceId: 'other', percent: 50 }, { taskId: 'c', phase: 'registering' }]);
    set([{ taskId: 'a', percent: 20 }, { taskId: 'b', spaceId: 'other', percent: 60 }, { taskId: 'c', phase: 'registering' }]);
    vi.advanceTimersByTime(999);
    expect(session.setUploadProgress).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(session.setUploadProgress).toHaveBeenLastCalledWith({ a: 20 });
    expect(session.setUploadProgress).toHaveBeenCalledTimes(2);
    stop();
    expect(session.setUploadProgress).toHaveBeenLastCalledWith({});
  });
});
