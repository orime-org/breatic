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

/** A part R2 has accepted, in the form completing the upload needs back. */
interface RecordedPart {
  partNumber: number;
  etag: string;
}

/**
 * How far the finishing sequence has got.
 *
 * Kept because the alarm re-enters it: a report the server did not accept
 * leaves the alarm set, and the next attempt must not complete an upload that
 * is already complete or read a 2 GiB object back a second time to hash it
 * again.
 */
interface FinishProgress {
  /** R2 has assembled the object, or the upload was aborted. */
  settled: boolean;
  /** What was computed over the stored bytes, once it has been.  */
  sha256?: string;
  /** What the assembled object weighs. */
  sizeBytes?: number;
  /** Why it was given up on, when it was. */
  abortedReason?: string;
  /** The server has accepted the outcome; nothing more is owed. */
  reported: boolean;
}

/** The Durable Object holding one upload's parts, ticket context and alarm. */
export class UploadSession implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: {
    BUCKET: R2Bucket;
    INGEST_SHARED_SECRET: string;
    SERVER_REPORT_URL: string;
  };

  /**
   * @param state - The instance's own storage and alarm.
   * @param env - The Worker's bindings, of which this needs the bucket and secret.
   */
  constructor(
    state: DurableObjectState,
    env: {
      BUCKET: R2Bucket;
      INGEST_SHARED_SECRET: string;
      SERVER_REPORT_URL: string;
    },
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
    const part = /^\/part\/(\d+)$/.exec(pathname);
    if (part) {
      return this.#part(Number(part[1]), await request.arrayBuffer());
    }
    if (pathname === "/complete") {
      return this.#finish();
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * The alarm going off.
   *
   * Same work as the browser asking, because the question is the same one:
   * did every part arrive? The browser only ever gets there sooner. A browser
   * that stopped sending never asks at all, and this is what notices.
   */
  async alarm(): Promise<void> {
    await this.#finish();
  }

  /**
   * Settle the upload and tell the server.
   *
   * Re-entrant by construction: each step records that it happened, so the
   * alarm coming back after a report the server refused re-sends the report
   * without completing an already-complete upload or hashing its bytes twice.
   * @returns 200 once the server has accepted the outcome, 502 while it has not.
   */
  async #finish(): Promise<Response> {
    const upload = await this.#state.storage.get<OpenUpload>("upload");
    if (upload === undefined) return new Response("Gone", { status: 410 });

    const progress: FinishProgress = (await this.#state.storage.get<FinishProgress>(
      "finish",
    )) ?? { settled: false, reported: false };
    if (progress.reported) return new Response(null, { status: 200 });

    const settled = progress.settled
      ? progress
      : await this.#settle(upload, progress);

    const accepted = await this.#report(upload, settled);
    if (!accepted) {
      // The alarm stays set. Nothing else will tell the node what happened, so
      // the only way this upload reaches the user is by trying again.
      return new Response("Report not accepted", { status: 502 });
    }

    await this.#state.storage.put("finish", { ...settled, reported: true });
    await this.#state.storage.deleteAlarm();
    return new Response(null, { status: 200 });
  }

  /**
   * Assemble the object if every part arrived, otherwise drop what was written.
   *
   * Counting is enough because a non-final part is only accepted at exactly
   * `partSize` and each part is recorded once under its own number, so the
   * count answers "is the file whole?" on its own.
   * @param upload - What is open.
   * @param progress - How far finishing has got.
   * @returns The progress after settling, already persisted.
   */
  async #settle(
    upload: OpenUpload,
    progress: FinishProgress,
  ): Promise<FinishProgress> {
    const parts = (await this.#state.storage.get<RecordedPart[]>("parts")) ?? [];
    const resumed = this.#env.BUCKET.resumeMultipartUpload(
      upload.ticket.storageKey,
      upload.uploadId,
    );

    if (parts.length < upload.ticket.totalParts) {
      await resumed.abort();
      const aborted: FinishProgress = {
        ...progress,
        settled: true,
        abortedReason: `only ${parts.length} of ${upload.ticket.totalParts} parts arrived`,
      };
      await this.#state.storage.put("finish", aborted);
      return aborted;
    }

    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const object = await resumed.complete(ordered);
    const settled: FinishProgress = {
      ...progress,
      settled: true,
      sha256: await this.#hashStored(upload.ticket.storageKey),
      sizeBytes: object.size,
    };
    await this.#state.storage.put("finish", settled);
    return settled;
  }

  /**
   * Hash the object R2 assembled.
   *
   * Streamed rather than buffered: an upload may be gigabytes, and the read
   * stays inside Cloudflare's network where it costs nothing.
   * @param storageKey - The assembled object's key.
   * @returns Its SHA-256 as lowercase hex.
   * @throws {Error} When the object is not readable, which leaves the alarm set.
   */
  async #hashStored(storageKey: string): Promise<string> {
    const stored = await this.#env.BUCKET.get(storageKey);
    if (stored === null) throw new Error(`completed object ${storageKey} is missing`);
    const digestStream = new crypto.DigestStream("SHA-256");
    await stored.body.pipeTo(digestStream);
    const digest = await digestStream.digest;
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Tell the server how this upload ended.
   * @param upload - What was uploaded, carrying the context the server reads back.
   * @param progress - The settled outcome.
   * @returns Whether the server accepted it.
   */
  async #report(upload: OpenUpload, progress: FinishProgress): Promise<boolean> {
    const body =
      progress.abortedReason === undefined
        ? {
            storage_key: upload.ticket.storageKey,
            outcome: "completed",
            lease_gen: upload.ticket.leaseGen,
            sha256: progress.sha256,
            size_bytes: progress.sizeBytes,
            content_type: upload.ticket.contentType,
          }
        : {
            storage_key: upload.ticket.storageKey,
            outcome: "aborted",
            lease_gen: upload.ticket.leaseGen,
            reason: progress.abortedReason,
          };

    try {
      const response = await fetch(this.#env.SERVER_REPORT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ingest-secret": this.#env.INGEST_SHARED_SECRET,
        },
        body: JSON.stringify(body),
      });
      return response.ok;
    } catch {
      // Unreachable server, DNS, TLS — all the same answer here: not accepted,
      // so the alarm keeps this upload alive for another try.
      return false;
    }
  }

  /**
   * Take one part: check it against the layout, write it, record its etag.
   *
   * Only the last part may be short. Every earlier one must be exactly
   * `partSize`, which is what makes "have they all arrived?" a matter of
   * counting — and R2 refuses a non-final part under 5 MiB in any case.
   * @param partNumber - Which part this is, one-based.
   * @param body - The bytes.
   * @returns A token for the next part, or why this one was refused.
   */
  async #part(partNumber: number, body: ArrayBuffer): Promise<Response> {
    const upload = await this.#state.storage.get<OpenUpload>("upload");
    if (upload === undefined) return new Response("Gone", { status: 410 });

    const { partSize, totalParts } = upload.ticket;
    if (partNumber < 1 || partNumber > totalParts) {
      return new Response("Part number outside the signed layout", { status: 400 });
    }
    const isFinal = partNumber === totalParts;
    const fits = isFinal
      ? body.byteLength <= partSize
      : body.byteLength === partSize;
    if (!fits) {
      return new Response("Part length does not match the signed layout", {
        status: 400,
      });
    }

    const resumed = this.#env.BUCKET.resumeMultipartUpload(
      upload.ticket.storageKey,
      upload.uploadId,
    );
    const written = await resumed.uploadPart(partNumber, body);

    const parts = (await this.#state.storage.get<RecordedPart[]>("parts")) ?? [];
    // Keyed on the part number rather than appended: a part the browser
    // retried is the same part, and counting it twice would make an incomplete
    // upload look complete.
    const next = parts
      .filter((p) => p.partNumber !== partNumber)
      .concat({ partNumber, etag: written.etag });
    await this.#state.storage.put("parts", next);
    // Push the deadline out. An upload that keeps moving is never cut off,
    // however large the file; one that stops is judged dead this long after
    // its last part.
    await this.#state.storage.setAlarm(
      Date.now() + upload.ticket.alarmIdleSeconds * 1000,
    );

    return Response.json({ token: await this.#issueToken(upload) });
  }

  /**
   * Issue a token for the next part of this upload.
   * @param upload - What is open.
   * @returns The signed token.
   */
  async #issueToken(upload: OpenUpload): Promise<string> {
    return signSessionToken(
      {
        storageKey: upload.ticket.storageKey,
        uploadId: upload.uploadId,
        expiresAt: Date.now() + SESSION_TOKEN_TTL_MS,
      },
      this.#env.INGEST_SHARED_SECRET,
    );
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

    return Response.json({
      uploadId: upload.uploadId,
      token: await this.#issueToken(upload),
    });
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
