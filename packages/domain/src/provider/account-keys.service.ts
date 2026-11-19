// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a Studio's payer brought (inner#1953): sealed text at most, never a key; the caller opens it in its own process.
 */

import { accountModelUpstreamsRepo, accountProviderKeysRepo } from "@breatic/core";
import { ACCOUNT_LLM_UPSTREAM } from "@breatic/provider";
import { liveAdminOf } from "@domain/auth/studioMembers.repo.js";
import { provider } from "@domain/provider/instance.js";

/** What a call needs keys for: a language model (always provider's `ACCOUNT_LLM_UPSTREAM`), or one catalog media model. */
export type KeyPurpose = { kind: "llm" } | { kind: "media"; model: string };

/** The payer's key a call of a Studio runs on, sealed. */
export interface StudioProviderKey {
  /** The account that pays for the Studio: its current admin. */
  payerUserId: string;
  /** The `account_provider_keys` row. */
  keyId: string;
  upstream: string;
  ciphertext: string;
}

/**
 * A key row by id: sealed while it and its account are live; once it is replaced, deleted or erased, or its account is
 * gone, only whose it was and its upstream, with `ciphertext` null.
 */
export interface ProviderKeyById {
  id: string;
  userId: string;
  upstream: string;
  ciphertext: string | null;
}

/** What a Studio's payer brought, without any key or sealed text. */
export interface StudioKeyPlan {
  payerUserId: string;
  /** The upstreams the payer holds a live key for. */
  upstreams: string[];
  /** Each media model the payer pointed at an upstream it holds a key for, by model. */
  models: Record<string, string>;
}

/**
 * Whether a model choice still holds: the configuration binds the model on the upstream. A choice saved while a binding
 * existed outlives the binding, and then counts as no choice at all, as one dropped with its key does.
 * @param model - The catalog model.
 * @param upstream - The upstream it was pointed at.
 * @returns True while the upstream runs the model.
 */
export function choiceHolds(model: string, upstream: string): boolean {
  return (provider().config.models[model] ?? []).some((binding) => binding.upstream === upstream);
}

/**
 * The payer's key a call of a Studio runs on, for its purpose: the language-model upstream's key, the key of the
 * upstream the payer chose for a media model.
 * @param studioId - The Studio.
 * @param purpose - What the call is for.
 * @returns The payer, the key row and its sealed text, or null when the call runs on the deployment's keys.
 */
export async function studioProviderKey(studioId: string, purpose: KeyPurpose): Promise<StudioProviderKey | null> {
  const payerUserId = await liveAdminOf(studioId);
  if (payerUserId === null) return null;
  const upstream = purpose.kind === "llm" ? ACCOUNT_LLM_UPSTREAM : await accountModelUpstreamsRepo.modelUpstreamFor(payerUserId, purpose.model);
  if (upstream === null || (purpose.kind === "media" && !choiceHolds(purpose.model, upstream))) return null;
  const sealed = await accountProviderKeysRepo.sealedLiveKeyFor(payerUserId, upstream);
  return sealed === null ? null : { payerUserId, keyId: sealed.id, upstream, ciphertext: sealed.ciphertext };
}

/**
 * A key row's sealed text while the row and its account are live, and otherwise only whose it was and its upstream, so a
 * run on a key that is gone can say which upstream's key it was.
 * @param keyId - The row a task, turn or lookup recorded.
 * @returns The live row, the retired row with `ciphertext` null, or null when no row has the id.
 */
export async function providerKeyById(keyId: string): Promise<ProviderKeyById | null> {
  return accountProviderKeysRepo.keyRowById(keyId);
}

/**
 * What a Studio's payer brought, for the key plan a Project's panels read.
 * @param studioId - The Studio.
 * @returns The payer's upstreams and model choices, or null when the Studio or its payer is gone.
 */
export async function studioKeyPlan(studioId: string): Promise<StudioKeyPlan | null> {
  const payerUserId = await liveAdminOf(studioId);
  if (payerUserId === null) return null;
  const upstreams = (await accountProviderKeysRepo.liveKeysFor(payerUserId)).map((key) => key.upstream);
  const choices = await accountModelUpstreamsRepo.liveModelUpstreamsFor(payerUserId);
  return {
    payerUserId,
    upstreams,
    models: Object.fromEntries(choices.filter((c) => upstreams.includes(c.upstream) && choiceHolds(c.model, c.upstream)).map((c) => [c.model, c.upstream])),
  };
}
