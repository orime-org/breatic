// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useStore, type NodeProps } from '@xyflow/react';
import type { ComponentType } from 'react';
import * as React from 'react';

import { useCanvasStore } from '@web/stores';
import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';
import type { GroupResizeBound } from '@web/spaces/canvas/group-geometry';
import { GroupResizer } from '@web/spaces/canvas/nodes/GroupResizer';
import { MagneticHandle } from '@web/spaces/canvas/nodes/_shared/MagneticHandle';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';
import { NODE_KIND_LIST, NODE_TYPES } from '@web/spaces/canvas/nodes/registry';
import { overlayCounterScale } from '@web/spaces/canvas/overlay-scale';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

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
   * Commit inline-edited text content, pre-bound to this node's id (text nodes).
   * Without it the text body's edit is never persisted — discarded on blur.
   */
  onChange?: (next: string) => void;
  /**
   * Retry a failed upload from its session-stashed File, pre-bound to this
   * node's id (#1609 P4). Present only while a stash exists — its absence
   * hides the error-state Retry button.
   */
  onRetryUpload?: () => void;
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
    const {
      renameNode,
      activateNodeUpload,
      setNodeContent,
      commitGroupResize,
      retryNodeUpload,
      hasUploadRetryFile,
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
    // Text body commits its inline edit through here — the wrapper is the only
    // layer that knows the node id, so it binds the content write to it (mirrors
    // onRename). Without this the body's onChange is undefined and the edit is
    // lost on blur (#1470).
    const onChange = React.useCallback(
      (content: string): void => setNodeContent(props.id, content),
      [setNodeContent, props.id],
    );
    // Error-state Retry (#1609 P4): bound only while the session still
    // stashes this node's failed File — no stash (refresh / success /
    // non-upload error) leaves the prop undefined and no button renders.
    // The stash is written BEFORE the error lands in Yjs, so by the time
    // the error re-render evaluates this the stash is already visible.
    const onRetryUpload = React.useCallback(
      (): void => retryNodeUpload(props.id),
      [retryNodeUpload, props.id],
    );
    const canRetryUpload = hasUploadRetryFile(props.id);
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
    return (
      <NodeIdContext.Provider value={props.id}>
        <NodeScaleContext.Provider value={headerScale}>
          <div
            className={isGroup ? 'relative size-full' : 'relative'}
            onDoubleClickCapture={onDoubleClickCapture}
          >
            {isGroup &&
            Boolean(props.selected) &&
            !data.locked &&
            resizeBounds.length > 0 ? (
                <GroupResizer bounds={resizeBounds} onResizeEnd={onResizeEnd} />
              ) : null}
            <Inner
              data={data}
              selected={props.selected}
              locked={data.locked}
              onRename={onRename}
              onActivate={onActivate}
              onChange={onChange}
              {...(canRetryUpload && { onRetryUpload })}
            />
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
          </div>
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
