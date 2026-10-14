// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { formatNameOf, type PastePair, type TaskFailureReason } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { UploadFailedError, type StoredUpload } from '@web/data/upload/media-upload';
import type { UploadEnding } from '@web/data/upload/upload-status';
import { STORAGE_FULL_STATUS } from '@web/data/upload/upload-retry';
import { refusedFormatParams } from '@web/spaces/canvas/canvas-upload';
import { failureMessage } from '@web/spaces/canvas/failure-sentence';
import { uploadFailureMessageKey, uploadRetryCanChange } from '@web/spaces/canvas/upload-failure';
import { routeAddress } from '@web/spaces/document/document-canvas-paste';
import { isMediaBlockType } from '@web/spaces/document/document-media-types';
import type {
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
 * Whether fetching the address again can end differently, for every cause a
 * fetch can end in. A cause added to the vocabulary does not compile until
 * it is placed here.
 */
const FETCH_RETRY_CAN_CHANGE: Readonly<Record<TaskFailureReason, boolean>> = {
  internal: true,
  expired: true,
  aborted: true,
  source_unreachable: true,
  source_cut_off: true,
  unsupported_type: false,
  over_cap: false,
  empty: false,
  understand_over_cap: false,
  no_result: false,
  understand_unsupported_type: false,
  no_credits: false,
  declined: false,
  tool_failed: false,
  media_refused: false,
  no_audio_track: false,
};

/** The failure every catch-all says. */
const FAILED_KEY = 'canvas.upload.failed';

/**
 * A failure.
 * @param messageKey - What it says.
 * @param retryable - Whether running it again can help.
 * @param params - The values the message is filled with.
 * @returns The outcome.
 */
function fail(messageKey: string, retryable: boolean, params: Record<string, string> = {}): UploadOutcome {
  const failure: UploadFailure = { messageKey, params, retryable };
  return { ok: false, failure };
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
  if (status === STORAGE_FULL_STATUS) return fail('canvas.upload.storageFull', false);
  if (status === RATE_LIMITED_STATUS) return fail('canvas.upload.rateLimited', true);
  // Our own request was wrong (400, 403, 404): sending it again is the same.
  if (status >= 400 && status < 500) return fail(FAILED_KEY, false);
  // No answer, or the server broke.
  return fail(FAILED_KEY, true);
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
    const params = { filename: file.name, ...refusedFormatParams(file) };
    try {
      const filed = await deps.uploadFile(file, onProgress);
      // The kind the server read off the stored bytes, not the name's guess.
      if (!isMediaBlockType(filed.kind)) return fail(uploadFailureMessageKey('unsupportedType'), false, params);
      return done(filed.fileUrl, filed.width, filed.height);
    } catch (err) {
      const reason = err instanceof UploadFailedError ? err.reason : 'upload';
      return fail(uploadFailureMessageKey(reason), uploadRetryCanChange(reason), params);
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
      const message = failureMessage(ending.reason);
      return message === null
        ? fail(FAILED_KEY, true)
        : fail(message.key, FETCH_RETRY_CAN_CHANGE[message.reason], message.params);
    }
    return fail(FAILED_KEY, true);
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
      resolve(typeof copy === 'string' ? done(copy) : fail(FAILED_KEY, true));
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
        return fail(FAILED_KEY, false);
      }
      return uploadFile(pastedFile(blob), onProgress);
    }
    return fail(FAILED_KEY, false);
  };
}
