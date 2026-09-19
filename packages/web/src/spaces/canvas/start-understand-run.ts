// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of Understand, from the menu item to the request (#2175).
 *
 * The node and its edge are written before the request goes out, because the
 * node is the reader's content and its existence does not depend on the
 * server agreeing to the run (downstream-node-creation decision, stage 2).
 * What the server decides lands on the row it opens against that node — which
 * is why the two questions the browser can answer for itself are asked first:
 * a no to either has no row to land on, so it is a toast and nothing is built.
 */

import { t } from '@breatic/shared';

import { canvasApi, getCachedUnderstandMaxBytes } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { formatBytes } from '@web/lib/format-bytes';
import { toast } from '@web/lib/toast';
import { createEmptyNode } from '@web/spaces/canvas/node-factory';
import {
  understandNodePosition,
  understandRefusal,
  type UnderstandableKind,
} from '@web/spaces/canvas/node-understand';

/** The node being read, as the canvas holds it. */
export interface UnderstandSource {
  id: string;
  kind: UnderstandableKind;
  /** The address of what it is showing. */
  url: string;
  mimeType: string | undefined;
  sizeBytes: number | undefined;
  /** Its stored position, which is group-relative when it sits in one. */
  position: { x: number; y: number };
  /** The origin of the group holding it, or null when it is top-level. */
  groupOrigin: { x: number; y: number } | null;
}

/** Everything one press needs. */
export interface UnderstandRun {
  projectId: string;
  spaceId: string;
  /** Who is pressing, which is who the new node is created by. */
  userId: string;
  source: UnderstandSource;
}

/**
 * Whether this failure is already sitting on the node's task row.
 *
 * The endpoint opens the row before the one gate it can fail after: credits.
 * Every other refusal — the project would not take the caller, the row could
 * not be opened, the request never arrived — answers while the node has
 * nothing on it, so the press is the only place those can be said.
 *
 * The status is the whole judgement, because the browser's client wraps
 * every rejection in `ApiException`, a dead network included (status 0).
 * @param err - What the request rejected with.
 * @returns True when the node already says why.
 */
function landedOnTheRow(err: unknown): boolean {
  return err instanceof ApiException && err.status === 402;
}

/**
 * Build the text node this run writes to, wire it, and ask for the run.
 *
 * Refuses in the browser what the browser can settle — a format the endpoint
 * does not read, a file over the ceiling — and says so in a toast, having
 * built nothing. Everything past that belongs to the run: its row sits on the
 * new node and carries whatever the server decides, so this waits for nothing
 * and reports only a request that never arrived.
 * @param run - The press: where it happens, who pressed, and what is read.
 * @returns Nothing; what happens next is on the new node's task list.
 */
export async function startUnderstandRun(run: UnderstandRun): Promise<void> {
  const { projectId, spaceId, userId, source } = run;

  // The ceiling rides on the knobs the canvas warms on mount, read here
  // without waiting. It is allowed to be absent: the refusal judges format
  // without it and skips only the size question, which the run then answers
  // on the row — the same place a node with no recorded size is judged
  // (§8.2).
  const refusal = understandRefusal(
    { kind: source.kind, mimeType: source.mimeType, sizeBytes: source.sizeBytes },
    getCachedUnderstandMaxBytes(),
  );
  if (refusal !== null) {
    toast.warning(
      refusal.kind === 'format'
        ? t('canvas.understand.unsupportedFormat', { formats: refusal.formats })
        : t('canvas.understand.tooLarge', {
          limit: formatBytes(refusal.limitBytes),
          size: formatBytes(refusal.sizeBytes),
        }),
    );
    return;
  }

  const node = createEmptyNode(
    'text',
    understandNodePosition(source.position, source.groupOrigin),
    userId,
  );
  // One press is ONE undo entry. `addNode` and `addEdge` open a transaction
  // each, so called plainly they leave two — and undoing once would take the
  // edge away and leave a node running a task with nothing tying it to what
  // that task is about.
  runCanvasUndoBatch(projectId, spaceId, () => {
    addNode(projectId, spaceId, node);
    addEdge(projectId, spaceId, {
      id: `${source.id}->${node.id}`,
      source: source.id,
      target: node.id,
    });
  });

  try {
    await canvasApi.understand({
      project_id: projectId,
      space_id: spaceId,
      source_type: source.kind,
      source_url: source.url,
      node_ids: [node.id],
    });
  } catch (err) {
    // A refusal the row already holds is not repeated here: the node says
    // what happened, and "try again" is wrong advice for a refusal that will
    // repeat. Everything else left the node with nothing on it and nothing
    // coming, so this is the only place it can be said. The node stays either
    // way — nothing here deletes one.
    if (!landedOnTheRow(err)) {
      toast.error(t('canvas.understand.couldNotStart'));
    }
  }
}
