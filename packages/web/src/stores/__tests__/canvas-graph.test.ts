// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Edge, Node } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { canvasGraphs } from '@web/stores/canvas-graph';

/**
 * The canvas graph store (#1647 step 4) owns the ReactFlow render buffer
 * (flowNodes / flowEdges) — a plain (non-immer) zustand store, because the node
 * array is high-frequency and immer's autoFreeze / proxy would freeze the node
 * objects and interfere with ReactFlow's controlled rendering. It exposes
 * functional-updater setters so the reference-stable mirror merge can run
 * against the current buffer. Every open Space keeps its canvas mounted, so
 * each Space has its own buffer (inner#1235 §5.2).
 */
describe('canvasGraphs', () => {
  beforeEach(() => {
    canvasGraphs.clear();
  });

  const graph = (): ReturnType<typeof canvasGraphs.of> => canvasGraphs.of('s');

  it('starts empty', () => {
    const s = graph().getState();
    expect(s.flowNodes).toEqual([]);
    expect(s.flowEdges).toEqual([]);
  });

  it('setFlowNodes applies the updater against the current buffer', () => {
    const a = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    graph().getState().setFlowNodes(() => [a]);
    expect(graph().getState().flowNodes).toEqual([a]);

    // The updater receives the current buffer, so it can append / reconcile.
    const b = { id: 'b', type: 'image', position: { x: 1, y: 1 }, data: {} } as Node;
    graph().getState().setFlowNodes((prev) => [...prev, b]);
    expect(graph().getState().flowNodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('does NOT freeze the stored node objects (immer autoFreeze would break ReactFlow)', () => {
    const node = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    graph().getState().setFlowNodes(() => [node]);
    const stored = graph().getState().flowNodes[0];
    expect(Object.isFrozen(stored)).toBe(false);
    // The exact same object reference is stored (no proxy wrapping).
    expect(stored).toBe(node);
  });

  it('setFlowEdges applies the updater against the current buffer', () => {
    const e = { id: 'e1', source: 'a', target: 'b', type: 'scissors' } as Edge;
    graph().getState().setFlowEdges(() => [e]);
    expect(graph().getState().flowEdges).toEqual([e]);
  });

  it('keeps one Space buffer apart from another', () => {
    const a = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    canvasGraphs.of('s1').getState().setFlowNodes(() => [a]);

    expect(canvasGraphs.of('s2').getState().flowNodes).toEqual([]);
    expect(canvasGraphs.of('s1').getState().flowNodes).toEqual([a]);
  });

  it('starts a dropped Space over from an empty buffer', () => {
    const a = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} } as Node;
    canvasGraphs.of('s1').getState().setFlowNodes(() => [a]);
    canvasGraphs.drop('s1');

    expect(canvasGraphs.of('s1').getState().flowNodes).toEqual([]);
  });
});
