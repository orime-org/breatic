// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import {
  clickNode,
  focusTarget,
  group,
  image,
  mockSpace,
  renderSpace,
  zOf,
  type Nodes,
} from '@web/spaces/canvas/__tests__/focus-harness';
import { canvasSessions } from '@web/stores/canvas-session';
import { FOCUS_TARGET_Z } from '@web/spaces/canvas/viewport-layers';

vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

// The return type is stated so a change to SocketState's shape fails
// typecheck here: `vi.mock` factory return values are otherwise
// unconstrained, and a double that has drifted from the real contract fails
// nothing at runtime either.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(
    (): ReturnType<typeof import('@web/data/yjs/use-socket').useSocket> => ({
      provider: null,
      synced: false,
      hasEverSynced: false,
      status: 'connecting',
      writeAccess: 'unknown',
      authFailedReason: null,
    }),
  ),
}));

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

describe('聚焦目标的抬升（#2000）', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    canvasSessions.of('s').setState({ pickSession: null });
  });

  it('A1: lifts the focus source to the focus target z once picked', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300)]),
    );
    renderSpace();
    expect(zOf('src')).toBe('0');

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');

    expect(focusTarget()).toBe('src');
    expect(zOf('src')).toBe(String(FOCUS_TARGET_Z));
  });

  it('A2: puts the focus target above a selected node (selection adds 1000)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('other', 300), image('src', 600)]),
    );
    renderSpace();
    // Select `other` while selection is still live (before the pick starts):
    // xyflow gives a selected node SELECTED_NODE_Z, i.e. 1000.
    clickNode('other');
    expect(zOf('other')).toBe('1000');

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');

    expect(Number(zOf('src'))).toBeGreaterThan(Number(zOf('other')));
  });

  it('A2: puts the focus target above a group member', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        image('host', 0),
        group('g', 300),
        { ...image('member', 20), parentId: 'g' } as Nodes[number],
        image('src', 900),
      ]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');

    expect(Number(zOf('src'))).toBeGreaterThan(Number(zOf('member')));
  });

  // A note stays visible over what it points at while that is being worked
  // on: above a member of a selected group, the tallest a node reaches.
  it('paints a pin above a member of a selected group', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        {
          id: 'pin',
          type: 'annotation',
          position: { x: 320, y: 20 },
          data: { content: 'look here', createdBy: 'u-1', createdAt: 1, replies: [] },
        } as Nodes[number],
        group('g', 300),
        { ...image('member', 20), parentId: 'g' } as Nodes[number],
      ]),
    );
    renderSpace();
    clickNode('g');
    expect(zOf('member')).toBe('1001');
    expect(Number(zOf('pin'))).toBeGreaterThan(Number(zOf('member')));
  });

  it('A2: puts the focus target above a member of a selected group (its parent chain lifts it to 1001)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        image('host', 0),
        group('g', 300),
        { ...image('member', 20), parentId: 'g' } as Nodes[number],
        image('src', 900),
      ]),
    );
    renderSpace();
    // A selected group is 1000; calculateChildXYZ then gives its member
    // parentZ + 1. That 1001 is the tallest a node reaches, since groups
    // cannot nest — it is one of the ceilings the focus target is set against.
    clickNode('g');
    expect(zOf('g')).toBe('1000');
    expect(zOf('member')).toBe('1001');

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');

    expect(Number(zOf('src'))).toBeGreaterThan(Number(zOf('member')));
  });

  it('A3：回到挑选态之后 zIndex 回到原值（确认 / 取消 / Esc 共用这条路）', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300)]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe(String(FOCUS_TARGET_Z));

    // Confirm, Cancel and the overlay's bare Esc share backToPick, which
    // drops the crop target and leaves the session running — the banner
    // stays. Esc is the one reachable here: the controls bar renders off a
    // measured source box, and jsdom gives images no size.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(zOf('src')).toBe('0');
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A3：会话换 purpose 之后 zIndex 回到原值', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300)]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe(String(FOCUS_TARGET_Z));

    act(() => canvasSessions.of('s').getState().startReferencePick('host'));
    expect(zOf('src')).toBe('0');
  });

  it('A3：换聚焦目标时，旧的落回原层、新的抬起来', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('a', 300), image('b', 600)]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('a');
    expect(zOf('a')).toBe(String(FOCUS_TARGET_Z));

    clickNode('b');
    expect(zOf('a')).toBe('0');
    expect(zOf('b')).toBe(String(FOCUS_TARGET_Z));
  });

  it('A3：退出聚焦后 zIndex 回到原值', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300)]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe(String(FOCUS_TARGET_Z));

    act(() => canvasSessions.of('s').getState().endPick());
    expect(zOf('src')).toBe('0');
  });

  it('A5：锁定的聚焦目标退出后，z 回原值而锁还在', () => {
    // The other direction of A5: leaving the crop must drop the lift without
    // taking the lock with it.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300, { locked: true })]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe(String(FOCUS_TARGET_Z));

    act(() => canvasSessions.of('s').getState().endPick());

    expect(zOf('src')).toBe('0');
    const el = document.querySelector('.react-flow__node[data-id="src"]')!;
    expect(el.className).not.toContain('draggable');
  });

  it('A4：本功能不写 selected —— 聚焦目标不带 selected class', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300)]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');

    const el = document.querySelector('.react-flow__node[data-id="src"]')!;
    expect(el.className).not.toContain('selected');
  });

  it('A5：聚焦目标是锁定节点时，抬起来了但仍不可拖', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300, { locked: true })]),
    );
    renderSpace();

    act(() => canvasSessions.of('s').getState().startFocusPick('host'));
    clickNode('src');

    expect(zOf('src')).toBe(String(FOCUS_TARGET_Z));
    const el = document.querySelector('.react-flow__node[data-id="src"]')!;
    expect(el.className).not.toContain('draggable');
  });
});
