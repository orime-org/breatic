/**
 * Project Spaces API client (v10 §10.4 / §10.5).
 *
 * Spaces have NO PG table — server only validates permission, generates
 * the spaceId, and publishes a Redis pub/sub event that Collab applies
 * as `meta.spaces[spaceId] = {...}`. The frontend pairs the API 201
 * with a meta-doc Y.Map observer to render the new tab once Yjs sync
 * lands (typically 50–200ms).
 *
 * V1 only `canvas` is implemented; the server returns 422 for
 * `document` / `timeline` until those kinds ship.
 */

import { request } from '@/utils/request';
import type { ApiResponse, SpaceType } from '@breatic/shared';

/**
 * `POST /api/v1/projects/:projectId/spaces`
 *
 * @returns the new Space `{ id, type, name }`. The Yjs sync that
 *   surfaces it under `meta.spaces[id]` is asynchronous — observe the
 *   meta doc to know when the entry has actually arrived.
 */
export const create = (
  projectId: string,
  body: { type: SpaceType; name: string },
) =>
  request<ApiResponse<{ id: string; type: SpaceType; name: string }>>({
    url: `/api/v1/projects/${projectId}/spaces`,
    method: 'post',
    data: body,
  });

/**
 * `DELETE /api/v1/projects/:projectId/spaces/:spaceId`
 *
 * Soft-deletes the corresponding `yjs_documents` row server-side and
 * publishes `space:deleted` so Collab removes
 * `meta.spaces[spaceId]`. The lock-state check is enforced at the
 * frontend UX layer; the API does not read the meta doc.
 */
export const remove = (projectId: string, spaceId: string) =>
  request<ApiResponse<{ ok: true }>>({
    url: `/api/v1/projects/${projectId}/spaces/${spaceId}`,
    method: 'delete',
  });
