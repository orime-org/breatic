// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading one web-animation model call's keys from our server (inner#1953). The Worker holds no model key: before each
 * call it posts `{ executionId, upstreams }` to the endpoint the job names, signed with the shared secret over a
 * timestamp, and opens the sealed answer with `KEY_UNSEAL_PRIVATE_KEY`. The keys live only in the call that asked for
 * them. Format and signing are shared with the server (`@breatic/shared/space-content`).
 */

import {
  MODEL_KEYS_REFUSAL_STATUS,
  MODEL_KEYS_SIGNATURE_HEADER,
  MODEL_KEYS_TIMESTAMP_HEADER,
  ModelKeysUnreadable,
  modelKeysRefusalSchema,
  openModelKeys,
  signModelKeysRequest,
} from "@breatic/shared/space-content";

/** Where a job's calls read their keys. */
export interface ModelKeysTarget {
  url: string;
  executionId: string;
}

/** What the Worker signs and opens with. */
export interface ModelKeysSecrets {
  sharedSecret: string;
  privateKey: string;
}

/**
 * What one read gave: the keys by upstream; a refusal that ends the execution with `reason` (`unreadable` when the seal
 * did not open, a key pair that does not match); an execution that no longer runs; or no answer to act on this time.
 */
export type ModelKeysFetch =
  | { kind: "keys"; keys: Record<string, string> }
  | { kind: "refused"; reason: "account_key_missing" | "feature_disabled"; upstream?: string; unreadable?: true }
  | { kind: "not_running" }
  | { kind: "unavailable"; status: number | null };

/** The fetch the read is sent with. */
export type Send = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Read the keys of the asked upstreams for one call.
 * @param target - The job's key endpoint and execution.
 * @param upstreams - The plan's upstreams.
 * @param secrets - The shared secret and the private key.
 * @param send - The fetch to send with.
 * @returns What the server answered.
 * @throws {never} Never: a request that reached no server is `unavailable`.
 */
export async function fetchModelKeys(target: ModelKeysTarget, upstreams: readonly string[], secrets: ModelKeysSecrets, send: Send = fetch): Promise<ModelKeysFetch> {
  const body = JSON.stringify({ executionId: target.executionId, upstreams });
  const timestamp = Math.floor(Date.now() / 1000);
  let res: Response;
  try {
    res = await send(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MODEL_KEYS_TIMESTAMP_HEADER]: String(timestamp),
        [MODEL_KEYS_SIGNATURE_HEADER]: await signModelKeysRequest(secrets.sharedSecret, timestamp, body),
      },
      body,
    });
  } catch {
    // Dropped on purpose: the next call asks again, and the transport's error says nothing a key could be read from.
    return { kind: "unavailable", status: null };
  }
  if (res.status === 200) {
    try {
      return { kind: "keys", keys: await openModelKeys(await res.text(), secrets.privateKey) };
    } catch (err) {
      if (!(err instanceof ModelKeysUnreadable)) return { kind: "unavailable", status: res.status };
      return { kind: "refused", reason: "feature_disabled", unreadable: true };
    }
  }
  if (res.status === 404) return { kind: "not_running" };
  if (res.status === MODEL_KEYS_REFUSAL_STATUS) {
    const refusal = modelKeysRefusalSchema.safeParse(await res.json().catch(() => null));
    if (refusal.success) {
      return refusal.data.code === "account_key_missing"
        ? { kind: "refused", reason: "account_key_missing", ...(refusal.data.upstream === undefined ? {} : { upstream: refusal.data.upstream }) }
        : { kind: "refused", reason: "feature_disabled" };
    }
  }
  return { kind: "unavailable", status: res.status };
}
