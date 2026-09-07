// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ingest Worker: where the browser's bytes go (#173, design §4).
 *
 * It sits between the browser and R2 because someone has to hash what
 * actually landed. The browser's own claim about the content decides only
 * whether to move bytes at all; what gets written into the ledger has to be
 * computed over the stored object, and computing it here means reading the
 * object back inside Cloudflare's network, where egress is free.
 *
 * It is authorised entirely by what our server signed. The Worker holds no
 * database and asks us nothing: a ticket carries the key, the studio, the part
 * layout and the deadlines, all under one HMAC, so every check it performs is
 * against values the browser cannot alter.
 */

import { verifyUploadTicket } from "@breatic/shared";
import { partLayoutRefusal, partListRefusal } from "@ingest/part-layout.js";
import {
  assembleObject,
  hashStoredObject,
  writeStreamAsParts,
  type RecordedPart,
} from "@ingest/stored-object.js";
import {
  signSessionToken,
  verifySessionToken,
  type SessionTokenPayload,
} from "@ingest/session-token.js";

/**
 * `/uploads/{uploadId}/parts/{n}`. The part number is captured as digits so
 * a path that is not a number never reaches the layout check as NaN.
 */
const PART_PATH = /^\/uploads\/([^/]+)\/parts\/(\d+)$/;

/**
 * What a part sends beyond a simple request. The browser preflights on account
 * of these, and will not send the bytes if the answer does not list them.
 */
const ALLOWED_HEADERS = "content-type, x-upload-ticket, x-upload-token";

/** The methods the three endpoints use. */
const ALLOWED_METHODS = "POST, PUT, OPTIONS";

/** `/uploads/{uploadId}/complete`. */
const COMPLETE_PATH = /^\/uploads\/([^/]+)\/complete$/;

/** What wrangler binds into the Worker. */
export interface Env {
  BUCKET: R2Bucket;
  /** Signs the ticket we verify, and authenticates what we send back. */
  INGEST_SHARED_SECRET: string;
  /** Where an upload's outcome is reported. */
  SERVER_REPORT_URL: string;
  /** Where the exclusive permission to finish a key is asked for. */
  SERVER_CLAIM_URL: string;
  /** Comma-separated origins the browser may send parts from. */
  ALLOWED_ORIGINS: string;
}

/**
 * The settings this Worker cannot run without, each filled in by hand: the
 * vars and the bucket binding from `wrangler.toml` (copied from its template),
 * the secret from `.dev.vars` locally and `wrangler secret put` on a
 * deployment.
 *
 * The binding is in here for the same reason the vars are: a binding whose
 * name was typed differently in `wrangler.toml` than the code expects arrives
 * as nothing at all, and reading it throws somewhere far from the file that
 * has the typo.
 */
const REQUIRED_SETTINGS = [
  "INGEST_SHARED_SECRET",
  "SERVER_REPORT_URL",
  "SERVER_CLAIM_URL",
  "ALLOWED_ORIGINS",
  "BUCKET",
] as const;

/**
 * Which required settings this deployment is missing.
 *
 * An empty string counts as missing: a name present with nothing after the
 * equals sign is the same mistake as a name that was never added, and reading
 * it as configured turns it into a puzzle further down.
 * @param env - The bound resources and configuration.
 * @returns The names of the settings that have no value.
 */
function missingSettings(env: Env): string[] {
  return REQUIRED_SETTINGS.filter((name) => !env[name]);
}

/**
 * Issue the token the next request carries.
 *
 * Its window comes off whatever was presented — the ticket on the first one,
 * the previous token on every re-issue — rather than from a figure held here:
 * the value lives in `config/storage.yaml`, which also checks it against the
 * other windows, and a copy in this Worker would be a second place for it to
 * drift out of that relation.
 *
 * Every issue starts the window over. It is sized for the gap between two
 * parts, and carrying the remaining life forward instead would make that same
 * figure a ceiling on the whole upload.
 * @param grant - What the ticket or the presented token signed.
 * @param uploadId - R2's id for the multipart upload.
 * @param secret - The shared secret.
 * @returns The signed token.
 */
async function issueToken(
  grant: {
    storageKey: string;
    contentType: string;
    partSize: number;
    totalParts: number;
    sessionTokenTtlSeconds: number;
  },
  uploadId: string,
  secret: string,
): Promise<string> {
  return signSessionToken(
    {
      storageKey: grant.storageKey,
      uploadId,
      contentType: grant.contentType,
      sessionTokenTtlSeconds: grant.sessionTokenTtlSeconds,
      expiresAt: Date.now() + grant.sessionTokenTtlSeconds * 1000,
      partSize: grant.partSize,
      totalParts: grant.totalParts,
    },
    secret,
  );
}

/**
 * Open an upload: verify the ticket, ask R2 for a multipart upload, and hand
 * back what the browser has to hold on to.
 *
 * Nothing is recorded on this side. What one upload needs remembered is its
 * upload id and the parts that landed, and the browser carries both back with
 * every request — which is how Cloudflare's own multipart example works:
 * "the state of the multipart upload is tracked in the client application
 * which sends requests to the Worker".
 * @param request - The browser's request, carrying the ticket in a header.
 * @param env - The Worker's bindings.
 * @returns The upload id and the first token, or 401 when the ticket does not
 *   verify.
 */
async function startUpload(request: Request, env: Env): Promise<Response> {
  const ticket = request.headers.get("x-upload-ticket");
  if (ticket === null) return new Response("Unauthorized", { status: 401 });

  const verified = await verifyUploadTicket(
    ticket,
    env.INGEST_SHARED_SECRET,
    Date.now(),
  );
  if (!verified.ok) return new Response("Unauthorized", { status: 401 });

  const created = await env.BUCKET.createMultipartUpload(
    verified.payload.storageKey,
    // Set now rather than at completion: R2 takes the object's metadata from
    // the upload it was created under, and without it a public read answers
    // application/octet-stream whatever the file actually is.
    { httpMetadata: { contentType: verified.payload.contentType } },
  );

  return Response.json({
    uploadId: created.uploadId,
    token: await issueToken(
      verified.payload,
      created.uploadId,
      env.INGEST_SHARED_SECRET,
    ),
  });
}

/**
 * The session this request may write into, or null when it may write into none.
 *
 * One place decides it for both endpoints that take bytes. The upload id is
 * inside the signature as well as in the path, so a token names the one upload
 * it opened rather than any upload at all.
 * @param request - The incoming request.
 * @param env - The bound resources and configuration.
 * @param uploadId - The upload named in the path.
 * @returns The verified session, or null when this caller may not write here.
 */
async function authorizedSession(
  request: Request,
  env: Env,
  uploadId: string,
): Promise<SessionTokenPayload | null> {
  const token = request.headers.get("x-upload-token");
  if (token === null) return null;
  const session = await verifySessionToken(
    token,
    env.INGEST_SHARED_SECRET,
    Date.now(),
  );
  return session !== null && session.uploadId === uploadId ? session : null;
}

/**
 * Write one part to R2 and hand its receipt back.
 *
 * The layout is judged here, before the write: this is the last point at which
 * a part outside what the ticket signed can still be stopped from costing
 * anything. What comes back is the line the browser has to keep — the part
 * number and R2's etag for it — because finishing needs the whole list and
 * nothing here is holding one.
 * @param request - The browser's request, carrying the token and the bytes.
 * @param env - The Worker's bindings.
 * @param uploadId - The upload from the path.
 * @returns The part's receipt and a fresh token, or why the part was refused.
 */
async function uploadPart(
  request: Request,
  env: Env,
  uploadId: string,
  partNumber: number,
): Promise<Response> {
  const session = await authorizedSession(request, env, uploadId);
  if (session === null) return new Response("Unauthorized", { status: 401 });

  const body = await request.arrayBuffer();

  // Judged before the write, because this is the last moment it can stop one.
  // R2 takes part numbers far past the layout and any length its own floor
  // allows, so a part refused after the write is a part already written and
  // already paid for — and the layout is what bounds an upload to the bytes
  // its ticket authorised. The token carries it, signed, so holding that
  // bound here costs no lookup and the browser cannot widen it.
  const refusal = partLayoutRefusal(partNumber, body.byteLength, session);
  if (refusal !== null) return new Response(refusal, { status: 400 });

  // R2 throws for a part it will not take, and the reason is a fact about this
  // upload rather than about the request: it was already assembled, or it was
  // never opened. Either way there is nothing left for this part to join.
  const written = await env.BUCKET.resumeMultipartUpload(
    session.storageKey,
    uploadId,
  )
    .uploadPart(partNumber, body)
    .catch(noted("ingest_part_write_failed", {
      storageKey: session.storageKey,
      uploadId,
      partNumber,
    }));
  if (written === null) {
    return new Response("This upload is no longer open", { status: 410 });
  }

  return Response.json({
    partNumber,
    etag: written.etag,
    token: await issueToken(session, uploadId, env.INGEST_SHARED_SECRET),
  });
}

/** What the browser hands back to finish an upload. */
interface FinishBody {
  parts?: RecordedPart[];
}

/**
 * Write down a failure this Worker turns into an answer of its own.
 *
 * The answer says what the browser can do about it; the reason it happened
 * exists nowhere else. Without this an operator cannot tell a wrong URL from a
 * refused claim from R2 turning an assembly down — every one of them reads as
 * the same 502 in Cloudflare's logs.
 * @param label - What failed, as one searchable token.
 * @param ctx - The key, ids and status that name this attempt.
 */
function noteFailure(label: string, ctx: Record<string, unknown>): void {
  console.error(label, ctx);
}

/**
 * Turn a rejected promise into null, writing down what it was.
 * @param label - What failed, as one searchable token.
 * @param ctx - The key and ids that name this attempt.
 * @returns A catch handler answering null.
 */
function noted(
  label: string,
  ctx: Record<string, unknown>,
): (err: unknown) => null {
  return (err: unknown): null => {
    noteFailure(label, {
      ...ctx,
      err: err instanceof Error ? err.stack : String(err),
    });
    return null;
  };
}

/** What our server answers a claim with. */
interface ClaimAnswer {
  granted: boolean;
  reason?: "no_grant" | "in_flight" | "already_registered";
}

/**
 * Ask our server whether this upload may finish on this key (design §6.4).
 * @param env - The Worker's bindings.
 * @param storageKey - The key being finished.
 * @param uploadId - The multipart upload this Worker holds.
 * @returns The verdict, or null when the server could not be reached.
 */
async function claimFinalize(
  env: Env,
  storageKey: string,
  uploadId: string,
): Promise<ClaimAnswer | null> {
  const response = await fetch(env.SERVER_CLAIM_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": env.INGEST_SHARED_SECRET,
    },
    body: JSON.stringify({ storage_key: storageKey, upload_id: uploadId }),
  }).catch(noted("ingest_claim_unreachable", { storageKey, uploadId }));
  if (response === null) return null;
  if (!response.ok) {
    noteFailure("ingest_claim_refused", {
      storageKey,
      uploadId,
      status: response.status,
    });
    return null;
  }
  const answer = await response
    .json<{ data?: ClaimAnswer }>()
    .catch(noted("ingest_claim_unreadable", { storageKey, uploadId }));
  return answer?.data ?? null;
}

/**
 * Finish the upload: check the list, take the permission, assemble, hash and
 * report.
 *
 * The list comes back from the browser, so it is judged against the layout
 * this Worker's own token signed — every part inside the bound, and as many of
 * them as the ticket said there would be. A short list is a refusal rather
 * than an outcome: the upload is still open and sending the missing part
 * finishes it.
 *
 * The permission is taken before R2 is touched, because what it stops is a
 * write: a replayed ticket opening a second multipart upload over a key the
 * ledger already describes.
 * @param request - The browser's request, carrying the token and the parts.
 * @param env - The Worker's bindings.
 * @param uploadId - The upload from the path.
 * @returns The outcome, or why it was refused.
 */
async function completeUpload(
  request: Request,
  env: Env,
  uploadId: string,
): Promise<Response> {
  const session = await authorizedSession(request, env, uploadId);
  if (session === null) return new Response("Unauthorized", { status: 401 });

  const body = (await request.json<FinishBody>().catch(() => null)) ?? {};
  const parts = body.parts ?? [];
  const refusal = partListRefusal(parts, session);
  if (refusal !== null) return new Response(refusal, { status: 400 });
  if (parts.length !== session.totalParts) {
    return new Response(
      `Cannot finish with ${parts.length} of ${session.totalParts} parts`,
      { status: 409 },
    );
  }

  return finishUpload(env, {
    storageKey: session.storageKey,
    uploadId,
    contentType: session.contentType,
    parts,
  });
}

/**
 * Take the permission, assemble, hash and report.
 *
 * Both ways bytes reach R2 end here — the browser sending parts, and this
 * Worker fetching a URL — because everything after the last byte lands is the
 * same for either: what the ledger records is computed over the stored object,
 * so how it got there stops mattering.
 *
 * The permission is taken before R2 is touched, because what it stops is a
 * write: a replayed ticket opening a second multipart upload over a key the
 * ledger already describes.
 * @param env - The Worker's bindings.
 * @param upload - What was written.
 * @param upload.storageKey - The key it was written to.
 * @param upload.uploadId - R2's id for the multipart upload.
 * @param upload.contentType - What the ticket signed for these bytes.
 * @param upload.parts - Every part R2 accepted.
 * @returns What the server registered, or why this could not finish.
 */
async function finishUpload(
  env: Env,
  upload: {
    storageKey: string;
    uploadId: string;
    contentType: string;
    parts: RecordedPart[];
  },
): Promise<Response> {
  const { storageKey, uploadId, contentType, parts } = upload;

  const claim = await claimFinalize(env, storageKey, uploadId);
  if (claim === null) {
    return new Response("Could not reach the server", { status: 502 });
  }
  if (!claim.granted) {
    if (claim.reason === "no_grant") {
      return new Response("No grant for this key", { status: 403 });
    }
    // Some other multipart upload holds this key — which is what a replayed
    // ticket looks like, since it had to open one of its own. Completing it
    // would write over what the ledger already describes.
    return new Response(
      claim.reason === "already_registered"
        ? "This key is already registered"
        : "Another delivery is finishing this upload",
      { status: 409 },
    );
  }

  const assembled = await assembleObject(env.BUCKET, storageKey, uploadId, parts)
    .then((sizeBytes) => ({ sizeBytes }))
    .catch(noted("ingest_assemble_failed", {
      storageKey,
      uploadId,
      parts: parts.length,
    }));
  if (assembled === null) {
    await reportOutcome(env, {
      storage_key: storageKey,
      outcome: "aborted",
      reason: "assembly failed",
    });
    return new Response("Could not assemble the object", { status: 502 });
  }

  const sha256 = await hashStoredObject(env.BUCKET, storageKey).catch(
    noted("ingest_hash_failed", { storageKey }),
  );
  if (sha256 === null) {
    await reportOutcome(env, {
      storage_key: storageKey,
      outcome: "aborted",
      reason: "hashing failed",
    });
    return new Response("Could not hash the object", { status: 502 });
  }

  const reported = await reportOutcome(env, {
    storage_key: storageKey,
    outcome: "completed",
    sha256,
    size_bytes: assembled.sizeBytes,
    content_type: contentType,
  });
  if (reported === null) {
    // The bytes are in R2 and nothing describes them. This delivery did not
    // finish, and retrying it is the caller's to do (design §6.6).
    return new Response("The server did not take the report", { status: 502 });
  }
  // Flat, the way opening an upload and writing a part answer. What the
  // server registered is already the payload of its own envelope; wrapping it
  // again would leave the caller reading `fileUrl` off a field that holds
  // another envelope.
  return Response.json(reported);
}

/** What the backend hands us to fetch. */
interface FetchBody {
  url?: string;
}

/**
 * Whether two secrets are the same, without leaking where they diverge.
 * @param a - One secret.
 * @param b - The other.
 * @returns True when they match.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i += 1) {
    differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return differing === 0;
}

/**
 * Fetch a URL straight into R2 (#181, lane ③).
 *
 * An AIGC provider hands back a link that expires, and the bytes behind it
 * never need to touch our servers: pulling them here keeps them inside
 * Cloudflare's network, where the wait costs no CPU time and the egress is
 * free. Waiting is nearly all this does.
 *
 * It takes the shared secret as well as a ticket. A ticket alone authorises
 * the key being written to, which is all the other endpoints need — but this
 * one also makes the Worker fetch whatever address the body names, and every
 * browser holds a ticket. The secret is what only our own backend has.
 * @param request - The backend's request, carrying the ticket and the URL.
 * @param env - The Worker's bindings.
 * @returns What the server registered, or why the transfer did not finish.
 */
async function fetchIntoUpload(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-ingest-secret");
  if (secret === null || !secretsMatch(secret, env.INGEST_SHARED_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const ticket = request.headers.get("x-upload-ticket");
  if (ticket === null) return new Response("Unauthorized", { status: 401 });
  const verified = await verifyUploadTicket(
    ticket,
    env.INGEST_SHARED_SECRET,
    Date.now(),
  );
  if (!verified.ok) return new Response("Unauthorized", { status: 401 });
  const { storageKey, contentType, partSize, totalParts } = verified.payload;

  const body = await request.json<FetchBody>().catch(() => null);
  const source = body?.url;
  if (typeof source !== "string" || !source.startsWith("https://")) {
    return new Response("A https source url is required", { status: 400 });
  }

  const upstream = await fetch(source).catch(
    noted("ingest_source_unreachable", { storageKey }),
  );
  if (upstream === null || !upstream.ok || upstream.body === null) {
    if (upstream !== null && !upstream.ok) {
      noteFailure("ingest_source_refused", {
        storageKey,
        status: upstream.status,
      });
    }
    // Nothing was written, so the grant is voided rather than left for the
    // sweep, and the caller's task settles on this answer.
    await reportOutcome(env, {
      storage_key: storageKey,
      outcome: "aborted",
      reason: "source unreadable",
    });
    return new Response("Could not read the source", { status: 502 });
  }

  const created = await env.BUCKET.createMultipartUpload(storageKey, {
    httpMetadata: { contentType },
  });
  const written = await writeStreamAsParts(
    env.BUCKET,
    storageKey,
    created.uploadId,
    upstream.body,
    partSize,
    totalParts,
  ).catch(noted("ingest_source_write_failed", { storageKey }));
  if (written === null || written === "over_cap") {
    await reportOutcome(env, {
      storage_key: storageKey,
      outcome: "aborted",
      reason: written === "over_cap" ? "over cap" : "write failed",
    });
    return written === "over_cap"
      ? new Response("The source is larger than this ticket allows", {
          status: 413,
        })
      : new Response("Could not store the source", { status: 502 });
  }

  return finishUpload(env, {
    storageKey,
    uploadId: created.uploadId,
    contentType,
    parts: written,
  });
}

/**
 * Tell our server how an upload went.
 * @param env - The Worker's bindings.
 * @param body - The report.
 * @returns What the server registered, or null when it did not take it.
 */
async function reportOutcome(
  env: Env,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  const response = await fetch(env.SERVER_REPORT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": env.INGEST_SHARED_SECRET,
    },
    body: JSON.stringify(body),
  }).catch(noted("ingest_report_unreachable", { report: body }));
  if (response === null) return null;
  if (!response.ok) {
    noteFailure("ingest_report_refused", {
      report: body,
      status: response.status,
    });
    return null;
  }
  const answer = await response
    .json<{ data?: unknown }>()
    .catch(noted("ingest_report_unreadable", { report: body }));
  return answer?.data ?? {};
}

/**
 * The origin to echo back, or null when the caller is not one we serve.
 *
 * Echoed rather than answered with `*`, because `*` and a specific origin are
 * not interchangeable to a browser: the wildcard is refused outright once a
 * request carries credentials, and a page that has to re-check its own origin
 * against a wildcard cannot.
 * @param request - The incoming request.
 * @param env - The Worker's bindings.
 * @returns The allowed origin, or null.
 */
function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  // Absent when that is the very setting missing; nothing is then allowed.
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
  return allowed.includes(origin) ? origin : null;
}

/**
 * Put the cross-origin headers on a response.
 *
 * `Vary: Origin` on every answer, allowed or not: caches key on it, and a
 * preflight answered from another origin's cached response is how a page that
 * should have been refused gets in.
 * @param response - What the route produced.
 * @param origin - The allowed origin, or null.
 * @returns The response with its headers set.
 */
function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.append("Vary", "Origin");
  if (origin !== null) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  /**
   * Route one request.
   * @param request - The incoming request.
   * @param env - The bound resources and configuration.
   * @param ctx - The execution context, for work that outlives the response.
   * @returns The response.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;

    const origin = allowedOrigin(request, env);

    // Answered before the configuration is judged. A refused preflight is a
    // CORS error in the browser, which says nothing about what is wrong here;
    // an allowed one lets the request through to the 500 below, which names it.
    if (request.method === "OPTIONS") {
      const preflight = new Response(null, { status: 204 });
      if (origin !== null) {
        preflight.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
        preflight.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        preflight.headers.set("Access-Control-Max-Age", "86400");
      }
      return withCors(preflight, origin);
    }

    // Before anything reads a binding. Every one of these comes from a file
    // somebody fills in by hand, so a missing one is ordinary — and saying
    // which one is the difference between a one-line fix and a hunt through a
    // stack trace. It goes out through the same headers as any other answer,
    // because a cross-origin caller cannot read a response without them.
    const missing = missingSettings(env);
    if (missing.length > 0) {
      return withCors(
        new Response(
          `This Worker is missing configuration: ${missing.join(", ")}. ` +
            "See packages/ingest/README.md.",
          { status: 500 },
        ),
        origin,
      );
    }

    return withCors(await answer(request, env), origin);
  },
} satisfies ExportedHandler<Env>;

/**
 * Run the route and turn anything it throws into an answer.
 *
 * An escaping exception is answered by the runtime, whose 500 carries none of
 * the headers added above — and a cross-origin caller cannot read a response
 * without them, so the browser reports a network failure and the status saying
 * this was ours to fix never arrives.
 * @param request - The incoming request.
 * @param env - The bound resources and configuration.
 * @returns The endpoint's response, or a 500.
 */
async function answer(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env);
  } catch (err) {
    // Written here because catching it is what takes it off Cloudflare's own
    // error reporting: what that shows is the exceptions nobody handled. A 500
    // with nothing behind it is all anyone would have to go on otherwise.
    console.error("ingest_request_failed", {
      url: request.url,
      method: request.method,
      err: err instanceof Error ? err.stack : String(err),
    });
    return new Response("Internal error", { status: 500 });
  }
}

/**
 * Match one request to its endpoint.
 * @param request - The incoming request.
 * @param env - The bound resources and configuration.
 * @returns The endpoint's response.
 */
async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === "POST" && pathname === "/uploads") {
    return startUpload(request, env);
  }

  if (request.method === "POST" && pathname === "/fetch") {
    return fetchIntoUpload(request, env);
  }

  const part = PART_PATH.exec(pathname);
  if (request.method === "PUT" && part) {
    return uploadPart(request, env, part[1] ?? "", Number(part[2]));
  }

  const finish = COMPLETE_PATH.exec(pathname);
  if (request.method === "POST" && finish) {
    return completeUpload(request, env, finish[1] ?? "");
  }

  return new Response("Not found", { status: 404 });
}
