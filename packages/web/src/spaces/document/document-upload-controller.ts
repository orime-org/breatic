// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The page's upload controller (inner#1351 + inner#1390 design §5.5, §5.6).
 *
 * A pending media block is a real block in the shared document whose
 * `uploadId` is set and whose `url` is empty. The controller runs the upload
 * behind each id. A file or a fetched address is handed to the server, and
 * collab writes its ending into the blocks of its own Document (breatic#1574);
 * only an address answered on the spot (already ours) is written here, onto
 * every pending block carrying its id in an attached body.
 *
 * The write is a Yjs transaction under {@link UPLOAD_WRITE_ORIGIN}, which no
 * UndoManager tracks, so it is never undone and never splits the user's
 * undo steps. It is an `edit` for the size cap (inner#1790, design 5.2): while
 * the Space is full, over its ceiling or being rebuilt it is skipped, the
 * record stays `done` and the block waits; the body is scanned again whenever
 * its size changes, so the address lands once the Space has room. It runs from a microtask, outside every Yjs transaction and the
 * sync binding's mutex: a write nested in the transaction that brought the
 * block in reaches Yjs but not the local editor view.
 */

import * as Y from 'yjs';

import {
  documentBodyFragment,
  landDocumentUpload,
  UPLOAD_FAILURE_ATTR,
  UPLOAD_RETRYABLE_ATTR,
  UPLOAD_STATE_ATTR,
  type DocumentUploadResult,
  type UploadFailure,
} from '@breatic/shared';

import type { WriteAccess } from '@web/data/yjs/collab-socket';
import { subscribeDocSize } from '@web/data/yjs/doc-size';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import { CLAIMS_FIELD, type UploadClaim } from '@web/lib/upload-claims';
import { isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';

/** Where a pending block's bytes come from. */
export type UploadSource =
  | { readonly kind: 'file'; readonly file: File }
  | { readonly kind: 'address'; readonly url: string }
  | { readonly kind: 'ours'; readonly url: string; readonly coverUrl?: string };

/** A finished upload: the stored address and the media's own size. */
export type UploadResult = DocumentUploadResult;

export type { PendingFailureReason, UploadFailure } from '@breatic/shared';

/** How this page's part of an upload ended. */
export type UploadOutcome =
  /** Answered on the spot: this page writes the address. */
  | { readonly ok: true; readonly result: UploadResult }
  /** The server took the bytes or the address: it announces the ending and collab writes the block (breatic#1574). */
  | { readonly ok: true; readonly handedOff: true }
  | { readonly ok: false; readonly failure: UploadFailure };

/** Where an upload stands on this page: a failure always says why, a finished one always holds its result. */
export type UploadEntry =
  /** `progress` is the share sent, 0 to 1, when the size is known; otherwise null. */
  | { readonly phase: 'uploading'; readonly progress: number | null }
  | { readonly phase: 'failed'; readonly failure: UploadFailure }
  | { readonly phase: 'done'; readonly result: UploadResult }
  /** The server has it; the block learns the ending from collab. */
  | { readonly phase: 'handedOff' };

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
  /** The body's document name, whose size gates the address write; absent for a body not in the document cache. */
  readonly name?: string | null;
  /** Where this page's claims on the body's uploads are published. */
  readonly awareness?: ClaimChannel;
  /** This page's write access to the body, read now. */
  writeAccess: () => WriteAccess;
  /**
   * Calls back whenever the write access may have changed.
   * @returns What stops listening.
   */
  onChange: (listener: () => void) => () => void;
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
  /**
   * Runs an upload this page holds the source of again, under a new id: its blocks take `nextId` and drop what
   * collab wrote, so nothing the earlier attempt announces reaches them (breatic#1574).
   */
  retry: (uploadId: string, nextId: string) => void;
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
const UPLOAD_WRITE_ORIGIN: Readonly<{ name: string }> = Object.freeze({
  name: 'document-upload-write',
});

/** What collab writes onto a pending block, dropped when its upload is run again. */
const SERVER_ATTRS = [UPLOAD_STATE_ATTR, UPLOAD_FAILURE_ATTR, UPLOAD_RETRYABLE_ATTR];

/**
 * Whether this page can run an upload again from what it holds: the server has the upload, or this page's own
 * attempt failed in a way running it again can change.
 * @param entry - This page's record of the upload.
 * @returns True when a retry runs.
 */
export function canRetry(entry: UploadEntry): boolean {
  return entry.phase === 'handedOff' || (entry.phase === 'failed' && entry.failure.retryable);
}

/** One upload's whole record. */
interface UploadRecord {
  /** Where the bytes come from; kept for a Retry until nothing can run the upload again. */
  source: UploadSource | null;
  state: UploadEntry;
}

/** One attached body and what the controller holds for it. */
interface Watched {
  readonly body: AttachedBody;
  /** Upload ids this body has registered with the guard. */
  readonly registered: Set<string>;
  queued: boolean;
  /** This page's claims on the pending blocks in this body. */
  claims: Readonly<Record<string, UploadClaim>>;
}

/**
 * Whether a body holds a pending block this page claims.
 * @param entry - The body.
 * @returns True when it does.
 */
function claiming(entry: Watched): boolean {
  return Object.keys(entry.claims).length > 0;
}

/**
 * The upload id of a pending media element, or null.
 * @param element - A Yjs element.
 * @returns The id, when the element is a media block with an id and no url.
 */
function pendingId(element: Y.XmlElement): string | null {
  return isMediaBlockType(element.nodeName) ? pendingUploadId(element.getAttributes()) : null;
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
  const records = new Map<string, UploadRecord>();
  const watched = new Set<Watched>();
  const listeners = new Set<() => void>();

  /** Tells every listener something changed. */
  const notify = (): void => {
    listeners.forEach((listener) => {
      listener();
    });
  };

  /** The blocks each upload in flight or handed off was last seen pending in, to tell when it settled. */
  const trackedBlocks = new Map<string, Set<Y.XmlElement>>();

  /**
   * Lets go of a handed-off upload once nothing can run it again: its block
   * landed (collab wrote the address), or collab wrote a failure running it
   * again cannot change. The source would otherwise stay for the page's life.
   */
  const releaseSettled = (): void => {
    for (const [uploadId, blocks] of trackedBlocks) {
      const record = records.get(uploadId);
      // Collab can land a block before the hand-off answer arrives (a dedup
      // hit is announced first), so blocks are kept from the start and judged
      // once the record is handed off.
      if (record?.state.phase === 'uploading') continue;
      if (record === undefined || record.state.phase !== 'handedOff') {
        trackedBlocks.delete(uploadId);
        continue;
      }
      const elements = [...blocks];
      if (elements.some((element) => Boolean(element.getAttribute('url')))) {
        records.delete(uploadId);
        trackedBlocks.delete(uploadId);
      } else if (elements.some((element) => element.getAttribute(UPLOAD_STATE_ATTR) === 'failed' && (element.getAttribute(UPLOAD_RETRYABLE_ATTR) as unknown) === false)) {
        record.source = null;
      }
    }
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
    for (const { element, uploadId } of pending) {
      const phase = records.get(uploadId)?.state.phase;
      if (phase !== 'uploading' && phase !== 'handedOff') continue;
      const seen = trackedBlocks.get(uploadId) ?? new Set<Y.XmlElement>();
      seen.add(element);
      trackedBlocks.set(uploadId, seen);
    }
    releaseSettled();
    /**
     * The result of an upload this page finished.
     * @param uploadId - The upload.
     * @returns Its result, or null while it is not finished.
     */
    const finished = (uploadId: string): UploadResult | null => {
      const state = records.get(uploadId)?.state;
      return state?.phase === 'done' ? state.result : null;
    };
    const writable =
      body.writeAccess() === 'granted' ? pending.filter(({ uploadId }) => finished(uploadId) !== null) : [];
    // The block reports the wait itself, so the refusal says nothing. A body
    // outside the document cache has no size facts and is judged as unknown.
    const landed =
      writable.length > 0 &&
      writeSpaceDoc(body.name ?? '', { kind: 'edit', notify: false }, () => {
        body.doc.transact(() => {
          for (const { element, uploadId } of writable) {
            landDocumentUpload(element, finished(uploadId)!);
          }
        }, UPLOAD_WRITE_ORIGIN);
      }).ok;
    const written = new Set(landed ? writable.map(({ element }) => element) : []);
    const present = new Set(pending.filter(({ element }) => !written.has(element)).map(({ uploadId }) => uploadId));
    const busy = new Set([...present].filter((uploadId) => records.get(uploadId)?.state.phase === 'uploading'));
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

  /**
   * Renews every attached body's awareness with its claims written in, so
   * claims a restored page's awareness lost are published again.
   */
  const tick = (): void => {
    watched.forEach((entry) => {
      const state = entry.body.awareness?.getLocalState() ?? null;
      if (state !== null) entry.body.awareness!.setLocalState({ ...state, [CLAIMS_FIELD]: entry.claims });
    });
  };

  /** Runs the renewal while any body holds a claim, and stops it otherwise. */
  const steerRenewal = (): void => {
    const any = [...watched].some(claiming);
    if (any && stopRenewal === null && deps.renew !== undefined) stopRenewal = deps.renew(tick);
    if (!any && stopRenewal !== null) {
      stopRenewal();
      stopRenewal = null;
    }
  };

  /**
   * Publishes this page's claims in one body's awareness, for the pending
   * blocks in it this page ran: failed, or in flight — a finished one whose
   * block still waits to be written is still in flight to a reader.
   * @param entry - The body.
   * @param present - The upload ids of the pending blocks in it.
   */
  const publish = (entry: Watched, present: ReadonlySet<string>): void => {
    const claims: Record<string, UploadClaim> = {};
    for (const uploadId of present) {
      const record = records.get(uploadId);
      if (record !== undefined) claims[uploadId] = record.state.phase === 'failed' ? 'failed' : 'uploading';
    }
    claim(entry, claims);
  };

  /**
   * Sets a body's claims: the entry holds this page's record, which the
   * renewal tick writes back; the awareness is written now only when what it
   * holds differs, so a scan that changes nothing broadcasts nothing.
   * @param entry - The body.
   * @param claims - The claims.
   */
  const claim = (entry: Watched, claims: Readonly<Record<string, UploadClaim>>): void => {
    entry.claims = claims;
    const state = entry.body.awareness?.getLocalState() ?? null;
    if (state !== null && JSON.stringify(state[CLAIMS_FIELD] ?? {}) !== JSON.stringify(claims)) {
      entry.body.awareness!.setLocalStateField(CLAIMS_FIELD, claims);
    }
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
   * @param source - Where its bytes come from.
   */
  const run = (uploadId: string, record: UploadRecord, source: UploadSource): void => {
    record.state = { phase: 'uploading', progress: null };
    void deps
      .run(uploadId, source, (share) => {
        record.state = { phase: 'uploading', progress: share };
        notify();
      })
      .then((outcome) => {
        if (outcome.ok && 'handedOff' in outcome) {
          // The source stays: a server failure the block shows can still be retried from it.
          record.state = { phase: 'handedOff' };
        } else if (outcome.ok) {
          record.state = { phase: 'done', result: outcome.result };
          record.source = null;
        } else {
          record.state = { phase: 'failed', failure: outcome.failure };
        }
        queueAll();
        notify();
      });
  };

  return {
    start(uploadId, source) {
      const record: UploadRecord = { source, state: { phase: 'uploading', progress: null } };
      records.set(uploadId, record);
      run(uploadId, record, source);
      queueAll();
      notify();
    },
    retry(uploadId, nextId) {
      const record = records.get(uploadId);
      if (record === undefined || record.source === null || !canRetry(record.state)) return;
      for (const { body } of watched) {
        const blocks = pendingElements(documentBodyFragment(body.doc)).filter(({ uploadId: id }) => id === uploadId);
        if (blocks.length === 0) continue;
        writeSpaceDoc(body.name ?? '', { kind: 'edit', notify: false }, () => {
          body.doc.transact(() => {
            for (const { element } of blocks) {
              element.setAttribute('uploadId', nextId);
              for (const attr of SERVER_ATTRS) element.removeAttribute(attr);
            }
          }, UPLOAD_WRITE_ORIGIN);
        });
      }
      records.delete(uploadId);
      records.set(nextId, record);
      run(nextId, record, record.source);
      queueAll();
      notify();
    },
    attach(body) {
      const entry: Watched = { body, registered: new Set(), queued: false, claims: {} };
      const fragment = documentBodyFragment(body.doc);
      /** Queues a scan for any change in the body. */
      const onChange = (): void => {
        queue(entry);
      };
      fragment.observeDeep(onChange);
      const stopAccess = body.onChange(onChange);
      const stopSize = body.name == null ? null : subscribeDocSize(body.name, onChange);
      watched.add(entry);
      queue(entry);
      return () => {
        if (!watched.delete(entry)) return;
        fragment.unobserveDeep(onChange);
        stopAccess();
        stopSize?.();
        for (const uploadId of entry.registered) deps.unregister(body.spaceId, uploadId);
        entry.registered.clear();
        claim(entry, {});
      };
    },
    entry(uploadId) {
      return records.get(uploadId)?.state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
