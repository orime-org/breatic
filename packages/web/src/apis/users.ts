/**
 * Users API client — batch display-info lookup (v10 §7.2.6).
 *
 * The frontend joins `useProjectMembers` (role relation) with the
 * output of this client to render avatar / username / email per
 * member. Backed by `GET /api/v1/users?ids=`.
 */

import { request } from '@/utils/request';
import type { ApiResponse } from '@breatic/shared';

/** Public display fields returned by the batch endpoint. */
export interface UserDisplay {
  id: string;
  email: string;
  username: string | null;
  avatar_url: string | null;
}

/**
 * Look up display info for many users in one call. Caps server-side
 * at 100 ids; pass at most 100 (the rest are silently dropped).
 */
export const batchGet = (ids: string[]) => {
  const idsParam = ids.slice(0, 100).join(',');
  return request<ApiResponse<UserDisplay[]>>({
    url: '/api/v1/users',
    method: 'get',
    params: { ids: idsParam },
  });
};
