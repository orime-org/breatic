// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The page's upload controller (inner#1351 + inner#1390 design §5.5, §5.6).
 *
 * A pending media block is a real block in the shared document whose
 * `uploadId` is set and whose `url` is empty. The controller runs the upload
 * behind each id, keeps every result for the page's lifetime, and writes the
 * address onto every pending block carrying a finished id, whenever such a
 * block appears in an attached body: inserted, undone, redone, synced from a
 * peer, pasted as a copy, moved.
 *
 * The write is a Yjs transaction under {@link UPLOAD_WRITE_ORIGIN}, which no
 * UndoManager tracks, so it is never undone and never splits the reader's
 * undo steps. It runs from a microtask, outside every Yjs transaction and the
 * sync binding's mutex: a write nested in the transaction that brought the
 * block in reaches Yjs but not the local editor view.
 */

import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

/** Where a pending block's bytes come from. */
export type UploadSource =
  | { readonly kind: 'file'; readonly file: File }
  | { readonly kind: 'address'; readonly url: string }
  | { readonly kind: 'ours'; readonly url: string; readonly coverUrl?: string };

/** A finished upload: the stored address and the media's own size. */
export interface UploadResult {
  readonly url: string;
  readonly mediaWidth?: number;
  readonly mediaHeight?: number;
}

/** Why an upload did not finish, and whether running it again can help. */
export interface UploadFailure {
  /** The message key the block shows. */
  readonly messageKey: string;
  /** The values the message is filled with. */
  readonly params: Readonly<Record<string, string>>;
  readonly retryable: boolean;
}

/** How an upload ended. */
export type UploadOutcome =
  | { readonly ok: true; readonly result: UploadResult }
  | { readonly ok: false; readonly failure: UploadFailure };

/** Where an upload stands on this page. */
export type UploadPhase = 'uploading' | 'failed' | 'done';

/** What this page knows about one upload. */
export interface UploadEntry {
  readonly phase: UploadPhase;
  /** Share sent, 0 to 1, while uploading with a known size; otherwise null. */
  readonly progress: number | null;
  readonly failure: UploadFailure | null;
}

/** What this page's connection to a body may do. */
export type WriteAccess = 'unknown' | 'granted' | 'denied';

/** The part of a body's awareness the controller publishes claims through. */
export interface ClaimChannel {
  getLocalState: () => Record<string, unknown> | null;
  setLocalState: (state: Record<string, unknown> | null) => void;
  setLocalStateField: (field: string, value: unknown) => void;
}

/** A body open on this page: its editor is built and not blocked. */
export interface AttachedBody {
  readonly spaceId: string;
  readonly doc: Y.Doc;
  /** Where this page's claims on the body's uploads are published. */
  readonly awareness?: ClaimChannel;
  /** This page's write access to the body, read now. */
  writeAccess: () => WriteAccess;
  /**
   * Calls back whenever the write access may have changed.
   * @returns What stops listening.
   */
  onWriteAccess: (listener: () => void) => () => void;
}

/** What the controller needs from the rest of the page. */
export interface UploadControllerDeps {
  /** Runs one upload to its end. */
  run: (
    uploadId: string,
    source: UploadSource,
    onProgress: (share: number) => void,
  ) => Promise<UploadOutcome>;
  /** Marks a Space busy for this upload (the tab-close guard). */
  register: (spaceId: string, uploadId: string) => void;
  /** Releases what {@link UploadControllerDeps.register} marked. */
  unregister: (spaceId: string, uploadId: string) => void;
  /**
   * Calls `tick` on a timer the page's background throttling does not slow,
   * while any claim is published; each tick renews every body's awareness.
   * @returns What stops the timer.
   */
  renew?: (tick: () => void) => () => void;
}

/** The page's upload controller. */
export interface UploadController {
  /** Starts the upload behind a pending block. */
  start: (uploadId: string, source: UploadSource) => void;
  /** Runs a failed, retryable upload again from the same source. */
  retry: (uploadId: string) => void;
  /**
   * Watches a body for pending blocks.
   * @returns What stops watching it.
   */
  attach: (body: AttachedBody) => () => void;
  /** What this page knows about an upload, if it ran it. */
  entry: (uploadId: string) => UploadEntry | undefined;
  /**
   * Calls back whenever an entry changes.
   * @returns What stops listening.
   */
  subscribe: (listener: () => void) => () => void;
}

/** The origin of the address write; no UndoManager tracks it. */
export const UPLOAD_WRITE_ORIGIN: Readonly<{ name: string }> = Object.freeze({
  name: 'document-upload-write',
});

const MEDIA_NODES: ReadonlySet<string> = new Set(['image', 'video', 'audio']);

/** One upload's whole record. */
interface Record_ {
  source: UploadSource;
  phase: UploadPhase;
  progress: number | null;
  failure: UploadFailure | null;
  result: UploadResult | null;
}

/** One attached body and what the controller holds for it. */
interface Watched {
  readonly body: AttachedBody;
  /** Upload ids this body has registered with the guard. */
  readonly registered: Set<string>;
  queued: boolean;
  /** The claims last published in this body's awareness, as JSON. */
  published: string;
}

/** The awareness field claims are published in. */
const CLAIMS_FIELD = 'uploads';

/**
 * The upload id of a pending media element, or null.
 * @param element - A Yjs element.
 * @returns The id, when the element is a media block with an id and no url.
 */
function pendingId(element: Y.XmlElement): string | null {
  if (!MEDIA_NODES.has(element.nodeName)) return null;
  const uploadId = element.getAttribute('uploadId');
  const url = element.getAttribute('url');
  if (typeof uploadId !== 'string' || uploadId === '') return null;
  return typeof url === 'string' && url !== '' ? null : uploadId;
}

/**
 * Every pending media element in a body, with its upload id.
 * @param fragment - The body.
 * @returns The elements and their ids.
 */
function pendingElements(fragment: Y.XmlFragment): { element: Y.XmlElement; uploadId: string }[] {
  const out: { element: Y.XmlElement; uploadId: string }[] = [];
  /**
   * Walks one level.
   * @param parent - The parent.
   */
  const walk = (parent: Y.XmlElement | Y.XmlFragment): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const uploadId = pendingId(child);
      if (uploadId !== null) out.push({ element: child, uploadId });
      walk(child);
    }
  };
  walk(fragment);
  return out;
}

/**
 * Creates the page's upload controller.
 * @param deps - What it runs uploads with and how it marks Spaces busy.
 * @returns The controller.
 */
export function createUploadController(deps: UploadControllerDeps): UploadController {
  const records = new Map<string, Record_>();
  const watched = new Set<Watched>();
  const listeners = new Set<() => void>();

  /** Tells every listener something changed. */
  const notify = (): void => {
    listeners.forEach((listener) => {
      listener();
    });
  };

  /**
   * Writes finished addresses into one body and brings its guard
   * registrations in line with what is in it now.
   * @param entry - The body.
   */
  const scan = (entry: Watched): void => {
    entry.queued = false;
    const { body } = entry;
    const pending = pendingElements(documentBodyFragment(body.doc));
    if (body.writeAccess() === 'granted') {
      const writable = pending.filter(({ uploadId }) => records.get(uploadId)?.result != null);
      if (writable.length > 0) {
        body.doc.transact(() => {
          for (const { element, uploadId } of writable) {
            const result = records.get(uploadId)!.result!;
            element.setAttribute('url', result.url);
            if (result.mediaWidth !== undefined) element.setAttribute('mediaWidth', result.mediaWidth as never);
            if (result.mediaHeight !== undefined) element.setAttribute('mediaHeight', result.mediaHeight as never);
            element.setAttribute('uploadId', '');
          }
        }, UPLOAD_WRITE_ORIGIN);
      }
    }
    const present = new Set(pendingElements(documentBodyFragment(body.doc)).map(({ uploadId }) => uploadId));
    const busy = new Set([...present].filter((uploadId) => records.get(uploadId)?.phase === 'uploading'));
    publish(entry, present);
    for (const uploadId of [...entry.registered]) {
      if (!busy.has(uploadId)) {
        entry.registered.delete(uploadId);
        deps.unregister(body.spaceId, uploadId);
      }
    }
    for (const uploadId of busy) {
      if (!entry.registered.has(uploadId)) {
        entry.registered.add(uploadId);
        deps.register(body.spaceId, uploadId);
      }
    }
  };

  let stopRenewal: (() => void) | null = null;

  /** Renews every attached body's awareness. */
  const tick = (): void => {
    watched.forEach(({ body }) => {
      const state = body.awareness?.getLocalState() ?? null;
      if (state !== null) body.awareness!.setLocalState(state);
    });
  };

  /** Runs the renewal while any body publishes a claim, and stops it otherwise. */
  const steerRenewal = (): void => {
    const claiming = [...watched].some(({ published }) => published !== '{}');
    if (claiming && stopRenewal === null && deps.renew !== undefined) stopRenewal = deps.renew(tick);
    if (!claiming && stopRenewal !== null) {
      stopRenewal();
      stopRenewal = null;
    }
  };

  /**
   * Publishes this page's claims in one body's awareness: every upload in
   * flight or failed, and every finished one whose block in this body still
   * waits to be written.
   * @param entry - The body.
   * @param present - The upload ids of the pending blocks in it.
   */
  const publish = (entry: Watched, present: ReadonlySet<string>): void => {
    const claims: Record<string, string> = {};
    records.forEach((record, uploadId) => {
      if (record.phase === 'uploading') claims[uploadId] = 'uploading';
      else if (record.phase === 'failed') claims[uploadId] = 'failed';
      else if (present.has(uploadId)) claims[uploadId] = 'uploading';
    });
    const json = JSON.stringify(claims);
    if (json !== entry.published && entry.body.awareness?.getLocalState() != null) {
      entry.body.awareness.setLocalStateField(CLAIMS_FIELD, claims);
    }
    entry.published = json;
    steerRenewal();
  };

  /**
   * Scans a body once the current task's transactions are all done.
   * @param entry - The body.
   */
  const queue = (entry: Watched): void => {
    if (entry.queued) return;
    entry.queued = true;
    queueMicrotask(() => {
      if (watched.has(entry)) scan(entry);
    });
  };

  /** Scans every attached body. */
  const queueAll = (): void => {
    watched.forEach(queue);
  };

  /**
   * Runs one upload and records how it ended.
   * @param uploadId - The upload.
   * @param record - Its record.
   */
  const run = (uploadId: string, record: Record_): void => {
    void deps
      .run(uploadId, record.source, (share) => {
        record.progress = share;
        notify();
      })
      .then((outcome) => {
        record.progress = null;
        if (outcome.ok) {
          record.phase = 'done';
          record.result = outcome.result;
        } else {
          record.phase = 'failed';
          record.failure = outcome.failure;
        }
        queueAll();
        notify();
      });
  };

  return {
    start(uploadId, source) {
      const record: Record_ = { source, phase: 'uploading', progress: null, failure: null, result: null };
      records.set(uploadId, record);
      run(uploadId, record);
      queueAll();
      notify();
    },
    retry(uploadId) {
      const record = records.get(uploadId);
      if (record?.phase !== 'failed' || record.failure?.retryable !== true) return;
      record.phase = 'uploading';
      record.failure = null;
      run(uploadId, record);
      queueAll();
      notify();
    },
    attach(body) {
      const entry: Watched = { body, registered: new Set(), queued: false, published: '{}' };
      const fragment = documentBodyFragment(body.doc);
      /** Queues a scan for any change in the body. */
      const onChange = (): void => {
        queue(entry);
      };
      fragment.observeDeep(onChange);
      const stopAccess = body.onWriteAccess(onChange);
      watched.add(entry);
      queue(entry);
      return () => {
        if (!watched.delete(entry)) return;
        fragment.unobserveDeep(onChange);
        stopAccess();
        for (const uploadId of entry.registered) deps.unregister(body.spaceId, uploadId);
        entry.registered.clear();
        if (entry.published !== '{}' && body.awareness?.getLocalState() != null) {
          body.awareness.setLocalStateField(CLAIMS_FIELD, {});
        }
        entry.published = '{}';
        steerRenewal();
      };
    },
    entry(uploadId) {
      const record = records.get(uploadId);
      if (record === undefined) return undefined;
      return { phase: record.phase, progress: record.progress, failure: record.failure };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
