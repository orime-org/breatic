// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool layer on a node keeps from the canvas while its tool is open
 * (inner#1303 §6.6): arrows meant for the host node, and clicks meant for the
 * layer. The canvas's own copy, paste and duplicate read `toolLayerOpen`.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TOOL_LAYER_CLASS,
  stopNodeClick,
  toolLayerOpen,
  useToolLayerArrows,
} from '@web/spaces/canvas/mini-tool/tool-layer-input';
import { canvasSessions } from '@web/stores/canvas-session';
import { useUIStore } from '@web/stores/ui';

/**
 * A canvas node and a panel slider beside it, in the space region.
 * @param root0 - Props.
 * @param root0.active - Whether a tool layer is open.
 * @returns The canvas.
 */
function Canvas({ active }: { active: boolean }): React.JSX.Element {
  useToolLayerArrows(active);
  return (
    <div data-region='space'>
      <div className='react-flow__node selected'>
        <button type='button' data-testid='control'>tile</button>
        <textarea data-testid='typing' />
        {/* A player's seek bar and a tile checkbox carry `nokey`; a list box and editable text too are xyflow's to skip. */}
        <div className='nokey'>
          <div role='slider' tabIndex={0} aria-valuenow={0} data-testid='nokey' />
        </div>
        <select data-testid='choice' />
        <div contentEditable suppressContentEditableWarning data-testid='editable' />
      </div>
      {/* Another node, not selected: an audio node's seek bar, say. */}
      <div className='react-flow__node'>
        <div role='slider' tabIndex={0} aria-valuenow={0} data-testid='unselected' />
      </div>
      <div role='slider' tabIndex={0} aria-valuenow={0} data-testid='slider' />
    </div>
  );
}

const reached = vi.fn();
afterEach(() => {
  document.removeEventListener('keydown', reached);
  reached.mockClear();
  useUIStore.setState({ activeRegion: 'space' });
  canvasSessions.clear();
});

describe('toolLayerOpen', () => {
  const session = (): ReturnType<ReturnType<typeof canvasSessions.of>['getState']> =>
    canvasSessions.of('t').getState();

  it.each(['image.mark', 'image.grid', 'image.erase', 'image.sketch', 'image.expand', 'image.crop'])(
    'is true while %s is open on a node',
    (toolId) => {
      act(() => session().openMiniTool('n1', toolId, { sourceContent: 'https://cdn/a.png', params: {} }));
      expect(toolLayerOpen(session())).toBe(true);
    },
  );

  it.each(['image.adjust', 'image.upscale'])('is false while %s, whose work is held in its panel, is open', (toolId) => {
    act(() => session().openMiniTool('n1', toolId, { sourceContent: 'https://cdn/a.png', params: {} }));
    expect(toolLayerOpen(session())).toBe(false);
  });

  it('is true while a focus crop is on a node', () => {
    act(() => session().setFocusTarget({ nodeId: 'n1', content: 'https://cdn/a.png' }));
    expect(toolLayerOpen(session())).toBe(true);
  });

  it('is false with nothing open', () => {
    expect(toolLayerOpen(session())).toBe(false);
  });
});

describe('useToolLayerArrows', () => {
  it.each(['ArrowRight', 'ArrowUp'])('keeps %s pressed in a node from it', (key) => {
    document.addEventListener('keydown', reached);
    render(<Canvas active />);
    expect(fireEvent.keyDown(screen.getByTestId('control'), { key })).toBe(false);
    expect(reached).not.toHaveBeenCalled();
  });

  // xyflow moves the node whichever region holds the keyboard (a scrollbar
  // press in the agent column hands it over and leaves focus on the node).
  it('keeps arrows pressed in a node from it while another region holds the keyboard', () => {
    useUIStore.setState({ activeRegion: 'agent' });
    document.addEventListener('keydown', reached);
    render(<Canvas active />);
    expect(fireEvent.keyDown(screen.getByTestId('control'), { key: 'ArrowDown' })).toBe(false);
    expect(reached).not.toHaveBeenCalled();
  });

  // xyflow moves the selected nodes by the arrows pressed in a selected one
  // (`@xyflow/react` index.mjs:2309); a control in any other node keeps them.
  it('lets arrows pressed in a node that is not selected through', () => {
    document.addEventListener('keydown', reached);
    render(<Canvas active />);
    expect(fireEvent.keyDown(screen.getByTestId('unselected'), { key: 'ArrowRight' })).toBe(true);
    expect(reached).toHaveBeenCalledOnce();
  });

  // xyflow moves a node by the arrows pressed in it; a control outside every
  // node (a panel's slider, the focus crop's timeline) keeps its own arrows.
  it('lets arrows pressed outside the nodes through', () => {
    document.addEventListener('keydown', reached);
    render(<Canvas active />);
    expect(fireEvent.keyDown(screen.getByTestId('slider'), { key: 'ArrowRight' })).toBe(true);
    expect(reached).toHaveBeenCalledOnce();
  });

  // xyflow skips the arrows pressed on an input, a select, a textarea,
  // editable content or anything under `.nokey` (`@xyflow/system`
  // isInputDOMNode, which `@xyflow/react` index.mjs:2297 asks first).
  it.each(['nokey', 'choice', 'editable'])('lets the arrows pressed on %s in a selected node through', (id) => {
    document.addEventListener('keydown', reached);
    render(<Canvas active />);
    expect(fireEvent.keyDown(screen.getByTestId(id), { key: 'ArrowRight' })).toBe(true);
    expect(reached).toHaveBeenCalledOnce();
  });

  it('lets a text box keep its arrows, and every other key through', () => {
    document.addEventListener('keydown', reached);
    render(<Canvas active />);
    fireEvent.keyDown(screen.getByTestId('typing'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('control'), { key: 'd', metaKey: true });
    fireEvent.keyDown(screen.getByTestId('control'), { key: 'v', ctrlKey: true });
    expect(reached).toHaveBeenCalledTimes(3);
  });

  it('takes nothing while no tool layer is open', () => {
    document.addEventListener('keydown', reached);
    render(<Canvas active={false} />);
    fireEvent.keyDown(screen.getByTestId('control'), { key: 'ArrowRight' });
    expect(reached).toHaveBeenCalledOnce();
  });
});

describe('a tool layer root', () => {
  it('is left out of the Shift marquee and node drags', () => {
    expect(TOOL_LAYER_CLASS.split(' ')).toEqual(expect.arrayContaining(['nokey', 'nodrag', 'nopan']));
  });

  it('keeps its clicks from the node', () => {
    const node = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={node}>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div data-testid='layer' onClick={stopNodeClick} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('layer'), { metaKey: true });
    expect(node).not.toHaveBeenCalled();
  });
});
