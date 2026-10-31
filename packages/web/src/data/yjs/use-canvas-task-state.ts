// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type NodeTaskCounts } from '@breatic/shared';
import type { Modality } from '@web/data/yjs/node-view';
import { docName, getDoc } from '@web/data/yjs/manager';

/** Task badges belong to content views; containers and annotations carry none. */
const TASK_NODE_TYPES: Readonly<Record<Modality, true>> = {
  text: true, image: true, audio: true, video: true, '3d': true, web: true,
};

export interface CanvasTaskState {
  running: boolean;
  contentNodeIds: ReadonlySet<string>;
}

const EMPTY: CanvasTaskState = { running: false, contentNodeIds: new Set() };

/**
 * Read the task facts already present in the canonical document.
 * @param doc - Existing Canvas document.
 * @returns Its running flag and current content node ids.
 * @throws {never} Never.
 */
function readTaskState(doc: Y.Doc | null): CanvasTaskState {
  if (!doc || doc.isDestroyed) return EMPTY;
  let running = false;
  const contentNodeIds = new Set<string>();
  doc.getMap<unknown>(CANVAS_NODES_KEY).forEach((node, id) => {
    if (!(node instanceof Y.Map)) return;
    const type = node.get('type');
    const data = node.get('data');
    if (typeof type !== 'string' || !Object.hasOwn(TASK_NODE_TYPES, type) || !(data instanceof Y.Map)) return;
    contentNodeIds.add(id);
    const counts = data.get('taskCounts') as NodeTaskCounts | undefined;
    if ((counts?.running ?? 0) > 0) running = true;
  });
  return { running, contentNodeIds };
}

/**
 * Observe task counts outside the content Activity without mirroring the document.
 * @param projectId - Owning Project.
 * @param spaceId - Observed Space.
 * @param enabled - Whether this Space is a Canvas.
 * @param connectedDoc - Document used by the existing provider when connected.
 * @returns The current task facts.
 * @throws {never} Never.
 */
export function useCanvasTaskState(
  projectId: string,
  spaceId: string,
  enabled: boolean,
  connectedDoc?: Y.Doc,
): CanvasTaskState {
  const doc = React.useMemo(() => enabled
    ? connectedDoc ?? getDoc(docName.canvasSpace(projectId, spaceId))
    : null, [projectId, spaceId, enabled, connectedDoc]);
  const source = React.useMemo(() => {
    let snapshot = readTaskState(doc);
    /**
     * Keep the snapshot stable while task facts stay the same.
     * @throws {never} Never.
     */
    const refresh = (): void => {
      const next = readTaskState(doc);
      const sameIds = next.contentNodeIds.size === snapshot.contentNodeIds.size
        && [...next.contentNodeIds].every((id) => snapshot.contentNodeIds.has(id));
      if (next.running === snapshot.running && sameIds) return;
      snapshot = { running: next.running, contentNodeIds: sameIds ? snapshot.contentNodeIds : next.contentNodeIds };
    };
    return {
      subscribe: (onChange: () => void): (() => void) => {
        if (!doc || doc.isDestroyed) return (): void => undefined;
        const nodes = doc.getMap<unknown>(CANVAS_NODES_KEY);
        /**
         * Re-read authoritative engine facts on either change or destruction.
         * @throws {never} Never.
         */
        const changed = (): void => { refresh(); onChange(); };
        nodes.observeDeep(changed);
        doc.on('destroy', changed);
        refresh();
        return (): void => { nodes.unobserveDeep(changed); doc.off('destroy', changed); };
      },
      getSnapshot: (): CanvasTaskState => snapshot,
    };
  }, [doc]);
  return React.useSyncExternalStore(source.subscribe, source.getSnapshot);
}
