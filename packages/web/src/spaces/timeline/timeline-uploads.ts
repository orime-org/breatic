// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Timeline's background uploads (#1434 design §3.1), on the protocol of the Document's pending media blocks
 * (`spaces/document/document-upload-controller.ts`): a placeholder is an `upload` clip in the shared document, this
 * page runs the upload behind its `uploadId` and keeps the result for the document's lifetime, and whenever a
 * placeholder of a finished upload is in the document and this page may write, it turns it into a video clip under
 * the untracked `TIMELINE_UPLOAD_ORIGIN`. The controller lives with the document, so a hidden Space tab keeps it.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import type { ProjectRegisteredAsset } from '@breatic/shared';

import { timelineApi } from '@web/data/api/timeline';
import { UploadFailedError, uploadMedia, type UploadFailureReason } from '@web/data/upload/media-upload';
import { readDocFacts, readDocProvider, readWriteAccess, subscribeDocProvider, type WriteAccess } from '@web/data/yjs/collab-socket';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { convertTimelineUpload, readTimelineDocument } from '@web/data/yjs/timeline-document';
import { renewOnWorker } from '@web/lib/claim-renewal';
import { uploadRetryCanChange } from '@web/spaces/canvas/upload-failure';
import { CLAIMS_FIELD, type UploadClaim } from '@web/spaces/document/document-upload-controller';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/** Where an upload stands on this page; `progress` is the share sent, 0 to 1, or null before any is known. */
export type TimelineUploadEntry =
  | { readonly phase: 'uploading'; readonly progress: number | null }
  | { readonly phase: 'done'; readonly asset: ProjectRegisteredAsset }
  | { readonly phase: 'failed'; readonly reason: UploadFailureReason; readonly retryable: boolean };

/** One open Timeline document's uploads. */
export interface TimelineUploads {
  /** Start the upload behind a placeholder just written. */
  start: (uploadId: string, file: File) => void;
  /** Run a failed, retryable upload again with the same file. */
  retry: (uploadId: string) => void;
  /** What this page knows about an upload, if it ran it. */
  entry: (uploadId: string) => TimelineUploadEntry | undefined;
  /** Calls back whenever an entry changes; returns what stops it. */
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

/** Where a document's uploads land. */
interface TimelineUploadsInputs { projectId: string; spaceId: string }

/** One upload's record; the file is let go once the upload has finished. */
interface UploadRecord { file: File | null; state: TimelineUploadEntry }

/**
 * This page's write access to the document, as the Document's pending uploads read it.
 * @param name - The document name.
 * @param provider - Its provider; absent, the document is taken as writable.
 * @returns The access.
 * @throws {never} Never.
 */
function writeAccessOf(name: string, provider: HocuspocusProvider | null): WriteAccess {
  if (provider === null) return 'granted';
  const { authFailure } = readDocFacts(name);
  return authFailure !== null ? 'denied' : readWriteAccess(provider, authFailure);
}

/**
 * Create the upload controller of one Timeline document.
 * @param doc - The document.
 * @param inputs - Where its uploads land, and its document name.
 * @returns The controller.
 * @throws {never} Never.
 */
function createTimelineUploads(doc: Y.Doc, inputs: TimelineUploadsInputs & { name: string }): TimelineUploads {
  const { projectId, spaceId, name } = inputs;
  const records = new Map<string, UploadRecord>();
  const listeners = new Set<() => void>();
  const registered = new Set<string>();
  const aborts = new AbortController();
  let claims: Readonly<Record<string, UploadClaim>> = {};
  let provider: HocuspocusProvider | null = null;
  let stopRenewal: (() => void) | null = null;
  let queued = false;
  let disposed = false;

  /** Tell every listener an entry changed. */
  const notify = (): void => { listeners.forEach((listener) => listener()); };

  /** Write this page's claims back into its awareness, which a restored page may have lost. */
  const renew = (): void => {
    const state = provider?.awareness?.getLocalState() ?? null;
    if (state !== null) provider?.awareness?.setLocalState({ ...state, [CLAIMS_FIELD]: claims });
  };

  /**
   * Publish this page's claims for the placeholders in the document: failed, or in flight — a finished upload whose
   * placeholder still waits to be written is still in flight to a collaborator.
   * @param next - The claims.
   */
  const claim = (next: Readonly<Record<string, UploadClaim>>): void => {
    claims = next;
    const state = provider?.awareness?.getLocalState() ?? null;
    if (state !== null && JSON.stringify(state[CLAIMS_FIELD] ?? {}) !== JSON.stringify(next)) provider?.awareness?.setLocalStateField(CLAIMS_FIELD, next);
    const any = Object.keys(next).length > 0;
    if (any && stopRenewal === null) stopRenewal = renewOnWorker(renew);
    if (!any && stopRenewal !== null) {
      stopRenewal();
      stopRenewal = null;
    }
  };

  /** Convert finished uploads this page may write, then bring the claims and the busy registrations in line. */
  const scan = (): void => {
    queued = false;
    if (disposed) return;
    /**
     * The registered video of an upload this page finished.
     * @param uploadId - The upload.
     * @returns The asset, or null while it is not finished.
     */
    const finished = (uploadId: string): ProjectRegisteredAsset | null => {
      const state = records.get(uploadId)?.state;
      return state?.phase === 'done' ? state.asset : null;
    };
    /**
     * The uploads whose placeholders are in the document now.
     * @returns Their ids.
     */
    const presentIds = (): Set<string> => new Set(Object.values(readTimelineDocument(doc).clips)
      .flatMap((clip) => (clip.kind === 'upload' ? [clip.upload.uploadId] : [])));
    if (writeAccessOf(name, provider) === 'granted') {
      for (const uploadId of presentIds()) {
        const asset = finished(uploadId);
        if (asset !== null) convertTimelineUpload(doc, uploadId, asset);
      }
    }
    const present = presentIds();
    const next: Record<string, UploadClaim> = {};
    for (const uploadId of present) {
      const record = records.get(uploadId);
      if (record !== undefined) next[uploadId] = record.state.phase === 'failed' ? 'failed' : 'uploading';
    }
    claim(next);
    const busy = new Set([...present].filter((uploadId) => records.get(uploadId)?.state.phase === 'uploading'));
    const operations = useSpaceOperationsStore.getState();
    for (const uploadId of [...registered]) {
      if (busy.has(uploadId)) continue;
      registered.delete(uploadId);
      operations.unregister(spaceId, uploadId);
    }
    for (const uploadId of busy) {
      if (registered.has(uploadId)) continue;
      registered.add(uploadId);
      operations.register(spaceId, uploadId);
    }
  };

  /** Scan once the current task's transactions are all done, so the write never nests in the one that brought a placeholder in. */
  const queue = (): void => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(scan);
  };

  /**
   * Set an upload's state and rescan.
   * @param record - Its record.
   * @param state - The new state.
   */
  const settle = (record: UploadRecord, state: TimelineUploadEntry): void => {
    if (disposed) return;
    record.state = state;
    if (state.phase === 'done') record.file = null;
    queue();
    notify();
  };

  /**
   * Upload a file and read back the registered video.
   * @param record - The upload's record.
   * @param file - The file.
   */
  const run = (record: UploadRecord, file: File): void => {
    record.state = { phase: 'uploading', progress: null };
    const { signal } = aborts;
    void (async (): Promise<void> => {
      let assetId: string;
      try {
        assetId = (await uploadMedia(file, { projectId, spaceId }, (share) => {
          if (disposed) return;
          record.state = { phase: 'uploading', progress: share };
          notify();
        }, signal)).assetId;
      } catch (err) {
        const reason = err instanceof UploadFailedError ? err.reason : 'upload';
        settle(record, { phase: 'failed', reason, retryable: uploadRetryCanChange(reason) });
        return;
      }
      try {
        const asset = await timelineApi.resolveAsset(projectId, assetId, signal);
        settle(record, asset.kind === 'video' ? { phase: 'done', asset } : { phase: 'failed', reason: 'unsupportedType', retryable: false });
      } catch {
        // The bytes are stored and registered; reading the registration again can succeed.
        settle(record, { phase: 'failed', reason: 'upload', retryable: true });
      }
    })();
  };

  const clips = doc.getMap<unknown>('clips');
  clips.observeDeep(queue);
  /**
   * Stop listening to the provider bound last; nothing is bound yet.
   * @returns Nothing.
   */
  let stopProvider = (): void => undefined;
  /** Follow the document's current provider, rescanning whenever its write access may have changed. */
  const bindProvider = (): void => {
    stopProvider();
    provider = readDocProvider(name);
    const bound = provider;
    if (bound === null) {
      stopProvider = (): void => undefined;
    } else {
      bound.on('authenticated', queue);
      bound.on('authenticationFailed', queue);
      stopProvider = (): void => {
        bound.off('authenticated', queue);
        bound.off('authenticationFailed', queue);
      };
    }
    queue();
  };
  bindProvider();
  const stopRegistry = subscribeDocProvider(name, bindProvider);

  return {
    start(uploadId, file) {
      const record: UploadRecord = { file, state: { phase: 'uploading', progress: null } };
      records.set(uploadId, record);
      run(record, file);
      queue();
      notify();
    },
    retry(uploadId) {
      const record = records.get(uploadId);
      if (record?.state.phase !== 'failed' || !record.state.retryable || record.file === null) return;
      run(record, record.file);
      queue();
      notify();
    },
    entry: (uploadId) => records.get(uploadId)?.state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      claim({});
      disposed = true;
      aborts.abort();
      clips.unobserveDeep(queue);
      stopRegistry();
      stopProvider();
      const operations = useSpaceOperationsStore.getState();
      for (const uploadId of registered) operations.unregister(spaceId, uploadId);
      registered.clear();
      listeners.clear();
    },
  };
}

const cache = createDocScopedCache<TimelineUploads, TimelineUploadsInputs & { name: string }>(createTimelineUploads, (uploads) => uploads.dispose());

/**
 * The background uploads of an open Timeline document, kept across body remounts and hidden tabs.
 * @param doc - The live collaborative document.
 * @param name - Its canonical document name.
 * @param inputs - The Project and Space its uploads land in.
 * @returns The cached or new controller.
 * @throws {never} Never.
 */
export function getTimelineUploads(doc: Y.Doc, name: string, inputs: TimelineUploadsInputs): TimelineUploads {
  return cache.get(doc, name, { ...inputs, name });
}

/**
 * Stop a closed tab's uploads and release what they registered.
 * @param name - Its canonical document name.
 * @throws {never} Never.
 */
export function evictTimelineUploads(name: string): void {
  cache.evict(name);
}
