// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModelAvailability } from '@breatic/shared';

import { apiDelete, apiGet, apiPost, apiPut } from '@web/data/api/request';

/** Which group an upstream is listed under (inner#1953). */
export type ByokUpstreamKind = 'llm' | 'official' | 'reseller';

/** One upstream the deployment lists. */
export interface ByokUpstream {
  upstream: string;
  name: string;
  kind: ByokUpstreamKind;
  /** Where the upstream hands out keys; null when it publishes no such page. */
  keyUrl: string | null;
}

/** What the last check could tell about a key's balance. */
export type ByokBalanceState = 'known' | 'forbidden' | 'no_cap' | 'unsupported';

/** One saved key, as the server answers it: never the key itself. */
export interface ByokSavedKey {
  upstream: string;
  displayHint: string;
  lastConnected: boolean;
  lastCheckedAt: string;
  lastBalanceState: ByokBalanceState | null;
  lastBalanceAmount: string | null;
  /** The ISO 4217 code of the balance; null when the upstream reported none. */
  lastBalanceCurrency: string | null;
  lastFailure: string | null;
  /** Whether the key can read the actual costs of its calls; false is said in its detail, null has no such probe. */
  costsReadable: boolean | null;
}

/** The account's BYOK settings, as `GET /account/byok` answers them. */
export interface ByokView {
  /** False where the deployment has no master key to seal keys with. */
  enabled: boolean;
  upstreams: ByokUpstream[];
  keys: ByokSavedKey[];
  /** The upstream each model is pointed at; a model left out runs on the platform key. */
  models: { model: string; upstream: string }[];
  /** For each media model, the upstreams holding a key of this account that can run it. */
  choices?: Record<string, string[]>;
}

/** Whose key a project's runs use and, per model on that key, where it runs. */
export interface KeyPlan {
  /** The viewer's own key, or the Studio admin's. */
  payer: 'self' | 'admin';
  /** The account that pays for the Studio; null when it has none. */
  payerUserId: string | null;
  /** Whether language model calls run on the payer's OpenRouter key. */
  llm: { usesAccountKey: boolean };
  /** Non-language models on the payer's key, with the availability counted on that payer's keys. */
  models: Record<string, { upstream: string; availability: ModelAvailability }>;
  /** Each upstream's name on screen, for a failure that names the upstream a key failed on. */
  upstreamNames: Record<string, string>;
}

export const byokApi = {
  /**
   * Read the account's BYOK settings.
   * @returns The view.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  view(): Promise<ByokView> {
    return apiGet<ByokView>('/account/byok');
  },

  /**
   * Save or replace a key; the server checks it first and answers 422 with the reason when it does not connect.
   * @param upstream - The upstream id.
   * @param key - What the input shows.
   * @returns The saved key.
   * @throws {import('@web/data/api/types').ApiException} When the key does not connect or the request fails.
   */
  saveKey(upstream: string, key: string): Promise<ByokSavedKey> {
    return apiPut<ByokSavedKey, { key: string }>(`/account/byok/keys/${encodeURIComponent(upstream)}`, { key });
  },

  /**
   * Check a saved key again.
   * @param upstream - The upstream id.
   * @returns The checked key.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  checkKey(upstream: string): Promise<ByokSavedKey> {
    return apiPost<ByokSavedKey>(`/account/byok/keys/${encodeURIComponent(upstream)}/check`);
  },

  /**
   * Delete a key and every model choice pointing at it.
   * @param upstream - The upstream id.
   * @returns Nothing.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  deleteKey(upstream: string): Promise<void> {
    return apiDelete(`/account/byok/keys/${encodeURIComponent(upstream)}`);
  },

  /**
   * Point a model at an upstream, or back at the platform key with null.
   * @param model - The model's name.
   * @param upstream - The upstream id, or null.
   * @returns Nothing.
   * @throws {import('@web/data/api/types').ApiException} When the choice is refused or the request fails.
   */
  setModel(model: string, upstream: string | null): Promise<void> {
    return apiPut<void, { upstream: string | null }>(`/account/byok/models/${encodeURIComponent(model)}`, { upstream });
  },

  /**
   * Read whose key the runs in a project use.
   * @param projectId - The project.
   * @returns The plan.
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  keyPlan(projectId: string): Promise<KeyPlan> {
    return apiGet<KeyPlan>(`/projects/${encodeURIComponent(projectId)}/key-plan`);
  },
};
