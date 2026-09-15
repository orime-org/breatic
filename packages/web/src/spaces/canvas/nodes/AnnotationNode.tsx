// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an annotation IS on the canvas: a pin (#1881 §8.7).
 *
 * The sticky is what the pin opens into, and it floats beside it rather than
 * being the node — see `AnnotationPanelContainer`. Making the pin the node is
 * what gives a note dragging, selection, marquee and Delete for nothing: they
 * are the canvas's own, and a note was the one thing on the board that could
 * not be moved after it was left.
 *
 * Not a content node — it holds no payload and generates nothing, so it draws
 * no handles: a sticky is about the canvas, never an input to it (§8.5). With
 * no handle there is nothing for xyflow to start or land a connection on, and
 * that is the whole of it: `connection-rules.ts` lists no annotation, and a
 * target absent from its whitelist accepts any source.
 */

import * as React from 'react';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { AnnotationPin } from '@web/spaces/canvas/annotation/AnnotationPin';
import { useAnnotationNames } from '@web/spaces/canvas/annotation/names';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useCanvasStore } from '@web/stores/canvas';

interface AnnotationNodeProps {
  data: AnnotationNodeView;
  selected?: boolean;
  locked?: boolean;
}

/**
 * Draw the pin a note is while it is closed.
 * @param root0 - Annotation node props.
 * @param root0.data - The note: who raised it, and what has been said under it.
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock mark.
 * @returns The pin.
 */
export const AnnotationNode = React.memo(function AnnotationNode({
  data,
  selected,
  locked,
}: AnnotationNodeProps): React.JSX.Element {
  const nodeId = React.useContext(NodeIdContext);
  // The box is sized in flow pixels against the live zoom, which is what makes
  // `offsetWidth` — the only measurement xyflow takes — equal what the reader
  // sees (`pin-geometry`).
  const zoom = useCanvasStore((s) => s.zoom);
  const openAnnotationPanel = useCanvasStore((s) => s.openAnnotationPanel);
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const expanded = useCanvasStore(
    (s) => s.panelKind === 'annotation' && s.panelHostId === nodeId,
  );

  // Whoever raised the note, for good: the last person to reply changes with
  // every reply, and the same pin would keep changing face. The profiles come
  // from the board's one request; while it is in flight, and for an account
  // that has been deleted, there is no entry and the pin shows a plain ground
  // rather than going missing (§8.7.1).
  const author = useAnnotationNames().get(data.createdBy);

  const toggle = React.useCallback((): void => {
    if (nodeId === null) return;
    if (expanded) closeActivePanel();
    else openAnnotationPanel(nodeId);
  }, [nodeId, expanded, closeActivePanel, openAnnotationPanel]);

  return (
    <AnnotationPin
      authorName={author?.name ?? ''}
      avatarUrl={author?.avatarUrl ?? null}
      replyCount={data.replies.length}
      zoom={zoom}
      locked={locked}
      selected={selected}
      onOpen={toggle}
    />
  );
});
