// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which keys a model call runs on (inner#1953). Whoever pays for a Studio supplies them: a language-model call runs on
 * the payer's OpenRouter key when it has one, a media call on the upstream the payer chose for that model while that
 * upstream's key is live; anything else on the deployment's keys. The key is read sealed and opened here; the answer names its key row by id, so a task, turn or lookup records the id and reads the key back
 * with {@link keysById}, never storing it.
 */

import { accountProviderKeysRepo, getConfig, openProviderKey, projectsRepo, providerKeyRingOf, type ProviderKeyRing } from "@breatic/core";
import { AccountKeyFailure, type KeySet, type Route } from "@breatic/provider";
import { describesInput } from "@breatic/provider/pricing";
import { provider } from "@domain/provider/instance.js";
import { providerKeyById, studioProviderKey, type KeyPurpose } from "@domain/provider/account-keys.service.js";
import { PROMPT_REWRITTEN_MODELS } from "@domain/provider/prompt-rewritten-models.js";

/** Who pays for a call: a Studio, or the Studio a Project belongs to. */
export type KeyPayer = { studioId: string } | { projectId: string };

/** The keys a call runs on, the route they give it, and the account key row they come from. */
export interface ResolvedKeys {
  keys: KeySet;
  /** The upstream the payer chose for a media model; the weights otherwise. */
  route: Route;
  /** The `account_provider_keys` row, or null for the deployment's keys. */
  keyId: string | null;
  /** The account whose key it is, or null for the deployment's keys. */
  payerUserId: string | null;
}

/** The deployment's keys, read through this process's provider when a call uses one. */
const DEPLOYMENT_KEYS: KeySet = { owner: "deployment", keyOf: (upstream) => provider().deploymentKeys.keyOf(upstream) };

/** A call on the deployment's keys and the model's weights. */
const ON_DEPLOYMENT: ResolvedKeys = { keys: DEPLOYMENT_KEYS, route: { mode: "default" }, keyId: null, payerUserId: null };

/**
 * An account's key set: one key, for one upstream.
 * @param upstream - The upstream.
 * @param key - The key.
 * @returns The set.
 */
function accountKeySet(upstream: string, key: string): KeySet {
  return { owner: "account", keyOf: (asked) => (asked === upstream ? key : undefined) };
}

/**
 * This deployment's master keys.
 * @returns The ring, or null when bring-your-own-key is off.
 */
function ring(): ProviderKeyRing | null {
  return providerKeyRingOf(getConfig());
}

/**
 * The keys a call of a Studio runs on, for its purpose.
 * @param payer - The Studio, or a Project of it.
 * @param purpose - A language-model call, or a run of one media model.
 * @returns The keys, the route and the key row, the deployment's when the payer brought none for this purpose.
 * @throws {ProviderKeySealBroken} When the payer's sealed key cannot be opened with this deployment's ring.
 */
export async function resolveKeys(payer: KeyPayer, purpose: KeyPurpose): Promise<ResolvedKeys> {
  const masterKeys = ring();
  if (masterKeys === null) return ON_DEPLOYMENT;
  const studioId = "studioId" in payer ? payer.studioId : await projectsRepo.findOwnerStudioId(payer.projectId);
  if (studioId === undefined) return ON_DEPLOYMENT;
  const found = await studioProviderKey(studioId, purpose);
  if (found === null) return ON_DEPLOYMENT;
  return {
    keys: accountKeySet(found.upstream, openProviderKey(found.ciphertext, masterKeys)),
    route: purpose.kind === "media" ? { mode: "upstream", upstream: found.upstream } : { mode: "default" },
    keyId: found.keyId,
    payerUserId: found.payerUserId,
  };
}

/**
 * The key a task, turn or lookup recorded by its row id.
 * @param keyId - The row, or null for the deployment's keys.
 * @returns The account's key for that row's upstream alone, or null for no row.
 * @throws {AccountKeyFailure} `account_key_missing` when the row was replaced, deleted or erased, its account is gone,
 *   or this deployment no longer opens account keys, naming the row's upstream while the row exists; no other key is
 *   used instead.
 * @throws {ProviderKeySealBroken} When the sealed key cannot be opened with this deployment's ring.
 */
export async function keysById(keyId: string | null): Promise<{ keys: KeySet } | null> {
  if (keyId === null) return null;
  const masterKeys = ring();
  const found = await providerKeyById(keyId);
  // A retired row still names its upstream, so the user is told which key is gone; no other key is used instead.
  if (masterKeys === null || found === null || found.ciphertext === null) {
    throw new AccountKeyFailure("", "account_key_missing", found === null ? {} : { upstream: found.upstream });
  }
  return { keys: accountKeySet(found.upstream, openProviderKey(found.ciphertext, masterKeys)) };
}

/**
 * The account a key row belongs to, live or retired, so a failure on it can say whose key it was.
 * @param keyId - The row a task, turn or execution recorded, or null for the deployment's keys.
 * @returns The account's id, or undefined for our keys or an id no row has.
 */
export async function keyOwnerOf(keyId: string | null): Promise<string | undefined> {
  return keyId === null ? undefined : (await accountProviderKeysRepo.keyOwnerById(keyId))?.userId;
}

/**
 * Whether a step on one of a media run's bindings describes an input first (Kling O3's elements): a language-model call
 * the run is charged for when it runs on our keys.
 * @param model - The catalog model.
 * @param params - The run's params, in our names.
 * @returns True when the run has a description step.
 */
export function runDescribesInput(model: string, params: Readonly<Record<string, unknown>>): boolean {
  return describesInput(provider().pricingRules(model), params);
}

/**
 * Whether a media run makes a language-model call of its own (inner#1953): its prompt is rewritten, which is never
 * charged, or it describes an input first. That call runs on the payer's language-model keys.
 * @param model - The catalog model.
 * @param params - The run's params, in our names.
 * @returns True when the run has a language-model step.
 */
export function runCallsLlm(model: string, params: Readonly<Record<string, unknown>>): boolean {
  return PROMPT_REWRITTEN_MODELS.has(model) || runDescribesInput(model, params);
}
