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
  verifySessionToken,
  type SessionTokenPayload,
} from "@ingest/session-token.js";

export { UploadSession } from "@ingest/upload-session.js";
export { TaskTimer } from "@ingest/task-timer.js";

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
  UPLOAD_SESSION: DurableObjectNamespace;
  /** One instance per task, addressed by task id. Judges it dead (#186). */
  TASK_TIMER: DurableObjectNamespace;
  /** Signs the ticket we verify, and authenticates the report we send back. */
  INGEST_SHARED_SECRET: string;
  /** Where an upload's outcome is reported. */
  SERVER_REPORT_URL: string;
  /** Comma-separated origins the browser may send parts from. */
  ALLOWED_ORIGINS: string;
}

/**
 * The settings this Worker cannot run without, each filled in by hand: the two
 * vars and the two bindings from `wrangler.toml` (copied from its template),
 * the secret from `.dev.vars` locally and `wrangler secret put` on a
 * deployment.
 *
 * The bindings are in here for the same reason the vars are: a binding whose
 * name was typed differently in `wrangler.toml` than the code expects arrives
 * as nothing at all, and reading it throws somewhere far from the file that
 * has the typo.
 */
const REQUIRED_SETTINGS = [
  "INGEST_SHARED_SECRET",
  "SERVER_REPORT_URL",
  "ALLOWED_ORIGINS",
  "BUCKET",
  "UPLOAD_SESSION",
  "TASK_TIMER",
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
 * The instance holding one upload's bookkeeping.
 *
 * Addressed by storage key rather than by R2's `uploadId`, because the first
 * request has no upload id yet — the whole point of that request is to get
 * one, and getting the same one back on a retry needs somewhere to have
 * remembered it.
 * @param env - The Worker's bindings.
 * @param storageKey - The key this upload writes to.
 * @returns A stub for that upload's Durable Object.
 */
function sessionFor(env: Env, storageKey: string): DurableObjectStub {
  return env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(storageKey));
}

/**
 * Open an upload: verify the ticket, then let the Durable Object decide
 * whether this is a new upload or a retry of one already open.
 * @param request - The browser's request, carrying the ticket in a header.
 * @param env - The Worker's bindings.
 * @returns The instance's answer, or 401 when the ticket does not verify.
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

  // Everything past here depends on what happened before — whether this upload
  // is already open, already finishing, or already done — so the instance that
  // remembers decides it.
  return sessionFor(env, verified.payload.storageKey).fetch(
    new Request("https://session/open", {
      method: "POST",
      body: JSON.stringify(verified.payload),
    }),
  );
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
 * Write one part to R2 and tell the instance that owns this upload.
 *
 * The layout is judged here, before the write: this is the last point at
 * which a part outside what the ticket signed can still be stopped from
 * costing anything. The instance is told about a part only once R2 has been
 * asked to take it.
 * @param request - The browser's request, carrying the token and the bytes.
 * @param env - The Worker's bindings.
 * @param uploadId - The upload from the path.
 * @param partNumber - The part number from the path.
 * @returns A fresh token for the next part, or why the part was refused.
 */
async function uploadPart(
  request: Request,
  env: Env,
  uploadId: string,
  partNumber: number,
): Promise<Response> {
  const session = await authorizedSession(request, env, uploadId);
  if (session === null) return new Response("Unauthorized", { status: 401 });

  // Read from here rather than forwarded. A Durable Object is billed for
  // wall-clock time against a fixed 128 MB, so a slow network waited on inside
  // one is paid for at that rate; a Worker waiting on I/O is not billed for
  // the wait at all (design §6.1). What goes to the instance is the one line
  // that says this part landed.
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
  // never opened. The instance is what holds that, so a failed write is
  // reported like any other and answered from there.
  const etag = await env.BUCKET.resumeMultipartUpload(session.storageKey, uploadId)
    .uploadPart(partNumber, body)
    .then((written) => written.etag)
    .catch(() => null);

  return sessionFor(env, session.storageKey).fetch(
    new Request(`https://session/part/${partNumber}`, {
      method: "PUT",
      body: JSON.stringify({ etag, sizeBytes: body.byteLength }),
    }),
  );
}

/**
 * Finish the upload: assemble the object, hash it, and have the outcome told.
 *
 * The instance is asked twice. The first call answers 202 with the parts to
 * assemble, or with this upload's outcome when there is already one — 409
 * while parts are still owed, 410 for an upload it no longer holds, or what
 * the server registered. The second carries what assembling and hashing
 * produced, and its answer is the browser's.
 *
 * The two steps between them run here rather than in the instance. A Durable
 * Object is billed for wall-clock time against a fixed 128 MB, so reading a
 * multi-gigabyte object back inside one is paid for at that rate for as long
 * as the read takes (design §6.2).
 * @param request - The browser's request, carrying the session token.
 * @param env - The Worker's bindings.
 * @param uploadId - The upload from the path.
 * @returns The outcome, or 401 when the token does not verify.
 */
async function completeUpload(
  request: Request,
  env: Env,
  uploadId: string,
): Promise<Response> {
  const session = await authorizedSession(request, env, uploadId);
  if (session === null) return new Response("Unauthorized", { status: 401 });

  const instance = sessionFor(env, session.storageKey);
  const plan = await instance.fetch(
    new Request("https://session/finish", { method: "POST" }),
  );
  if (plan.status !== 202) return plan;

  const { storageKey, parts } = await plan.json<{
    storageKey: string;
    parts: RecordedPart[];
  }>();
  const sizeBytes = await assembleObject(
    env.BUCKET,
    storageKey,
    uploadId,
    parts,
  );
  const sha256 = await hashStoredObject(env.BUCKET, storageKey);

  return instance.fetch(
    new Request("https://session/finish", {
      method: "POST",
      body: JSON.stringify({ sizeBytes, sha256 }),
    }),
  );
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
 * Arm the timer that will judge one task dead (#186, design §4.6.5).
 *
 * Our server is the only caller and proves it with the shared secret, the
 * same one the ingest report carries the other way. A browser has no business
 * here: what it holds says an upload may send bytes, and nothing it holds
 * should be able to say when a task stops counting as alive.
 *
 * The body is passed through to the Durable Object, which is what decides
 * whether it is well formed — one place holds that shape.
 * @param request - The arm request.
 * @param env - The bound resources and configuration.
 * @returns 204 once armed, 401 for a caller we cannot identify, and whatever
 *   the timer answered otherwise.
 */
async function armTaskTimer(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("x-ingest-secret") !== env.INGEST_SHARED_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    taskId?: unknown;
  } | null;
  const taskId = body?.taskId;
  if (typeof taskId !== "string" || taskId === "") {
    return new Response("Expected taskId", { status: 400 });
  }

  const timer = env.TASK_TIMER.get(env.TASK_TIMER.idFromName(taskId));
  return timer.fetch("https://timer.invalid/arm", {
    method: "POST",
    body: JSON.stringify(body),
  });
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

  if (request.method === "POST" && pathname === "/task-timers/arm") {
    return armTaskTimer(request, env);
  }

  return new Response("Not found", { status: 404 });
}
