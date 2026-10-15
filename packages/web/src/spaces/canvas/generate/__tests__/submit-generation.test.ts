// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Generate press closes the panel open on its node when the answer comes
 * back (inner#1490 A1), whichever opening of the Space that panel is in.
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
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { submitGeneration } from '@web/spaces/canvas/generate/submit-generation';

/**
 * Let pending promise callbacks run.
 * @returns Once they have.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  resetRunOnceForTests();
  canvasSessions.clear();
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
});
