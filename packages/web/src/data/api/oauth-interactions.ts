// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the consent page reads and sends for an external agent's
 * authorization (#1488 §5.3). The browser also carries the authorization
 * server's interaction cookie, which ties these calls to the browser that
 * started the authorization.
 */

import type { OAuthInteractionResult, OAuthInteractionView } from '@breatic/shared';
import { apiGet, apiPost } from '@web/data/api/request';

export const oauthInteractionsApi = {
  /**
   * Who is asking to connect.
   * @param uid - The interaction.
   * @returns The agent's name and where the answer goes.
   * @throws {import('@web/data/api/types').ApiException} 404 when the request is gone, or any failed read.
   */
  view(uid: string): Promise<OAuthInteractionView> {
    return apiGet<OAuthInteractionView>(`/oauth/interactions/${encodeURIComponent(uid)}`);
  },

  /**
   * Allow the agent.
   * @param uid - The interaction.
   * @returns Where the browser goes next.
   * @throws {import('@web/data/api/types').ApiException} 404 when the request is gone, or any failed call.
   */
  confirm(uid: string): Promise<OAuthInteractionResult> {
    return apiPost<OAuthInteractionResult>(`/oauth/interactions/${encodeURIComponent(uid)}/confirm`, {});
  },

  /**
   * Refuse the agent.
   * @param uid - The interaction.
   * @returns Where the browser goes next.
   * @throws {import('@web/data/api/types').ApiException} 404 when the request is gone, or any failed call.
   */
  abort(uid: string): Promise<OAuthInteractionResult> {
    return apiPost<OAuthInteractionResult>(`/oauth/interactions/${encodeURIComponent(uid)}/abort`, {});
  },
};
