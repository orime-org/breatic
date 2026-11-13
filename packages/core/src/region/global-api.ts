// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Calls between regions (inner#1955).
 *
 * The global region holds the accounts, the Studio directory and the credit
 * books. {@link createGlobalApi} turns a set of global functions into the API
 * a service calls: in the global region the functions run in process; in any
 * other region each call is a signed `POST {GLOBAL_API_URL}/internal/global/<fn>`
 * with `{ "args": [...] }`, answered `{ "result": ... }` or, on refusal, an
 * HTTP status with `{ "code" }`. {@link callRegion} is the same request
 * aimed the other way, at `/internal/region/<fn>` of one region.
 *
 * The signature is the internal API's own (`signature.ts`), with the admin id
 * `region-<code>` naming the calling region.
 */

import { randomBytes } from "node:crypto";
import { httpRequest } from "@breatic/shared";
import { signRequest } from "@core/region/signature.js";

/** A global function as the API exposes it: async, JSON in and out. */
type RemoteFunction = (...args: never[]) => Promise<unknown>;

/** Where this process runs and how it reaches the global region. */
export interface GlobalApiOptions {
  region: string;
  globalRegion: string;
  globalApiUrl: string;
  secret: string;
  /** How long one remote call may take; defaults to five seconds. */
  timeoutMs?: number;
}

/** Where a region lives and how this process signs for it. */
export interface RegionApiOptions {
  callerRegion: string;
  url: string;
  secret: string;
  /** How long one call may take; defaults to five seconds. */
  timeoutMs?: number;
}

/** The status a call gets when no answer came back at all. */
export const UNREACHABLE_STATUS = 0;

/** A remote call that was refused or never answered. */
export class GlobalApiError extends Error {
  /** The HTTP status the other side answered, or {@link UNREACHABLE_STATUS}. */
  readonly status: number;
  /** The other side's refusal code, or `unreachable`. */
  readonly code: string;

  /**
   * Build the error for one failed call.
   * @param status - The HTTP status, or {@link UNREACHABLE_STATUS}.
   * @param code - The refusal code.
   * @param message - What went wrong.
   */
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GlobalApiError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Post one signed call and read its result.
 * @param base - The other side's internal listener.
 * @param path - `/internal/global/<fn>` or `/internal/region/<fn>`.
 * @param args - The call's arguments.
 * @param callerRegion - Who is calling, for the admin id.
 * @param secret - The shared internal API secret.
 * @param timeoutMs - How long the call may take.
 * @returns The `result` the other side answered.
 * @throws {GlobalApiError} When the other side refused or did not answer.
 */
async function postSigned(
  base: string,
  path: string,
  args: unknown[],
  callerRegion: string,
  secret: string,
  timeoutMs: number,
): Promise<unknown> {
  const body = JSON.stringify({ args });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const adminId = `region-${callerRegion}`;
  const signature = signRequest(secret, {
    method: "POST",
    pathWithQuery: path,
    timestamp,
    nonce,
    adminId,
    idempotencyKey: null,
    body,
  });
  let response: Response;
  try {
    response = await httpRequest(
      `${base}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-admin": adminId,
          "x-internal-timestamp": timestamp,
          "x-internal-nonce": nonce,
          "x-internal-signature": signature,
        },
        body,
      },
      { replaySafe: false, timeoutMs },
    );
  } catch (err) {
    throw new GlobalApiError(UNREACHABLE_STATUS, "unreachable", `${path} did not answer: ${(err as Error).message}`);
  }
  const answer = (await response.json().catch(() => ({}))) as { result?: unknown; code?: unknown };
  if (!response.ok) {
    const code = typeof answer.code === "string" ? answer.code : `http_${response.status}`;
    throw new GlobalApiError(response.status, code, `${path} refused with ${code}`);
  }
  return answer.result ?? null;
}

/**
 * The API of the global functions for this process.
 * @param local - The global functions, as the global region runs them.
 * @param options - This region and how it reaches the global region.
 * @returns An object with the same functions: in process in the global
 *   region, signed requests to it everywhere else.
 */
export function createGlobalApi<T extends Record<string, RemoteFunction>>(local: T, options: GlobalApiOptions): T {
  if (options.region === options.globalRegion) return local;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remote: Record<string, RemoteFunction> = {};
  for (const name of Object.keys(local)) {
    remote[name] = (...args: never[]) =>
      postSigned(options.globalApiUrl, `/internal/global/${name}`, args, options.region, options.secret, timeoutMs);
  }
  return remote as T;
}

/**
 * Call a function another region serves.
 * @param fn - The function's name.
 * @param args - Its arguments.
 * @param options - The region's address and how to sign.
 * @returns What the region answered.
 * @throws {GlobalApiError} When the region refused or did not answer.
 */
export function callRegion(fn: string, args: unknown[], options: RegionApiOptions): Promise<unknown> {
  return postSigned(
    options.url.replace(/\/+$/, ""),
    `/internal/region/${fn}`,
    args,
    options.callerRegion,
    options.secret,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}
