// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of Snapshot, from the menu item to the row (#2175).
 *
 * What it keeps is what the node says at the moment of the press. The words
 * live in the canvas document, where a collaborator's typing and a finished
 * reading both land while the menu stands open — so they are read here,
 * after the press, rather than carried in from when the menu was built.
 */

import { t } from '@breatic/shared';

import { canvasApi } from '@web/data/api/canvas';
import { readTextBodies } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';

/** Everything one press needs. */
export interface SnapshotPress {
  projectId: string;
  spaceId: string;
  /** The text node whose words are being kept. */
  nodeId: string;
  /** Called once the row exists, for whoever is showing the list. */
  onKept: () => void;
}

/**
 * Keep what this text node says right now as a history row.
 *
 * A node saying nothing has nothing to keep: the press produces no row, the
 * same answer the server gives a snapshot of nothing.
 * @param press - Where it happens and which node was pressed.
 * @returns Nothing; the outcome is a toast and, on success, a new row.
 */
export async function keepSnapshot(press: SnapshotPress): Promise<void> {
  const { projectId, spaceId, nodeId, onKept } = press;
  const text = readTextBodies(projectId, spaceId, [nodeId]).get(nodeId) ?? '';
  if (text.length === 0) return;

  try {
    await canvasApi.snapshotNodeText({
      project_id: projectId,
      node_id: nodeId,
      text,
    });
    toast.success(t('canvas.history.snapshotKept'));
    onKept();
  } catch {
    toast.error(t('canvas.history.snapshotFailed'));
  }
}
