// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What has to happen around a studio edit, especially a slug change.
 *
 * A slug change is the awkward one: the address the user is standing on stops
 * existing the moment it succeeds. The old slug is released immediately — no
 * redirect, no alias — so everything keyed by it has to be dealt with in the
 * same breath, and dealt with by REMOVING rather than invalidating, since an
 * invalidated query refetches and the refetch is a guaranteed 404.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useStudioSettings } from '@web/pages/studio/container/tabs/settings/use-studio-settings';
import { studiosApi } from '@web/data/api/studios';
import { useCurrentUserStore } from '@web/stores/current-user';
import type { Studio, StudioDetail } from '@breatic/shared';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    update: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    leave: vi.fn(),
  },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const TEAM: StudioDetail = {
  id: 's1',
  slug: 'acme',
  name: 'Acme',
  type: 'team',
  avatarUrl: null,
  bio: null,
  memberCount: 3,
  myStudioRole: 'admin',
};

const PERSONAL: StudioDetail = {
  ...TEAM,
  id: 's2',
  slug: 'alice',
  name: 'Alice',
  type: 'personal',
  memberCount: 1,
};

/**
 * Build the updated studio the server would answer with.
 * @param base - The studio before the edit.
 * @param patch - The changed fields.
 * @returns The updated studio.
 */
function updated(base: StudioDetail, patch: Partial<Studio>): Studio {
  return {
    ...base,
    createdByUserId: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...patch,
  } as Studio;
}

let client: QueryClient;

/**
 * Provider wrapper carrying a fresh query client per test.
 * @param props - Children to wrap.
 * @param props.children - The subtree under the query client.
 * @returns The wrapped subtree.
 */
function wrapper({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useCurrentUserStore.getState().clear();
});

describe('useStudioSettings — editing name and bio', () => {
  it('keeps the user where they are when the slug did not change', async () => {
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { name: 'Acme Inc' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ name: 'Acme Inc' });

    await waitFor(() =>
      expect(studiosApi.update).toHaveBeenCalledWith('acme', {
        name: 'Acme Inc',
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refreshes the studio itself and the rail listing it', async () => {
    client.setQueryData(['studio', 'acme'], TEAM);
    client.setQueryData(['studios', 'user'], [TEAM]);
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { name: 'Acme Inc' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ name: 'Acme Inc' });

    await waitFor(() =>
      expect(
        client.getQueryState(['studio', 'acme'])?.isInvalidated,
      ).toBe(true),
    );
    expect(client.getQueryState(['studios', 'user'])?.isInvalidated).toBe(true);
  });
});

describe('useStudioSettings — changing the slug', () => {
  it('moves to the new address, replacing history so Back cannot reach the dead one', async () => {
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { slug: 'acme-co' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-co' });

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/studio/acme-co', {
        replace: true,
      }),
    );
  });

  it('REMOVES the old slug\'s cache rather than invalidating it', async () => {
    client.setQueryData(['studio', 'acme'], TEAM);
    client.setQueryData(['studio', 'acme', 'projects'], []);
    client.setQueryData(['studio', 'acme', 'members'], []);
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { slug: 'acme-co' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-co' });

    // Invalidating would schedule a refetch of an address that no longer
    // exists, so the user would land on their renamed studio and watch it 404.
    await waitFor(() =>
      expect(client.getQueryData(['studio', 'acme'])).toBeUndefined(),
    );
    expect(client.getQueryData(['studio', 'acme', 'projects'])).toBeUndefined();
    expect(client.getQueryData(['studio', 'acme', 'members'])).toBeUndefined();
  });

  it('leaves an unrelated studio\'s cache alone', async () => {
    client.setQueryData(['studio', 'other'], TEAM);
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { slug: 'acme-co' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-co' });

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(client.getQueryData(['studio', 'other'])).toBeDefined();
  });

  it('updates the signed-in user when their PERSONAL studio is renamed', async () => {
    // A personal studio's slug is the user's @handle, shown in the account
    // menu — leaving the store alone would keep showing the old one until a
    // full reload.
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      personalStudio: { name: 'Alice', slug: 'alice' },
    });
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(PERSONAL, { slug: 'alice-new', name: 'Alice' }),
    );
    const { result } = renderHook(() => useStudioSettings(PERSONAL), {
      wrapper,
    });

    result.current.save({ slug: 'alice-new' });

    await waitFor(() =>
      expect(
        useCurrentUserStore.getState().user?.personalStudio?.slug,
      ).toBe('alice-new'),
    );
  });

  it('does NOT touch the signed-in user when a TEAM studio is renamed', async () => {
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      personalStudio: { name: 'Alice', slug: 'alice' },
    });
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { slug: 'acme-co' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-co' });

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(useCurrentUserStore.getState().user?.personalStudio?.slug).toBe(
      'alice',
    );
  });

  it('reflects a new avatar on the signed-in user too', async () => {
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      personalStudio: { name: 'Alice', slug: 'alice' },
    });
    vi.mocked(studiosApi.uploadAvatar).mockResolvedValue(
      updated(PERSONAL, { avatarUrl: 'https://cdn/a.webp' }),
    );
    const { result } = renderHook(() => useStudioSettings(PERSONAL), {
      wrapper,
    });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/webp' }));

    await waitFor(() =>
      expect(useCurrentUserStore.getState().user?.avatarUrl).toBe(
        'https://cdn/a.webp',
      ),
    );
  });
});

describe('useStudioSettings — avatar error lifetime', () => {
  it('clears a previous failure when the next attempt starts', async () => {
    // Clearing only on success left the message set for good: the next crop
    // dialog opened already showing an error about an upload the user had
    // moved on from.
    vi.mocked(studiosApi.uploadAvatar).mockRejectedValueOnce(
      new Error('boom'),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/webp' }));
    await waitFor(() => expect(result.current.avatarError).not.toBeNull());

    vi.mocked(studiosApi.uploadAvatar).mockResolvedValueOnce(
      updated(TEAM, { avatarUrl: 'https://cdn/new.webp' }),
    );
    result.current.uploadAvatar(new Blob(['y'], { type: 'image/webp' }));

    await waitFor(() => expect(result.current.avatarError).toBeNull());
  });

  it('drops the error when the picker is dismissed, not only on the next upload', async () => {
    // Clearing on the next upload alone is one step too late. Someone who
    // gives up on a failed image closes the dialog, opens it again with a
    // different one, and is greeted by the old message — it survives until
    // they press Confirm, which is the one moment the bug never showed. The
    // error belongs to an attempt, and dismissing ends that attempt.
    vi.mocked(studiosApi.uploadAvatar).mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/webp' }));
    await waitFor(() => expect(result.current.avatarError).not.toBeNull());

    result.current.clearAvatarError();

    await waitFor(() => expect(result.current.avatarError).toBeNull());
  });
});

describe('useStudioSettings — callback stability', () => {
  it('hands back the same callbacks across renders', async () => {
    // They used to depend on the mutation OBJECT, which React Query rebuilds
    // every render — so every callback was new every render, and every child
    // they are passed to re-rendered for nothing.
    const { result, rerender } = renderHook(() => useStudioSettings(TEAM), {
      wrapper,
    });
    const first = {
      save: result.current.save,
      uploadAvatar: result.current.uploadAvatar,
      removeAvatar: result.current.removeAvatar,
      leave: result.current.leave,
    };

    rerender();

    expect(result.current.save).toBe(first.save);
    expect(result.current.uploadAvatar).toBe(first.uploadAvatar);
    expect(result.current.removeAvatar).toBe(first.removeAvatar);
    expect(result.current.leave).toBe(first.leave);
  });
});

describe('useStudioSettings — leaving', () => {
  it('sends the user to their own studio and drops the one they left', async () => {
    client.setQueryData(['studio', 'acme'], TEAM);
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      personalStudio: { name: 'Alice', slug: 'alice' },
    });
    vi.mocked(studiosApi.leave).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.leave();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/studio/alice', {
        replace: true,
      }),
    );
    // They are no longer a member, so the studio's cached pages would 403.
    expect(client.getQueryData(['studio', 'acme'])).toBeUndefined();
  });

  it('falls back to the studio index when the user has no personal studio cached', async () => {
    vi.mocked(studiosApi.leave).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.leave();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/studio', { replace: true }),
    );
  });
});
