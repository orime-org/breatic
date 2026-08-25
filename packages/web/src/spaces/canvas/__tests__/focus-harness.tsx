// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type * as React from 'react';

import type * as canvasSpace from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';

/** The canvas nodes `useCanvasSpace` hands back. */
export type Nodes = ReturnType<typeof canvasSpace.useCanvasSpace>['nodes'];

/**
 * Builds the shape `useCanvasSpace` returns.
 *
 * The default is a remote write, which is what the exit specs are about; a
 * spec that means "this client did it" passes true.
 * @param nodes - The canvas nodes to mirror.
 * @param lastWriteWasLocal - Whether this client made the latest write.
 * @returns The mocked space value.
 */
export function mockSpace(
  nodes: Nodes,
  lastWriteWasLocal = false,
): ReturnType<typeof canvasSpace.useCanvasSpace> {
  return {
    nodes,
    edges: [],
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    lastWriteWasLocal,
    getLastWriteWasLocal: () => lastWriteWasLocal,
  };
}

/**
 * Mounts the canvas and hands back a re-render that makes it re-read the
 * mocked space, which is how a write to the document reaches this component.
 *
 * A re-render, not a remount: `focusTarget` is local state inside
 * `CanvasSpaceInner`, so unmounting would take the open crop with it and
 * every exit spec would lose its premise before it asserted anything.
 * @returns A re-render callback.
 */
export function renderSpace(): () => void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A fresh element each time: passing the same element object back to
  // rerender lets React bail out of the whole subtree, so the component would
  // never re-read the mocked space.
  const tree = (): React.ReactElement => (
    <QueryClientProvider client={client}>
      <CanvasSpace projectId='p' spaceId='s' readOnly={false} />
    </QueryClientProvider>
  );
  const r = render(tree());
  return () => {
    act(() => r.rerender(tree()));
  };
}

/**
 * Clicks a node element by id.
 * @param id - The node id.
 * @returns Nothing.
 */
export function clickNode(id: string): void {
  act(() => {
    fireEvent.click(
      document.querySelector(`.react-flow__node[data-id="${id}"]`)!,
    );
  });
}

/**
 * Reads the inline z-index xyflow wrote onto a node element.
 * @param id - The node id.
 * @returns The element's z-index string.
 * @throws {Error} When the node is not rendered.
 */
export function zOf(id: string): string {
  const el = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  );
  if (!el) throw new Error(`node ${id} is not rendered`);
  return el.style.zIndex;
}

/**
 * An idle image node at a given x, with optional data overrides.
 * @param id - The node id.
 * @param x - The x position.
 * @param over - Data fields to override.
 * @returns The node.
 */
export function image(id: string, x: number, over = {}): Nodes[number] {
  return {
    id,
    type: 'image',
    position: { x, y: 0 },
    data: { kind: 'image', content: `${id}.png`, status: 'idle', ...over },
  } as Nodes[number];
}

/**
 * A group node sized to hold members.
 * @param id - The group id.
 * @param x - The x position.
 * @returns The node.
 */
export function group(id: string, x: number): Nodes[number] {
  return {
    id,
    type: 'group',
    position: { x, y: 0 },
    width: 400,
    height: 400,
    data: { kind: 'group' },
  } as Nodes[number];
}
