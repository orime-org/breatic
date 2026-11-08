// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a pending block's bytes come from, and how each source ends
 * (inner#1351 + inner#1390 design §5.2, §5.3, §5.4). This is the upload
 * controller's `run`.
 *
 * - A file is uploaded with no node behind it.
 * - An `https:` address is fetched into storage by the ingest Worker. The
 *   requests go one at a time, and one turned away for the rate waits as
 *   long as the server says and is sent again.
 * - A `data:` or `blob:` address is read in the browser and uploaded as a file.
 * - An address under our prefix pasted before the prefix was known keeps its
 *   address.
 * - An address of ours from a canvas node is registered into this project's
 *   Studio, with every other one started in the same task, in one request.
 */

import { formatNameOf, readTaskFailure, type PastePair, type TaskFailureReason } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { UploadFailedError, type StoredUpload, type UploadFailureReason } from '@web/data/upload/media-upload';
import type { UploadEnding } from '@web/data/upload/upload-status';
import { STORAGE_FULL_STATUS } from '@web/data/upload/upload-retry';
import { uploadRetryCanChange } from '@web/spaces/canvas/upload-failure';
import { routeAddress } from '@web/spaces/document/document-media-address';
import { isMediaBlockType } from '@web/spaces/document/document-media-types';
import type {
  PendingFailureReason,
  UploadControllerDeps,
  UploadFailure,
  UploadOutcome,
  UploadResult,
  UploadSource,
} from '@web/spaces/document/document-upload-controller';

/** What the sources need from the network and the clock. */
export interface UploadSourceDeps {
  /** Uploads a file with no node behind it; rejects with `UploadFailedError`. */
  uploadFile: (file: File, onProgress: (share: number) => void) => Promise<StoredUpload>;
  /** Asks the ingest Worker to fetch an address; answers the storage key. */
  ingest: (url: string) => Promise<string>;
  /** Waits for how the upload under a storage key ended. */
  waitForEnding: (storageKey: string) => Promise<UploadEnding>;
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

/**
 * How a fetch that ended in each cause fails: what the block says and whether
 * fetching the address again can end differently. A cause added to the
 * vocabulary does not compile until it is placed here.
 */
const FETCH_FAILURE: Readonly<Record<TaskFailureReason, UploadFailure>> = {
  internal: { reason: 'failed', retryable: true },
  expired: { reason: 'failed', retryable: true },
  aborted: { reason: 'failed', retryable: true },
  source_unreachable: { reason: 'unreachable', retryable: true },
  source_cut_off: { reason: 'failed', retryable: true },
  unsupported_type: { reason: 'unsupportedType', retryable: false },
  over_cap: { reason: 'tooLarge', retryable: false },
  empty: { reason: 'empty', retryable: false },
  understand_over_cap: { reason: 'failed', retryable: false },
  no_result: { reason: 'failed', retryable: false },
  understand_unsupported_type: { reason: 'failed', retryable: false },
  no_credits: { reason: 'failed', retryable: false },
  declined: { reason: 'failed', retryable: false },
  tool_failed: { reason: 'failed', retryable: false },
  media_refused: { reason: 'failed', retryable: false },
  no_audio_track: { reason: 'failed', retryable: false },
  credits_held: { reason: 'failed', retryable: false },
  cut_short: { reason: 'failed', retryable: false },
};

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
 * A success from what the server filed.
 * @param url - The stored address.
 * @param width - Its pixel width, when it has one.
 * @param height - Its pixel height, when it has one.
 * @returns The outcome.
 */
function done(url: string, width?: number | null, height?: number | null): UploadOutcome {
  const result: UploadResult = {
    url,
    ...(typeof width === 'number' && typeof height === 'number' && { mediaWidth: width, mediaHeight: height }),
  };
  return { ok: true, result };
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
   * Uploads a file.
   * @param file - The file.
   * @param onProgress - Told the share sent.
   * @returns How it ended.
   */
  const uploadFile = async (file: File, onProgress: (share: number) => void): Promise<UploadOutcome> => {
    try {
      const filed = await deps.uploadFile(file, onProgress);
      // The kind the server read off the stored bytes, not the name's guess.
      if (!isMediaBlockType(filed.kind)) return fail('unsupportedType', false);
      return done(filed.fileUrl, filed.width, filed.height);
    } catch (err) {
      const reason = err instanceof UploadFailedError ? err.reason : 'upload';
      return fail(FILE_FAILURE_REASON[reason], uploadRetryCanChange(reason));
    }
  };

  /**
   * Sends one ingest request, waiting out a 429 as often as it comes.
   * @param url - The address.
   * @returns The storage key.
   */
  const ingest = async (url: string): Promise<string> => {
    for (;;) {
      try {
        return await deps.ingest(url);
      } catch (err) {
        if (!(err instanceof ApiException) || err.status !== RATE_LIMITED_STATUS) throw err;
        await deps.sleep((err.retryAfterSeconds ?? FALLBACK_WAIT_SECONDS) * 1000);
      }
    }
  };

  /**
   * Has the ingest Worker fetch an address.
   * @param url - The address.
   * @returns How it ended.
   */
  const fetchAddress = async (url: string): Promise<UploadOutcome> => {
    const sent = line.then(() => ingest(url));
    // The next address goes once this one has been taken, however it ended.
    line = sent.catch(() => undefined);
    let key: string;
    try {
      key = await sent;
    } catch (err) {
      return refusal(err);
    }
    const ending = await deps.waitForEnding(key);
    if (ending.state === 'completed') return done(ending.result.fileUrl, ending.result.width, ending.result.height);
    if (ending.state === 'failed') {
      const cause = readTaskFailure(ending.reason).reason;
      return cause === null ? fail('failed', true) : { ok: false, failure: FETCH_FAILURE[cause] };
    }
    return fail('failed', true);
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

  return async (_uploadId, source, onProgress) => {
    if (source.kind === 'file') return uploadFile(source.file, onProgress);
    if (source.kind === 'ours') {
      return new Promise<UploadOutcome>((resolve) => {
        if (batch.length === 0) queueMicrotask(() => void flush());
        batch.push({ source, resolve });
      });
    }
    const prefix = await deps.assetUrlPrefix();
    if (prefix !== null && source.url.startsWith(prefix)) return done(source.url);
    const route = routeAddress(source.url);
    if (route === 'fetch') return fetchAddress(source.url);
    if (route === 'file') {
      let blob: Blob;
      try {
        blob = await deps.readAddress(source.url);
      } catch {
        // A blob: address revoked by the page it came from reads as nothing again.
        return fail('failed', false);
      }
      return uploadFile(pastedFile(blob), onProgress);
    }
    return fail('failed', false);
  };
}
