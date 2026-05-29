import { apiGet } from '@web/data/api/request';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
}

export const usersApi = {
  search(query: string) {
    return apiGet<{ users: UserSummary[] }>('/users', { params: { q: query } });
  },
};
