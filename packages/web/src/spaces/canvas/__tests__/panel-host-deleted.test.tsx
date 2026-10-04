// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A node-anchored panel whose node is deleted closes, and a collaborator's
 * delete is told (canvas awareness design §5.7.2, done with inner#1235 /
 * inner#844). Each canvas reads only its own Space's nodes and session now,
 * so "the node is gone" means a delete rather than a Space switch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { toast } from 'sonner';
import en from '@locales/en.json';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import {
  image,
  mockSpace,
  renderSpace,
  type Nodes,
} from '@web/spaces/canvas/__tests__/focus-harness';
import { canvasSessions } from '@web/stores/canvas-session';

vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      ...actual.toast,
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
    }),
  };
});

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

const WITH_HOST: Nodes = [image('host', 0), image('other', 300)];
const WITHOUT_HOST: Nodes = [image('other', 300)];

/**
 * Opens the history panel on `host`, then removes `host` from the board.
 * @param byPeer - Whether a collaborator removed it.
 */
function deleteHostUnderOpenPanel(byPeer: boolean): void {
  mockUseCanvasSpace.mockReturnValue(mockSpace(WITH_HOST));
  const rerender = renderSpace();
  act(() => canvasSessions.of('s').getState().openHistoryPanel('host'));
  vi.mocked(toast.warning).mockClear();
  mockUseCanvasSpace.mockReturnValue({
    ...mockSpace(WITHOUT_HOST),
    deletedByPeer: (id: string) => byPeer && id === 'host',
  });
  rerender();
}

describe('a panel whose node is deleted', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
  });

  it('closes and says so when a collaborator deleted the node', () => {
    deleteHostUnderOpenPanel(true);

    expect(canvasSessions.of('s').getState().panelHostId).toBeNull();
    expect(toast.warning).toHaveBeenCalledWith(
      en.canvas.panel.hostDeletedByPeer,
    );
  });

  it('closes without a message when this reader deleted the node', () => {
    deleteHostUnderOpenPanel(false);

    expect(canvasSessions.of('s').getState().panelHostId).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('gives the keyboard focus that fell to the page back to the canvas', () => {
    deleteHostUnderOpenPanel(true);

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="canvas-space"]'),
    );
  });
});
