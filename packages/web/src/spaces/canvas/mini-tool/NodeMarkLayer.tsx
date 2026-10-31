// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useStore } from '@xyflow/react';

import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { isFreeEscape } from '@web/spaces/canvas/use-escape-in-space';
import { useMediaGeometry, type MediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import type { MarkCanvasController } from '@web/spaces/canvas/mini-tool/mark-canvas';
import { TOOL_LAYER_CLASS, stopNodeClick } from '@web/spaces/canvas/mini-tool/tool-layer-input';

interface NodeMarkLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * Markup's canvas, laid over the node's picture while that tool's panel is
 * open on it (inner#1303 §6.2).
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The layer, or null when markup is not open on this node.
 */
export function NodeMarkLayer({ nodeId, wrapper }: NodeMarkLayerProps): React.JSX.Element | null {
  const open = useCanvasSession((s) => miniToolOpenOn(nodeId)(s)?.mark != null);
  const geometry = useMediaGeometry(wrapper, open);
  if (!open || geometry === null) return null;
  // A different picture under the same node starts a fresh canvas.
  return <MarkSurface key={geometry.src ?? ''} geometry={geometry} />;
}

/**
 * The Fabric canvas and the keys it takes ahead of the canvas page. Fabric
 * loads with the first markup opened.
 * @param root0 - Component props.
 * @param root0.geometry - The media's place in the node.
 * @returns The layer.
 */
function MarkSurface({ geometry }: { geometry: MediaGeometry }): React.JSX.Element {
  const store = useCanvasSessionStore();
  const host = React.useRef<HTMLDivElement>(null);
  const controller = React.useRef<MarkCanvasController | null>(null);
  const { width, height } = geometry.box;
  // The box the canvas was built at; later sizes reach it through `setBox`.
  const box = React.useRef({ width, height });
  box.current = { width, height };
  // The canvas draws at the node's screen pixels; built at this zoom, later ones reach it through `setZoom`.
  const zoom = useStore((s) => s.transform[2]);
  const builtZoom = React.useRef(zoom);
  builtZoom.current = zoom;

  React.useEffect(() => {
    let live = true;
    /**
     * Stop following the store; nothing to stop until the canvas is built.
     * @returns Nothing.
     */
    let unsubscribe = (): void => undefined;
    void import('@web/spaces/canvas/mini-tool/mark-canvas').then(({ MarkCanvasController }) => {
      const el = host.current;
      if (!live || el === null) return;
      const canvasEl = document.createElement('canvas');
      el.appendChild(canvasEl);
      const made = new MarkCanvasController(canvasEl, box.current, store.getState, builtZoom.current);
      controller.current = made;
      /** Draw the draft and say how many objects are drawn. */
      const sync = (): void => {
        made.sync();
        el.dataset.objects = String(made.canvas.getObjects().length);
      };
      // A store write is drawn once the code that made it has returned; the
      // controller's own pointer handlers draw what they commit at once.
      let queued = false;
      unsubscribe = store.subscribe(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (live) sync();
        });
      });
      sync();
      store.getState().registerMarkChannel(made.channel);
    });
    return () => {
      live = false;
      unsubscribe();
      const made = controller.current;
      controller.current = null;
      if (made === null) return;
      made.dispose();
      if (store.getState().markChannel === made.channel) store.getState().registerMarkChannel(null);
    };
  }, [store]);

  React.useEffect(() => {
    controller.current?.setBox({ width, height });
  }, [width, height]);

  React.useEffect(() => {
    controller.current?.setZoom(zoom);
  }, [zoom]);

  // Escape leaves a text edit, then drops a selection, before it reaches the
  // node (whose Escape deselects the host and so closes the panel).
  React.useEffect(() => {
    /**
     * Take Escape while markup has a use for it.
     * @param event - The key.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFreeEscape(event)) return;
      const session = store.getState();
      const mark = session.miniTool?.mark;
      if (mark == null || session.miniTool?.exporting === true) return;
      // Markup answers only a press meant for it: one in Fabric's own text
      // input, which keeps focus when a scrollbar press hands the keyboard to
      // another region, or one meant for this space.
      // Focus can leave Fabric's input while its edit stays open, so a menu,
      // dialog or list opened elsewhere closes on its own Escape first.
      const ours =
        (event.target instanceof Element && event.target.matches('[data-fabric="textarea"]')) ||
        regionOwnsKeyboard(event.target, 'space');
      if (!ours) return;
      if (mark.editingText !== null) session.markChannel?.exitEditing();
      else if (mark.selectedId !== null) session.markChannel?.discardSelection();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [store]);

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the click is only kept from the node
    <div
      ref={host}
      data-testid='mini-tool-mark-layer'
      className={`${TOOL_LAYER_CLASS} absolute`}
      onClick={stopNodeClick}
      style={{ left: geometry.at.x, top: geometry.at.y, width, height }}
    />
  );
}
