// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `usersApi.getByIds` wraps `apiGet`, which already unwraps the `{ data }`
// envelope, so the mock resolves directly to the raw row array.
vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from '@web/data/api/request';
import { usersApi } from '@web/data/api/users';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usersApi.getByIds (#1375: profile fetch + snake_case mapping)', () => {
  it('maps raw rows to UserSummary (username → name, avatar_url → avatarUrl)', async () => {
    vi.mocked(apiGet).mockResolvedValue([
      { id: 'u1', email: 'a@x.com', username: 'Alice', avatar_url: 'a.png' },
    ]);

    const result = await usersApi.getByIds(['u1']);

    expect(result).toEqual([
      { id: 'u1', name: 'Alice', email: 'a@x.com', avatarUrl: 'a.png' },
    ]);
    // The ids are joined into the comma-separated `ids` query param.
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/users', {
      params: { ids: 'u1' },
    });
  });

  it('falls back to the email local-part when username is null', async () => {
    vi.mocked(apiGet).mockResolvedValue([
      { id: 'u2', email: 'bob@example.com', username: null, avatar_url: null },
    ]);

    const result = await usersApi.getByIds(['u2']);

    // username:null (user mid-onboarding) → name = email local-part;
    // avatar_url:null maps to undefined (optional field).
    expect(result).toEqual([
      { id: 'u2', name: 'bob', email: 'bob@example.com', avatarUrl: undefined },
    ]);
  });

  it('joins multiple ids and never returns more than requested', async () => {
    vi.mocked(apiGet).mockResolvedValue([
      { id: 'u1', email: 'a@x.com', username: 'Alice', avatar_url: null },
      { id: 'u2', email: 'b@x.com', username: 'Bob', avatar_url: null },
    ]);

    await usersApi.getByIds(['u1', 'u2']);

    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/users', {
      params: { ids: 'u1,u2' },
    });
  });

  it('returns [] WITHOUT calling the API when ids is empty', async () => {
    const result = await usersApi.getByIds([]);

    expect(result).toEqual([]);
    expect(vi.mocked(apiGet)).not.toHaveBeenCalled();
  });
});
