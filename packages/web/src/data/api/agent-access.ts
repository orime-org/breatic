// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signed-in user's external agents (#1488 §5): the connections the
 * settings page lists, renames and disconnects, and the personal access
 * tokens it creates.
 */

import type { AgentConnectionItem, ConnectionName, CreatedPersonalAccessToken, PersonalAccessTokenExpiryDays } from '@breatic/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';

/** The React Query key of the user's connection list. */
export const AGENT_CONNECTIONS_KEY = ['agent-access', 'connections'] as const;

/** One thread the user handed over in a Space, as the server keeps it (#1488 §11.7). */
export interface SpaceAssignment {
  threadId: string;
  connectionId: string;
  /** When it was handed over, epoch milliseconds. */
  assignedAt: number;
  status: 'pending' | 'answered';
}

/**
 * The React Query key of what the user handed over in one Space.
 * @param projectId - The project.
 * @param spaceId - The Space; left out, every Space of the project.
 * @returns The key.
 */
export function commentAssignmentsKey(projectId: string, spaceId?: string): readonly string[] {
  return spaceId === undefined ? ['comment-assignments', projectId] : ['comment-assignments', projectId, spaceId];
}

export const agentAccessApi = {
  /**
   * The user's live connections, newest first.
   * @returns The connections.
   * @throws {import('@web/data/api/types').ApiException} When the read fails.
   */
  listConnections(): Promise<AgentConnectionItem[]> {
    return apiGet<AgentConnectionItem[]>('/agent-access/connections');
  },

  /**
   * Rename a connection.
   * @param id - The connection.
   * @param name - Its new name.
   * @returns The renamed connection's id and name.
   * @throws {import('@web/data/api/types').ApiException} When the server refuses or the call fails.
   */
  rename(id: string, name: string): Promise<{ id: string; name: string }> {
    return apiPatch<{ id: string; name: string }>(`/agent-access/connections/${encodeURIComponent(id)}`, { name });
  },

  /**
   * Disconnect, remove or revoke a connection: every credential under it ends.
   * @param id - The connection.
   * @returns Nothing.
   * @throws {import('@web/data/api/types').ApiException} When the server refuses or the call fails.
   */
  async disconnect(id: string): Promise<void> {
    await apiDelete(`/agent-access/connections/${encodeURIComponent(id)}`);
  },

  /**
   * Create a personal access token.
   * @param name - Its name.
   * @param expiresInDays - How long it lasts; null never expires.
   * @returns The plaintext, shown this once, and the connection it made.
   * @throws {import('@web/data/api/types').ApiException} 409 at the live-token limit, or any failed call.
   */
  createToken(name: string, expiresInDays: PersonalAccessTokenExpiryDays): Promise<CreatedPersonalAccessToken> {
    return apiPost<CreatedPersonalAccessToken>('/agent-access/personal-access-tokens', { name, expiresInDays });
  },

  /**
   * The names of connections, anyone's and deleted ones included, so a reply
   * an external agent wrote can say which one.
   * @param ids - The connections.
   * @returns Their names, with what tells same-named ones of one owner apart; unknown ids are left out.
   * @throws {import('@web/data/api/types').ApiException} When the read fails.
   */
  connectionNames(ids: readonly string[]): Promise<ConnectionName[]> {
    return apiGet<ConnectionName[]>(
      `/agent-access/connections/names?ids=${encodeURIComponent(ids.join(','))}`,
    );
  },

  /**
   * Hand back the capture an external agent asked for (#1488 §19.1).
   * @param requestId - The request.
   * @param upload - The picture or note, and the on-screen data.
   * @param upload.image - The picture, when a Space was captured.
   * @param upload.note - What was said instead, when none was.
   * @param upload.view - The on-screen data.
   * @returns Nothing.
   * @throws {import('@web/data/api/types').ApiException} 409 when another tab answered first, 410 once expired.
   */
  async uploadViewCapture(
    requestId: string,
    upload: { image?: Blob; note?: string; view: Record<string, unknown> },
  ): Promise<void> {
    const form = new FormData();
    if (upload.image !== undefined) form.append('image', upload.image, 'view');
    if (upload.note !== undefined) form.append('note', upload.note);
    form.append('view', JSON.stringify(upload.view));
    // The instance defaults to JSON, under which axios turns a FormData body
    // into JSON; declared multipart, it sends the form and lets the browser
    // write the boundary.
    await apiPost(`/agent/view-captures/${encodeURIComponent(requestId)}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  /**
   * What the user handed over in one Space.
   * @param projectId - The project.
   * @param spaceId - The Space.
   * @returns The hand-overs.
   * @throws {import('@web/data/api/types').ApiException} When the read fails.
   */
  spaceAssignments(projectId: string, spaceId: string): Promise<SpaceAssignment[]> {
    return apiGet<SpaceAssignment[]>(
      `/comment-assignments?project_id=${encodeURIComponent(projectId)}&space_id=${encodeURIComponent(spaceId)}`,
    );
  },
};
