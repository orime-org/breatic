// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { studioTabPath } from '@web/pages/studio/container/studio-tabs';
import {
  applyPersonalStudio,
  useCurrentUserStore,
} from '@web/stores/current-user';
import type { Studio, StudioDetail, UpdateStudioInput } from '@breatic/shared';

/** The settings tab's write actions and their in-flight state. */
export interface StudioSettingsActions {
  save: (patch: UpdateStudioInput) => void;
  uploadAvatar: (image: Blob) => void;
  removeAvatar: () => void;
  leave: () => void;
  /** Drop a stale avatar failure — the picker closing means it is done with. */
  clearAvatarError: () => void;
  /** Any studio edit is in flight — the basic-info form greys itself out. */
  saving: boolean;
  /**
   * The in-flight edit is a SLUG change specifically.
   *
   * The rename dialog draws a spinner off this one, and holds its Confirm
   * button back off `saving`. Keeping them apart matters in both directions: a
   * spinner is a claim about what is running, so the broad flag would have the
   * rename button claim to be renaming during a name save; and the gate has to
   * be the broad one, or a rename fires while another patch is still out and
   * two ride the single mutation at once.
   */
  renaming: boolean;
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
        store.setUser(
          applyPersonalStudio(user, {
            name: next.name,
            slug: next.slug,
            avatarUrl: next.avatarUrl ?? null,
          }),
        );
      }

      // Back to Settings, not to the studio's front door. A rename happens
      // while the user is standing in Settings, and the tab is part of the
      // address now — so dropping the segment would move them somewhere they
      // did not ask to go, as the last step of an edit they did ask for.
      if (renamed) {
        navigate(studioTabPath(next.slug, 'settings'), { replace: true });
      }
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
    // Cleared when a new attempt starts, not only when one succeeds: otherwise
    // a failure leaves the message set for good, and the next crop dialog opens
    // already showing an error about an upload the user has moved on from.
    onMutate: () => setAvatarError(null),
    onSuccess: (next) => {
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

  // Depend on `.mutate`, not on the mutation object. React Query hands back a
  // fresh object every render, so depending on it makes every one of these
  // callbacks new every render — which defeats the point of wrapping them and
  // pushes a re-render through every child they are passed to. `.mutate` is
  // stable for the mutation's lifetime.
  const { mutate: mutateUpdate } = updateMutation;
  const { mutate: mutateAvatar } = avatarMutation;
  const { mutate: mutateRemoveAvatar } = removeAvatarMutation;
  const { mutate: mutateLeave } = leaveMutation;

  const save = React.useCallback(
    (patch: UpdateStudioInput): void => mutateUpdate(patch),
    [mutateUpdate],
  );
  const uploadAvatar = React.useCallback(
    (image: Blob): void => mutateAvatar(image),
    [mutateAvatar],
  );
  const removeAvatar = React.useCallback(
    (): void => mutateRemoveAvatar(),
    [mutateRemoveAvatar],
  );
  const leave = React.useCallback((): void => mutateLeave(), [mutateLeave]);
  // Clearing only when the NEXT upload starts is one step too late: a user who
  // gives up on a failed image and closes the dialog gets the old message
  // again the moment they open it with a different one, and it lingers until
  // they press Confirm. The error belongs to an attempt, and dismissing the
  // picker ends that attempt.
  const clearAvatarError = React.useCallback(
    (): void => setAvatarError(null),
    [],
  );

  return {
    save,
    uploadAvatar,
    removeAvatar,
    leave,
    clearAvatarError,
    saving: updateMutation.isPending,
    // Read off the patch that is actually out, so this answers "a rename is
    // running" rather than "something is running". `variables` holds the
    // arguments of the request in flight.
    renaming:
      updateMutation.isPending && updateMutation.variables?.slug !== undefined,
    uploadingAvatar: avatarMutation.isPending,
    leaving: leaveMutation.isPending,
    avatarError,
  };
}
