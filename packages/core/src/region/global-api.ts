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
import { httpRequest, readWithin } from "@breatic/shared";
import { env } from "@core/config/env.js";
import { isGlobalRegion } from "@core/region/placement.js";
import { getRegionsConfig } from "@core/config/regions.js";
import type { HealthCheck } from "@core/infra/health-server.js";
import { signRequest } from "@core/region/signature.js";

/** A global function as the API exposes it: async, JSON in and out. */
type RemoteFunction = (...args: never[]) => Promise<unknown>;

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

/**
 * Whether a failed call means the other side is unavailable for now: no
 * answer, a server error, a timeout or rate limit, or a refused signature
 * (a secret or clock out of step between the regions). Anything else is the
 * other side's own answer to this request.
 * @param err - What the call threw.
 * @returns True when a later attempt may succeed unchanged.
 */
export function isRegionUnavailable(err: unknown): boolean {
  if (!(err instanceof GlobalApiError)) return false;
  const { status } = err;
  return status === UNREACHABLE_STATUS || status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/** Whether the latest call to the global region got an answer from it. */
let lastGlobalCallOk = true;

/**
 * Whether the latest call to the global region was answered: a refusal
 * counts, an unavailable global region ({@link isRegionUnavailable}) does
 * not. True before any call.
 * @returns The outcome, for a region's health report.
 */
export function lastGlobalCallSucceeded(): boolean {
  return lastGlobalCallOk;
}

/**
 * The `/healthz` item a region outside the global region reports: whether
 * its latest global call was answered. It never makes the instance
 * unhealthy, since replacing the instance does not bring the global region back.
 * @returns The check, or none in the global region.
 */
export function globalApiHealthChecks(): HealthCheck[] {
  if (isGlobalRegion(env)) return [];
  return [{ name: "global_api", informational: true, check: async () => lastGlobalCallSucceeded() }];
}

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
  const startedAt = Date.now();
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
  // The transport's deadline ends at the headers; the body is read within
  // what is left of the same wait.
  const budgetMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  if (!response.ok) {
    const refusal = (await readWithin(response, budgetMs).then((text) => JSON.parse(text) as unknown).catch(() => ({}))) as { code?: unknown };
    const code = typeof refusal.code === "string" ? refusal.code : `http_${response.status}`;
    throw new GlobalApiError(response.status, code, `${path} refused with ${code}`);
  }
  try {
    return (JSON.parse(await readWithin(response, budgetMs)) as { result?: unknown }).result ?? null;
  } catch (err) {
    // A body that is cut off, late or not JSON is no answer, never a null result.
    throw new GlobalApiError(UNREACHABLE_STATUS, "unreachable", `${path} answer could not be read: ${(err as Error).message}`);
  }
}

/**
 * The API of the global functions for this process.
 * @param local - The global functions, as the global region runs them.
 * @returns An object with the same functions: in process in the global
 *   region, signed requests to it everywhere else.
 */
export function createGlobalApi<T extends Record<string, RemoteFunction>>(local: T): T {
  if (isGlobalRegion(env)) return local;
  const remote: Record<string, RemoteFunction> = {};
  for (const name of Object.keys(local)) {
    remote[name] = async (...args: never[]) => {
      try {
        const result = await postSigned(
          env.GLOBAL_API_URL,
          `/internal/global/${name}`,
          args,
          env.REGION,
          env.INTERNAL_API_SECRET,
          getRegionsConfig().global_api_timeout_ms,
        );
        lastGlobalCallOk = true;
        return result;
      } catch (err) {
        lastGlobalCallOk = !isRegionUnavailable(err);
        throw err;
      }
    };
  }
  return remote as T;
}

/**
 * Call a function another region serves, at the address `REGION_API_URLS`
 * gives it, signed as this region.
 * @param region - The region's code.
 * @param fn - The function's name.
 * @param args - Its arguments.
 * @param timeoutMs - How long the call may take.
 * @returns What the region answered.
 * @throws {GlobalApiError} When the region has no address, refused or did not answer.
 */
export function callRegion(region: string, fn: string, args: unknown[], timeoutMs: number): Promise<unknown> {
  // Own keys only: a region name from a token must not reach an inherited property.
  const url = Object.hasOwn(env.REGION_API_URLS, region) ? env.REGION_API_URLS[region] : undefined;
  if (url === undefined) {
    return Promise.reject(new GlobalApiError(UNREACHABLE_STATUS, "unreachable", `no address for region ${region}`));
  }
  return postSigned(url.replace(/\/+$/, ""), `/internal/region/${fn}`, args, env.REGION, env.INTERNAL_API_SECRET, timeoutMs);
}
