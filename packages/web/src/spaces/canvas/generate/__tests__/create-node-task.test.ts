// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A generation submitted from a panel is an operation started on its node
 * (inner#1303 §6.7): a failure line an earlier upload or tool left there gives
 * way to it, and nothing is left once the server has answered.
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

beforeEach(() => {
  vi.restoreAllMocks();
  useUploadMarksStore.setState({ marks: {} });
  const marks = useUploadMarksStore.getState();
  const op = marks.begin(SPACE, NODE, 'upload');
  marks.fail(SPACE, NODE, op, { key: 'canvas.upload.tooLarge' });
});

describe('createNodeTask', () => {
  it('replaces a failure line left on the node while the request is out', async () => {
    let seen: ReturnType<typeof mark>;
    vi.spyOn(canvasApi, 'createTask').mockImplementation(() => {
      seen = mark();
      return Promise.resolve({} as never);
    });
    await createNodeTask(SPACE, NODE, PAYLOAD);
    expect(seen!).toMatchObject({ state: 'waiting', action: 'generate' });
    expect(mark()).toBeUndefined();
  });

  it('leaves no mark when the server refuses, and passes the refusal on', async () => {
    const refused = new Error('402');
    vi.spyOn(canvasApi, 'createTask').mockRejectedValue(refused);
    await expect(createNodeTask(SPACE, NODE, PAYLOAD)).rejects.toBe(refused);
    expect(mark()).toBeUndefined();
  });
});
