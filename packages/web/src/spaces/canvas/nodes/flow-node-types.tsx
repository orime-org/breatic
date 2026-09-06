// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore, type NodeProps } from '@xyflow/react';
import type { ComponentType } from 'react';
import * as React from 'react';

import { useCanvasStore } from '@web/stores';
import { readOccupants } from '@web/spaces/canvas/attach-occupants';
import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';
import type { GroupResizeBound } from '@web/spaces/canvas/group-geometry';
import { GroupResizer } from '@web/spaces/canvas/nodes/GroupResizer';
import { MagneticHandle } from '@web/spaces/canvas/nodes/_shared/MagneticHandle';
import {
  NodeOccupantsContext,
  NOBODY,
} from '@web/spaces/canvas/nodes/_shared/node-occupants-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';
import { NODE_KIND_LIST, NODE_TYPES } from '@web/spaces/canvas/nodes/registry';
import { overlayCounterScale } from '@web/spaces/canvas/overlay-scale';
import { TaskCountColumn } from '@web/spaces/canvas/tasks/TaskCountColumn';
import type { TaskStatus } from '@web/spaces/canvas/tasks/TaskStatusDot';
import type { NodeView } from '@web/spaces/canvas/types/node-view';
import { failedTaskListToOpen } from '@web/spaces/canvas/types/node-view';

/**
 * What a node whose document carries no counts yet reads as. It is the four
 * numbers being absent, not the node having no tasks, so it stands in for
 * them here and every reader downstream sees the same shape.
 */
const NO_TASKS = { running: 0, done: 0, failed: 0, expired: 0 } as const;

/** Prop surface every node body accepts from the ReactFlow wrapper. */
interface InnerNodeProps {
  data: unknown;
  selected?: boolean;
  locked?: boolean;
  /** Commit a rename, pre-bound to this node's id (content nodes only). */
  onRename?: (name: string) => void;
  /**
   * Empty-state activation, pre-bound to this node's id + modality: opens a
   * file picker and fills this node (media nodes). Text handles its own edit.
   */
  onActivate?: () => void;
  /**
   * Open this node's task list on its failures, pre-bound to this node
   * (#186 §3.7.2). The node's error box carries one sentence; this is the way
   * from it to the row that says which task failed and why.
   */
  onViewTasks?: () => void;
}

/**
 * Wrap a registry node component for ReactFlow: adapt `NodeProps` into the
 * component's `{ data, selected, locked, onRename }` props and render the
 * source / target connection handles.
 *
 * This wrapper is the only layer that knows ReactFlow's node id, so it binds
 * the body's `onRename` to `renameNode(thisNodeId, name)` from the canvas
 * actions context — the node body knows the new name but not its own id.
 *
 * The handles live here, not in the shared `NodeShell`, because `<Handle>`
 * reads ReactFlow store context and would throw when `NodeShell` is
 * rendered in isolation (its own unit tests, future non-canvas reuse).
 * This wrapper only ever mounts inside `<ReactFlow>`, so the context is
 * guaranteed.
 * @param Inner - The registry node component for one modality.
 * @returns A ReactFlow-compatible node component.
 */
function makeFlowNode(
  Inner: ComponentType<InnerNodeProps>,
): ComponentType<NodeProps> {
  /**
   * ReactFlow node renderer: connection handles + the modality body.
   * @param props - ReactFlow node props; `data` carries the node's NodeView.
   * @returns The wrapped node element.
   */
  function FlowNode(props: NodeProps): React.JSX.Element {
    const data = props.data as unknown as NodeView;
    // Who is holding this node, baked onto it by the mirror (`attachOccupants`).
    // A node nobody holds carries nothing, and the context's own default — one
    // shared empty array — is what every such node reads.
    //
    // Whoever started a task on this node is not among them (#186): the
    // document says only how many tasks are in each state, and who started
    // each one is a detail the task list answers.
    const occupants = readOccupants(props.data) ?? NOBODY;
    const {
      renameNode,
      activateNodeUpload,
      beginGroupResize,
      commitGroupResize,
      reportGroupResize,
    } = useCanvasActions();
    // The canvas zoom (transform[2]) lets the name header counter-scale so it
    // keeps a constant screen size — down to a floor zoom, below which it
    // shrinks with the canvas (see `overlayCounterScale`). The scissors button
    // uses the same shared factor.
    const zoom = useStore((s) => s.transform[2]);
    const headerScale = overlayCounterScale(zoom);
    const onRename = React.useCallback(
      (name: string): void => renameNode(props.id, name),
      [renameNode, props.id],
    );
    // Empty-state double-click on a media node: open a file picker + fill THIS
    // node (the canvas owns the picker + upload). Only image / video / audio
    // upload this way; text enters inline edit (handled in-body), and group /
    // annotation / web have no empty-state file upload.
    const onActivate = React.useCallback((): void => {
      const kind = data.kind;
      if (kind === 'image' || kind === 'video' || kind === 'audio') {
        activateNodeUpload(props.id, kind);
      }
    }, [activateNodeUpload, props.id, data.kind]);
    // A Group fills the ReactFlow wrapper sized to its stored width/height, so
    // the GroupNode's own `size-full` resolves to the full rect. Content nodes
    // size to their body, so they keep the auto-height wrapper. A selected,
    // unlocked Group shows the GroupResizer handles when it has resize bounds
    // (empty for a read-only viewer, so no handles show — see the gate below).
    const isGroup = data.kind === 'group';
    // Per-control resize bounds (from groupResizeBounds, attached in renderNodes)
    // — each edge / corner carries its own min so ReactFlow's native clamp
    // hard-stops it at "members + padding" (see GroupResizer). Empty for a
    // non-group node.
    const resizeBounds =
      (props.data as { groupResizeBounds?: GroupResizeBound[] })
        .groupResizeBounds ?? [];
    // Persist a Group's manual resize. ReactFlow's native per-control clamp
    // guarantees the params already keep every member ≥ padding inside (even on
    // a fast release), so the canvas commits the rect verbatim.
    const onResizeEnd = React.useCallback(
      (
        _event: unknown,
        params: { x: number; y: number; width: number; height: number },
      ): void => commitGroupResize(props.id, params),
      [commitGroupResize, props.id],
    );
    // Open the resize on the press. ReactFlow reads its own starting geometry
    // in this same frame, so the canvas records its starting point here to have
    // the two agree.
    const onResizeStart = React.useCallback(
      (): void => beginGroupResize(props.id),
      [beginGroupResize, props.id],
    );
    // During a reference pick the pick owns node interaction: a double-click
    // must NOT enter inline edit / open the upload picker (user 2026-07-12 P2b —
    // a text empty node still entered edit, the upload placeholder still fired).
    // Capture-phase
    // stop blocks the body's / placeholder's onDoubleClick before it runs; the
    // native double-click text selection is separately killed by user-select:none
    // (index.css .canvas-picking). Read the flag lazily so no node re-renders on
    // pick toggle.
    const onDoubleClickCapture = React.useCallback(
      (event: React.MouseEvent): void => {
        if (useCanvasStore.getState().pickSession != null) {
          event.stopPropagation();
        }
      },
      [],
    );
    // The task counts sit outside the node's top-right corner, one per state
    // this node has something in (#186 §7.1). Which one is pressed is the
    // panel's own state, so a second node's column never lights up from the
    // first node's list.
    const taskCounts =
      data.kind === 'group' || data.kind === 'annotation'
        ? null
        : (data.taskCounts ?? NO_TASKS);
    const taskPanelOpenHere = useCanvasStore(
      (s) =>
        s.panelKind === 'tasks' && s.panelHostId === props.id
          ? s.taskPanelStatus
          : null,
    );
    const openTaskPanel = useCanvasStore((s) => s.openTaskPanel);
    const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
    const onOpenTasks = React.useCallback(
      (next: TaskStatus | null): void => {
        if (next === null) closeActivePanel();
        else openTaskPanel(props.id, next);
      },
      [closeActivePanel, openTaskPanel, props.id],
    );
    // Absent when no task on this node failed, which is what keeps the error
    // box from offering a way into a list with nothing in it: the counts that
    // put that box on screen also say which of the two failure states to show.
    const failedList = failedTaskListToOpen(taskCounts);
    const onViewTasks = React.useCallback((): void => {
      if (failedList !== null) openTaskPanel(props.id, failedList);
    }, [failedList, openTaskPanel, props.id]);
    return (
      <NodeIdContext.Provider value={props.id}>
        <NodeScaleContext.Provider value={headerScale}>
          <NodeOccupantsContext.Provider value={occupants}>
            <div
              className={isGroup ? 'relative size-full' : 'relative'}
              onDoubleClickCapture={onDoubleClickCapture}
            >
              <Inner
                data={data}
                selected={props.selected}
                locked={data.locked}
                onRename={onRename}
                onActivate={onActivate}
                {...(failedList !== null && { onViewTasks })}
              />
              {/* The resize controls render AFTER the body for the same reason
                the connection handles below do: absolutely-positioned siblings
                paint in DOM order, and a Group's body fills the whole rect. An
                edge line is 1px wide and centred on the border, so its inner
                half lands on the body — and `left` / `top` centre their box on
                coordinate 0, which the body's own box still covers. Painted
                before the body, those two edges hand every press to the body
                and the grab reads as a drag of the whole Group; `right` and
                `bottom` centre on w / h, one pixel past the body, which is why
                only they ever answered. */}
              {isGroup &&
            Boolean(props.selected) &&
            !data.locked &&
            resizeBounds.length > 0 ? (
                  <GroupResizer
                    bounds={resizeBounds}
                    onResizeStart={onResizeStart}
                    onResize={reportGroupResize}
                    onResizeEnd={onResizeEnd}
                  />
                ) : null}
              {/* Connection handles are for content nodes only — a Group is a
                container (Figma-Frame-style), not an edge endpoint, so it renders
                none (Bug 7: the Left handle also sat on the group's left edge and
                interfered with the left resize grab). Both handles render AFTER
                the body: absolutely-positioned siblings paint in DOM order, so a
                handle placed BEFORE the body has its inner half covered by the
                body's surface and reads as a half-circle (the left-handle bug);
                painting both on top of the body shows each as a full dot. */}
              {/* Magnetic handles (user 2026-07-11): a 36px outside-the-border
                hit zone whose visible dot spring-follows the cursor, while
                the 8px anchor keeps the wire attachment on the border.
                MagneticHandle forwards all three connectable flags — the
                gesture gates sit on Start/End, so a viewer / pick session
                that drops them keeps handles live (adversarial round-1). See
                MagneticHandle for the three-layer decoupling. */}
              {!isGroup ? (
                <>
                  <MagneticHandle
                    type='target'
                    isConnectable={props.isConnectable}
                  />
                  <MagneticHandle
                    type='source'
                    isConnectable={props.isConnectable}
                  />
                </>
              ) : null}
              {/* Outside the node's own box, so it never covers content and
                never changes what the body is sized to. It counter-scales on
                the same factor as the name header, so the four numbers stay
                readable at any zoom. */}
              {taskCounts !== null ? (
                <div
                  // `nodrag` keeps a press on a count from starting a node
                  // drag: xyflow's threshold is one pixel, so opening the list
                  // would otherwise slide the node under the cursor and write
                  // a new position into the shared document.
                  className='nodrag absolute left-full top-0'
                  style={{
                    transform: `scale(${headerScale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  {/* The gap sits inside the counter-scaled box so it holds
                      the same screen distance the column does. As a margin on
                      the box it was a flow-unit measure against a screen-unit
                      column, and zooming in pulled the two apart. */}
                  <div className='pl-2'>
                    <TaskCountColumn
                      counts={taskCounts}
                      openFor={taskPanelOpenHere}
                      onOpen={onOpenTasks}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </NodeOccupantsContext.Provider>
        </NodeScaleContext.Provider>
      </NodeIdContext.Provider>
    );
  }
  return FlowNode;
}

/**
 * ReactFlow `nodeTypes` map — one handle-wrapped component per node kind,
 * keyed by the same `NodeKind` strings ReactFlow matches against `node.type`.
 */
export const FLOW_NODE_TYPES: Record<string, ComponentType<NodeProps>> =
  Object.fromEntries(
    NODE_KIND_LIST.map((kind) => [kind, makeFlowNode(NODE_TYPES[kind])]),
  );
