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
import { partLayoutRefusal } from "@ingest/part-layout.js";
import {
  assembleObject,
  hashStoredObject,
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
 * Its window comes off the ticket rather than from a figure held here: the
 * value lives in `config/storage.yaml`, which also checks it against the other
 * windows, and a copy in this Worker would be a second place for it to drift
 * out of that relation.
 * @param ticket - The verified ticket.
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
    .catch(() => null);
  if (written === null) {
    return new Response("This upload is no longer open", { status: 410 });
  }

  return Response.json({
    partNumber,
    etag: written.etag,
    token: await issueToken(
      { ...session, sessionTokenTtlSeconds: tokenTtlSecondsOf(session) },
      uploadId,
      env.INGEST_SHARED_SECRET,
    ),
  });
}

/**
 * How long the next token should last, taken from the one presented.
 *
 * The window was decided when the ticket was signed and travels forward with
 * every re-issue, so a long upload never needs a longer-lived credential and
 * this Worker never holds a second copy of the figure.
 * @param session - The token this request presented.
 * @returns The window, in seconds.
 */
function tokenTtlSecondsOf(session: SessionTokenPayload): number {
  return Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
}

/** What the browser hands back to finish an upload. */
interface FinishBody {
  parts?: RecordedPart[];
}

/** What our server answers a claim with. */
interface ClaimAnswer {
  granted: boolean;
  reason?: "no_grant" | "in_flight" | "already_registered";
  result?: unknown;
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
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  const answer = await response
    .json<{ data?: ClaimAnswer }>()
    .catch(() => null);
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
  for (const part of parts) {
    // A part's own size is not in the list, so the length the layout would
    // judge is the one it signed for that position.
    const isFinal = part.partNumber === session.totalParts;
    const refusal = partLayoutRefusal(
      part.partNumber,
      isFinal ? 1 : session.partSize,
      session,
    );
    if (refusal !== null) return new Response(refusal, { status: 400 });
  }
  if (parts.length !== session.totalParts) {
    return new Response(
      `Cannot finish with ${parts.length} of ${session.totalParts} parts`,
      { status: 409 },
    );
  }

  const claim = await claimFinalize(env, session.storageKey, uploadId);
  if (claim === null) {
    return new Response("Could not reach the server", { status: 502 });
  }
  if (!claim.granted) {
    if (claim.reason === "already_registered") {
      // The bytes this would write are the ones already described, so writing
      // them again is the overwrite the permission exists to stop. What the
      // ledger holds is what the browser gets.
      return Response.json({ data: claim.result ?? {} });
    }
    return new Response(
      claim.reason === "no_grant"
        ? "No grant for this key"
        : "Another delivery is finishing this upload",
      { status: claim.reason === "no_grant" ? 403 : 409 },
    );
  }

  const assembled = await assembleObject(
    env.BUCKET,
    session.storageKey,
    uploadId,
    parts,
  )
    .then((sizeBytes) => ({ sizeBytes }))
    .catch(() => null);
  if (assembled === null) {
    await reportOutcome(env, {
      storage_key: session.storageKey,
      outcome: "aborted",
      reason: "assembly failed",
    });
    return new Response("Could not assemble the object", { status: 502 });
  }

  const sha256 = await hashStoredObject(env.BUCKET, session.storageKey).catch(
    () => null,
  );
  if (sha256 === null) {
    await reportOutcome(env, {
      storage_key: session.storageKey,
      outcome: "aborted",
      reason: "hashing failed",
    });
    return new Response("Could not hash the object", { status: 502 });
  }

  const reported = await reportOutcome(env, {
    storage_key: session.storageKey,
    outcome: "completed",
    sha256,
    size_bytes: assembled.sizeBytes,
    content_type: session.contentType,
  });
  if (reported === null) {
    // The bytes are in R2 and nothing describes them. This delivery did not
    // finish, and retrying it is the browser's to do (design §6.6).
    return new Response("The server did not take the report", { status: 502 });
  }
  return Response.json({ data: reported });
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
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  const answer = await response
    .json<{ data?: unknown }>()
    .catch(() => null);
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
