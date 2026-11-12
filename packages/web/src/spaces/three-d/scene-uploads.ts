// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model uploads this page started into its 3D Spaces (inner#1690).
 *
 * An upload outlives the import dialog that began it and the Space tab it
 * was begun in: it lives here for the page's lifetime, one entry per task
 * row, holding the File so the uploader can retry a failed row. The server's
 * task list is the record everyone reads; this holds only what a page alone
 * knows — the bytes, the live percent, and which rows it may retry.
 *
 * The Space counts as busy from the press until the bytes are delivered, so
 * closing its tab is held back and leaving the page asks first. The File is
 * let go once its row ends in a model or a timeout, or disappears from the
 * list, because only a failed row is retried.
 *
 * The model is placed in the Space only after the server answers, so a full
 * Space sends nothing (inner#1790): a start says why to the import dialog,
 * a retry warns and keeps its row and file.
 */

import { t } from '@breatic/shared';
import { assetsApi } from '@web/data/api/assets';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import { runMediaUpload, type MediaUploadDeps, type UploadFailure } from '@web/data/upload/media-upload';
import type { UploadContext } from '@web/data/upload/ingest-upload';
import { docName } from '@web/data/yjs/manager';
import { checkAdd, type SpaceRefusalReason } from '@web/data/yjs/space-write';
import { reportSpaceTaskFailure } from '@web/data/api/scene';
import { toast } from '@web/lib/toast';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';

/** Where one page-held upload stands. */
export type SceneUploadPhase = 'uploading' | 'registering' | 'retained' | 'retrying';

/** One upload this page holds, keyed by its task row. */
export interface SceneUploadEntry {
  taskId: string;
  projectId: string;
  spaceId: string;
  label: string;
  file: File;
  phase: SceneUploadPhase;
  /** Whole percent of the bytes landed, while they are being sent. */
  percent: number;
}

/** The callbacks one run reports through. */
export type SceneUploadSinks = Pick<MediaUploadDeps, 'onAnswered' | 'onProgress' | 'onRegistering' | 'onRegistered' | 'onSuccess' | 'onFailure'>;

/** What the store calls out to. */
export interface SceneUploadDeps {
  /** Send one file through the common pipeline. */
  run: (file: File, context: UploadContext, sinks: SceneUploadSinks) => Promise<void>;
  /** Tell the server the bytes never reached the edge. */
  reportFailure: (projectId: string, spaceId: string, taskId: string) => Promise<void>;
  /** Hold a Space busy (closing its tab is held back). */
  register: (spaceId: string, operationId: string) => void;
  /** Release a Space's hold. */
  unregister: (spaceId: string, operationId: string) => void;
  /** Tell the uploader why their upload stopped. */
  notify: (message: { toastKey: string; severity: 'error' | 'warning'; filename: string }) => void;
}

/** How a start or a retry was answered. */
export type SceneUploadStart =
  | { kind: 'opened'; taskId: string }
  | { kind: 'refused'; reason: UploadFailure['reason'] }
  | { kind: 'full'; reason: SpaceRefusalReason }
  | { kind: 'missing' };

/** The part of a listed row the store reads. */
export interface SceneTaskStatus {
  id: string;
  status: 'running' | 'done' | 'failed' | 'expired';
}

/** The page's scene uploads. */
export interface SceneUploads {
  start: (args: { projectId: string; spaceId: string; file: File; label: string }) => Promise<SceneUploadStart>;
  retry: (taskId: string) => Promise<SceneUploadStart>;
  reconcile: (spaceId: string, rows: readonly SceneTaskStatus[]) => void;
  get: (taskId: string) => SceneUploadEntry | undefined;
  list: (spaceId: string) => readonly SceneUploadEntry[];
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
}

/**
 * Build a store over injected network, holds and messages.
 * @param deps - What the store calls out to.
 * @returns The store.
 */
export function createSceneUploads(deps: SceneUploadDeps): SceneUploads {
  const entries = new Map<string, SceneUploadEntry>();
  /** The rows each Space's list last answered, by id. */
  const listed = new Map<string, Map<string, SceneTaskStatus['status']>>();
  /** Rows a list has named at least once; only those can be judged removed. */
  const seenRows = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  /** Tell listeners something changed. */
  const changed = (): void => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  /**
   * Replace one entry's fields.
   * @param taskId - The entry.
   * @param patch - What changes.
   */
  const patch = (taskId: string, patch: Partial<SceneUploadEntry>): void => {
    const entry = entries.get(taskId);
    if (!entry) return;
    entries.set(taskId, { ...entry, ...patch });
    changed();
  };

  /**
   * Let an entry's file go when its listed row no longer needs it: the row
   * holds a model, timed out, or was removed. A row still being sent waits
   * for its bytes to land; a failed row keeps the file for a retry.
   * @param taskId - The entry.
   */
  const settleFromList = (taskId: string): void => {
    const entry = entries.get(taskId);
    if (!entry || entry.phase === 'uploading' || entry.phase === 'retrying') return;
    const rows = listed.get(entry.spaceId);
    if (!rows) return;
    const status = rows.get(taskId);
    const seen = seenRows.has(taskId);
    if (status === 'done' || status === 'expired' || (status === undefined && seen)) {
      entries.delete(taskId);
      changed();
    } else if (status === 'failed' && entry.phase === 'registering') {
      patch(taskId, { phase: 'retained' });
    }
  };

  /**
   * Send one file and follow it to its row.
   * @param args - Where it goes and under which name.
   * @param args.projectId - The project.
   * @param args.spaceId - The 3D Space.
   * @param args.file - The bytes.
   * @param args.label - The model's name.
   * @param replaces - The failed row this run retries, whose file it takes over.
   * @returns How the ticket was answered.
   */
  const send = (
    args: { projectId: string; spaceId: string; file: File; label: string },
    replaces?: string,
  ): Promise<SceneUploadStart> => new Promise((resolve) => {
    const { projectId, spaceId, file, label } = args;
    const operationId = crypto.randomUUID();
    let held = true;
    deps.register(spaceId, operationId);
    /** Release the Space once, whichever way the bytes stop. */
    const release = (): void => {
      if (!held) return;
      held = false;
      deps.unregister(spaceId, operationId);
    };
    let taskId: string | undefined;
    let answered = false;
    void deps.run(file, { projectId, purpose: 'scene_model', spaceId, label }, {
      onAnswered: (answeredTaskId) => {
        answered = true;
        if (answeredTaskId === undefined) return;
        taskId = answeredTaskId;
        if (replaces !== undefined) entries.delete(replaces);
        entries.set(taskId, { taskId, projectId, spaceId, label, file, phase: 'uploading', percent: 0 });
        changed();
        resolve({ kind: 'opened', taskId });
      },
      onProgress: (fraction) => {
        const percent = Math.floor(fraction * 100);
        if (taskId !== undefined && entries.get(taskId)?.percent !== percent) patch(taskId, { percent });
      },
      onRegistering: () => {
        release();
        if (taskId === undefined) return;
        patch(taskId, { phase: 'registering' });
        settleFromList(taskId);
      },
      onRegistered: () => {
        // The row holds the model now; only a failed row is retried.
        if (taskId !== undefined && entries.delete(taskId)) changed();
      },
      onSuccess: () => {
        // Only a dedup hit lands here: the row opened already holding the model.
        release();
        if (taskId !== undefined && entries.delete(taskId)) changed();
      },
      onFailure: (outcome) => {
        release();
        if (!answered || outcome.taskId === undefined) {
          if (replaces !== undefined) {
            patch(replaces, { phase: 'retained' });
            settleFromList(replaces);
            const plan = resolveUploadFailure(outcome);
            if (plan.kind === 'toastOnly') deps.notify({ toastKey: plan.toastKey, severity: plan.severity, filename: file.name });
          }
          resolve({ kind: 'refused', reason: outcome.reason });
          return;
        }
        const plan = resolveUploadFailure(outcome);
        if (plan.kind === 'reportToServer') {
          void deps.reportFailure(projectId, spaceId, plan.taskId).catch((err: unknown) => {
            // The row still has its budget to fall back on; the line is for whoever has the devtools open.
            console.warn('scene task failure report rejected', plan.taskId, err);
          });
          patch(plan.taskId, { phase: 'retained' });
          settleFromList(plan.taskId);
          return;
        }
        deps.notify({ toastKey: plan.toastKey, severity: plan.severity, filename: file.name });
        if (plan.keepFileFor !== undefined) {
          patch(plan.keepFileFor, { phase: 'retained' });
          settleFromList(plan.keepFileFor);
        } else if (entries.delete(outcome.taskId)) {
          changed();
        }
      },
    }).catch((err: unknown) => {
      // The pipeline rejects only on a cancelled signal, and this run passes none.
      console.warn('scene upload stopped', err);
      release();
      if (!answered) resolve({ kind: 'refused', reason: 'upload' });
    });
  });

  return {
    start: (args) => {
      const room = checkAdd(docName.threeDSpace(args.projectId, args.spaceId), { notify: false });
      return room.ok ? send(args) : Promise.resolve({ kind: 'full', reason: room.reason });
    },
    retry: (taskId) => {
      const entry = entries.get(taskId);
      if (!entry || entry.phase !== 'retained') return Promise.resolve({ kind: 'missing' });
      const room = checkAdd(docName.threeDSpace(entry.projectId, entry.spaceId));
      if (!room.ok) return Promise.resolve({ kind: 'full', reason: room.reason });
      patch(taskId, { phase: 'retrying' });
      return send(entry, taskId);
    },
    reconcile: (spaceId, rows) => {
      listed.set(spaceId, new Map(rows.map((row) => [row.id, row.status])));
      rows.forEach((row) => seenRows.add(row.id));
      [...entries.values()].filter((entry) => entry.spaceId === spaceId).forEach((entry) => settleFromList(entry.taskId));
    },
    get: (taskId) => entries.get(taskId),
    list: (spaceId) => [...entries.values()].filter((entry) => entry.spaceId === spaceId),
    subscribe: (listener) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    getVersion: () => version,
  };
}

let pageUploads: SceneUploads | null = null;

/**
 * The page's store, wired to the real network on first use.
 * @param deps - Everything but the run, which is always the common pipeline.
 * @returns The page-wide store.
 */
export function getSceneUploads(deps: Omit<SceneUploadDeps, 'run' | 'notify'>): SceneUploads {
  pageUploads ??= createSceneUploads({
    ...deps,
    run: (file, context, sinks) => runMediaUpload(file, context, {
      getUploadConfig: assetsApi.fetchUploadConfig,
      hashFile,
      requestTicket: assetsApi.requestUploadTicket,
      sendToIngest: sendFileAndFinish,
      ...sinks,
    }),
    notify: ({ toastKey, severity, filename }) => { toast[severity](t(toastKey, { filename })); },
  });
  return pageUploads;
}

/**
 * The page's scene uploads, holding each Space busy through the shared operations store.
 * @returns The page-wide store.
 */
export function pageSceneUploads(): SceneUploads {
  return getSceneUploads({
    reportFailure: reportSpaceTaskFailure,
    register: (spaceId, operationId) => useSpaceOperationsStore.getState().register(spaceId, operationId),
    unregister: (spaceId, operationId) => useSpaceOperationsStore.getState().unregister(spaceId, operationId),
  });
}
