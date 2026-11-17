// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys one call may use (inner#1953). The caller hands a `KeySet` to each call: the deployment's (ours, read
 * through `createProvider`'s `keyOf`, used when a call is handed none) or an account's (the user's own). Provider never
 * stores a key: a ticket and a cost lookup record only whose keys ran a step (`account` when an account's did, absent for
 * the deployment's), and the caller hands the same owner's keys back for every later step and lookup.
 */

import type { ProviderConfig } from "@provider/config/schema.js";
import type { Cost, CostLookup, Payer } from "@provider/cost.js";
import { AccountKeyFailure, NoUpstreamAvailable, UpstreamRequestRejected, type AccountKeyFailureKind, type AccountKeyFailureReason } from "@provider/errors.js";
import { passingStatus, type Failure, type Phase } from "@provider/routing/decide.js";

/** The keys one call may use, by upstream name, and whose they are. */
export interface KeySet {
  /** `deployment`: ours, which the caller charges for; `account`: a user's own. */
  readonly owner: Payer;
  /** The key for one upstream (by its name in the configuration); undefined or empty when the set has none. */
  keyOf(upstream: string): string | undefined;
}

/**
 * The one upstream an account's own key runs language-model calls on (inner#1953): an account fills in one OpenRouter
 * key, and every language model goes through it.
 */
export const ACCOUNT_LLM_UPSTREAM = "openrouter";

/** A key a user filled in may hold only printable ASCII: anything else could break the header it is sent in. */
const WELL_FORMED = /^[\x21-\x7E]+$/;

/** A key that is not printable ASCII; it never carries the key. */
export class MalformedKey extends Error {
  /**
   * Record which upstream's key it was.
   * @param upstream - The upstream.
   */
  constructor(upstream: string) {
    super(`The key for ${upstream} holds a character that is not printable ASCII`);
    this.name = "MalformedKey";
  }
}

/**
 * Refuse a key that is not printable ASCII, before it reaches a header (whose error would quote it).
 * @param upstream - The upstream it is for.
 * @param key - The key.
 * @returns The key.
 * @throws {MalformedKey} When it holds anything else.
 */
export function wellFormed(upstream: string, key: string): string {
  if (!WELL_FORMED.test(key)) throw new MalformedKey(upstream);
  return key;
}

/**
 * The deployment's key set: each upstream's key read from its `key_env` through the caller's reader.
 * @param config - The validated configuration.
 * @param keyOf - Reads one environment variable.
 * @returns The set.
 */
export function deploymentKeySet(config: Pick<ProviderConfig, "upstreams">, keyOf: (envName: string) => string | undefined): KeySet {
  return {
    owner: "deployment",
    keyOf: (upstream) => {
      const decl = config.upstreams[upstream];
      return decl === undefined ? undefined : keyOf(decl.key_env);
    },
  };
}

/**
 * The key a set holds for an upstream; an account's key is checked to be printable ASCII.
 * @param keys - The set.
 * @param upstream - The upstream.
 * @returns The key, or undefined when the set holds none.
 * @throws {MalformedKey} When an account's key is not printable ASCII.
 */
export function keyIn(keys: KeySet, upstream: string): string | undefined {
  const key = keys.keyOf(upstream);
  if (key === undefined || key === "") return undefined;
  return keys.owner === "account" ? wellFormed(upstream, key) : key;
}

/**
 * The key a call on an upstream is sent with: the set's, or "" when it holds none (a call routing never picks).
 * @param keys - The set.
 * @param upstream - The upstream.
 * @returns The key.
 * @throws {MalformedKey} When an account's key is not printable ASCII.
 */
export function keyFor(keys: KeySet, upstream: string): string {
  return keyIn(keys, upstream) ?? "";
}

/**
 * Whether a set holds a key for an upstream.
 * @param keys - The set.
 * @param upstream - The upstream.
 * @returns True when it does.
 * @throws {MalformedKey} When an account's key is not printable ASCII.
 */
export function hasKey(keys: KeySet, upstream: string): boolean {
  return keyIn(keys, upstream) !== undefined;
}

/**
 * The set a call runs on: the one it was handed, or the deployment's.
 * @param given - The set the caller handed, if any.
 * @param deployment - The deployment's set.
 * @returns The set.
 */
export function keysOr(given: KeySet | undefined, deployment: KeySet): KeySet {
  return given ?? deployment;
}

/**
 * The set a later step of a ticket runs on, checked against the owner the ticket recorded for it.
 * @param recorded - The owner the ticket recorded (`account`), or undefined for the deployment's.
 * @param given - The set the caller handed, if any.
 * @param deployment - The deployment's set.
 * @param what - What the step is, for the error.
 * @returns The set.
 * @throws {Error} When the caller handed another owner's keys than the step ran on.
 */
export function recordedKeys(recorded: Payer | undefined, given: KeySet | undefined, deployment: KeySet, what: string): KeySet {
  const keys = keysOr(given, deployment);
  const owner = recorded ?? "deployment";
  if (keys.owner !== owner) throw new Error(`The ${what} ran on the ${owner}'s keys and was handed the ${keys.owner}'s`);
  return keys;
}

/**
 * The owner a ticket or lookup records for a set: `account`, or nothing for the deployment's.
 * @param keys - The set.
 * @returns The owner to record.
 */
export function ownerRecord(keys: KeySet): Payer | undefined {
  return keys.owner === "account" ? "account" : undefined;
}

/**
 * The upstreams a call may move between: all of them on the deployment's keys, only the first on an account's, which
 * never falls back to another upstream.
 * @param keys - The set.
 * @param order - The upstreams in try order.
 * @returns The ones to try.
 */
export function triedOn<T>(keys: KeySet, order: readonly T[]): T[] {
  return keys.owner === "account" ? order.slice(0, 1) : [...order];
}

/**
 * Refuse a call on an account's keys that holds a key for none of the model's upstreams.
 * @param model - Our model id.
 * @param keys - The set.
 * @param candidates - The model's upstreams, each saying whether the set holds its key.
 * @throws {AccountKeyFailure} `account_key_missing` when an account's set holds none.
 */
export function assertAccountReaches(model: string, keys: KeySet, candidates: readonly { configured: boolean }[]): void {
  if (keys.owner === "account" && !candidates.some((c) => c.configured)) throw new AccountKeyFailure(model, "account_key_missing");
}

/**
 * A cost marked with whose keys paid it: an account's pending lookup also records the owner it is looked up with.
 * @param payer - Who paid, or undefined to leave the cost as it is (the deployment, with nothing else beside it).
 * @returns The marking.
 */
export function paidBy(payer: Payer | undefined): (cost: Cost) => Cost {
  if (payer === undefined) return (cost) => cost;
  return (cost) => (cost.state === "pending" && payer === "account" ? { ...cost, lookup: { ...cost.lookup, payer }, payer } : { ...cost, payer });
}

/**
 * The payer a call's costs are marked with: `account` on an account's keys, nothing on the deployment's.
 * @param keys - The set the call ran on.
 * @returns The marking.
 */
export function paidOn(keys: KeySet): (cost: Cost) => Cost {
  return paidBy(ownerRecord(keys));
}

/**
 * Whose keys a lookup was recorded on.
 * @param lookup - The lookup.
 * @returns `account` when an account's were, else undefined for the deployment's.
 */
export function lookupOwner(lookup: CostLookup): Payer | undefined {
  return lookup["payer"] === "account" ? "account" : undefined;
}

/** How a failure on an account's key reads, and whether asking again could change it. */
interface Turned {
  kind: AccountKeyFailureKind;
  reason?: AccountKeyFailureReason;
  /** True when asking again cannot change it. */
  lasting: boolean;
}

/**
 * How a failure on an account's key reads: a missing model or balance and a 401 are lasting; a 429 is the key's rate
 * limit, and a connection that was never made, a 408 or a 5xx the upstream's, both passing.
 * @param failure - The failure class, read the answering upstream's way.
 * @param phase - Where the call was.
 * @returns The reading, or undefined for a failure that is not the account's (a refused request, a lost answer, an abort).
 */
export function accountFailureOf(failure: Failure | null, phase: Phase): Turned | undefined {
  if (failure === null) return undefined;
  if (failure.kind === "model_not_found") return { kind: "account_key_failed", reason: "model_not_found", lasting: true };
  if (failure.kind === "insufficient_balance") return { kind: "account_key_failed", reason: "no_balance", lasting: true };
  if (failure.kind === "not_sent") return { kind: "upstream_unavailable", lasting: false };
  if (failure.kind !== "http_status") return undefined;
  if (failure.status === 401) return { kind: "account_key_failed", reason: "invalid", lasting: true };
  if (failure.status === 429) return { kind: "account_key_failed", reason: "rate_limited", lasting: false };
  return passingStatus(failure.status, phase) ? { kind: "upstream_unavailable", lasting: false } : undefined;
}

/**
 * The failure class an ended LLM call stands for: the last upstream failure a route ran out on, the status of a refusal
 * it stopped on, or the class its own reader gives.
 * @param error - What the call threw.
 * @param classify - Reads an error the answering upstream's way.
 * @returns The class, or null.
 */
function endedFailure(error: unknown, classify: (error: unknown) => Failure | null): Failure | null {
  if (error instanceof NoUpstreamAvailable) {
    const last = [...error.reasons].reverse().find((r): r is Extract<typeof r, { kind: "failed" }> => r.kind === "failed");
    if (last === undefined) return null;
    return last.failure === "http_status" ? { kind: "http_status", status: last.status! } : ({ kind: last.failure } as Failure);
  }
  if (error instanceof UpstreamRequestRejected && error.status !== undefined) return { kind: "http_status", status: error.status };
  return classify(error);
}

/**
 * What an LLM call on a key set throws when it ends with an error: on an account's keys, a failure of the key or its
 * upstream becomes an AccountKeyFailure with the call's own error as its cause; anything else, and every error on the
 * deployment's keys, is thrown as it is.
 * @param keys - The set the call ran on.
 * @param model - Our model id.
 * @param upstream - The one upstream an account's call runs on.
 * @param classify - Reads an error the answering upstream's way.
 * @returns The error to throw.
 */
export function llmFailureOn(keys: KeySet, model: string, upstream: string, classify: (error: unknown) => Failure | null): (error: unknown) => unknown {
  if (keys.owner !== "account") return (error) => error;
  return (error) => {
    if (error instanceof AccountKeyFailure) return error;
    const turned = accountFailureOf(endedFailure(error, classify), "llm_before_content");
    return turned === undefined ? error : new AccountKeyFailure(model, turned.kind, { upstream, ...(turned.reason === undefined ? {} : { reason: turned.reason }), cause: error });
  };
}

/** Whose keys each part of a media run ran on, as its ticket records them; absent means the deployment's. */
export interface TicketOwners {
  /** The media steps'. */
  keysOwner?: Payer;
  /** The description step's (an understand call inside the run). */
  llmKeysOwner?: Payer;
}

/**
 * The owners a new ticket records.
 * @param keys - The media steps' set.
 * @param llmKeys - The description step's set.
 * @returns The fields, each left out for the deployment's.
 */
export function ticketOwners(keys: KeySet, llmKeys: KeySet): TicketOwners {
  const media = ownerRecord(keys);
  const llm = ownerRecord(llmKeys);
  return { ...(media === undefined ? {} : { keysOwner: media }), ...(llm === undefined ? {} : { llmKeysOwner: llm }) };
}

/**
 * The payer a media run's costs of one part are marked with: none on a run wholly on the deployment's keys, else the
 * part's owner, the deployment's included, so the caller can split the run's costs by payer.
 * @param owners - The ticket's owners.
 * @param part - The media steps' costs or the description's.
 * @returns The marking.
 */
export function paidInRun(owners: TicketOwners, part: "media" | "llm"): (cost: Cost) => Cost {
  if (owners.keysOwner === undefined && owners.llmKeysOwner === undefined) return paidBy(undefined);
  return paidBy((part === "media" ? owners.keysOwner : owners.llmKeysOwner) ?? "deployment");
}

/**
 * What a prepared call on a key set adds to its finish metadata: `payer: "account"` on an account's keys, so its cost
 * is marked with it.
 * @param keys - The set.
 * @returns The field, or none on the deployment's keys.
 */
export function payerMark(keys: KeySet): { payer?: Payer } {
  const owner = ownerRecord(keys);
  return owner === undefined ? {} : { payer: owner };
}

/**
 * The marking of a finished call's cost, by the payer its `breatic` metadata names.
 * @param breatic - The finish's `providerMetadata.breatic`.
 * @returns The marking.
 */
export function paidAsMarked(breatic: unknown): (cost: Cost) => Cost {
  return paidBy((breatic as { payer?: unknown } | undefined)?.payer === "account" ? "account" : undefined);
}
