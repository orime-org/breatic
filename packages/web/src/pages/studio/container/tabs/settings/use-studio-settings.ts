// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The write side of the studio settings tab: editing the studio, swapping its
 * avatar, and leaving it.
 *
 * These share one hook because they share the awkward part — what has to
 * happen to cached state and to the address bar afterwards. A slug change in
 * particular pulls the ground out from under the page: the old slug is
 * released immediately, with no redirect and no alias, so the address the
 * user is standing on stops existing the moment the request succeeds.
 */

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { studiosApi } from '@web/data/api/studios';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCurrentUserStore } from '@web/stores/current-user';
import type { Studio, StudioDetail, UpdateStudioInput } from '@breatic/shared';

/** The settings tab's write actions and their in-flight state. */
export interface StudioSettingsActions {
  save: (patch: UpdateStudioInput) => void;
  uploadAvatar: (image: Blob) => void;
  removeAvatar: () => void;
  leave: () => void;
  saving: boolean;
  uploadingAvatar: boolean;
  leaving: boolean;
  /** The last avatar upload failure, kept so the crop dialog can show it. */
  avatarError: string | null;
}

/**
 * Wire the settings tab's mutations, including everything that has to follow
 * a slug change.
 *
 * After a rename the hook:
 *   - moves to the new address, REPLACING the history entry, so Back cannot
 *     return to an address that now 404s;
 *   - removes every query cached under the old slug rather than invalidating
 *     it — an invalidated query refetches, and that refetch is a guaranteed
 *     404 the user would watch happen;
 *   - refreshes the rail, which lists the studio by name and links it by slug;
 *   - updates the signed-in user when it was their PERSONAL studio, since that
 *     slug is their `@handle` and their name and avatar are shown in the
 *     account menu.
 * @param studio - The studio being edited.
 * @returns The write actions and their state.
 */
export function useStudioSettings(
  studio: StudioDetail,
): StudioSettingsActions {
  const t = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [avatarError, setAvatarError] = React.useState<string | null>(null);

  /**
   * Translate a failed request into something worth reading.
   * @param err - The thrown error.
   * @returns The message to show.
   */
  const messageFor = React.useCallback(
    (err: unknown): string =>
      err instanceof ApiException
        ? err.message
        : t('studio.container.settings.saveFailed'),
    [t],
  );

  /**
   * Fold a server-confirmed studio back into everything that displays it.
   * @param next - The studio as the server now has it.
   */
  const absorb = React.useCallback(
    (next: Studio): void => {
      const renamed = next.slug !== studio.slug;
      if (renamed) {
        // Remove, never invalidate: the old slug is already gone server-side.
        queryClient.removeQueries({ queryKey: ['studio', studio.slug] });
      } else {
        void queryClient.invalidateQueries({
          queryKey: ['studio', studio.slug],
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['studios', 'user'] });

      const store = useCurrentUserStore.getState();
      const user = store.user;
      if (user !== null && studio.type === 'personal') {
        // A personal studio IS the user's display identity.
        store.setUser({
          ...user,
          name: next.name,
          avatarUrl: next.avatarUrl ?? undefined,
          personalStudio: { name: next.name, slug: next.slug },
        });
      }

      if (renamed) navigate(`/studio/${next.slug}`, { replace: true });
    },
    [navigate, queryClient, studio.slug, studio.type],
  );

  const updateMutation = useMutation({
    mutationFn: (patch: UpdateStudioInput) =>
      studiosApi.update(studio.slug, patch),
    onSuccess: (next) => {
      absorb(next);
      toast.success(t('studio.container.settings.saved'));
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  const avatarMutation = useMutation({
    mutationFn: (image: Blob) => studiosApi.uploadAvatar(studio.slug, image),
    onSuccess: (next) => {
      setAvatarError(null);
      absorb(next);
      toast.success(t('studio.container.settings.avatarSaved'));
    },
    // Kept in state rather than only a toast: the crop dialog stays open on
    // failure so the user can retry without redoing their crop, and the reason
    // belongs next to the retry button.
    onError: (err) => setAvatarError(messageFor(err)),
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => studiosApi.removeAvatar(studio.slug),
    onSuccess: (next) => {
      absorb(next);
      toast.success(t('studio.container.settings.avatarRemoved'));
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  const leaveMutation = useMutation({
    mutationFn: () => studiosApi.leave(studio.slug),
    onSuccess: () => {
      // Every page of this studio would now answer 403.
      queryClient.removeQueries({ queryKey: ['studio', studio.slug] });
      void queryClient.invalidateQueries({ queryKey: ['studios', 'user'] });
      const home = useCurrentUserStore.getState().user?.personalStudio?.slug;
      navigate(home === undefined ? '/studio' : `/studio/${home}`, {
        replace: true,
      });
      toast.success(t('studio.container.settings.leaveDone'));
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  const save = React.useCallback(
    (patch: UpdateStudioInput): void => updateMutation.mutate(patch),
    [updateMutation],
  );
  const uploadAvatar = React.useCallback(
    (image: Blob): void => avatarMutation.mutate(image),
    [avatarMutation],
  );
  const removeAvatar = React.useCallback(
    (): void => removeAvatarMutation.mutate(),
    [removeAvatarMutation],
  );
  const leave = React.useCallback(
    (): void => leaveMutation.mutate(),
    [leaveMutation],
  );

  return {
    save,
    uploadAvatar,
    removeAvatar,
    leave,
    saving: updateMutation.isPending,
    uploadingAvatar: avatarMutation.isPending,
    leaving: leaveMutation.isPending,
    avatarError,
  };
}
