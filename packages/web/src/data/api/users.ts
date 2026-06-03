// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
