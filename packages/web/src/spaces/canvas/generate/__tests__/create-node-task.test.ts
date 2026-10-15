// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A generation submitted from a panel (inner#1303 §6.7): once the server takes
 * it, a failure line an earlier upload or tool left on the node goes. The
 * generation shows its progress through its own task count, so it never takes
 * the node's mark from an upload or tool still waiting there.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskCreateInput } from '@breatic/shared';

import { canvasApi } from '@web/data/api/canvas';
import { createNodeTask } from '@web/spaces/canvas/generate/create-node-task';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const SPACE = 's1';
const NODE = 'n1';
const PAYLOAD = { task_type: 'image', params: {} } as unknown as TaskCreateInput;

/** The node's mark. */
const mark = () => useUploadMarksStore.getState().markOf(SPACE, NODE);

/**
 * Leave a failed upload's line on the node.
 * @returns Nothing.
 */
function failUpload(): void {
  const marks = useUploadMarksStore.getState();
  const op = marks.begin(SPACE, NODE, 'upload');
  marks.fail(SPACE, NODE, op, { key: 'canvas.upload.tooLarge' });
}

beforeEach(() => {
  vi.restoreAllMocks();
  useUploadMarksStore.setState({ marks: {} });
});

describe('createNodeTask', () => {
  it('clears a failure line on the node once the server takes the task', async () => {
    failUpload();
    let seen: ReturnType<typeof mark>;
    vi.spyOn(canvasApi, 'createTask').mockImplementation(() => {
      seen = mark();
      return Promise.resolve({} as never);
    });
    await createNodeTask(SPACE, NODE, PAYLOAD, 'key-1');
    expect(canvasApi.createTask).toHaveBeenCalledWith(PAYLOAD, 'key-1');
    expect(seen!).toMatchObject({ state: 'failed', action: 'upload' });
    expect(mark()).toBeUndefined();
  });

  it('keeps the failure line when the server refuses, and passes the refusal on', async () => {
    failUpload();
    const refused = new Error('402');
    vi.spyOn(canvasApi, 'createTask').mockRejectedValue(refused);
    await expect(createNodeTask(SPACE, NODE, PAYLOAD, 'key-1')).rejects.toBe(refused);
    expect(mark()).toMatchObject({ state: 'failed', action: 'upload' });
  });

  it('leaves an upload waiting on the node its own, so its failure still shows', async () => {
    const marks = useUploadMarksStore.getState();
    const op = marks.begin(SPACE, NODE, 'upload');
    vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await createNodeTask(SPACE, NODE, PAYLOAD, 'key-1');
    expect(mark()).toMatchObject({ op, state: 'waiting', action: 'upload' });
    marks.fail(SPACE, NODE, op, { key: 'canvas.upload.failed' });
    expect(mark()).toMatchObject({ op, state: 'failed' });
  });
});
