// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Opening, disabling and enabling influencers for the back office
 * (inner#2157 design 7.6). Every decision, refusals included, is kept under
 * the request's idempotency key: the same key and body replay it, another
 * body under the key is a conflict.
 */

import { commerceOutboxRepo, cookieDomainHost, db, influencerRepo } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import * as operationRepo from "@server/modules/influencer/influencer-operation.repo.js";
import type { InfluencerDecision } from "@server/modules/influencer/influencer-operation.repo.js";
import { OFFICIAL_INFLUENCER } from "@server/modules/auth/influencer-code.js";
import { wakeCommerceRelay } from "@server/modules/commerce/commerce-relay.js";

/** A finite internal answer. */
export type InfluencerAnswer =
  | { status: 200; body: InfluencerDecision }
  | { status: 404; body: { code: "not_found" } }
  | { status: 409; body: { code: "idempotency_conflict" } };

/** The signed request identity every write carries. */
export interface InfluencerRequest { key: string; hash: string; adminId: string }

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host as a browser's `Origin` would carry it, when it is one label
 * directly under `partner.<cookieDomainHost()>`.
 * @param host - The host the back office registered.
 * @returns The normalised host, or null when it is not an influencer site.
 */
export function influencerHost(host: string): string | null {
  const domain = cookieDomainHost();
  if (domain === "") return null;
  let normalised: string;
  try {
    normalised = new URL(`https://${host}`).hostname;
  } catch {
    return null;
  }
  const suffix = `.partner.${domain}`;
  if (!normalised.endsWith(suffix)) return null;
  return LABEL.test(normalised.slice(0, -suffix.length)) ? normalised : null;
}

/**
 * Run one keyed decision: replay or conflict on a used key, otherwise decide
 * and keep the decision in the same transaction.
 * @param request - The signed request identity.
 * @param body - The request body, kept with the decision.
 * @param decide - Makes the decision and its effects.
 * @returns The answer.
 * @throws {Error} When any write fails; the transaction rolls back.
 */
async function keyed(
  request: InfluencerRequest,
  body: Record<string, unknown>,
  decide: (tx: DbTx) => Promise<{ result: InfluencerDecision; appended?: boolean }>,
): Promise<InfluencerAnswer> {
  let appended = false;
  const answer = await db.transaction(async (tx): Promise<InfluencerAnswer> => {
    await operationRepo.lockOperationKey(request.key, tx);
    const previous = await operationRepo.findOperation(request.key, tx);
    if (previous !== null) return previous.requestHash === request.hash
      ? { status: 200, body: previous.result } : { status: 409, body: { code: "idempotency_conflict" } };
    const decided = await decide(tx);
    const result = decided.result;
    appended = decided.appended === true;
    await operationRepo.insertOperation({ ...request, body, result }, tx);
    return { status: 200, body: result };
  });
  if (appended) wakeCommerceRelay();
  return answer;
}

/**
 * Register an influencer and its site.
 * @param request - The signed request identity.
 * @param body - The code and host.
 * @param body.code - The influencer code.
 * @param body.host - The site's host.
 * @returns `created`, or `refused` with `host_invalid`, `code_taken` or `host_taken`.
 * @throws {Error} When the database fails.
 */
export async function open(request: InfluencerRequest, body: { code: string; host: string }): Promise<InfluencerAnswer> {
  return keyed(request, body, async (tx) => {
    const host = influencerHost(body.host);
    if (host === null) return { result: { status: "refused", code: "host_invalid" } };
    const taken = await influencerRepo.findTaken({ code: body.code, host }, tx);
    if (taken.code) return { result: { status: "refused", code: "code_taken" } };
    if (taken.host) return { result: { status: "refused", code: "host_taken" } };
    await influencerRepo.insertInfluencer({ code: body.code, host }, tx);
    return { result: { status: "created", influencer: { code: body.code, host } } };
  });
}

/**
 * Enable or disable an influencer. A real change is told to the billing
 * service, which stops counting the influencer's payments while disabled.
 * @param request - The signed request identity.
 * @param code - The influencer code.
 * @param enabled - The state to reach.
 * @returns `applied`, or `refused` with `code_unknown` or `code_official`.
 * @throws {Error} When the database fails.
 */
export async function setStatus(request: InfluencerRequest, code: string, enabled: boolean): Promise<InfluencerAnswer> {
  return keyed(request, { code, enabled }, async (tx) => {
    if (code === OFFICIAL_INFLUENCER) return { result: { status: "refused", code: "code_official" } };
    const current = await influencerRepo.lockByCode(code, tx);
    if (current === null) return { result: { status: "refused", code: "code_unknown" } };
    const result: InfluencerDecision = { status: "applied", influencer: { code, enabled } };
    if (current.enabled === enabled) return { result };
    const changedAt = new Date();
    await influencerRepo.setInfluencerDisabled(code, enabled ? null : changedAt, tx);
    return { result, appended: await commerceOutboxRepo.appendInfluencerStatus({ code, enabled, changedAt }, tx) };
  });
}

/**
 * The decision stored under a key.
 * @param key - The idempotency key.
 * @returns It, or not found.
 * @throws {Error} When the database read fails.
 */
export async function operation(key: string): Promise<InfluencerAnswer> {
  const previous = await operationRepo.findOperation(key);
  return previous === null ? { status: 404, body: { code: "not_found" } } : { status: 200, body: previous.result };
}
