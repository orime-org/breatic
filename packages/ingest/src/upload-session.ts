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
 * It does not watch the clock. An upload has two exits — the object was
 * assembled and the outcome reported, or a step failed and that was reported —
 * and how long it took is neither of them (design §6.3). A task's lifetime
 * belongs to the timer Durable Object, which knows nothing about this chain.
 * The parts an abandoned upload leaves behind are expired by the bucket's own
 * lifecycle rule seven days after the upload started.
 *
 * The bytes do not pass through here either. A Durable Object bills wall-clock
 * time against a fixed 128 MB, so waiting on a slow network inside one is paid
 * for at that rate; the Worker holds the part and calls R2, and what arrives
 * here is the one line that says a part landed (design §6.1).
 *
 * Cloudflare runs each instance single-threaded, so the state read at the top
 * of a handler is still true when it writes at the bottom. That is what makes
 * "open it if nobody has, otherwise hand back what is already open" a decision
 * rather than a race.
 */

import { completeRetryBudgetMs } from "@breatic/shared";
import type { UploadTicketPayload } from "@breatic/shared";
import { partLayoutRefusal } from "@ingest/part-layout.js";
import { signSessionToken } from "@ingest/session-token.js";

/**
 * How long to wait before delivering an outcome the server did not take.
 *
 * A retry rhythm rather than a verdict: the bytes are stored and the outcome
 * is decided, and the node counts this task as running until the server hears
 * it. Held here rather than in `config/storage.yaml` because it names nothing
 * an operator tunes about uploads — it is how often this instance knocks.
 */
const REPORT_RETRY_MS = 30_000;

/** What the instance remembers about an upload while it is open. */
interface OpenUpload {
  /** The ticket that opened it; the part layout and the deadlines come from here. */
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
  /** R2 has assembled the object. */
  settled: boolean;
  /** What was computed over the stored bytes, once it has been.  */
  sha256?: string;
  /** What the assembled object weighs. */
  sizeBytes?: number;
  /** Why it was given up on, when it was. */
  abortedReason?: string;
  /**
   * The server has answered for good; nothing more is owed. True whether it
   * took the outcome or refused it — a refusal is the server having read the
   * report and acted on it, which asking again cannot change.
   */
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

/** What the server did with a report. */
type ReportAnswer = RegisteredAsset | "refused" | "unavailable";

/** Why finishing did not produce an outcome. */
interface StillIncomplete {
  /** Which parts are still owed, in the words the caller is given. */
  missing: string;
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
  // A refusal ends the upload the same way an abort does — the server will
  // never register this object, and asking again cannot change that — so it
  // gets the same answer. Only a report the server accepted leaves `registered`
  // behind, which is what tells the two apart.
  if (progress.abortedReason !== undefined || progress.registered === undefined) {
    return Response.json(
      { outcome: "aborted", ...(progress.abortedReason !== undefined && { reason: progress.abortedReason }) },
      { status: 409 },
    );
  }
  return Response.json(progress.registered);
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
      return this.#part(
        Number(part[1]),
        await request.json<{ etag: string | null; sizeBytes: number }>(),
      );
    }
    if (pathname === "/complete") {
      return this.#finish();
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * The alarm going off.
   *
   * The only clock this instance keeps, and it is a retry rhythm rather than a
   * verdict on the upload (design §6.3). Two jobs, told apart by whether the
   * server has answered: before it, deliver the outcome again; after it, the
   * instance has been holding that answer for anyone who asks, and this is the
   * end of that window.
   * @throws {Error} When the server did not answer.
   */
  async alarm(): Promise<void> {
    const stored = await this.#state.storage.get<FinishProgress>("finish");
    if (stored?.reported === true) {
      // Nobody is going to ask about this upload again. One instance per
      // upload and uploads never stop arriving, so what it holds — the ticket,
      // the part list, the outcome — is worth nothing from here on.
      await this.#state.storage.deleteAll();
      return;
    }

    const outcome = await this.#settleAndReport();
    if (outcome === "not_accepted") {
      // Cloudflare retries a failing alarm, so failing here is what buys the
      // next attempt beyond the one `#settleAndReport` scheduled. The node
      // this upload belongs to counts it as running until the server hears the
      // outcome, and nothing but this will tell it.
      //
      // Named, because the retries are finite: after the last one this upload
      // has nobody left, and the message is what says which one it was.
      const upload = await this.#state.storage.get<OpenUpload>("upload");
      throw new Error(
        `the server did not answer for ${upload?.ticket.storageKey ?? "an unknown upload"}`,
      );
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
      // `#settleAndReport` armed the next attempt, so this upload reaches the
      // server whether or not the browser asks again.
      return new Response("Report not accepted", { status: 502 });
    }
    if ("missing" in outcome) {
      // Not an outcome. The upload is still open and the parts that have not
      // arrived still can, so nothing is dropped and the server hears nothing.
      return new Response(outcome.missing, { status: 409 });
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
  async #settleAndReport(): Promise<
    FinishProgress | StillIncomplete | "gone" | "not_accepted"
  > {
    const upload = await this.#state.storage.get<OpenUpload>("upload");
    if (upload === undefined) return "gone";

    const stored: FinishProgress = (await this.#state.storage.get<FinishProgress>(
      "finish",
    )) ?? { settled: false, reported: false };
    if (stored.reported) return stored;

    const assembled = stored.settled
      ? stored
      : await this.#assemble(upload, stored);
    if ("missing" in assembled) return assembled;
    const settled =
      assembled.abortedReason === undefined && assembled.sha256 === undefined
        ? await this.#hash(upload, assembled)
        : assembled;

    const answer = await this.#report(upload, settled);
    if (answer === "unavailable") {
      // The one clock this instance keeps. The outcome is decided and the
      // bytes are stored; what is left is saying so, and the node counts this
      // task as running until the server hears it.
      await this.#state.storage.setAlarm(Date.now() + REPORT_RETRY_MS);
      return "not_accepted";
    }

    const done: FinishProgress = {
      ...settled,
      reported: true,
      ...(answer !== "refused" && { registered: answer }),
    };
    await this.#state.storage.put("finish", done);
    // Not deleted: the answer stays available for as long as a browser can
    // still be asking for it, which is its transport's whole redelivery
    // budget. The crop path reads its entire result off that response. The
    // alarm that ends the window is also what lets this instance go.
    await this.#state.storage.setAlarm(Date.now() + completeRetryBudgetMs());
    return done;
  }

  /**
   * Assemble the object, once every part has arrived.
   *
   * Counting is enough because a non-final part is only recorded at exactly
   * `partSize` and each part is recorded once under its own number, so the
   * count answers "is the file whole?" on its own.
   *
   * An upload still short of parts is said to be short, and left alone: the
   * ones that have not arrived still can, and this instance judges nothing by
   * how long that takes (design §6.3).
   * @param upload - What is open.
   * @param progress - How far finishing has got.
   * @returns The progress after assembling, already persisted, or what is owed.
   */
  async #assemble(
    upload: OpenUpload,
    progress: FinishProgress,
  ): Promise<FinishProgress | StillIncomplete> {
    const parts = (await this.#state.storage.get<RecordedPart[]>("parts")) ?? [];

    if (parts.length < upload.ticket.totalParts) {
      return {
        missing: `only ${parts.length} of ${upload.ticket.totalParts} parts have arrived`,
      };
    }

    const resumed = this.#env.BUCKET.resumeMultipartUpload(
      upload.ticket.storageKey,
      upload.uploadId,
    );
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
   * A 4xx is the server having decided rather than the server being unwell: it
   * read the report, acted on it — voiding the grant and telling the node —
   * and refused. Asking again gets the same answer, so it ends this upload as
   * surely as an acceptance does. Anything else leaves the outcome unsaid.
   * @param upload - What was uploaded, carrying the context the server reads back.
   * @param progress - The settled outcome.
   * @returns What the server filed, its refusal, or that it did not answer.
   */
  async #report(
    upload: OpenUpload,
    progress: FinishProgress,
  ): Promise<ReportAnswer> {
    const body =
      progress.abortedReason === undefined
        ? {
            storage_key: upload.ticket.storageKey,
            outcome: "completed",
            sha256: progress.sha256,
            size_bytes: progress.sizeBytes,
            content_type: upload.ticket.contentType,
          }
        : {
            storage_key: upload.ticket.storageKey,
            outcome: "aborted",
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
      // Two 4xx say nothing about this upload, because nothing on our side
      // read the report: 401 when the shared secret did not match, 429 when
      // something in front of the server — a CDN, a reverse proxy, a gateway —
      // turned the request away before it arrived. Both leave the same next
      // attempt open, so both are the server being unreachable rather than the
      // server deciding. Every other one in the range is the server having
      // read it and decided.
      if (response.status === 401 || response.status === 429) {
        return "unavailable";
      }
      if (response.status >= 400 && response.status < 500) return "refused";
      if (!response.ok) return "unavailable";
      // An answer we cannot read still means the server took it. The report is
      // what the outcome hinges on; the URL only serves the crop path, and
      // failing the whole upload over an unreadable body would strand a node
      // whose bytes are safely stored.
      const answer = await response
        .json<{ data?: RegisteredAsset }>()
        .catch(() => null);
      return answer?.data ?? {};
    } catch {
      // Unreachable server, DNS, TLS — all the same answer here: nothing was
      // said, so the alarm keeps this upload alive for another try.
      return "unavailable";
    }
  }

  /**
   * Record one part the Worker wrote, once it fits the signed layout.
   *
   * The bytes went to R2 from the Worker, and what arrives here is the line
   * that says so. The Worker judged the layout before it wrote, which is the
   * only moment the bound can still stop the bytes; this judges it again
   * before recording, because "have they all arrived?" is answered by counting
   * these rows and that only holds while every non-final row is exactly one
   * part long.
   * @param partNumber - Which part this is, one-based.
   * @param written - What R2 gave the Worker back for it.
   * @param written.etag - R2's tag for the stored part, or null when R2 would
   *   not take it — which this instance is the one that can explain.
   * @param written.sizeBytes - What the Worker sent, checked against the layout.
   * @returns A token for the next part, or why this one was refused.
   */
  async #part(
    partNumber: number,
    written: { etag: string | null; sizeBytes: number },
  ): Promise<Response> {
    const upload = await this.#state.storage.get<OpenUpload>("upload");
    if (upload === undefined) return new Response("Gone", { status: 410 });

    // Settled means R2 has assembled the object. There is no multipart upload
    // left to write into, and saying so is the difference between a caller
    // that can act on the answer and one that reads whatever R2 threw.
    const finish = await this.#state.storage.get<FinishProgress>("finish");
    if (finish?.settled === true) {
      return new Response("This upload has already finished", { status: 409 });
    }

    const refusal = partLayoutRefusal(
      partNumber,
      written.sizeBytes,
      upload.ticket,
    );
    if (refusal !== null) return new Response(refusal, { status: 400 });

    if (written.etag === null) {
      // Neither gone nor settled, so the layout holds and R2 still refused it.
      // Nothing here explains that, and saying so is better than recording a
      // part that never landed.
      return new Response("R2 would not take this part", { status: 502 });
    }

    const parts = (await this.#state.storage.get<RecordedPart[]>("parts")) ?? [];
    // Keyed on the part number rather than appended: a part the browser
    // retried is the same part, and counting it twice would make an incomplete
    // upload look complete.
    const next = parts
      .filter((p) => p.partNumber !== partNumber)
      .concat({ partNumber, etag: written.etag });
    await this.#state.storage.put("parts", next);

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
        partSize: upload.ticket.partSize,
        totalParts: upload.ticket.totalParts,
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
    return upload;
  }
}
