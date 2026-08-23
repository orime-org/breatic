// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { toast } from 'sonner';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import { useCanvasStore } from '@web/stores/canvas';
import {
  clickNode,
  group,
  image,
  mockSpace,
  renderSpace,
  zOf,
  type Nodes,
} from '@web/spaces/canvas/__tests__/focus-harness';

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

/**
 * Puts the canvas into the focused state on `src`.
 * @param nodes - The starting nodes.
 * @returns A remount callback.
 */
function enterFocus(nodes: Nodes): () => void {
  mockUseCanvasSpace.mockReturnValue(mockSpace(nodes));
  const remount = renderSpace();
  act(() => useCanvasStore.getState().startFocusPick('host'));
  clickNode('src');
  expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  return remount;
}

const START: Nodes = [image('host', 0), image('src', 300)];

describe('聚焦目标被改动之后（#2000）', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    useCanvasStore.setState({ pickSession: null });
    vi.restoreAllMocks();
  });

  it('A6：目标被删除 → toast 说被删了，退回挑选横幅', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(mockSpace([image('host', 0)]));
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source deleted.');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A7：内容被换 → toast 说换了，退回挑选横幅', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300, { content: 'other.png' })]),
    );
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source replaced.');
    expect(zOf('src')).toBe('0');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A8：进 handling → toast 说在生成，退回挑选横幅', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300, { status: 'handling' })]),
    );
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source is generating.');
    expect(zOf('src')).toBe('0');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A8b：让它进 error → toast 说生成失败，退回挑选横幅', () => {
    // deriveStatus reaches 'error' without passing through 'handling' (a
    // failure writes errorMessage and puts state back to idle), so a client
    // that receives both writes in one delivery lands here having never seen
    // 'handling'. Sharing the 'busy' copy would tell that user a generation
    // is running while the node draws an error frame.
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300, { status: 'error' })]),
    );
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source generation failed.');
    expect(zOf('src')).toBe('0');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('焦点在浮层内时，退出把它交回挑选横幅', () => {
    vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    // The overlay's own controls (ratio presets, confirm, cancel) render off
    // a measured source box and jsdom gives images no size, so focus goes
    // into the overlay root directly. This is the state the rescue exists
    // for: the user had reached a control, and the overlay is about to
    // unmount under them.
    const overlay = screen.getByTestId('focus-crop-overlay');
    overlay.tabIndex = -1;
    overlay.focus();
    expect(overlay.contains(document.activeElement)).toBe(true);

    mockUseCanvasSpace.mockReturnValue(mockSpace([image('host', 0)]));
    remount();

    expect(document.activeElement).toBe(
      screen.getByTestId('reference-pick-banner'),
    );
  });

  it('焦点在浮层外时，退出不去搬它', () => {
    vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    // Drawing a marquee never puts focus in the overlay (the capture layer
    // is a div with no tabIndex), so this is the ordinary path, and a write
    // by someone else must not pull focus away from wherever the user is.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    mockUseCanvasSpace.mockReturnValue(mockSpace([image('host', 0)]));
    remount();

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('换聚焦目标：快照跟着换，这一帧不误报「素材已更换」', () => {
    // I4's only check. The id and the snapshot live in one state object, so a
    // switch cannot leave the previous node's content behind — if it could,
    // the verdict would read the new node against the old content and eject
    // the user the moment they pick a second source.
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 300), image('other', 600)]),
    );
    const remount = renderSpace();
    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');
    clickNode('other');
    remount();

    expect(warn).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  });

  it('A10：四条文案在五份 catalog 里都有', async () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];
    const keys = [
      'focusSourceDeleted',
      'focusSourceReplaced',
      'focusSourceBusy',
      'focusSourceFailed',
    ];
    // The repo guard only reads locales/en.json, so a missing translation in
    // any of the other four would ship silently.
    for (const loc of locales) {
      const raw = await readFile(
        resolve(process.cwd(), `../../locales/${loc}.json`),
        'utf8',
      );
      const panel = (
        JSON.parse(raw) as {
          canvas: { generatePanel: Record<string, unknown> };
        }
      ).canvas.generatePanel;
      for (const k of keys) {
        expect(typeof panel[k], `${loc}.json is missing ${k}`).toBe('string');
      }
    }
  });

  it('A9：拖动它 → 聚焦照常，一条 toast 都没有', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([image('host', 0), image('src', 900)]),
    );
    remount();

    expect(warn).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  });

  it('A9：把它加进组 → 聚焦照常，一条 toast 都没有', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        image('host', 0),
        group('g', 280),
        { ...image('src', 20), parentId: 'g' } as Nodes[number],
      ]),
    );
    remount();

    expect(warn).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  });
});
