// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One upload's bookkeeping, addressed by its storage key (#173, design §4.3).
 *
 * R2 keeps no view of a multipart upload's progress that survives between
 * requests, so "have all the parts arrived?" is answerable only by something
 * that remembers. This is that something: one instance per upload, holding
 * which parts landed and what the ticket said to expect.
 *
 * It also holds the alarm. Every part that arrives pushes it out, so an upload
 * that keeps moving is never cut off however large the file is, and one that
 * stops is judged dead that long after its last part.
 *
 * Cloudflare runs each instance single-threaded, so the state read at the top
 * of a handler is still true when it writes at the bottom. That is what makes
 * "open it if nobody has, otherwise hand back what is already open" a decision
 * rather than a race.
 */

import type { UploadTicketPayload } from "@breatic/shared";
import { signSessionToken } from "@ingest/session-token.js";

/** How long a session token stays usable. */
const SESSION_TOKEN_TTL_MS = 600_000;

/** What the instance remembers about an upload while it is open. */
interface OpenUpload {
  /** The ticket that opened it; the part layout and ceilings come from here. */
  ticket: UploadTicketPayload;
  /** R2's id for the multipart upload. */
  uploadId: string;
}

/** The Durable Object holding one upload's parts, ticket context and alarm. */
export class UploadSession implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: { BUCKET: R2Bucket; INGEST_SHARED_SECRET: string };

  /**
   * @param state - The instance's own storage and alarm.
   * @param env - The Worker's bindings, of which this needs the bucket and secret.
   */
  constructor(
    state: DurableObjectState,
    env: { BUCKET: R2Bucket; INGEST_SHARED_SECRET: string },
  ) {
    this.#state = state;
    this.#env = env;
  }

  /**
   * Handle one request forwarded by the Worker's fetch handler.
   * @param request - The forwarded request.
   * @returns The response the Worker passes back to the browser.
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/open") {
      return this.#open(await request.json<UploadTicketPayload>());
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Open the multipart upload, or hand back the one already open.
   *
   * The browser's transport retries on a 5xx or a dropped connection, so this
   * arriving twice is ordinary. A second `createMultipartUpload` would strand
   * the first: parts already written would belong to an upload nothing ever
   * completes, and the object they were meant for would never appear.
   * @param ticket - The verified ticket, which the Worker has already checked.
   * @returns The upload id and a token for the first part.
   */
  async #open(ticket: UploadTicketPayload): Promise<Response> {
    const existing = await this.#state.storage.get<OpenUpload>("upload");
    const upload =
      existing ??
      (await this.#createUpload(ticket));

    const token = await signSessionToken(
      {
        storageKey: upload.ticket.storageKey,
        uploadId: upload.uploadId,
        expiresAt: Date.now() + SESSION_TOKEN_TTL_MS,
      },
      this.#env.INGEST_SHARED_SECRET,
    );

    return Response.json({ uploadId: upload.uploadId, token });
  }

  /**
   * Ask R2 for a multipart upload and record it.
   * @param ticket - The verified ticket.
   * @returns What was recorded.
   */
  async #createUpload(ticket: UploadTicketPayload): Promise<OpenUpload> {
    const created = await this.#env.BUCKET.createMultipartUpload(
      ticket.storageKey,
      // Set now rather than at completion: R2 takes the object's metadata from
      // the upload it was created under, and without it a public read answers
      // application/octet-stream whatever the file actually is.
      { httpMetadata: { contentType: ticket.contentType } },
    );
    const upload: OpenUpload = { ticket, uploadId: created.uploadId };
    await this.#state.storage.put("upload", upload);
    // The clock starts now. A browser that never sends a part leaves an
    // instance that would otherwise sit here holding a multipart upload
    // forever, and R2 charges for the parts already written into one.
    await this.#state.storage.setAlarm(Date.now() + ticket.alarmIdleSeconds * 1000);
    return upload;
  }
}
