// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Timeline's background uploads (#1434 design §3.1; inner#1709), on the protocol of the
 * Document's pending media blocks (`spaces/document/document-upload-controller.ts`): a placeholder is an `upload` clip
 * in the shared document, and this page only sends its bytes behind the placeholder's `uploadId`. Once the server has
 * them, collab writes the outcome into the placeholder; this page never writes the document on success. The controller
 * lives with the document, so a hidden Space tab keeps it.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { newId, type TimelineUploadClip } from '@breatic/shared';
import { attachTimelineRecord } from '@breatic/shared/space-content';

import { UploadFailedError, handOffSpaceMedia, type UploadFailureReason } from '@web/data/upload/media-upload';
import { readDocProvider, subscribeDocProvider } from '@web/data/yjs/collab-socket';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import { readTimelineDocument, TIMELINE_UPLOAD_ORIGIN } from '@web/data/yjs/timeline-document';
import { CLAIMS_FIELD, renewOnWorker, type UploadClaim } from '@web/lib/upload-claims';
import { uploadRetryCanChange } from '@web/spaces/canvas/upload-failure';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/**
 * Where an upload stands on this page: sending, with the share sent (0 to 1, or null before any is known); handed to
 * the server, the file kept for a retry after a server failure; or failed before the bytes reached the server.
 */
export type TimelineUploadEntry =
  | { readonly phase: 'uploading'; readonly progress: number | null }
  | { readonly phase: 'handedOff' }
  | { readonly phase: 'failed'; readonly reason: UploadFailureReason; readonly retryable: boolean };

/** The kinds collab turns a placeholder into. */
export type TimelineUploadKind = TimelineUploadClip['upload']['kind'];

/** One open Timeline document's uploads. */
export interface TimelineUploads {
  /** Start the upload behind a placeholder just written. */
  start: (uploadId: string, file: File) => void;
  /** Run a retryable upload again with the same file, under a new `uploadId` on every placeholder of the old one. */
  retry: (uploadId: string) => void;
  /** What this page knows about an upload, if it ran it. */
  entry: (uploadId: string) => TimelineUploadEntry | undefined;
  /** Calls back whenever an entry changes; returns what stops it. */
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

/** Where a document's uploads land, and who hears that collab landed one of them. */
interface TimelineUploadsInputs {
  projectId: string;
  spaceId: string;
  /** Called with the kind collab turned a placeholder of this page's upload into, so lists of that kind read again. */
  onLanded?: (kind: TimelineUploadKind) => void;
}

/** One upload's record; the file is kept for a retry for the document's lifetime. */
interface UploadRecord { file: File; state: TimelineUploadEntry }

/**
 * Whether this page can run an upload again: it holds the file, and either handed it off (a server failure collab
 * writes can be retried) or failed in a way sending it again can change, as the Document's `canRetry` decides.
 * @param state - The upload's state on this page.
 * @returns True when a retry may run.
 * @throws {never} Never.
 */
function canRetry(state: TimelineUploadEntry): boolean {
  return state.phase === 'handedOff' || (state.phase === 'failed' && state.retryable);
}

/**
 * Create the upload controller of one Timeline document.
 * @param doc - The document.
 * @param inputs - Where its uploads land, and its document name.
 * @returns The controller.
 * @throws {never} Never.
 */
function createTimelineUploads(doc: Y.Doc, inputs: TimelineUploadsInputs & { name: string }): TimelineUploads {
  const { projectId, spaceId, name, onLanded } = inputs;
  const records = new Map<string, UploadRecord>();
  const listeners = new Set<() => void>();
  const registered = new Set<string>();
  // The placeholders of this page's uploads as of the last scan, by clip id, to see collab land one.
  let watching = new Map<string, string>();
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
   * Publish this page's claims for the placeholders in the document.
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

  /** Hear what collab landed, then bring the claims and the busy registrations in line with the document. */
  const scan = (): void => {
    queued = false;
    if (disposed) return;
    const clips = readTimelineDocument(doc).clips;
    const landed = new Set<TimelineUploadKind>();
    for (const clipId of watching.keys()) {
      const kind = clips[clipId]?.kind;
      if (kind === 'video' || kind === 'image' || kind === 'audio') landed.add(kind);
    }
    watching = new Map(Object.values(clips).flatMap((clip) => (clip.kind === 'upload' && records.has(clip.upload.uploadId) ? [[clip.id, clip.upload.uploadId] as const] : [])));
    const present = new Set(watching.values());
    const next: Record<string, UploadClaim> = {};
    for (const uploadId of present) {
      const phase = records.get(uploadId)?.state.phase;
      // Once the bytes are handed off, collab writes the outcome for everyone to read.
      if (phase === 'uploading' || phase === 'failed') next[uploadId] = phase;
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
    landed.forEach((kind) => onLanded?.(kind));
  };

  /** Scan once the current task's transactions are all done. */
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
    queue();
    notify();
  };

  /**
   * Send a file to the server for a placeholder; collab writes what becomes of it.
   * @param uploadId - The placeholder's upload.
   * @param record - The upload's record.
   */
  const run = (uploadId: string, record: UploadRecord): void => {
    record.state = { phase: 'uploading', progress: null };
    handOffSpaceMedia(record.file, { projectId, spaceId, uploadId, uploadTarget: 'timeline' }, (share) => {
      if (disposed) return;
      record.state = { phase: 'uploading', progress: share };
      notify();
    }).then(
      () => { settle(record, { phase: 'handedOff' }); },
      (err: unknown) => {
        const reason = err instanceof UploadFailedError ? err.reason : 'upload';
        settle(record, { phase: 'failed', reason, retryable: uploadRetryCanChange(reason) });
      },
    );
  };

  /**
   * Give every placeholder of an upload a new `uploadId` and drop what collab wrote onto it, outside any history.
   * @param uploadId - The upload being retried.
   * @param nextId - Its new id.
   * @returns False when the Space's size refused the write.
   */
  const rename = (uploadId: string, nextId: string): boolean => {
    const placeholders = Object.values(readTimelineDocument(doc).clips)
      .flatMap((clip) => (clip.kind === 'upload' && clip.upload.uploadId === uploadId ? [clip] : []));
    if (placeholders.length === 0) return true;
    return writeSpaceDoc(name, { kind: 'edit' }, () => {
      doc.transact(() => {
        const clips = doc.getMap<unknown>('clips');
        for (const clip of placeholders) {
          const { state: _state, failure: _failure, retryable: _retryable, ...kept } = clip.upload;
          const upload = { ...kept, uploadId: nextId };
          const stored = clips.get(clip.id);
          if (stored instanceof Y.Map) stored.set('upload', upload);
          else attachTimelineRecord(clips, clip.id, { ...clip, upload });
        }
      }, TIMELINE_UPLOAD_ORIGIN);
    }).ok;
  };

  const clips = doc.getMap<unknown>('clips');
  clips.observeDeep(queue);
  /** Follow the document's current provider, whose awareness carries the claims. */
  const bindProvider = (): void => {
    provider = readDocProvider(name);
    queue();
  };
  bindProvider();
  const stopRegistry = subscribeDocProvider(name, bindProvider);

  return {
    start(uploadId, file) {
      const record: UploadRecord = { file, state: { phase: 'uploading', progress: null } };
      records.set(uploadId, record);
      run(uploadId, record);
      queue();
      notify();
    },
    retry(uploadId) {
      const record = records.get(uploadId);
      if (record === undefined || !canRetry(record.state)) return;
      const nextId = newId();
      if (!rename(uploadId, nextId)) return;
      records.delete(uploadId);
      records.set(nextId, record);
      run(nextId, record);
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
      clips.unobserveDeep(queue);
      stopRegistry();
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
 * @param inputs - The Project and Space its uploads land in, and who hears that collab landed one.
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
