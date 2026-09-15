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
  /** Whether this end wrote the change that just arrived (`canvas-space.ts`). */
  getLastWriteWasLocal: () => boolean;
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
 * @param root0.getLastWriteWasLocal - Who wrote the change that just arrived.
 * @returns The floating sticky, or null when no note is open.
 */
export function AnnotationPanelContainer({
  nodes,
  getLastWriteWasLocal,
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
  // Whether this board was showing the note a moment ago. A deletion is the
  // board LOSING one it had; a mount that never had it is something else —
  // switching Space remounts the canvas with another board's nodes while the
  // panel slot and the drafts carry over, being cleared per PROJECT
  // (`ProjectPage.tsx:201`). Measured before this, a half-typed reply plus a
  // click on another Space tab read "This note was deleted."
  const wasOnThisBoard = React.useRef(false);
  React.useEffect(() => {
    if (!gone) {
      wasOnThisBoard.current = nodeId !== null;
      return;
    }
    // §6.2 and §8.4 both ask for a word here, and the drop notice that carries
    // one for a deleted REPLY lives inside the sticky — which is exactly what
    // this removes, so the note's own case had no surface and the words went
    // without a line. Three things have to be true to say it: the board lost a
    // note it was showing, somebody was writing in it, and the deletion came
    // from somewhere else. A closed draft is a notice waiting to be waved
    // away, not a person typing.
    //
    // Who wrote it is the question, not which entry point ran: answered by
    // clearing the draft at each deleting call site, the answer is a list of
    // the callers somebody remembered, and the keyboard Delete
    // (`CanvasSpace.tsx:1540`) and undo were not on it — so a reader's own
    // press came back as news about their note. `CanvasSpace.tsx:894` draws
    // the same distinction for the focus session.
    const held = nodeId === null ? undefined : draftsHeld[nodeId];
    if (
      !getLastWriteWasLocal() &&
      wasOnThisBoard.current &&
      held !== undefined &&
      held.draft.mode !== 'closed'
    ) {
      toast.warning(t('canvas.annotation.noteGone'));
    }
    closeActivePanel();
  }, [gone, nodeId, draftsHeld, closeActivePanel, getLastWriteWasLocal, t]);
  // A draft's life is the sticky's open and close (user 2026-09-15): what is
  // typed survives the caret leaving the box, and ends when the whole panel
  // closes. The reducer holds the first half (`annotation-draft.ts`, the
  // 'blur' case); this is the second, and it belongs here because this is what
  // owns the slot — every way of closing (the pin toggle, Escape, another
  // panel opening, another note taking the slot) goes through the same host
  // id. Keyed on that id rather than on this component's mount, so the canvas
  // culling the pin's DOM leaves the draft alone.
  //
  // Without it a rewrite outlived the close: reopening drew the box with the
  // writer's own stale text, a collaborator's newer body was not on screen at
  // all, and Save wrote over it.
  const wasHeldFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    const left = wasHeldFor.current;
    if (left !== null && left !== nodeId) {
      useCanvasStore.getState().setAnnotationDraft(left, null);
    }
    wasHeldFor.current = nodeId;
  }, [nodeId]);
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
  // Both modes ask the same hook for the same press, and it hands the press to
  // every listener that wants it — measured on a board, one Escape disarmed
  // the tool AND collapsed the sticky.
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
