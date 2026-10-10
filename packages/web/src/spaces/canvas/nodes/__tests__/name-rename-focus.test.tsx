// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the keyboard goes when a node or group name stops being edited
 * (inner#956): back to the node's ReactFlow wrapper on Enter and Escape, so arrow keys and
 * Enter keep working on the node that was just renamed.
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeHeader } from '@web/spaces/canvas/nodes/_shared/NodeHeader';
import { GroupNode } from '@web/spaces/canvas/nodes/GroupNode';

const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's1',
  readOnly: false,
  myRole: 'owner',
  caretProvider: null,
};

/**
 * Renders a name editor inside the wrapper ReactFlow stamps for node `n1`.
 * @param children - The name editor.
 * @returns The node's ReactFlow wrapper.
 */
function renderInShell(children: React.ReactNode): HTMLElement {
  render(
    <div data-space-outlet='s1'>
      <CanvasContext.Provider value={CANVAS}>
        <NodeIdContext.Provider value='n1'>
          <div className='react-flow__node' data-id='n1' tabIndex={-1} data-testid='wrapper'>
            {children}
          </div>
        </NodeIdContext.Provider>
      </CanvasContext.Provider>
    </div>,
  );
  return screen.getByTestId('wrapper');
}

const SITES = [
  {
    name: 'node name',
    mount: (onRename: (name: string) => void) =>
      renderInShell(<NodeHeader modality='image' name='Old' onRename={onRename} />),
    label: 'node-header-name',
    input: 'node-header-input',
  },
  {
    name: 'group name',
    mount: (onRename: (name: string) => void) =>
      renderInShell(<GroupNode data={{ kind: 'group', name: 'Old' }} onRename={onRename} />),
    label: 'group-name',
    input: 'group-name-input',
  },
] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(SITES)('ending a $name edit', ({ mount, label, input }) => {
  it.each([
    ['Enter', { key: 'Enter', keyCode: 13 }],
    ['Escape', { key: 'Escape', keyCode: 27 }],
  ])('gives the node wrapper the keyboard on %s', (_, init) => {
    const wrapper = mount(vi.fn());
    fireEvent.doubleClick(screen.getByTestId(label));
    expect(document.activeElement).toBe(screen.getByTestId(input));
    const notCancelled = fireEvent.keyDown(screen.getByTestId(input), init);
    expect(notCancelled).toBe(false);
    expect(screen.queryByTestId(input)).toBeNull();
    expect(document.activeElement).toBe(wrapper);
  });

  it.each([
    ['Enter', { key: 'Enter', keyCode: 13 }],
    ['Escape', { key: 'Escape', keyCode: 27 }],
  ])('keeps the box open on the %s that ends an input method composition', (_, init) => {
    const onRename = vi.fn();
    mount(onRename);
    fireEvent.doubleClick(screen.getByTestId(label));
    const box = screen.getByTestId(input);
    fireEvent.compositionEnd(box);
    const notCancelled = fireEvent.keyDown(box, init);
    expect(notCancelled).toBe(false);
    expect(screen.getByTestId(input)).toBe(box);
    expect(onRename).not.toHaveBeenCalled();
  });
});
