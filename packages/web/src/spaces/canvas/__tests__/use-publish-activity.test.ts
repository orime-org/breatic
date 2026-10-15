// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The tab's activity publisher (inner#1303 §6.8): the operations this client
 * waits on in a Space, written into awareness in the task they start or end,
 * kept while another Space is on screen and withdrawn when the tab closes.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { usePublishActivity } from '@web/spaces/canvas/use-publish-activity';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const open: Y.Doc[] = [];

/**
 * A fresh awareness on a fresh document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  open.push(doc);
  return new Awareness(doc);
}

afterEach(() => {
  for (const doc of open.splice(0)) doc.destroy();
});

describe('usePublishActivity', () => {
  /**
   * Read back the activity this client publishes.
   * @param awareness - The awareness to read.
   * @returns The published list, or null.
   */
  function activityOf(awareness: Awareness): unknown {
    return (awareness.getLocalState() as { activity?: unknown } | null)?.activity ?? null;
  }

  /**
   * Mount the publisher for Space 'S'.
   * @param awareness - The awareness to write.
   * @param synced - Whether the document has synced.
   * @returns The rendered hook.
   */
  function mount(awareness: Awareness, synced = true): ReturnType<typeof renderHook<void, { synced: boolean }>> {
    return renderHook(({ synced: now }) => usePublishActivity({ awareness, spaceId: 'S', synced: now }), {
      initialProps: { synced },
    });
  }

  beforeEach(() => {
    useUploadMarksStore.setState({ marks: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes a waiting operation in the same task it starts, without waiting for a frame', async () => {
    const awareness = makeAwareness();
    mount(awareness);
    vi.spyOn(Date, 'now').mockReturnValue(42);
    await act(async () => {
      useUploadMarksStore.getState().begin('S', 'n1', 'image.grid');
    });
    expect(activityOf(awareness)).toEqual([{ nodeId: 'n1', action: 'image.grid', at: 42 }]);
  });

  it('takes a node off in the same task its operation fails or is answered', async () => {
    const awareness = makeAwareness();
    mount(awareness);
    let a = '';
    let b = '';
    await act(async () => {
      a = useUploadMarksStore.getState().begin('S', 'n1', 'upload');
      b = useUploadMarksStore.getState().begin('S', 'n2', 'upload');
    });
    await act(async () => useUploadMarksStore.getState().fail('S', 'n1', a, { key: 'canvas.upload.failed' }));
    expect(activityOf(awareness)).toEqual([expect.objectContaining({ nodeId: 'n2' })]);
    await act(async () => useUploadMarksStore.getState().answer('S', 'n2', b));
    expect(activityOf(awareness)).toBeNull();
  });

  it('sends the operations a press starts together in one write', async () => {
    const awareness = makeAwareness();
    mount(awareness);
    const write = vi.spyOn(awareness, 'setLocalState');
    await act(async () => {
      for (let i = 0; i < 64; i += 1) useUploadMarksStore.getState().begin('S', `n${i}`, 'image.grid');
    });
    expect(write).toHaveBeenCalledOnce();
    expect(activityOf(awareness)).toHaveLength(64);
  });

  it('leaves another Space’s operations out', async () => {
    const awareness = makeAwareness();
    mount(awareness);
    await act(async () => {
      useUploadMarksStore.getState().begin('T', 'n1', 'upload');
    });
    expect(activityOf(awareness)).toBeNull();
  });

  it('publishes what was already waiting when it mounts', () => {
    const awareness = makeAwareness();
    act(() => {
      useUploadMarksStore.getState().begin('S', 'n1', 'readText');
    });
    mount(awareness);
    expect(activityOf(awareness)).toEqual([expect.objectContaining({ nodeId: 'n1', action: 'readText' })]);
  });

  it('withdraws the activity when it unmounts', async () => {
    const awareness = makeAwareness();
    const rendered = mount(awareness);
    await act(async () => {
      useUploadMarksStore.getState().begin('S', 'n1', 'upload');
    });
    expect(activityOf(awareness)).toEqual([expect.objectContaining({ nodeId: 'n1', action: 'upload' })]);
    rendered.unmount();
    expect(activityOf(awareness)).toBeNull();
    expect(awareness.getLocalState()).not.toBeNull();
  });

  // The peers dropped this state while the socket was closed.
  it('sends the activity again on reconnect, though nothing local changed', async () => {
    const awareness = makeAwareness();
    const rendered = mount(awareness, false);
    await act(async () => {
      useUploadMarksStore.getState().begin('S', 'n1', 'upload');
    });
    const write = vi.spyOn(awareness, 'setLocalState');
    rendered.rerender({ synced: true });
    expect(write).toHaveBeenCalledOnce();
    expect(activityOf(awareness)).toEqual([expect.objectContaining({ nodeId: 'n1' })]);
  });

  it('sends the activity again when the page comes back from the bfcache', async () => {
    const awareness = makeAwareness();
    mount(awareness);
    await act(async () => {
      useUploadMarksStore.getState().begin('S', 'n1', 'upload');
    });
    awareness.setLocalState({});
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(activityOf(awareness)).toEqual([expect.objectContaining({ nodeId: 'n1' })]);
  });
});
