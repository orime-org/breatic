// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Edge, Node } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasGraphStore } from '@web/stores/canvas-graph';

/**
 * The canvas graph store (#1647 step 4) owns the ReactFlow render buffer
 * (flowNodes / flowEdges) — a plain (non-immer) zustand store, because the node
 * array is high-frequency and immer's autoFreeze / proxy would freeze the node
 * objects and interfere with ReactFlow's controlled rendering. It exposes
 * functional-updater setters (so the reference-stable mirror merge can run
 * against the current buffer) and a reset for space switches.
 */
describe('useCanvasGraphStore', () => {
  beforeEach(() => {
    useCanvasGraphStore.getState().reset();
  });

  it('starts empty', () => {
    const s = useCanvasGraphStore.getState();
    expect(s.flowNodes).toEqual([]);
    expect(s.flowEdges).toEqual([]);
  });

  it('setFlowNodes applies the updater against the current buffer', () => {
    const a = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    useCanvasGraphStore.getState().setFlowNodes(() => [a]);
    expect(useCanvasGraphStore.getState().flowNodes).toEqual([a]);

    // The updater receives the current buffer, so it can append / reconcile.
    const b = { id: 'b', type: 'image', position: { x: 1, y: 1 }, data: {} } as Node;
    useCanvasGraphStore.getState().setFlowNodes((prev) => [...prev, b]);
    expect(useCanvasGraphStore.getState().flowNodes.map((n) => n.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('does NOT freeze the stored node objects (immer autoFreeze would break ReactFlow)', () => {
    const node = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    useCanvasGraphStore.getState().setFlowNodes(() => [node]);
    const stored = useCanvasGraphStore.getState().flowNodes[0];
    expect(Object.isFrozen(stored)).toBe(false);
    // The exact same object reference is stored (no proxy wrapping).
    expect(stored).toBe(node);
  });

  it('setFlowEdges applies the updater against the current buffer', () => {
    const e = { id: 'e1', source: 'a', target: 'b', type: 'scissors' } as Edge;
    useCanvasGraphStore.getState().setFlowEdges(() => [e]);
    expect(useCanvasGraphStore.getState().flowEdges).toEqual([e]);
  });

  it('reset clears both buffers (space switch)', () => {
    const a = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    const e = { id: 'e1', source: 'a', target: 'b', type: 'scissors' } as Edge;
    useCanvasGraphStore.getState().setFlowNodes(() => [a]);
    useCanvasGraphStore.getState().setFlowEdges(() => [e]);
    useCanvasGraphStore.getState().reset();
    expect(useCanvasGraphStore.getState().flowNodes).toEqual([]);
    expect(useCanvasGraphStore.getState().flowEdges).toEqual([]);
  });
});
