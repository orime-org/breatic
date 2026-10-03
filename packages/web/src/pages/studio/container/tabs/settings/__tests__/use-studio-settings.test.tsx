// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';

import { useStudioSettings } from '@web/pages/studio/container/tabs/settings/use-studio-settings';
import { studiosApi } from '@web/data/api/studios';
import { UploadFailedError } from '@web/data/upload/media-upload';
import { useCurrentUserStore } from '@web/stores/current-user';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { creditOverviewKey } from '@web/features/credits/use-credit-overview';
import type { Studio, StudioDetail } from '@breatic/shared';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    update: vi.fn(),
    setAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    leave: vi.fn(),
  },
}));
const { uploadPicture } = vi.hoisted(() => ({ uploadPicture: vi.fn() }));
vi.mock('@web/pages/studio/shared/upload-picture', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadPicture,
}));
const { recheckSlugTaken } = vi.hoisted(() => ({ recheckSlugTaken: vi.fn() }));
vi.mock('@web/pages/studio/container/dialogs/use-slug-availability', () => ({
  recheckSlugTaken,
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

describe('useStudioSettings — telling a rename apart from any other save', () => {
  it('says no rename is running before anything has been saved', () => {
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });
    expect(result.current.renaming).toBe(false);
  });

  it('says no rename is running while a NAME save is out', async () => {
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ name: 'Acme Inc' });

    await waitFor(() => expect(result.current.saving).toBe(true));
    expect(result.current.renaming).toBe(false);
  });

  it('says a rename is running while the SLUG save is out', async () => {
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-renamed' });

    await waitFor(() => expect(result.current.renaming).toBe(true));
  });

  it('stops saying so once the rename has failed', async () => {
    // The variables of the last mutation survive its settling, so "the patch
    // in flight carried a slug" keeps answering yes afterwards. Only the
    // in-flight half tells a finished rename from a running one — without it
    // the confirm button would sit there spinning over a rename that came back
    // 409 several seconds ago.
    vi.mocked(studiosApi.update).mockRejectedValue(new Error('taken'));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-renamed' });

    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.renaming).toBe(false);
  });

  it('counts a rename queued behind a lost connection as still running', async () => {
    // Offline, React Query holds the mutation in `pending` and calls nothing;
    // it will send once the connection returns. So reporting it as running is
    // honest, and — since nothing locks on this any more — it costs at most a
    // spinner over a request that has not left yet.
    onlineManager.setOnline(false);
    try {
      vi.mocked(studiosApi.update).mockResolvedValue(
        updated(TEAM, { slug: 'acme-renamed' }),
      );
      const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

      result.current.save({ slug: 'acme-renamed' });

      await waitFor(() => expect(result.current.saving).toBe(true));
      expect(studiosApi.update).not.toHaveBeenCalled();
      expect(result.current.renaming).toBe(true);
    } finally {
      onlineManager.setOnline(true);
    }
  });
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

describe('useStudioSettings — every other read that shows the studio', () => {
  // Reads keyed outside `['studio', slug]` that carry this studio's name, slug
  // or avatar: the recent page's project cards and the credits overlay's
  // studio lists.
  const ELSEWHERE = [
    ['studios', 'recent'],
    ['studios', 'mine', 'u1'],
    creditOverviewKey('u1'),
  ];

  /**
   * Seed the reads that live outside the studio's own keys.
   */
  function seedElsewhere(): void {
    for (const key of ELSEWHERE) client.setQueryData(key, []);
  }

  /**
   * Assert every seeded read was marked stale.
   */
  async function expectElsewhereStale(): Promise<void> {
    await waitFor(() => {
      for (const key of ELSEWHERE) {
        expect(client.getQueryState(key)?.isInvalidated, String(key)).toBe(true);
      }
    });
  }

  it('marks them stale after a name save', async () => {
    seedElsewhere();
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { name: 'Acme Inc' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ name: 'Acme Inc' });

    await expectElsewhereStale();
  });

  it('marks them stale after a slug change', async () => {
    seedElsewhere();
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { slug: 'acme-co' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-co' });

    await expectElsewhereStale();
  });

  it('marks them stale after a new avatar', async () => {
    seedElsewhere();
    uploadPicture.mockResolvedValue('asset-1');
    vi.mocked(studiosApi.setAvatar).mockResolvedValue(
      updated(TEAM, { avatarUrl: 'https://cdn.test/a.png' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.uploadAvatar(new Blob(['x']));

    await expectElsewhereStale();
  });

  it('marks them stale after the avatar is removed', async () => {
    seedElsewhere();
    vi.mocked(studiosApi.removeAvatar).mockResolvedValue(
      updated(TEAM, { avatarUrl: null }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.removeAvatar();

    await expectElsewhereStale();
  });

  it('marks them stale after leaving the studio', async () => {
    // The recent page would otherwise keep offering the left studio's
    // projects, each of which now answers 403.
    seedElsewhere();
    vi.mocked(studiosApi.leave).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.leave();

    await expectElsewhereStale();
  });
});

describe('useStudioSettings — changing the slug', () => {
  it('moves to the new address, replacing history so Back cannot reach the dead one', async () => {
    vi.mocked(studiosApi.update).mockResolvedValue(
      updated(TEAM, { slug: 'acme-co' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.save({ slug: 'acme-co' });

    // The settings segment is not decoration. A rename happens WHILE the user
    // is standing in Settings, and the tab now lives in the address — so an
    // address without it is an instruction to leave, which is the opposite of
    // what just happened. This used to be `/studio/acme-co` and was correct
    // then: the tab was component state, and state survives a param change.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/studio/acme-co/settings', {
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
      personalStudio: { name: 'Alice', slug: 'alice', avatarUrl: null },
      membershipTier: 'base',
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
      personalStudio: { name: 'Alice', slug: 'alice', avatarUrl: null },
      membershipTier: 'base',
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
    uploadPicture.mockResolvedValue('asset-1');
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      personalStudio: { name: 'Alice', slug: 'alice', avatarUrl: null },
      membershipTier: 'base',
    });
    vi.mocked(studiosApi.setAvatar).mockResolvedValue(
      updated(PERSONAL, { avatarUrl: 'https://cdn/a.webp' }),
    );
    const { result } = renderHook(() => useStudioSettings(PERSONAL), {
      wrapper,
    });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/png' }));

    await waitFor(() =>
      expect(useCurrentUserStore.getState().user?.avatarUrl).toBe(
        'https://cdn/a.webp',
      ),
    );
  });
});

describe('useStudioSettings — the avatar is an asset', () => {
  beforeEach(() => {
    uploadPicture.mockReset();
  });

  it('uploads the crop to the studio\'s own assets and points the studio at the row', async () => {
    uploadPicture.mockResolvedValue('asset-1');
    vi.mocked(studiosApi.setAvatar).mockResolvedValue(
      updated(TEAM, { avatarUrl: 'https://cdn/a.png' }),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });
    const image = new Blob(['x'], { type: 'image/png' });

    result.current.uploadAvatar(image);

    await waitFor(() => expect(studiosApi.setAvatar).toHaveBeenCalledWith('acme', 'asset-1'));
    expect(uploadPicture).toHaveBeenCalledWith(image, {
      studioId: 's1',
      purpose: 'studio_avatar',
    });
  });

  it('says the storage is full when the account has no room', async () => {
    uploadPicture.mockRejectedValue(new UploadFailedError('storage'));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/png' }));

    await waitFor(() =>
      expect(result.current.avatarError).toBe(
        'Storage is full. The avatar was not uploaded.',
      ),
    );
    expect(studiosApi.setAvatar).not.toHaveBeenCalled();
  });
});

describe('useStudioSettings — avatar error lifetime', () => {
  beforeEach(() => {
    uploadPicture.mockReset();
    uploadPicture.mockResolvedValue('asset-1');
  });

  it('clears a previous failure when the next attempt starts', async () => {
    // Clearing only on success left the message set for good: the next crop
    // dialog opened already showing an error about an upload the user had
    // moved on from.
    vi.mocked(studiosApi.setAvatar).mockRejectedValueOnce(
      new Error('boom'),
    );
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/png' }));
    await waitFor(() => expect(result.current.avatarError).not.toBeNull());

    vi.mocked(studiosApi.setAvatar).mockResolvedValueOnce(
      updated(TEAM, { avatarUrl: 'https://cdn/new.webp' }),
    );
    result.current.uploadAvatar(new Blob(['y'], { type: 'image/png' }));

    await waitFor(() => expect(result.current.avatarError).toBeNull());
  });

  it('drops the error when the picker is dismissed, not only on the next upload', async () => {
    // Clearing on the next upload alone is one step too late. Someone who
    // gives up on a failed image closes the dialog, opens it again with a
    // different one, and is greeted by the old message — it survives until
    // they press Confirm, which is the one moment the bug never showed. The
    // error belongs to an attempt, and dismissing ends that attempt.
    vi.mocked(studiosApi.setAvatar).mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });

    result.current.uploadAvatar(new Blob(['x'], { type: 'image/png' }));
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
      personalStudio: { name: 'Alice', slug: 'alice', avatarUrl: null },
      membershipTier: 'base',
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

describe('useStudioSettings — a slug save the server refuses with 409', () => {
  const conflict = (): ApiException =>
    new ApiException({ status: 409, message: 'Conflict', fromServer: true });

  it('leaves the slug field to say it is taken, with no toast', async () => {
    vi.mocked(studiosApi.update).mockRejectedValue(conflict());
    recheckSlugTaken.mockResolvedValue(true);
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });
    result.current.save({ slug: 'acme-renamed' });
    await waitFor(() =>
      expect(recheckSlugTaken).toHaveBeenCalledWith(client, 'acme-renamed'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still says what went wrong when the slug turns out to be free', async () => {
    vi.mocked(studiosApi.update).mockRejectedValue(conflict());
    recheckSlugTaken.mockResolvedValue(false);
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });
    result.current.save({ slug: 'acme-renamed' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conflict'));
  });

  it('still says what went wrong when the recheck itself fails', async () => {
    vi.mocked(studiosApi.update).mockRejectedValue(conflict());
    recheckSlugTaken.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });
    result.current.save({ slug: 'acme-renamed' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conflict'));
  });

  it('does not recheck a 409 on a save that left the slug alone', async () => {
    vi.mocked(studiosApi.update).mockRejectedValue(conflict());
    const { result } = renderHook(() => useStudioSettings(TEAM), { wrapper });
    result.current.save({ name: 'Acme 2' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conflict'));
    expect(recheckSlugTaken).not.toHaveBeenCalled();
  });
});
