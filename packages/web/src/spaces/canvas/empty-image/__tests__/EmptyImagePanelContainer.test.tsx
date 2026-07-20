// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';

import { EmptyImagePanelContainer } from '@web/spaces/canvas/empty-image/EmptyImagePanelContainer';
import { useCanvasStore } from '@web/stores';

/**
 * Mount the container inside a REAL ReactFlow holding `target` (NodeToolbar
 * renders its children only when the node exists in ReactFlow's store).
 * @param onReset - Spy for the reset callback.
 * @param nodes - The container's node list (for the node-gone guard).
 * @returns The render result.
 */
function mountContainer(
  onReset: (nodeId: string, opts: unknown) => void,
  nodes: ReadonlyArray<{ id: string }> = [{ id: 'target' }],
): ReturnType<typeof render> {
  return render(
    <ReactFlow nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
      <EmptyImagePanelContainer nodes={nodes} onReset={onReset} />
    </ReactFlow>,
  );
}

describe('EmptyImagePanelContainer', () => {
  beforeEach(() => {
    useCanvasStore.setState({ panelHostId: null, panelKind: null, pickSession: null });
  });

  it('renders nothing until the reset panel is opened', () => {
    mountContainer(vi.fn());
    expect(screen.queryByTestId('empty-image-execute')).not.toBeInTheDocument();
  });

  it('renders nothing when a Generate panel (not reset) is open on the host', () => {
    mountContainer(vi.fn());
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target');
    });
    // Same host, but panelKind='generate' → this container stays closed.
    expect(screen.queryByTestId('empty-image-execute')).not.toBeInTheDocument();
  });

  it('renders the panel when openEmptyImagePanel targets an existing node', () => {
    mountContainer(vi.fn());
    act(() => {
      useCanvasStore.getState().openEmptyImagePanel('target');
    });
    expect(screen.getByTestId('empty-image-execute')).toBeInTheDocument();
  });

  it('Execute forwards the host id + spec to onReset', () => {
    const onReset = vi.fn();
    mountContainer(onReset);
    act(() => {
      useCanvasStore.getState().openEmptyImagePanel('target');
    });
    fireEvent.click(screen.getByTestId('empty-image-execute'));
    expect(onReset).toHaveBeenCalledWith(
      'target',
      expect.objectContaining({ width: 1024, height: 1024 }),
    );
  });

  it('Exit closes the active panel', () => {
    mountContainer(vi.fn());
    act(() => {
      useCanvasStore.getState().openEmptyImagePanel('target');
    });
    fireEvent.click(screen.getByTestId('empty-image-exit'));
    expect(useCanvasStore.getState().panelHostId).toBeNull();
    expect(useCanvasStore.getState().panelKind).toBeNull();
  });

  it('closes the panel when the host node disappears (collaborator delete)', () => {
    const { rerender } = mountContainer(vi.fn(), [{ id: 'target' }]);
    act(() => {
      useCanvasStore.getState().openEmptyImagePanel('target');
    });
    expect(screen.getByTestId('empty-image-execute')).toBeInTheDocument();
    // The host vanishes from the live node list → node-gone guard closes it.
    rerender(
      <ReactFlow nodes={[]} edges={[]}>
        <EmptyImagePanelContainer nodes={[]} onReset={vi.fn()} />
      </ReactFlow>,
    );
    expect(useCanvasStore.getState().panelHostId).toBeNull();
  });
});
