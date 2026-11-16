// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The oidc-provider adapter (#1488 §5.2): one instance per model, every
 * record in core's `oauth_records` table.
 *
 * Two places differ from a plain store:
 *
 * - `find` on a `RefreshToken` consumed less than
 *   `oauth.refresh_reuse_grace_seconds` ago answers it as unconsumed, so
 *   several sessions of one agent refreshing with the same token all get new
 *   ones. Outside the window the library voids the whole grant
 *   (`lib/actions/grants/refresh_token.js`).
 * - `destroy` on a `Grant` ends it through {@link endGrant}. oidc-provider
 *   destroys a Grant only from `lib/helpers/revoke.js`, which emits
 *   `grant.revoked` after the record is gone and without awaiting listeners,
 *   so the connection row, the downstream tokens and the collab announcement
 *   are handled here, before the response is sent, while the record still
 *   says whose grant it was. The source is the route revoking it:
 *   `/oauth/revoke` is the client's own revocation, anything else (a reused
 *   refresh token or authorization code at the token endpoint) is reuse.
 */

import Provider, { type Adapter, type AdapterPayload } from "oidc-provider";
import { getMcpConfig, logger, oauthRecordsRepo } from "@breatic/core";
import type { OAuthRecordEntity } from "@breatic/shared";
import { endGrant } from "@server/modules/agent-access/agent-access.service.js";

/**
 * The payload oidc-provider reads back, with `consumed` set from the column.
 * @param model - The adapter model name.
 * @param record - The stored record.
 * @returns The payload, or undefined when there is no record.
 */
function toPayload(model: string, record: OAuthRecordEntity | undefined): AdapterPayload | undefined {
  if (!record) return undefined;
  const payload = record.payload as AdapterPayload;
  if (record.consumedAt === null) return payload;
  const graceMs = getMcpConfig().oauth.refresh_reuse_grace_seconds * 1000;
  if (model === "RefreshToken" && Date.now() - record.consumedAt.getTime() < graceMs) return payload;
  return { ...payload, consumed: Math.floor(record.consumedAt.getTime() / 1000) };
}

/** Stores one oidc-provider model in `oauth_records`. */
export class OAuthRecordsAdapter implements Adapter {
  /**
   * An adapter for one model.
   * @param model - The model name oidc-provider passes (`Grant`, `RefreshToken`, ...).
   */
  constructor(private readonly model: string) {}

  /**
   * Store a record.
   * @param id - Its id.
   * @param payload - What oidc-provider stores.
   * @param expiresIn - Lifetime in seconds; omitted never expires.
   * @throws {Error} When the database write fails.
   */
  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    await oauthRecordsRepo.upsert(this.model, id, payload, expiresIn);
  }

  /**
   * Find a live record by id.
   * @param id - Its id.
   * @returns The payload, or undefined.
   * @throws {Error} When the database read fails.
   */
  async find(id: string): Promise<AdapterPayload | undefined> {
    return toPayload(this.model, await oauthRecordsRepo.find(this.model, id));
  }

  /**
   * Find a live record by uid (sessions and interactions).
   * @param uid - Its uid.
   * @returns The payload, or undefined.
   * @throws {Error} When the database read fails.
   */
  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return toPayload(this.model, await oauthRecordsRepo.findByUid(this.model, uid));
  }

  /**
   * Device flow is off, so nothing is ever stored by user code.
   * @returns Always undefined.
   */
  async findByUserCode(): Promise<undefined> {
    return undefined;
  }

  /**
   * Mark a record used up.
   * @param id - Its id.
   * @throws {Error} When the database write fails.
   */
  async consume(id: string): Promise<void> {
    await oauthRecordsRepo.consume(this.model, id);
  }

  /**
   * Delete a record; a Grant is ended through {@link endGrant}.
   * @param id - Its id.
   * @throws {Error} When the database or Redis write fails.
   */
  async destroy(id: string): Promise<void> {
    if (this.model !== "Grant") {
      await oauthRecordsRepo.destroy(this.model, id);
      return;
    }
    const source = Provider.ctx?.oidc.route === "revocation" ? "client_revoked" : "reuse_detected";
    const outcome = await endGrant(id, source);
    const ctx = { userId: outcome.userId, grantId: id, connectionId: outcome.connectionId, source };
    logger.info({ ...ctx, connectionDeleted: outcome.connectionDeleted }, "mcp_credential_revoked");
    if (outcome.signalFailure !== undefined) {
      logger.error({ err: outcome.signalFailure, ctx }, "mcp_credential_revoked_signal_failed");
    }
  }

  /**
   * Delete this model's records of a grant. The grant itself is ended by
   * `destroy`, which oidc-provider calls beside this (`revokeGrantPolicy` is
   * always true); this call must not touch the Grant record, or `destroy`
   * could no longer tell whose grant it was.
   * @param grantId - The grant.
   * @throws {Error} When the database write fails.
   */
  async revokeByGrantId(grantId: string): Promise<void> {
    await oauthRecordsRepo.revokeByGrantId(grantId, this.model);
  }
}
