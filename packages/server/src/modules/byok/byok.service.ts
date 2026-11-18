// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An account's own upstream keys (inner#1953): the settings the BYOK dialog reads and writes, and the key plan a
 * Project's panels read about whoever pays for its Studio.
 *
 * A key is checked with its upstream before it is saved, sealed with this deployment's master keys and kept only in
 * `account_provider_keys`; nothing answered here carries a key or its sealed text, only the hint the user is shown.
 * A language-model key goes only to OpenRouter (every language-model call runs on it); a media model may be pointed
 * only at an upstream it is bound on that holds a live key of the account.
 */

import {
  AppError,
  InvalidProviderKey,
  NotFoundError,
  accountModelUpstreamsRepo,
  accountProviderKeysRepo,
  displayHintOf,
  getConfig,
  normalizeProviderKey,
  openProviderKey,
  projectsRepo,
  providerKeyRingOf,
  sealProviderKey,
  type ProviderKeyCheckRecord,
  type ProviderKeyRing,
} from "@breatic/core";
import { provider, studioKeyPlan } from "@breatic/domain";
import { ACCOUNT_LLM_UPSTREAM, type KeyCheck, type KeySet } from "@breatic/provider";
import { t, type AccountProviderKey, type ModelAvailability, type ProviderKeyBalanceState } from "@breatic/shared";
import { assertAccess } from "@server/modules/project/project.service.js";

/** Which group the dialog lists an upstream under. */
export type ByokUpstreamKind = "llm" | "official" | "reseller";

/** An upstream a key can be added for. */
export interface ByokUpstream {
  upstream: string;
  name: string;
  kind: ByokUpstreamKind;
  /** Where the upstream hands out keys; null when it publishes no such page. */
  keyUrl: string | null;
}

/** A saved key as the account sees it: never the key itself. */
export interface ByokSavedKey {
  upstream: string;
  displayHint: string;
  lastConnected: boolean;
  lastCheckedAt: string | null;
  lastBalanceState: ProviderKeyBalanceState | null;
  /** The balance as decimal text, when the last check read one. */
  lastBalanceAmount: string | null;
  lastBalanceCurrency: string | null;
  /** Why the last check did not connect, as a reason code the web translates. */
  lastFailure: string | null;
  /**
   * Whether the key can read the actual costs of its calls (fal's billing events); false is said as "this key cannot
   * read actual costs", null where the upstream has no such probe.
   */
  costsReadable: boolean | null;
}

/** The account's BYOK settings. */
export interface ByokSettings {
  /** False where the deployment has no master keys to seal keys with. */
  enabled: boolean;
  upstreams: ByokUpstream[];
  keys: ByokSavedKey[];
  /** The upstream each media model is pointed at; a model left out runs on the deployment's keys. */
  models: { model: string; upstream: string }[];
  /** For each media model some saved key can run, the upstreams holding such a key. */
  choices: Record<string, string[]>;
}

/** Whose keys a Project's runs use and, per media model on those keys, where it runs. */
export interface KeyPlan {
  /** The caller's own keys, or the Studio admin's. */
  payer: "self" | "admin";
  llm: { usesAccountKey: boolean };
  models: Record<string, { upstream: string; availability: ModelAvailability }>;
  /** Each upstream's name on screen, for a failure sentence that names the upstream a key failed on. */
  upstreamNames: Record<string, string>;
}

/**
 * How the dialog lists an upstream: as the provider configuration names and groups it. OpenRouter is listed alone as
 * the language-model key; a media upstream the configuration does not group is a model vendor's own API.
 * @param upstream - The upstream.
 * @returns Its listing.
 */
function listingOf(upstream: string): ByokUpstream {
  const decl = provider().config.upstreams[upstream];
  return {
    upstream,
    name: decl?.display_name ?? upstream,
    kind: upstream === ACCOUNT_LLM_UPSTREAM ? "llm" : (decl?.group ?? "official"),
    keyUrl: decl?.key_url ?? null,
  };
}

/**
 * This deployment's master keys.
 * @returns The ring, or null when bring-your-own-key is off.
 */
function ring(): ProviderKeyRing | null {
  return providerKeyRingOf(getConfig());
}

/**
 * The ring, or the refusal a deployment without one answers.
 * @returns The ring.
 * @throws {AppError} 503 when bring-your-own-key is off here.
 */
function ringOrRefuse(): ProviderKeyRing {
  const found = ring();
  if (found === null) throw new AppError(503, t("server.byok.disabled"), "byok_disabled");
  return found;
}

/**
 * Every media model's bound upstreams, from the provider configuration.
 * @returns The upstreams, by model.
 */
function mediaBindings(): Map<string, string[]> {
  return new Map(Object.entries(provider().config.models).map(([model, bindings]) => [model, bindings.map((b) => b.upstream)]));
}

/**
 * The upstreams a key can be added for: OpenRouter, then every upstream a media model is bound on.
 * @returns The upstream names, in that order.
 */
function offeredUpstreams(): string[] {
  return [...new Set([ACCOUNT_LLM_UPSTREAM, ...[...mediaBindings().values()].flat()])];
}

/**
 * Refuse an upstream no key is taken for here.
 * @param upstream - The upstream the request names.
 * @throws {AppError} 422 when it is not one {@link offeredUpstreams} lists.
 */
function assertOffered(upstream: string): void {
  if (!offeredUpstreams().includes(upstream)) throw new AppError(422, t("server.byok.upstream_not_offered"), "upstream_not_offered");
}

/**
 * A saved key as the account sees it.
 * @param key - The stored key, without its sealed text.
 * @returns The view.
 */
function savedKeyView(key: AccountProviderKey): ByokSavedKey {
  return {
    upstream: key.upstream,
    displayHint: key.displayHint,
    lastConnected: key.lastConnected === true,
    lastCheckedAt: key.lastCheckedAt?.toISOString() ?? null,
    lastBalanceState: key.lastBalanceState,
    lastBalanceAmount: key.lastBalanceAmount === null ? null : String(key.lastBalanceAmount),
    lastBalanceCurrency: key.lastBalanceCurrency,
    lastFailure: key.lastFailure,
    costsReadable: key.lastCostsReadable,
  };
}

/**
 * What a check found, as stored beside the key.
 * @param check - provider's answer.
 * @returns The record.
 */
function checkRecord(check: KeyCheck): ProviderKeyCheckRecord {
  const { balance } = check;
  const known = typeof balance === "object";
  return {
    connected: check.connected,
    balanceState: balance === undefined ? null : known ? "known" : balance,
    balanceAmount: known ? balance.amount : null,
    balanceCurrency: known ? balance.currency : null,
    failure: check.connected ? null : (check.reason ?? "invalid"),
    costsReadable: check.costsReadable ?? null,
  };
}

/**
 * Read the account's settings.
 * @param userId - The account.
 * @returns The settings, with no key or sealed text.
 */
export async function readSettings(userId: string): Promise<ByokSettings> {
  const [keys, chosen] = await Promise.all([accountProviderKeysRepo.liveKeysFor(userId), accountModelUpstreamsRepo.liveModelUpstreamsFor(userId)]);
  const held = new Set(keys.map((k) => k.upstream));
  const choices: Record<string, string[]> = {};
  for (const [model, upstreams] of mediaBindings()) {
    const usable = upstreams.filter((u) => u !== ACCOUNT_LLM_UPSTREAM && held.has(u));
    if (usable.length > 0) choices[model] = usable;
  }
  return {
    enabled: ring() !== null,
    upstreams: offeredUpstreams().map(listingOf),
    keys: keys.map(savedKeyView),
    models: chosen.filter((c) => held.has(c.upstream)).map((c) => ({ model: c.model, upstream: c.upstream })),
    choices,
  };
}

/**
 * Save or replace the account's key for an upstream: the key is checked first and saved, sealed, only once it
 * connects; a replaced key's sealed text is cleared in the same write.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @param raw - The key as pasted.
 * @returns The saved key.
 * @throws {AppError} 503 when bring-your-own-key is off here; 422 for an upstream no key is taken for, a malformed key
 *   or one that does not connect, with the check's reason.
 */
export async function saveKey(userId: string, upstream: string, raw: string): Promise<ByokSavedKey> {
  const masterKeys = ringOrRefuse();
  assertOffered(upstream);
  let key: string;
  try {
    key = normalizeProviderKey(raw);
  } catch (err) {
    if (err instanceof InvalidProviderKey) throw new AppError(422, t("server.byok.key_malformed"), "key_malformed");
    throw err;
  }
  const check = await provider().checkKey(upstream, key);
  if (!check.connected) throw new AppError(422, t("server.byok.key_not_connected"), check.reason ?? "invalid");
  const saved = await accountProviderKeysRepo.saveKey({
    userId,
    upstream,
    ciphertext: sealProviderKey(key, masterKeys),
    displayHint: displayHintOf(key),
    check: checkRecord(check),
  });
  return savedKeyView(saved);
}

/**
 * Check the account's saved key for an upstream again and record what was found; a key that no longer connects is
 * kept, marked so.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @returns The key as now recorded.
 * @throws {AppError} 503 when bring-your-own-key is off here.
 * @throws {NotFoundError} When the account holds no live key for the upstream.
 * @throws {ProviderKeySealBroken} When the sealed key cannot be opened with this deployment's ring.
 */
export async function recheckKey(userId: string, upstream: string): Promise<ByokSavedKey> {
  const masterKeys = ringOrRefuse();
  const live = (await accountProviderKeysRepo.liveKeysFor(userId)).find((k) => k.upstream === upstream);
  const sealed = live === undefined ? null : await accountProviderKeysRepo.sealedKeyById(live.id);
  if (sealed === null) throw new NotFoundError(t("server.error.not_found"));
  const check = await provider().checkKey(upstream, openProviderKey(sealed.ciphertext, masterKeys));
  const recorded = await accountProviderKeysRepo.recordCheck(userId, upstream, checkRecord(check));
  if (recorded === null) throw new NotFoundError(t("server.error.not_found"));
  return savedKeyView(recorded);
}

/**
 * Delete the account's key for an upstream, and every model choice naming it.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @returns Nothing.
 * @throws {NotFoundError} When the account holds no live key for the upstream.
 */
export async function deleteKey(userId: string, upstream: string): Promise<void> {
  if (!(await accountProviderKeysRepo.deleteKey(userId, upstream))) throw new NotFoundError(t("server.error.not_found"));
}

/**
 * Point a media model at an upstream, or back at the deployment's keys with null.
 * @param userId - The account.
 * @param model - The catalog model.
 * @param upstream - An upstream the model is bound on that holds a live key of the account, or null.
 * @returns Nothing.
 * @throws {AppError} 422 for a model that is not a media model of the catalog, or an upstream that cannot run it or
 *   holds no live key of the account.
 */
export async function setModelUpstream(userId: string, model: string, upstream: string | null): Promise<void> {
  const bound = mediaBindings().get(model);
  const refused = new AppError(422, t("server.byok.model_choice_refused"), "model_choice_refused");
  if (bound === undefined) throw refused;
  if (upstream !== null) {
    if (upstream === ACCOUNT_LLM_UPSTREAM || !bound.includes(upstream)) throw refused;
    const held = (await accountProviderKeysRepo.liveKeysFor(userId)).some((k) => k.upstream === upstream);
    if (!held) throw refused;
  }
  await accountModelUpstreamsRepo.setModelUpstream(userId, model, upstream);
}

/**
 * A key set standing for keys the payer holds, for counting availability without opening any key.
 * @param upstream - The one upstream it holds.
 * @returns The set; its value is a placeholder no call is ever sent with.
 */
function heldOnly(upstream: string): KeySet {
  return { owner: "account", keyOf: (asked) => (asked === upstream ? "held" : undefined) };
}

/**
 * The key plan of a Project: whose keys its runs use, whether language-model calls run on the payer's OpenRouter key,
 * and each media model the payer pointed at an upstream, with the availability the payer's keys give it, beside every
 * upstream's name on screen.
 * @param projectId - The Project.
 * @param userId - The caller, a member of it.
 * @returns The plan, with no key, sealed text or hint.
 * @throws {NotFoundError} When the caller is not on the Project.
 */
export async function readKeyPlan(projectId: string, userId: string): Promise<KeyPlan> {
  await assertAccess(projectId, userId, "viewer");
  const studioId = await projectsRepo.findOwnerStudioId(projectId);
  const plan = studioId === undefined ? null : await studioKeyPlan(studioId);
  const payer = plan === null || plan.payerUserId === userId ? "self" : "admin";
  const upstreamNames = Object.fromEntries(Object.keys(provider().config.upstreams).map((u) => [u, listingOf(u).name]));
  if (plan === null || ring() === null) return { payer, llm: { usesAccountKey: false }, models: {}, upstreamNames };
  const bindings = mediaBindings();
  const models: KeyPlan["models"] = {};
  for (const [model, upstream] of Object.entries(plan.models)) {
    if (!bindings.has(model)) continue;
    models[model] = { upstream, availability: provider().availability(model, heldOnly(upstream)) };
  }
  return { payer, llm: { usesAccountKey: plan.upstreams.includes(ACCOUNT_LLM_UPSTREAM) }, models, upstreamNames };
}
