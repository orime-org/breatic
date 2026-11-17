// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Checking a key a user fills in (inner#1953): whether it reaches its upstream, and what balance it may read, each
 * upstream asked its own way. The answer holds only provider's own words, never the upstream's, which could echo the key.
 */

import { z } from "zod";
import type { ProviderConfig, UpstreamDecl } from "@provider/config/schema.js";
import { answerText, isServerError, isSuccess, parsed, send, sideBounds } from "@provider/http/request.js";
import { wellFormed } from "@provider/keys.js";

/** What balance a key reads: an amount, none to read, none it may read, or no cap on what it may spend. */
export type KeyBalance = { amount: number; currency: string } | "unsupported" | "forbidden" | "no_cap";

/** What checking a key answered. */
export interface KeyCheck {
  /** Whether the upstream took the key. */
  connected: boolean;
  balance?: KeyBalance;
  /** Why it is not connected: the upstream refused the key, limited it, could not be reached, or refused the check. */
  reason?: "invalid" | "rate_limited" | "unavailable" | "refused";
  /** fal only: whether the key can read the billing events actual costs are read from. */
  costsReadable?: boolean;
}

/** How one upstream kind is asked about a key. */
interface Checker {
  /** The balance request's address. */
  url: (decl: UpstreamDecl) => string;
  /** The header that carries the key. */
  auth: (key: string) => string;
  /** The balance an answered 2xx body states. */
  balance: (body: unknown) => KeyBalance;
}

/** The largest check answer read. */
const MAX_CHECK_BYTES = 64 * 1024;

/**
 * A balance in USD read from a number or a decimal string.
 * @param value - The value.
 * @returns The balance, or unsupported when it is neither.
 */
function usd(value: unknown): KeyBalance {
  const read = z.union([z.number().finite(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)]).safeParse(value);
  return read.success ? { amount: read.data, currency: "USD" } : "unsupported";
}

/**
 * The value at a dotted path of a body.
 * @param body - The body.
 * @param path - The path.
 * @returns The value, or undefined.
 */
function at(body: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined), body);
}

/** The billing events of a request that does not exist: costs nothing, and is refused only to a key without billing permission. */
const PROBE_REQUEST_ID = "00000000-0000-0000-0000-000000000000";

const CHECKERS: Readonly<Record<string, Checker>> = {
  wavespeed: {
    url: (decl) => `${decl.base_url}/balance`,
    auth: (key) => `Bearer ${key}`,
    balance: (body) => usd(at(body, "data.balance")),
  },
  fal: {
    // The configuration load refuses a fal upstream without billing_url.
    url: (decl) => `${decl.billing_url!}/account/billing?expand=credits`,
    auth: (key) => `Key ${key}`,
    balance: (body) => {
      const amount = usd(at(body, "credits.current_balance"));
      const currency = at(body, "credits.currency");
      return typeof amount === "object" && typeof currency === "string" ? { ...amount, currency } : amount;
    },
  },
  sandbase: {
    url: (decl) => `${decl.base_url}/account/balance`,
    auth: (key) => `Bearer ${key}`,
    balance: (body) => usd(at(body, "balance")),
  },
  openrouter: {
    url: (decl) => `${decl.base_url}/key`,
    auth: (key) => `Bearer ${key}`,
    // A key with no limit has no cap of its own; the account's balance needs a management key, so it is not read.
    balance: (body) => (at(body, "data.limit") === null ? "no_cap" : usd(at(body, "data.limit_remaining"))),
  },
};

/**
 * Send one GET with a key and read the status and body; anything that is not an answer reads as status 0.
 * @param url - The address.
 * @param authorization - The header that carries the key.
 * @returns The status and the parsed body.
 */
async function ask(url: string, authorization: string): Promise<{ status: number; body: unknown }> {
  const bounds = { replaySafe: false, ...sideBounds() };
  try {
    const response = await send({ url, method: "GET", headers: { authorization, accept: "application/json" } }, bounds);
    const text = await answerText(url, response, MAX_CHECK_BYTES, Math.max(1, bounds.deadlineAt - Date.now()), bounds);
    return { status: response.status, body: parsed(text) };
  } catch {
    // Not sent, no answer, cut or over the limit: the upstream could not be asked. Its error is dropped, as it may name the request.
    return { status: 0, body: undefined };
  }
}

/**
 * Check a key a user filled in for one upstream.
 * @param config - The validated configuration.
 * @param upstream - The upstream, by its name in the configuration.
 * @param key - The key.
 * @returns Whether it reaches the upstream, its balance and, on fal, whether it reads billing.
 * @throws {MalformedKey} When the key is not printable ASCII; nothing is sent.
 * @throws {Error} When the upstream is unknown or provider cannot check its keys.
 */
export async function checkKey(config: Pick<ProviderConfig, "upstreams">, upstream: string, key: string): Promise<KeyCheck> {
  const decl = config.upstreams[upstream];
  const checker = decl === undefined ? undefined : CHECKERS[decl.kind];
  if (decl === undefined || checker === undefined) throw new Error(`provider cannot check keys of upstream ${upstream}`);
  const authorization = checker.auth(wellFormed(upstream, key));
  const { status, body } = await ask(checker.url(decl), authorization);
  let check: KeyCheck;
  if (isSuccess(status)) check = { connected: true, balance: checker.balance(body) };
  else if (status === 403) check = { connected: true, balance: "forbidden" };
  else if (status === 401) check = { connected: false, reason: "invalid" };
  else if (status === 429) check = { connected: false, reason: "rate_limited" };
  else if (status === 0 || status === 408 || isServerError(status)) check = { connected: false, reason: "unavailable" };
  else check = { connected: false, reason: "refused" };
  if (decl.kind !== "fal" || !check.connected) return check;
  const query = new URLSearchParams({ request_id: PROBE_REQUEST_ID, start: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
  const probe = await ask(`${decl.billing_url!}/models/billing-events?${query.toString()}`, authorization);
  if (isSuccess(probe.status)) return { ...check, costsReadable: true };
  return probe.status === 401 || probe.status === 403 ? { ...check, costsReadable: false } : check;
}
