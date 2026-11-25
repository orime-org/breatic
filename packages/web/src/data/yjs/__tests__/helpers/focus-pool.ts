// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type FocusImage } from '@breatic/shared';
import { appendFocusImageCore } from '@breatic/shared/space-content';

import { CONTENT_WRITE } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';

/**
 * Add a crop to a node's pool as collab does once its upload is registered (#1580): the shared append, outside the
 * canvas undo history.
 * @param projectId - The project.
 * @param spaceId - The canvas Space.
 * @param nodeId - The node.
 * @param image - The crop.
 * @returns What the append answered, or `node-missing`.
 */
export function landFocusImage(
  projectId: string,
  spaceId: string,
  nodeId: string,
  image: FocusImage,
): ReturnType<typeof appendFocusImageCore> | 'node-missing' {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const node = doc.getMap<unknown>(CANVAS_NODES_KEY).get(nodeId);
  const data = node instanceof Y.Map ? node.get('data') : undefined;
  if (!(data instanceof Y.Map)) return 'node-missing';
  let outcome: ReturnType<typeof appendFocusImageCore> = 'invalid-entry';
  doc.transact(() => {
    outcome = appendFocusImageCore(data, image);
  }, CONTENT_WRITE);
  return outcome;
}
