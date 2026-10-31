// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Generate press closes the panel open on its node when the answer comes
 * back (inner#1490 A1), whichever opening of the Space that panel is in. An
 * accepted press also takes away a failure line an earlier upload or tool left
 * on the node (inner#1303 §6.7); a refused one leaves it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TaskCreateInput } from '@breatic/shared';

vi.mock('@web/data/api/canvas', () => ({
  canvasApi: { createTask: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { submitGeneration } from '@web/spaces/canvas/generate/submit-generation';

/**
 * Let pending promise callbacks run.
 * @returns Once they have.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Leave a failed upload's line on node n.
 * @returns Nothing.
 */
function failUpload(): void {
  const marks = useUploadMarksStore.getState();
  const op = marks.begin('s', 'n', 'upload');
  marks.fail('s', 'n', op, { key: 'canvas.upload.tooLarge' });
}

/**
 * Press Generate on node n.
 * @returns Nothing.
 */
function press(): void {
  submitGeneration({
    spaceId: 's',
    nodeId: 'n',
    panelKind: 'generate',
    buildPayload: () => ({}) as TaskCreateInput,
  });
}

afterEach(() => {
  resetRunOnceForTests();
  canvasSessions.clear();
  useUploadMarksStore.setState({ marks: {} });
});

describe('submitGeneration', () => {
  it('closes the panel reopened after the Space tab was closed and opened again', async () => {
    let answer: (value: unknown) => void = () => {};
    vi.mocked(canvasApi.createTask).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }) as never,
    );
    canvasSessions.of('s').getState().openGeneratePanel('n', 'image');
    submitGeneration({
      spaceId: 's',
      nodeId: 'n',
      panelKind: 'generate',
      buildPayload: () => ({}) as TaskCreateInput,
    });
    await flush();

    canvasSessions.drop('s');
    const reopened = canvasSessions.of('s');
    reopened.getState().openGeneratePanel('n', 'image');
    answer({});
    await flush();

    expect(reopened.getState().panelHostId).toBeNull();
  });

  it('opens no store for a Space whose tab is closed when the answer comes back', async () => {
    vi.mocked(canvasApi.createTask).mockResolvedValueOnce({} as never);
    canvasSessions.of('s').getState().openGeneratePanel('n', 'image');
    submitGeneration({
      spaceId: 's',
      nodeId: 'n',
      panelKind: 'generate',
      buildPayload: () => ({}) as TaskCreateInput,
    });
    canvasSessions.drop('s');
    await flush();

    expect(canvasSessions.peek('s')).toBeUndefined();
  });

  it('takes away the node\'s failure line once the server accepts the press', async () => {
    failUpload();
    let whileAsking: ReturnType<ReturnType<typeof useUploadMarksStore.getState>['markOf']>;
    vi.mocked(canvasApi.createTask).mockImplementationOnce(() => {
      whileAsking = useUploadMarksStore.getState().markOf('s', 'n');
      return Promise.resolve({} as never);
    });
    press();
    await flush();

    expect(whileAsking).toMatchObject({ state: 'failed', action: 'upload' });
    expect(useUploadMarksStore.getState().markOf('s', 'n')).toBeUndefined();
  });

  it('leaves an upload waiting on the node its own, so its failure still shows', async () => {
    const marks = useUploadMarksStore.getState();
    const op = marks.begin('s', 'n', 'upload');
    vi.mocked(canvasApi.createTask).mockResolvedValueOnce({} as never);
    press();
    await flush();

    expect(useUploadMarksStore.getState().markOf('s', 'n')).toMatchObject({ op, state: 'waiting', action: 'upload' });
    marks.fail('s', 'n', op, { key: 'canvas.upload.failed' });
    expect(useUploadMarksStore.getState().markOf('s', 'n')).toMatchObject({ op, state: 'failed' });
  });

  it('leaves the node\'s failure line when the server refuses the press', async () => {
    failUpload();
    vi.mocked(canvasApi.createTask).mockRejectedValueOnce(
      new ApiException({ status: 402, message: 'Not enough credits.', fromServer: true }),
    );
    press();
    await flush();

    expect(useUploadMarksStore.getState().markOf('s', 'n')).toMatchObject({ state: 'failed', action: 'upload' });
  });
});
