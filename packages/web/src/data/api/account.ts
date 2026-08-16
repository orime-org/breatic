// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { AccountMembership } from '@breatic/shared';
import { apiGet } from '@web/data/api/request';

export const accountApi = {
  /**
   * Everything the membership panel shows, for the signed-in account.
   *
   * One request behind the whole panel: the tier, what that tier grants, how
   * much of the two account-level allowances is spent, and the tiers to
   * compare against. Nothing names the account — it is the caller's.
   *
   * `limits` is `null` on the enterprise tier, whose ceilings are negotiated
   * per customer rather than configured. That is a state to render, not a
   * failure to handle.
   * @returns The account's membership as it stands.
   * @throws {ApiException} if the request fails or the session is not valid.
   */
  membership(): Promise<AccountMembership> {
    return apiGet<AccountMembership>('/account/membership');
  },
};
