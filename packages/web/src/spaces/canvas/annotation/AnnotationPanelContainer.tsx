// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';
import { AnnotationSticky } from '@web/spaces/canvas/annotation/AnnotationSticky';
import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';
import { useCanvasStore } from '@web/stores/canvas';

/** The gap between the pin and the sticky it opens, in screen pixels. */
const STICKY_GAP = 8;

interface AnnotationPanelContainerProps {
  /** Live nodes: the one being expanded is found here, by id. */
  nodes: readonly CanvasNodeView[];
  /** Whether a peer removed this node from the board (`canvas-space.ts`). */
  deletedByPeer: (nodeId: string) => boolean;
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
 * @param root0.deletedByPeer - Whether a peer is the one who removed a note.
 * @returns The floating sticky, or null when no note is open.
 */
export function AnnotationPanelContainer({
  nodes,
  deletedByPeer,
}: AnnotationPanelContainerProps): React.JSX.Element | null {
  const t = useTranslation();
  const host = useCanvasStore((s) => s.panelHostId);
  const kind = useCanvasStore((s) => s.panelKind);
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const draftsHeld = useCanvasStore((s) => s.annotationDrafts);
  const placing = useCanvasStore((s) => s.placingAnnotation);
  const nodeId = kind === 'annotation' ? host : null;
  const view =
    nodeId === null ? undefined : nodes.find((n) => n.id === nodeId)?.data;
  // A collaborator deleting the note takes the sticky with it (§6.2's "deleted
  // in Yjs" row): there is nothing left to draw and nothing left to write to.
  const gone = nodeId !== null && view?.kind !== 'annotation';
  React.useEffect(() => {
    if (!gone) return;
    // §6.2 and §8.4 both ask for a word here, and the drop notice that carries
    // one for a deleted REPLY lives inside the sticky — which is exactly what
    // this removes, so the note's own case had no surface and the words went
    // without a line. Two things have to be true to say it: a peer took the
    // note away, and somebody was writing in it. A closed draft is a notice
    // waiting to be waved away, not a person typing.
    //
    // Asked as "who wrote last", the answer is a board-wide flag that any
    // routine write can carry off between the removal and this read; asked as
    // "which entry point ran", it is a list of the callers somebody
    // remembered, and the keyboard Delete was not on it. Naming the ids
    // answers the question itself — and a board that never held the note has
    // no record of it being removed, which is what keeps a Space switch quiet.
    const held = nodeId === null ? undefined : draftsHeld[nodeId];
    if (
      nodeId !== null &&
      deletedByPeer(nodeId) &&
      held !== undefined &&
      held.draft.mode !== 'closed'
    ) {
      toast.warning(t('canvas.annotation.noteGone'));
    }
    closeActivePanel();
  }, [gone, nodeId, draftsHeld, closeActivePanel, deletedByPeer, t]);
  // What a close does to the box that was open, by which box it is (user
  // 2026-09-15). A REPLY is kept for as long as this Space is open: closing
  // the panel is not the reader saying they do not want it, and reopening the
  // pin draws it as it was. A REWRITE goes, and the reader opens a new one
  // from the entry's own menu — that one reads what the entry says now, so a
  // collaborator's newer body is what it starts from.
  //
  // Keyed on the host id, so the canvas culling the pin's DOM — which takes
  // the sticky and leaves the node — is not a close. The two shapes a close
  // has both run through here: the slot moving to another note (or to
  // nothing), and this canvas going away, the §8.7.3 「切 Space / 组件卸载 →
  // 收起」 row. The slot closes with it either way.
  React.useEffect(() => {
    if (nodeId === null) return undefined;
    return () => {
      const canvas = useCanvasStore.getState();
      const held = canvas.annotationDrafts[nodeId];
      const isAReply =
        held !== undefined &&
        held.draft.mode !== 'closed' &&
        held.draft.use === 'reply';
      if (!isAReply) canvas.setAnnotationDraft(nodeId, null);
      // Only when the slot is still this note's. React runs this cleanup AFTER
      // the render that already wrote the next note into the slot, so opening
      // another note through the same click would close what that click just
      // opened and the reader would have to press its pin twice.
      if (canvas.panelHostId === nodeId) closeActivePanel();
    };
  }, [nodeId, closeActivePanel]);
  // Escape collapses the note (§8.7.3), heard here rather than left to follow
  // from the selection: a pin is not a focus stop of xyflow's, so the library's
  // own "Escape unselects the focused node" never runs for one — measured on a
  // board, the sticky stayed open on every press. The press this mode may take
  // is the one the canvas's other two modes take, down to five conditions:
  // `useEscapeInSpace` is where they live, and a third hand-written copy is
  // what let the ⋯ menu, an IME candidate window and the agent column each
  // collapse a note out from under the reader. A box inside the sticky that
  // has something to drop stops the key before it reaches this (§6.2), so the
  // first press closes that box and the next one collapses the note.
  //
  // Stacked under the armed note tool: that is the thing the reader picked up
  // most recently, so the press puts it down and the next one collapses this.
  // The stack is this gate — while the tool is armed there is no listener here
  // at all. Measured on a board with both listening: one Escape disarmed the
  // tool AND collapsed the sticky.
  const open = nodeId !== null && !gone && !placing;
  useEscapeInSpace(open, closeActivePanel);
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
