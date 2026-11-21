// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type * as Y from 'yjs';
import { CANVAS_NODES_KEY } from '@breatic/shared';
import type { MiniToolPresentationRef, VideoToolDraftReading, VideoToolId } from '@breatic/shared/mini-tools';

import { nodeDataMap } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';

interface DraftSubscription<K extends VideoToolId> {
  getSnapshot: () => VideoToolDraftReading<K>;
  subscribe: (changed: () => void) => () => void;
}

/**
 * Adapts one document field to React's external-store subscription contract.
 * @param doc - The canonical live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool being observed.
 * @param presentationRef - The selected version's ref the draft is judged against.
 * @returns A stable snapshot reader and an attachment-scoped subscription.
 * @throws {never} Never.
 */
function draftSubscription<K extends VideoToolId>(doc: Y.Doc, nodeId: string, toolId: K, presentationRef: MiniToolPresentationRef | undefined): DraftSubscription<K> {
  const key = `miniToolDraft:${toolId}`;
  let current: unknown = nodeDataMap(doc, nodeId)?.get(key);
  let snapshot = readVideoToolDraft(doc, nodeId, toolId, presentationRef);

  /**
   * Reuses the parsed snapshot while the authoritative scalar is unchanged.
   * @returns The current reading with stable identity between changes.
   * @throws {never} Never.
   */
  const getSnapshot = (): VideoToolDraftReading<K> => {
    const value: unknown = nodeDataMap(doc, nodeId)?.get(key);
    if (value !== current) {
      current = value;
      snapshot = readVideoToolDraft(doc, nodeId, toolId, presentationRef);
    }
    return snapshot;
  };

  /**
   * Attaches to node replacement and scalar changes until detach or destruction.
   * @param changed - React's request to read the current snapshot.
   * @returns The function that releases this attachment.
   * @throws {never} Never.
   */
  const subscribe = (changed: () => void): (() => void) => {
    const nodes = doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY);
    let active = true;

    /**
     * Delivers changes only while this attachment owns the observer.
     * @throws {never} Never.
     */
    const report = (): void => {
      if (active) changed();
    };

    /**
     * Releases the same observers when React detaches or the document dies.
     * @throws {never} Never.
     */
    const release = (): void => {
      if (!active) return;
      active = false;
      nodes.unobserveDeep(report);
      doc.off('destroy', release);
    };

    nodes.observeDeep(report);
    doc.on('destroy', release);
    return release;
  };

  return { getSnapshot, subscribe };
}

/**
 * Follows a tool's persisted snapshot through edits and document remounts.
 * @param projectId - The Project that owns the canvas.
 * @param spaceId - The canvas Space.
 * @param nodeId - The host node.
 * @param toolId - The video tool being edited.
 * @param presentationRef - The selected version's ref, stable while it names the same version; a draft bound elsewhere reads stale.
 * @returns The current supported or stale snapshot, or its stored format state.
 * @throws {never} Never.
 */
export function useVideoToolDraft<K extends VideoToolId>(
  projectId: string,
  spaceId: string,
  nodeId: string,
  toolId: K,
  presentationRef?: MiniToolPresentationRef,
): VideoToolDraftReading<K> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const subscription = React.useMemo(() => draftSubscription(doc, nodeId, toolId, presentationRef), [doc, nodeId, toolId, presentationRef]);
  return React.useSyncExternalStore(subscription.subscribe, subscription.getSnapshot, subscription.getSnapshot);
}
