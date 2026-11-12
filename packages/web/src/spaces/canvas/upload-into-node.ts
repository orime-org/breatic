// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { t } from '@breatic/shared';
import { assetsApi, canvasApi } from '@web/data/api';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import type { MiniToolUploadTag } from '@web/data/upload/ingest-upload';
import type { UploadFailure } from '@web/data/upload/media-upload';
import { isNodeLocked, setNodeExtractedText } from '@web/data/yjs/canvas-space';
import { docName } from '@web/data/yjs/manager';
import { checkAdd } from '@web/data/yjs/space-write';
import { toast } from '@web/lib/toast';
import { checkFileAdmission, fileToNodeSpec, fillNodeFromFile, refusedFormatParams, type UploadNodeSpec } from '@web/spaces/canvas/canvas-upload';
import { fillActionOf } from '@web/spaces/canvas/node-activity';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import { extractText } from '@web/spaces/canvas/text-extract';
import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';
import { stashRetryFile } from '@web/spaces/canvas/upload-retry-files';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/** The node a file goes into. */
export interface UploadTarget {
  projectId: string;
  spaceId: string;
  nodeId: string;
}

/**
 * How an upload into a node ended: `uploaded` once the server holds the bytes
 * for the node; `failed` otherwise, `toasted` saying whether the user was
 * already told in a toast or only on the node.
 */
export type UploadIntoNodeOutcome = { status: 'uploaded' } | { status: 'failed'; toasted: boolean };

/** What the picker, Retry and a tool export may add to a fill. */
export interface UploadIntoNodeOptions {
  /** The node's modality; the file's own kind when absent. */
  modality?: UploadNodeSpec['nodeType'];
  /** A browser mini-tool's tag, when its export is what is uploaded. */
  tag?: MiniToolUploadTag;
  /** An upload mark the caller's press already began, which this fill ends. */
  continuing?: string;
}

/**
 * Carry out what a failed upload into a node calls for (#237, #186 §3.7.3):
 * a failure the server was never told of is reported against its row and the
 * file kept for Retry, with nothing said, since the row under the node's
 * failed count is what the user reads; any other is said in a toast, and the
 * file kept only when sending it again can end differently.
 * @param target - The canvas the node is on.
 * @param outcome - How the upload ended.
 * @param file - The file.
 * @param tag - The mini-tool tag the Retry re-sends with.
 * @returns Whether a toast was shown.
 */
export function failUploadIntoNode(target: Pick<UploadTarget, 'projectId' | 'spaceId'>, outcome: UploadFailure, file: File, tag?: MiniToolUploadTag): boolean {
  const { projectId, spaceId } = target;
  const plan = resolveUploadFailure(outcome);
  if (plan.kind === 'reportToServer') {
    stashRetryFile(projectId, spaceId, plan.taskId, file, tag);
    void canvasApi.reportNodeTaskFailure(plan.taskId).catch((err: unknown) => {
      // The report is itself a request that can fail for the same reason, and
      // the row still has its budget to fall back on; the line is for devtools.
      console.warn('node task failure report rejected', plan.taskId, err);
    });
    return false;
  }
  toast[plan.severity](t(plan.toastKey, { filename: file.name, ...refusedFormatParams(file) }));
  if (plan.keepFileFor !== undefined) stashRetryFile(projectId, spaceId, plan.keepFileFor, file, tag);
  return true;
}

/** A started upload into a node: the send the leave guard waits on, and how it ended. */
export interface StartedUploadIntoNode {
  /** Ends when the bytes are on their way or the fill stopped; undefined when it never started. */
  sent: Promise<void> | undefined;
  outcome: Promise<UploadIntoNodeOutcome>;
}

/**
 * Fill an existing canvas node from a file and wait for how it ended.
 * @param target - The node.
 * @param file - The file.
 * @param options - Modality, tool tag and a continuing mark.
 * @returns How the upload ended, once the server registered the bytes or it failed.
 */
export function uploadIntoNode(target: UploadTarget, file: File, options: UploadIntoNodeOptions = {}): Promise<UploadIntoNodeOutcome> {
  return startUploadIntoNode(target, file, options).outcome;
}

/**
 * Fill an existing canvas node from a file: the picker, the error-state
 * Retry and a 3D capture placed on a canvas all come here.
 *
 * The node's lock is read again now (a collaborator can lock it while a
 * picker is open), a Space that cannot take an add sends nothing, the node
 * shows the wait from here until the server answers, and the front-end
 * operation is registered before the first await so leaving cannot slip in.
 * @param target - The node.
 * @param file - The file.
 * @param options - Modality, tool tag and a continuing mark.
 * @returns The send and the outcome.
 */
export function startUploadIntoNode(target: UploadTarget, file: File, options: UploadIntoNodeOptions = {}): StartedUploadIntoNode {
  const { projectId, spaceId, nodeId } = target;
  const { tag, continuing } = options;
  const modality = options.modality ?? fileToNodeSpec(file).nodeType;
  const marks = useUploadMarksStore.getState();
  const gateBlock = evaluateNodeGate({ locked: isNodeLocked(projectId, spaceId, nodeId) });
  if (gateBlock) {
    warnNodeGate(t(gateBlock.toastKey));
    if (continuing !== undefined) marks.answer(spaceId, nodeId, continuing);
    return { sent: undefined, outcome: Promise.resolve({ status: 'failed', toasted: true }) };
  }
  const added = checkAdd(docName.canvasSpace(projectId, spaceId));
  if (!added.ok) {
    if (continuing !== undefined) marks.fail(spaceId, nodeId, continuing, { key: 'spaces.sizeCap.reason' });
    // The gate says every refusal but a rebuild in progress in its own warning.
    return { sent: undefined, outcome: Promise.resolve({ status: 'failed', toasted: added.reason !== 'resyncing' }) };
  }
  const markOp = continuing ?? marks.begin(spaceId, nodeId, fillActionOf(fileToNodeSpec(file)));
  /**
   * Hand the outcome to the caller; the first call wins.
   * @param outcome - How the upload ended.
   */
  let settle = (outcome: UploadIntoNodeOutcome): void => { void outcome; };
  const ended = new Promise<UploadIntoNodeOutcome>((resolve) => { settle = resolve; });
  const work = (async (): Promise<void> => {
    let maxBytes = Infinity;
    try {
      maxBytes = (await assetsApi.fetchUploadConfig()).maxUploadBytes;
    } catch {
      // The server's 413 remains the authoritative gate.
    }
    const rejection = checkFileAdmission(file, maxBytes);
    if (rejection !== null) {
      useUploadMarksStore.getState().fail(spaceId, nodeId, markOp, {
        key: `canvas.upload.${rejection}`,
        params: { filename: file.name, ...refusedFormatParams(file) },
      });
      settle({ status: 'failed', toasted: false });
      return;
    }
    await fillNodeFromFile(nodeId, file, modality, projectId, {
      getUploadConfig: assetsApi.fetchUploadConfig,
      hashFile,
      requestTicket: assetsApi.requestUploadTicket,
      sendToIngest: sendFileAndFinish,
      spaceId,
      markOp,
      ...(tag !== undefined && { tag }),
      extractText,
      // Only the text path reaches this: it reads the content here, so there
      // is nobody else to write it. A media node's content arrives from the
      // server through Yjs.
      setContent: (id, content) => setNodeExtractedText(projectId, spaceId, id, content, false),
      onUploadFailure: (outcome, f) => settle({ status: 'failed', toasted: failUploadIntoNode(target, outcome, f, tag) }),
      onStored: () => settle({ status: 'uploaded' }),
      onFailedBeforeAnswer: () => settle({ status: 'failed', toasted: false }),
    });
  })();
  const ops = useSpaceOperationsStore.getState();
  ops.register(spaceId, nodeId);
  void work.finally(() => ops.unregister(spaceId, nodeId));
  return { sent: work, outcome: ended };
}
