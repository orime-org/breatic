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
 * Kept because the alarm re-enters it, and each step is remembered on its own:
 * assembling the object and hashing it are two facts, and reading a completed
 * object back can fail by itself. A retry that lost only the hash asks R2 for
 * nothing it has already done, and one that lost only the report re-sends it
 * without reading a 2 GiB object back a second time.
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
  /**
   * What the server said the upload became. Kept so that asking to complete a
   * second time answers the same thing without a second report.
   */
  registered?: RegisteredAsset;
}

/** What the server answers a completed report with. */
interface RegisteredAsset {
  /** Where the stored object is readable — the canonical URL a node pins. */
  fileUrl?: string;
  /** The asset kind the server filed it under. */
  kind?: string;
}

/**
 * Say how a finished upload ended.
 *
 * An abort answers 409 rather than 200: the parts that were written are gone,
 * so this upload will never become the object it was opened for and asking
 * again cannot change that.
 * @param progress - The settled, reported outcome.
 * @returns The answer to give the caller.
 */
function outcomeResponse(progress: FinishProgress): Response {
  if (progress.abortedReason !== undefined) {
    return Response.json(
      { outcome: "aborted", reason: progress.abortedReason },
      { status: 409 },
    );
  }
  return Response.json(progress.registered ?? {});
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
   * @throws {Error} When the server did not accept the outcome.
   */
  async alarm(): Promise<void> {
    const outcome = await this.#settleAndReport();
    if (outcome === "not_accepted") {
      // Cloudflare retries a failing alarm and reschedules nothing when one
      // returns, so failing here is the only way another attempt happens. The
      // node this upload belongs to sits in handling until the server hears
      // the outcome, and nothing but this will tell it.
      throw new Error("the server did not accept this upload's report");
    }
  }

  /**
   * Answer the browser asking to finish.
   *
   * The answer carries the outcome because one caller has no other way to hear
   * it: an upload with no node behind it — a focus crop — is not something the
   * server can tell through Yjs (design §9). An upload that does have a node
   * gets its answer that way and needs nothing from here.
   * @returns The outcome once the server has accepted it, 502 while it has not.
   */
  async #finish(): Promise<Response> {
    const outcome = await this.#settleAndReport();
    if (outcome === "gone") return new Response("Gone", { status: 410 });
    if (outcome === "not_accepted") {
      // The alarm is still set, so this upload gets another attempt whether or
      // not the browser makes one.
      return new Response("Report not accepted", { status: 502 });
    }
    return outcomeResponse(outcome);
  }

  /**
   * Settle the upload and tell the server, from wherever the last attempt got
   * to.
   *
   * Each step is persisted as it happens, so a re-entry redoes only what is
   * actually missing: an object R2 has already assembled is not assembled
   * again, and bytes already hashed are not read back a second time.
   * @returns The accepted outcome, or why there is not one.
   */
  async #settleAndReport(): Promise<FinishProgress | "gone" | "not_accepted"> {
    const upload = await this.#state.storage.get<OpenUpload>("upload");
    if (upload === undefined) return "gone";

    const stored: FinishProgress = (await this.#state.storage.get<FinishProgress>(
      "finish",
    )) ?? { settled: false, reported: false };
    if (stored.reported) return stored;

    const assembled = stored.settled
      ? stored
      : await this.#assemble(upload, stored);
    const settled =
      assembled.abortedReason === undefined && assembled.sha256 === undefined
        ? await this.#hash(upload, assembled)
        : assembled;

    const reported = await this.#report(upload, settled);
    if (reported === null) return "not_accepted";

    const done: FinishProgress = { ...settled, reported: true, registered: reported };
    await this.#state.storage.put("finish", done);
    await this.#state.storage.deleteAlarm();
    return done;
  }

  /**
   * Assemble the object if every part arrived, otherwise drop what was written.
   *
   * Counting is enough because a non-final part is only accepted at exactly
   * `partSize` and each part is recorded once under its own number, so the
   * count answers "is the file whole?" on its own.
   * @param upload - What is open.
   * @param progress - How far finishing has got.
   * @returns The progress after assembling, already persisted.
   */
  async #assemble(
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
    // Recorded before the hash is taken. Reading the object back can fail on
    // its own, and R2 refuses to assemble an upload it has already assembled.
    const assembled: FinishProgress = {
      ...progress,
      settled: true,
      sizeBytes: object.size,
    };
    await this.#state.storage.put("finish", assembled);
    return assembled;
  }

  /**
   * Hash the assembled object and remember what came out.
   * @param upload - What is open.
   * @param progress - The assembled progress.
   * @returns The progress carrying the hash, already persisted.
   * @throws {Error} When the object is not readable, which fails the alarm.
   */
  async #hash(
    upload: OpenUpload,
    progress: FinishProgress,
  ): Promise<FinishProgress> {
    const hashed: FinishProgress = {
      ...progress,
      sha256: await this.#hashStored(upload.ticket.storageKey),
    };
    await this.#state.storage.put("finish", hashed);
    return hashed;
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
   * @returns What the server filed, or null when it did not accept the report.
   */
  async #report(
    upload: OpenUpload,
    progress: FinishProgress,
  ): Promise<RegisteredAsset | null> {
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
      if (!response.ok) return null;
      // An answer we cannot read still means the server took it. The report is
      // what the outcome hinges on; the URL only serves the crop path, and
      // failing the whole upload over an unreadable body would strand a node
      // whose bytes are safely stored.
      const answer = await response
        .json<{ data?: RegisteredAsset }>()
        .catch(() => null);
      return answer?.data ?? {};
    } catch {
      // Unreachable server, DNS, TLS — all the same answer here: not accepted,
      // so the alarm keeps this upload alive for another try.
      return null;
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
   *
   * Its window comes off the ticket rather than from a figure held here: the
   * value lives in `config/storage.yaml`, which also checks it against the
   * idle window, and a copy in this Worker would be a second place for it to
   * drift out of that relation.
   * @param upload - What is open.
   * @returns The signed token.
   */
  async #issueToken(upload: OpenUpload): Promise<string> {
    return signSessionToken(
      {
        storageKey: upload.ticket.storageKey,
        uploadId: upload.uploadId,
        expiresAt: Date.now() + upload.ticket.sessionTokenTtlSeconds * 1000,
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
