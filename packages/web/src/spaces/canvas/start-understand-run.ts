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

import { getLocale, t } from '@breatic/shared';

import { canvasApi, getCachedUnderstandMaxBytes } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { formatBytes } from '@web/lib/format-bytes';
import { toast } from '@web/lib/toast';
import { refusalClause } from '@web/spaces/canvas/failure-sentence';
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
  /**
   * Called with the node this press built, the moment it exists.
   *
   * It lands one whole step to the right of the node being read, which on a
   * canvas scrolled near its right edge is outside the viewport — so where it
   * went travels with it, and the canvas looks at it.
   */
  onBuilt: (built: { id: string; position: { x: number; y: number } }) => void;
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
  const { projectId, spaceId, userId, source, onBuilt } = run;

  // The ceiling rides on the knobs the canvas warms on mount, read here
  // without waiting. It is allowed to be absent: the refusal judges format
  // without it and skips only the size question, which the run then answers
  // on the row — the same place a node with no recorded size is judged
  // (§8.2).
  const refusal = understandRefusal(
    {
      kind: source.kind,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      url: source.url,
    },
    getCachedUnderstandMaxBytes(),
  );
  if (refusal !== null) {
    toast.warning(
      refusal.kind === 'format'
        ? t('canvas.task.failure.understand_unsupported_type', {
          // The one sentence both gates write, filled from the same two facts
          // about the same address: the key names the file, the recorded type
          // names the format.
          ...refusalClause(refusal),
        })
        : t('canvas.understand.tooLarge', {
          limit: formatBytes(refusal.limitBytes),
          size: formatBytes(refusal.sizeBytes),
        }),
    );
    return;
  }

  const position = understandNodePosition(source.position, source.groupOrigin);
  const node = createEmptyNode('text', position, userId);
  // One press is ONE undo entry. `addNode` and `addEdge` open a transaction
  // each, so called plainly they leave two — and undoing once would take the
  // edge away and leave a node running a task with nothing tying it to what
  // that task is about.
  let wired = false;
  runCanvasUndoBatch(projectId, spaceId, () => {
    addNode(projectId, spaceId, node);
    wired = addEdge(projectId, spaceId, {
      id: `${source.id}->${node.id}`,
      source: source.id,
      target: node.id,
    });
  });
  // `addEdge` refuses an edge whose endpoint is gone and hands that back: the
  // node being read can be deleted by a collaborator while this menu stands
  // open. The address it holds was captured before that, so the reading goes
  // ahead — and the wire, which is the only thing saying what this reading is
  // about, is missing, so the reader is told.
  if (!wired) toast.warning(t('canvas.understand.sourceGone'));
  onBuilt({ id: node.id, position });

  try {
    await canvasApi.understand({
      project_id: projectId,
      space_id: spaceId,
      source_type: source.kind,
      source_url: source.url,
      node_ids: [node.id],
      // The same judgement the gate above used, so the run cannot refuse a
      // file this end just let through.
      ...(source.mimeType !== undefined && { source_mime_type: source.mimeType }),
      // The answer becomes this node's body, and this is the only end that
      // knows which language the reader set. It travels as the code; the
      // sentence is the model's to write, four processes from here.
      reader_locale: getLocale(),
    });
  } catch (err) {
    // A rejection means no row was opened. The endpoint answers 201 with the
    // row's own state once one exists — a refused run's row holds the cause
    // and the node shows it — so anything that rejects left the node with
    // nothing on it and nothing coming, and the press is the only place the
    // reason can be said. The node stays either way; nothing here deletes one.
    //
    // A sentence our server wrote is the reader's own, and which layer put it
    // in their language depends on the branch: `error-handler.ts` calls `t()`
    // itself for an `HTTPException` and for the catch-all, and hands an
    // `AppError`'s message on untouched because that message is the thrower's
    // — so the thrower is where `t()` is, held there by
    // `breatic/no-untranslated-error-message`. Both routes this press can be
    // refused on are covered: `validate` raises
    // `ValidationError(t("server.error.validation"))`, and the access check
    // builds its own through `t()`. `fromServer` is true only when the answer
    // carried a sentence at all; the short line below is for the rejections
    // that carried none — a request that never arrived, an answer that was
    // not ours.
    const said =
      err instanceof ApiException && err.fromServer && err.message
        ? err.message
        : t('canvas.understand.couldNotStart');
    toast.error(said);
  }
}
