// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { AnnotationSticky } from '@web/spaces/canvas/annotation/AnnotationSticky';
import { useCanvasStore } from '@web/stores/canvas';

/** The gap between the pin and the sticky it opens, in screen pixels. */
const STICKY_GAP = 8;

interface AnnotationPanelContainerProps {
  /** Live nodes: the one being expanded is found here, by id. */
  nodes: readonly CanvasNodeView[];
}

/**
 * The expanded sticky's canvas integration point (#1881 §8.7).
 *
 * The fifth node-anchored panel in the same exclusive slot as Generate,
 * reset-empty-image, node history and the task list — which is where "only one
 * sticky open at a time" comes from, rather than from a rule of its own.
 *
 * `NodeToolbar` gives it two things the sticky needs: it portals into
 * `.react-flow__renderer`, above the layer the annotation tool arms, so a
 * sticky stays usable while somebody is placing another note; and
 * `getNodeToolbarTransform` (`@xyflow/system@0.0.79:1492`) only translates the
 * node's rect into screen coordinates, never scales it, so the sticky reads at
 * the same size at every zoom.
 * @param root0 - Component props.
 * @param root0.nodes - Live nodes, to find the host and to notice it going.
 * @returns The floating sticky, or null when no note is open.
 */
export function AnnotationPanelContainer({
  nodes,
}: AnnotationPanelContainerProps): React.JSX.Element | null {
  const host = useCanvasStore((s) => s.panelHostId);
  const kind = useCanvasStore((s) => s.panelKind);
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const nodeId = kind === 'annotation' ? host : null;
  const view =
    nodeId === null ? undefined : nodes.find((n) => n.id === nodeId)?.data;
  // A collaborator deleting the note takes the sticky with it (§6.2's "deleted
  // in Yjs" row): there is nothing left to draw and nothing left to write to.
  const gone = nodeId !== null && view?.kind !== 'annotation';
  React.useEffect(() => {
    if (gone) closeActivePanel();
  }, [gone, closeActivePanel]);
  if (nodeId === null || view?.kind !== 'annotation') return null;
  return (
    <NodeToolbar
      nodeId={nodeId}
      isVisible
      position={Position.Right}
      // Top edges level with the pin's, the way the demo has them: centred on
      // a 28px pin, a sticky 280px tall hangs 126px above the point somebody
      // was pointing at — both measured on a board. The gap is the demo's 8px,
      // from the pin's own edge; the pin is the whole trigger, with nothing
      // wrapped around it.
      align='start'
      offset={STICKY_GAP}
    >
      <AnnotationSticky
        key={nodeId}
        data={view satisfies AnnotationNodeView}
        nodeId={nodeId}
        locked={view.locked === true}
      />
    </NodeToolbar>
  );
}
