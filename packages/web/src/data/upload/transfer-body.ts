// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A request body too large for the API, moved through storage (inner#1006).
 *
 * The server reads at most `maxRequestBodyBytes` of any request. The three
 * routes that can legitimately carry more (paste, snapshot, chat) also take
 * `{ transfer: storageKey }`: the body is written as a transfer file, uploaded
 * through the ingest Worker like any upload, and the route is sent the
 * reference instead. Everything after that — the route's checks, what it
 * stores — is unchanged.
 */

import { encodeTransferBody } from '@breatic/shared';
import {
  assetsApi,
  NO_CLIENT_TIMEOUT,
  requestBodyLimitOf,
  type UploadConfig,
} from '@web/data/api/assets';
import { apiPost } from '@web/data/api/request';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { waitForUploadEnding } from '@web/data/upload/upload-status';

/** What a route is sent in place of a body that went through storage. */
export interface TransferReference {
  transfer: string;
}

/** What the caller may hook into a transfer. */
export interface BodyOrTransferOptions {
  /** Stops the transfer between steps and inside the requests that take it. */
  signal?: AbortSignal;
  /** Told once, when the body turns out to need a transfer, before it starts. */
  onTransferStart?: () => void;
}

/**
 * Settle with `work`, or reject as soon as `signal` is raised.
 * @param work - What is being waited for.
 * @param signal - The caller's stop.
 * @returns What `work` settles with.
 */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    /** Reject with the stop. */
    const stop = (): void => {
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * Upload the body as a transfer file and wait until the server has it.
 * @param projectId - The project the request is for.
 * @param json - The body's `JSON.stringify` output.
 * @param cfg - The upload knobs.
 * @param options - The stop signal and the start hook.
 * @returns The reference to send in place of the body.
 * @throws {Error} When the ticket is refused or the upload does not end transferred.
 * @throws {DOMException} `AbortError` when the signal is raised between steps;
 *   a stop during the ticket or finish request rejects with the `ApiException`
 *   the cancelled request becomes, which `bodyOrTransfer` turns into `AbortError`.
 */
async function transfer(
  projectId: string,
  json: string,
  cfg: UploadConfig,
  options: BodyOrTransferOptions,
): Promise<TransferReference> {
  const { signal } = options;
  signal?.throwIfAborted();
  options.onTransferStart?.();
  signal?.throwIfAborted();

  const file = new Blob([encodeTransferBody(json)]);
  const config = signal === undefined ? NO_CLIENT_TIMEOUT : { signal, ...NO_CLIENT_TIMEOUT };
  const ticket = await apiPost<UploadTicket>(
    '/assets/transfer-ticket',
    { project_id: projectId, size: file.size },
    config,
  );
  signal?.throwIfAborted();
  const queued = await sendFileAndFinish(file, ticket, cfg, undefined, signal);
  const ending = await untilStopped(waitForUploadEnding(queued.storageKey), signal);
  signal?.throwIfAborted();
  if (ending.state !== 'transferred') {
    throw new Error(`the transfer upload ended ${ending.state}`);
  }
  return { transfer: queued.storageKey };
}

/**
 * The body to send: itself when it fits the server's request body limit, or
 * a reference to it once it has gone through storage. A page whose server
 * names no limit, or whose knobs cannot be fetched, sends the body as it is:
 * one within the limit goes through, and the server refuses a larger one with
 * the failure the caller already shows.
 * @param projectId - The project the request is for.
 * @param body - The request body.
 * @param options - The stop signal and the start hook.
 * @returns The body itself, or the reference to send in its place.
 * @throws {Error} When the transfer fails.
 * @throws {DOMException} `AbortError` once the signal is raised.
 */
export async function bodyOrTransfer<B>(
  projectId: string,
  body: B,
  options: BodyOrTransferOptions = {},
): Promise<B | TransferReference> {
  let cfg: UploadConfig;
  try {
    cfg = await assetsApi.fetchUploadConfig();
  } catch {
    // Without the knobs the body goes as it is; see above.
    return body;
  }
  const limit = requestBodyLimitOf(cfg);
  if (limit === null) return body;
  const json = JSON.stringify(body);
  if (new TextEncoder().encode(json).length <= limit) return body;

  try {
    return await transfer(projectId, json, cfg, options);
  } catch (err) {
    // However far it got, a stop reads as a stop.
    if (options.signal?.aborted === true) {
      throw new DOMException('The transfer was stopped.', 'AbortError');
    }
    throw err;
  }
}
