// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool layer on a node keeps from the canvas while its tool is open
 * (inner#1303 §6.6): node keys and clicks meant for the layer.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOOL_LAYER_CLASS, stopNodeClick, useToolLayerKeys } from '@web/spaces/canvas/mini-tool/tool-layer-input';

/**
 * A canvas node holding a tool layer, and a panel slider beside it, in the
 * space region.
 * @param root0 - Props.
 * @param root0.active - Whether its tool is open.
 * @returns The layer.
 */
function Layer({ active }: { active: boolean }): React.JSX.Element {
  useToolLayerKeys(active);
  return (
    <div data-region='space'>
      <div className='react-flow__node'>
        <button type='button' data-testid='control'>tile</button>
        <textarea data-testid='typing' />
      </div>
      <div role='slider' tabIndex={0} aria-valuenow={0} data-testid='slider' />
    </div>
  );
}

const reached = vi.fn();
afterEach(() => {
  document.removeEventListener('keydown', reached);
  reached.mockClear();
});

describe('useToolLayerKeys', () => {
  it.each([
    ['ArrowRight', {}],
    ['ArrowUp', {}],
    ['c', { metaKey: true }],
    ['v', { ctrlKey: true }],
    ['x', { metaKey: true }],
    ['d', { metaKey: true }],
  ])('keeps %s from the node while the tool is open', (key, modifiers) => {
    document.addEventListener('keydown', reached);
    render(<Layer active />);
    const allowed = fireEvent.keyDown(screen.getByTestId('control'), { key, ...modifiers });
    expect(allowed).toBe(false);
    expect(reached).not.toHaveBeenCalled();
  });

  // xyflow moves a node by the arrows pressed in it; a control outside every
  // node (a panel's slider, the focus crop's timeline) keeps its own arrows.
  it('lets arrows pressed outside the node through', () => {
    document.addEventListener('keydown', reached);
    render(<Layer active />);
    expect(fireEvent.keyDown(screen.getByTestId('slider'), { key: 'ArrowRight' })).toBe(true);
    expect(reached).toHaveBeenCalledOnce();
  });

  it('keeps the node shortcuts pressed outside the node from it', () => {
    document.addEventListener('keydown', reached);
    render(<Layer active />);
    expect(fireEvent.keyDown(screen.getByTestId('slider'), { key: 'd', metaKey: true })).toBe(false);
    expect(reached).not.toHaveBeenCalled();
  });

  it('lets undo and the keys of a text box through', () => {
    document.addEventListener('keydown', reached);
    render(<Layer active />);
    fireEvent.keyDown(screen.getByTestId('control'), { key: 'z', metaKey: true });
    fireEvent.keyDown(screen.getByTestId('typing'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('typing'), { key: 'c', metaKey: true });
    expect(reached).toHaveBeenCalledTimes(3);
  });

  it('takes nothing while the tool is closed', () => {
    document.addEventListener('keydown', reached);
    render(<Layer active={false} />);
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
