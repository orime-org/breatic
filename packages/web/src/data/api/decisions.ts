// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one client for answering any waiting request.
 *
 * Replaces the two invite-specific clients: a studio invite, a project invite,
 * either transfer and a role upgrade are all read and answered the same way,
 * and the caller never has to know which it is holding.
 */

import { apiGet, apiPost } from '@web/data/api/request';
import type {
  DecisionAction,
  DecisionResult,
  DecisionView,
} from '@breatic/shared';

export const decisionsApi = {
  /**
   * Reads what a decision link points at.
   * @param token - The token from the link.
   * @returns What to render, including which of the dead ends it is in.
   */
  view(token: string): Promise<DecisionView> {
    return apiGet<DecisionView>(`/decisions/${encodeURIComponent(token)}`);
  },

  /**
   * Answers the request.
   *
   * The token travels in the body rather than the path, matching the server:
   * it is the part worth keeping out of logs and referrers.
   * @param token - The token from the link.
   * @param action - Confirm or decline.
   * @returns What it settled into, and where to go next.
   */
  respond(token: string, action: DecisionAction): Promise<DecisionResult> {
    return apiPost<DecisionResult>('/decisions/respond', { token, action });
  },
};
