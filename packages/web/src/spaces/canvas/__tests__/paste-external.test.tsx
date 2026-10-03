// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasting a node whose content is an address outside our storage.
 *
 * Such a node never takes that address as its own: a node pins the address of
 * the stored copy, so the paste creates an empty image node and asks the
 * server to fetch the address into storage for it. The server writes the
 * stored address onto the node when the fetch is done.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { _resetForTests } from '@web/data/yjs/manager';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { canvasTakesPaste, cloneForPaste, CLIPBOARD_MARKER } from '@web/spaces/canvas/node-clipboard';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@web/lib/toast', () => ({ toast: { error: toastError } }));

const outside = {
  type: 'image' as const,
  position: { x: 10, y: 20 },
  name: 'A picture',
  content: 'https://original.example/1.png',
  external: true,
};

describe('cloning a node from outside', () => {
  it('leaves the address off the node and keeps the name as it is', () => {
    const [node] = cloneForPaste([outside], 'u-9', { dx: 0, dy: 0 });

    expect(node?.type).toBe('image');
    expect(node?.data.content).toBeUndefined();
    expect(node?.data.name).toBe('A picture');
  });
});

describe('pasting a node from outside', () => {
  beforeEach(() => {
    _resetForTests();
    toastError.mockReset();
    useCurrentUserStore.getState().setUser({
      id: 'u-9',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
      membershipTier: 'base',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an empty image node and asks for the address to be fetched into it', async () => {
    const addNode = vi.spyOn(canvasSpace, 'addNode').mockImplementation(() => undefined);
    const ingestUrl = vi
      .spyOn(canvasApi, 'ingestUrl')
      .mockResolvedValue({ task_id: 't1' });
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const [id] = result.current.pasteNodesAt(
      [outside, { type: 'text', position: { x: 0, y: 0 }, content: 'note' }],
      { dx: 0, dy: 0 },
    );

    expect(addNode).toHaveBeenCalledTimes(2);
    const created = addNode.mock.calls[0]?.[2];
    expect(created?.id).toBe(id);
    expect(created?.data.content).toBeUndefined();
    await waitFor(() => expect(ingestUrl).toHaveBeenCalledTimes(1));
    expect(ingestUrl).toHaveBeenCalledWith({
      url: 'https://original.example/1.png',
      project_id: 'p1',
      space_id: 's1',
      node_id: id,
    });
  });

  it('asks for nothing when no node in the paste is from outside', () => {
    vi.spyOn(canvasSpace, 'addNode').mockImplementation(() => undefined);
    const ingestUrl = vi.spyOn(canvasApi, 'ingestUrl');
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    result.current.pasteNodesAt(
      [{ type: 'image', position: { x: 0, y: 0 }, content: 'https://ours.example/a.png' }],
      { dx: 0, dy: 0 },
    );

    expect(ingestUrl).not.toHaveBeenCalled();
  });

  it('says storage is full when the server answers 507', async () => {
    vi.spyOn(canvasSpace, 'addNode').mockImplementation(() => undefined);
    vi.spyOn(canvasApi, 'ingestUrl').mockRejectedValue(new ApiException({ status: 507, message: 'full' }));
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    result.current.pasteNodesAt([outside], { dx: 0, dy: 0 });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Studio storage is full. Uploading is unavailable.'));
  });

  it('says the upload failed for any other refusal', async () => {
    vi.spyOn(canvasSpace, 'addNode').mockImplementation(() => undefined);
    vi.spyOn(canvasApi, 'ingestUrl').mockRejectedValue(new ApiException({ status: 429, message: 'slow down' }));
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    result.current.pasteNodesAt([outside], { dx: 0, dy: 0 });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Upload failed.'));
  });
});

describe('whether the canvas takes a paste', () => {
  it('takes any paste while the space holds the keyboard', () => {
    expect(canvasTakesPaste(true, 'plain text')).toBe(true);
  });

  it('takes its own nodes even after a click elsewhere', () => {
    // Copying a picture in the agent column leaves the keyboard there; a
    // paste of canvas nodes has no other place to go.
    expect(canvasTakesPaste(false, `${CLIPBOARD_MARKER}[]`)).toBe(true);
  });

  it('leaves plain text to whoever holds the keyboard', () => {
    expect(canvasTakesPaste(false, 'plain text')).toBe(false);
  });
});
