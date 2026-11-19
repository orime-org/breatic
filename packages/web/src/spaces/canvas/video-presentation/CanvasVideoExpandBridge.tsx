// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { newId } from '@breatic/shared';
import { getDoc, docName } from '@web/data/yjs/manager';
import { nodeDataMap } from '@web/data/yjs/canvas-space';
import { useVideoToolDraft } from '@web/data/yjs/use-video-tool-draft';
import { readVideoToolDraft, commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useConnectionLost } from '@web/data/yjs/space-connection';
import { ExpandFrameOverlay, type ExpandFrameOverlayProps } from '@web/spaces/canvas/mini-tool/ExpandFrameOverlay';
import type { ExpandFrame, ExpandRatio } from '@web/spaces/canvas/mini-tool/expand-frame';
import type { MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

interface CanvasVideoExpandBridgeProps {
  nodeId: string;
  canonicalURL: string;
  locked: boolean;
  snapshot: MediaPlayerVideoSnapshot | undefined;
  onNodeContextMenu: ExpandFrameOverlayProps['onNodeContextMenu'];
}

/**
 * Commits the existing expansion gesture while keeping the real video and controls live.
 * @param props - The current node source and owned attachment.
 * @returns The original frame geometry and eight grips with outside-only backgrounds.
 * @throws {Error} When a supposedly supported draft fails validation on write.
 */
export function CanvasVideoExpandBridge(props: CanvasVideoExpandBridgeProps): React.JSX.Element {
  const { projectId, spaceId, readOnly: viewer } = useCanvasContext();
  // Offline the frame takes no edit, as the panel takes none (canvas design §4).
  const offline = useConnectionLost();
  const readOnly = viewer || offline;
  const reading = useVideoToolDraft(projectId, spaceId, props.nodeId, 'video.expand');
  const draft = reading.state === 'supported' ? reading.draft : null;
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  /**
   * Rechecks the current persisted source, lock and revision at pointer completion.
   * @param nodeId - The owning node.
   * @param frame - The completed source-relative target geometry.
   * @param ratio - The existing ratio mode.
   * @param revision - Authoritative revision captured when the pointer began.
   * @throws {Error} When a supported snapshot fails schema validation.
   */
  const commit = React.useCallback((nodeId: string, frame: ExpandFrame, ratio: ExpandRatio, revision: string): void => {
    if (readOnly) return;
    const data = nodeDataMap(doc, nodeId);
    const current = readVideoToolDraft(doc, nodeId, 'video.expand');
    if (!data || data.get('locked') === true || current.state !== 'supported' || current.draft.revision !== revision || current.draft.source.canonicalURL !== data.get('content') || current.draft.source.canonicalURL !== props.canonicalURL) return;
    commitVideoToolDraft(doc, nodeId, 'video.expand', { ...current.draft, revision: newId(), params: { ...current.draft.params, frame, ratio } });
  }, [doc, readOnly, props.canonicalURL]);
  const binding = props.snapshot?.binding;
  return <ExpandFrameOverlay
    onNodeContextMenu={props.onNodeContextMenu}
    videoLiveSource
    videoCanonicalURL={props.canonicalURL}
    videoRevision={draft?.revision}
    videoSourceEpoch={binding?.sourceEpoch}
    videoSeekEpoch={binding?.getSeekEpoch()}
    videoDisabled={readOnly || props.locked || draft === null || draft.source.canonicalURL !== props.canonicalURL}
    onVideoFrameCommit={commit}
  />;
}
