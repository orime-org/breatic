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
 * layout and the size ceiling, all under one HMAC, so every check it performs
 * is against values the browser cannot alter.
 */

import { verifyUploadTicket } from "@breatic/shared";
import { verifySessionToken } from "@ingest/session-token.js";

export { UploadSession } from "@ingest/upload-session.js";

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
  /** Signs the ticket we verify, and authenticates the report we send back. */
  INGEST_SHARED_SECRET: string;
  /** Where an upload's outcome is reported. */
  SERVER_REPORT_URL: string;
  /** Comma-separated origins the browser may send parts from. */
  ALLOWED_ORIGINS: string;
}

/**
 * The settings this Worker cannot run without, each filled in by hand: the two
 * vars from `wrangler.toml` (copied from its template), the secret from
 * `.dev.vars` locally and `wrangler secret put` on a deployment.
 */
const REQUIRED_SETTINGS = [
  "INGEST_SHARED_SECRET",
  "SERVER_REPORT_URL",
  "ALLOWED_ORIGINS",
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
 * Write one part's bytes into R2 and have the instance record it.
 *
 * The bytes do not pass through the Durable Object. An instance runs one
 * request at a time, so streaming a part through it would serialise every
 * part of every upload it owns; what goes to the instance is the part number
 * and its etag, once the bytes are already in R2.
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
  const token = request.headers.get("x-upload-token");
  if (token === null) return new Response("Unauthorized", { status: 401 });

  const session = await verifySessionToken(
    token,
    env.INGEST_SHARED_SECRET,
    Date.now(),
  );
  // The upload id is inside the signature as well as in the path, so a token
  // names the one upload it may write into rather than any upload at all.
  if (session === null || session.uploadId !== uploadId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.arrayBuffer();
  return sessionFor(env, session.storageKey).fetch(
    new Request(`https://session/part/${partNumber}`, {
      method: "PUT",
      body,
    }),
  );
}

/**
 * Ask the instance to finish the upload.
 *
 * Only ever early: the alarm reaches the same place on its own, so a browser
 * that never asks still gets an outcome. That is also why a failure here
 * changes nothing — the alarm is what guarantees the attempt, this is what
 * makes it prompt.
 * @param request - The browser's request, carrying the session token.
 * @param env - The Worker's bindings.
 * @param uploadId - The upload from the path.
 * @returns The instance's answer, or 401 when the token does not verify.
 */
async function completeUpload(
  request: Request,
  env: Env,
  uploadId: string,
): Promise<Response> {
  const token = request.headers.get("x-upload-token");
  if (token === null) return new Response("Unauthorized", { status: 401 });

  const session = await verifySessionToken(
    token,
    env.INGEST_SHARED_SECRET,
    Date.now(),
  );
  if (session === null || session.uploadId !== uploadId) {
    return new Response("Unauthorized", { status: 401 });
  }

  return sessionFor(env, session.storageKey).fetch(
    new Request("https://session/complete", { method: "POST" }),
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
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
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

    // Before anything reads a binding. Every one of these comes from a file
    // somebody fills in by hand, so a missing one is ordinary — and saying
    // which one is the difference between a one-line fix and a hunt through a
    // stack trace.
    const missing = missingSettings(env);
    if (missing.length > 0) {
      return new Response(
        `This Worker is missing configuration: ${missing.join(", ")}. ` +
          "See packages/ingest/README.md.",
        { status: 500 },
      );
    }

    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      const preflight = new Response(null, { status: 204 });
      if (origin !== null) {
        preflight.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
        preflight.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        preflight.headers.set("Access-Control-Max-Age", "86400");
      }
      return withCors(preflight, origin);
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
  } catch {
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
