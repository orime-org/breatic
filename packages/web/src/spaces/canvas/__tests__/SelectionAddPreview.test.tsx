// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selection plus's preview wires (inner#2216 design 4.5): drawn in the
 * canvas viewport above every node, a selected one included, so a wire that
 * passes behind a neighbouring source stays one unbroken line; one wire per
 * source the canvas still holds.
 */

import { render } from '@testing-library/react';
import { ReactFlow, type Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { SelectionAddPreview } from '@web/spaces/canvas/SelectionAddPreview';
import { XYFLOW_SELECTED_NODE_Z } from '@web/spaces/canvas/viewport-layers';

/**
 * A node the canvas has measured, as xyflow keeps it once rendered.
 * @param id - The node id.
 * @param y - Its top edge.
 * @param selected - Whether it is selected.
 * @returns The node.
 */
function measuredNode(id: string, y: number, selected = false): Node {
  return { id, position: { x: 0, y }, data: {}, selected, measured: { width: 288, height: 192 } };
}

/**
 * Renders the preview inside a canvas holding the given nodes.
 * @param nodes - The canvas nodes.
 * @param sourceIds - The nodes a pick would wire in.
 * @returns The preview svg and the canvas container.
 */
function mount(nodes: Node[], sourceIds: string[]): { svg: SVGSVGElement; container: HTMLElement } {
  const { container, getByTestId } = render(
    <div style={{ width: 1000, height: 800 }}>
      <ReactFlow nodes={nodes} edges={[]}>
        <SelectionAddPreview anchorIds={nodes.map((n) => n.id)} sourceIds={sourceIds} />
      </ReactFlow>
    </div>,
  );
  return { svg: getByTestId('selection-add-preview') as unknown as SVGSVGElement, container };
}

describe('SelectionAddPreview', () => {
  it('draws in the canvas viewport, above a selected node', () => {
    const { svg, container } = mount([measuredNode('a', 0, true), measuredNode('b', 300, true)], ['a', 'b']);
    expect(svg.closest('.react-flow__viewport')).not.toBeNull();
    const z = Number(svg.style.zIndex);
    expect(z).toBeGreaterThan(XYFLOW_SELECTED_NODE_Z);
    // The real wrapper of a selected node, not only the constant: the preview
    // must sit above what xyflow actually writes on it.
    const wrapper = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    expect(wrapper).not.toBeNull();
    expect(z).toBeGreaterThan(Number(wrapper?.style.zIndex ?? Number.NaN));
  });

  it('draws one wire per source the canvas holds', () => {
    const { svg } = mount([measuredNode('a', 0), measuredNode('b', 300), measuredNode('c', 600)], ['a', 'c', 'gone']);
    expect(svg.querySelectorAll('path')).toHaveLength(2);
  });

  it('draws no wire when there are no sources', () => {
    const { svg } = mount([measuredNode('a', 0), measuredNode('b', 300)], []);
    expect(svg.querySelectorAll('path')).toHaveLength(0);
  });
});
