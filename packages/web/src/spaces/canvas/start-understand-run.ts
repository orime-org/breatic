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
import { runOnce, useRunning, type RunOnceOutcome } from '@web/stores/task-actions-in-flight';
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
  /**
   * What the reader calls it, which is what the node it builds is named
   * after. Absent only in the view's type, which makes the field optional so
   * component tests need not spell it out; a node with no name to borrow
   * leaves the new one the name its own kind gives it.
   */
  name: string | undefined;
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
 * Prefix on the name of the node a reading builds, so a paragraph says which
 * node it is about.
 *
 * Same shape `node-clipboard.ts` gives a clone (`COPY-` plus the name of what
 * it was cloned from): a node derived from another is named after it, marked
 * by the act that derived it. A fixed-English data value, like the other
 * default names in `node-factory.ts` — the reader renames it from there.
 */
const UNDERSTAND_PREFIX = 'UNDERSTAND-';

/**
 * The run-once intent of an Understand press on one node (inner#1490).
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node being read.
 * @returns The intent id.
 */
function understandIntent(spaceId: string, nodeId: string): string {
  return `understand:${spaceId}:${nodeId}`;
}

/**
 * Whether an Understand press on this node is still waiting; the menu item reads it.
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node being read.
 * @returns True while it waits.
 */
export function useUnderstanding(spaceId: string, nodeId: string): boolean {
  return useRunning(understandIntent(spaceId, nodeId)) !== undefined;
}

/**
 * Build the text node this run writes to, wire it, and ask for the run.
 *
 * Refuses in the browser what the browser can settle — a format the endpoint
 * does not read, a file over the ceiling — and says so in a toast, having
 * built nothing. Everything past that belongs to the run: its row sits on the
 * new node and carries whatever the server decides, so this waits for nothing
 * and reports only a request that never arrived.
 *
 * One press per node runs at a time (inner#1490): a press while one waits
 * builds nothing and sends nothing, and an unanswered request is re-sent with
 * the same key without building a second node.
 * @param run - The press: where it happens, who pressed, and what is read.
 * @returns The press's whole run; what happens next is on the new node's task list.
 */
export function startUnderstandRun(run: UnderstandRun): Promise<RunOnceOutcome<unknown>> {
  const { projectId, spaceId, userId, source, onBuilt } = run;
  return runOnce(understandIntent(spaceId, source.id), {
    scope: 'understand',
    prepare: () => buildUnderstandRun(projectId, spaceId, userId, source, onBuilt),
    send: (key, body: UnderstandBody) => canvasApi.understand(body, key),
    onFailure: reportUnderstandFailure,
  });
}

/** The request body of one Understand run. */
type UnderstandBody = Parameters<typeof canvasApi.understand>[0];

/**
 * The browser's half of a press: refuse what it can settle, build and wire
 * the text node, and fix the request body.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param userId - Who pressed.
 * @param source - The node being read.
 * @param onBuilt - Told about the node this press built.
 * @returns The request body, or null when the press was refused here.
 */
function buildUnderstandRun(
  projectId: string,
  spaceId: string,
  userId: string,
  source: UnderstandSource,
  onBuilt: UnderstandRun['onBuilt'],
): UnderstandBody | null {
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
    // Each refusal is the sentence its own row holds, filled from the same
    // facts about the same address. One refusal reads one way whichever end
    // raises it: this gate before anything is built, or the run once it is.
    toast.warning(
      refusal.kind === 'format'
        ? t(
          'canvas.task.failure.understand_unsupported_type',
          refusalClause(refusal),
        )
        : t('canvas.task.failure.understand_over_cap', {
          ...refusalClause(refusal),
          bytes: formatBytes(refusal.sizeBytes),
          limit: formatBytes(refusal.limitBytes),
        }),
    );
    return null;
  }

  const position = understandNodePosition(source.position, source.groupOrigin);
  const built = createEmptyNode('text', position, userId);
  const node = {
    ...built,
    data: {
      ...built.data,
      ...(source.name !== undefined && {
        name: UNDERSTAND_PREFIX + source.name,
      }),
    },
  };
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

  return {
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
  };
}

/**
 * Say why a press got no run.
 *
 * A rejection means no row was opened. The endpoint answers 201 with the
 * row's own state once one exists — a refused run's row holds the cause and
 * the node shows it — so anything that rejects left the node with nothing on
 * it and nothing coming, and the press is the only place the reason can be
 * said. The node stays either way; nothing here deletes one.
 *
 * A sentence our server wrote is the reader's own, and which layer put it in
 * their language depends on the branch: `error-handler.ts` calls `t()` itself
 * for an `HTTPException` and for the catch-all, and hands an `AppError`'s
 * message on untouched because that message is the thrower's — so the thrower
 * is where `t()` is, held there by `breatic/no-untranslated-error-message`.
 * `fromServer` is true only when the answer carried a sentence at all; the
 * short line below is for the rejections that carried none.
 * @param err - The final failure.
 */
function reportUnderstandFailure(err: unknown): void {
  const said =
    err instanceof ApiException && err.fromServer && err.message
      ? err.message
      : t('canvas.understand.couldNotStart');
  toast.error(said);
}
