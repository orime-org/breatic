// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Where a pending block's bytes come from, and how each source ends
 * (inner#1351 + inner#1390 design §5.2, §5.3, §5.4). This is the upload
 * controller's `run`.
 *
 * - A file is uploaded, and an `https:` address is fetched into storage by
 *   the ingest Worker, for the block's `uploadId`: once the server has either,
 *   the server announces the ending and collab writes the block (breatic#1574).
 *   Address requests go one at a time, and one turned away for the rate waits
 *   as long as the server says and is sent again.
 * - A `data:` or `blob:` address is read in the browser and uploaded as a file.
 * - An address under our prefix pasted before the prefix was known keeps its
 *   address.
 * - An address of ours from a canvas node is registered into this project's
 *   Studio, with every other one started in the same task, in one request.
 */

import { formatNameOf, type PastePair } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { UploadFailedError, type UploadFailureReason } from '@web/data/upload/media-upload';
import { STORAGE_FULL_STATUS } from '@web/data/upload/upload-retry';
import { uploadRetryCanChange } from '@web/spaces/canvas/upload-failure';
import { routeAddress } from '@web/spaces/document/document-media-address';
import type {
  PendingFailureReason,
  UploadControllerDeps,
  UploadOutcome,
  UploadSource,
} from '@web/spaces/document/document-upload-controller';

/** What the sources need from the network and the clock. */
export interface UploadSourceDeps {
  /** Hands a block's file to the server; rejects with `UploadFailedError`. */
  uploadFile: (file: File, uploadId: string, onProgress: (share: number) => void) => Promise<void>;
  /** Asks the ingest Worker to fetch an address into a block. */
  ingest: (url: string, uploadId: string) => Promise<void>;
  /** Registers addresses of ours into this project's Studio (`/canvas/paste`). */
  register: (input: { urls: string[]; pairs: PastePair[] }) => Promise<Readonly<Record<string, string | null>>>;
  /** Our public prefix, or null when it cannot be read. */
  assetUrlPrefix: () => Promise<string | null>;
  /** Reads a `data:` or `blob:` address. */
  readAddress: (url: string) => Promise<Blob>;
  /** Waits this many milliseconds. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * The bytes an address held, as a file named for its format: the name's
 * extension is what the storage key, and a later save-as, carry.
 * @param blob - The bytes.
 * @returns The file.
 */
function pastedFile(blob: Blob): File {
  const extension = formatNameOf(blob.type)?.toLowerCase();
  return new File([blob], extension === undefined ? 'pasted' : `pasted.${extension}`, { type: blob.type });
}

/** Too Many Requests (RFC 6585 §4). */
const RATE_LIMITED_STATUS = 429;

/** How long to wait on a 429 that named no time; the server always names one. */
const FALLBACK_WAIT_SECONDS = 1;

/** What the block says for each way a file upload fails. */
const FILE_FAILURE_REASON: Readonly<Record<UploadFailureReason, PendingFailureReason>> = {
  storage: 'storageFull',
  hash: 'hashUnavailable',
  unsupportedType: 'unsupportedType',
  rateLimited: 'rateLimited',
  tooLarge: 'tooLarge',
  upload: 'failed',
  transfer: 'failed',
};

/** The server has the upload: it announces the ending and collab writes the block. */
const HANDED_OFF: UploadOutcome = { ok: true, handedOff: true };

/**
 * A failure.
 * @param reason - What it says.
 * @param retryable - Whether running it again can help.
 * @returns The outcome.
 */
function fail(reason: PendingFailureReason, retryable: boolean): UploadOutcome {
  return { ok: false, failure: { reason, retryable } };
}

/**
 * An address answered on the spot.
 * @param url - The stored address.
 * @returns The outcome.
 */
function done(url: string): UploadOutcome {
  return { ok: true, result: { url } };
}

/**
 * How a refused request to our server ends, when it is not a 429 to wait out.
 * @param err - What it rejected with.
 * @returns The outcome.
 */
function refusal(err: unknown): UploadOutcome {
  const status = err instanceof ApiException ? err.status : 0;
  if (status === STORAGE_FULL_STATUS) return fail('storageFull', false);
  if (status === RATE_LIMITED_STATUS) return fail('rateLimited', true);
  // Our own request was wrong (400, 403, 404): sending it again is the same.
  if (status >= 400 && status < 500) return fail('failed', false);
  // No answer, or the server broke.
  return fail('failed', true);
}

/**
 * Builds the controller's `run` against these deps.
 * @param deps - The network and the clock.
 * @returns The run function.
 */
export function createUploadSources(deps: UploadSourceDeps): UploadControllerDeps['run'] {
  /** The ingest requests in flight, one after another. */
  let line: Promise<unknown> = Promise.resolve();

  /** Addresses of ours waiting for this task's registration. */
  let batch: { source: Extract<UploadSource, { kind: 'ours' }>; resolve: (outcome: UploadOutcome) => void }[] = [];

  /**
   * Hands a file to the server.
   * @param file - The file.
   * @param uploadId - The block's upload.
   * @param onProgress - Told the share sent.
   * @returns How this page's part ended.
   */
  const uploadFile = async (file: File, uploadId: string, onProgress: (share: number) => void): Promise<UploadOutcome> => {
    try {
      await deps.uploadFile(file, uploadId, onProgress);
      return HANDED_OFF;
    } catch (err) {
      const reason = err instanceof UploadFailedError ? err.reason : 'upload';
      return fail(FILE_FAILURE_REASON[reason], uploadRetryCanChange(reason));
    }
  };

  /**
   * Sends one ingest request, waiting out a 429 as often as it comes.
   * @param url - The address.
   * @param uploadId - The block's upload.
   * @returns Once the server took it.
   */
  const ingest = async (url: string, uploadId: string): Promise<void> => {
    for (;;) {
      try {
        await deps.ingest(url, uploadId);
        return;
      } catch (err) {
        if (!(err instanceof ApiException) || err.status !== RATE_LIMITED_STATUS) throw err;
        await deps.sleep((err.retryAfterSeconds ?? FALLBACK_WAIT_SECONDS) * 1000);
      }
    }
  };

  /**
   * Has the ingest Worker fetch an address.
   * @param url - The address.
   * @param uploadId - The block's upload.
   * @returns How this page's part ended.
   */
  const fetchAddress = async (url: string, uploadId: string): Promise<UploadOutcome> => {
    const sent = line.then(() => ingest(url, uploadId));
    // The next address goes once this one has been taken, however it ended.
    line = sent.catch(() => undefined);
    try {
      await sent;
    } catch (err) {
      return refusal(err);
    }
    return HANDED_OFF;
  };

  /** Registers this task's addresses of ours in one request. */
  const flush = async (): Promise<void> => {
    const taken = batch;
    batch = [];
    const urls = taken.filter(({ source }) => source.coverUrl === undefined).map(({ source }) => source.url);
    const pairs = taken.flatMap(({ source }) =>
      source.coverUrl === undefined ? [] : [{ url: source.url, cover: source.coverUrl }],
    );
    let map: Readonly<Record<string, string | null>>;
    try {
      map = await deps.register({ urls, pairs });
    } catch (err) {
      const outcome = refusal(err);
      taken.forEach(({ resolve }) => {
        resolve(outcome);
      });
      return;
    }
    taken.forEach(({ source, resolve }) => {
      const copy = map[source.url];
      resolve(typeof copy === 'string' ? done(copy) : fail('failed', true));
    });
  };

  return async (uploadId, source, onProgress) => {
    if (source.kind === 'file') return uploadFile(source.file, uploadId, onProgress);
    if (source.kind === 'ours') {
      return new Promise<UploadOutcome>((resolve) => {
        if (batch.length === 0) queueMicrotask(() => void flush());
        batch.push({ source, resolve });
      });
    }
    const prefix = await deps.assetUrlPrefix();
    if (prefix !== null && source.url.startsWith(prefix)) return done(source.url);
    const route = routeAddress(source.url);
    if (route === 'fetch') return fetchAddress(source.url, uploadId);
    if (route === 'file') {
      let blob: Blob;
      try {
        blob = await deps.readAddress(source.url);
      } catch {
        // A blob: address revoked by the page it came from reads as nothing again.
        return fail('failed', false);
      }
      return uploadFile(pastedFile(blob), uploadId, onProgress);
    }
    return fail('failed', false);
  };
}
