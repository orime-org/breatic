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
import {
  pictureErrorMessage,
  uploadPicture,
} from '@web/pages/studio/shared/upload-picture';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { slugFieldShowsConflict } from '@web/pages/studio/container/dialogs/use-slug-availability';
import { studioTabPath } from '@web/pages/studio/container/studio-tabs';
import {
  applyPersonalStudio,
  useCurrentUserStore,
} from '@web/stores/current-user';
import type { Studio, StudioDetail, UpdateStudioInput } from '@breatic/shared';

/** One studio edit, with the slug field's check when it changes the slug. */
interface StudioSave {
  patch: UpdateStudioInput;
  slugFieldShown?: () => boolean;
}

/** The settings tab's write actions and their in-flight state. */
export interface StudioSettingsActions {
  /**
   * Save an edit. A slug change passes whether the slug field holding the sent
   * slug is still on screen; while it is, a slug taken in the meantime is left
   * to that field instead of a toast.
   */
  save: (patch: UpdateStudioInput, slugFieldShown?: () => boolean) => void;
  uploadAvatar: (image: Blob) => void;
  /** Clear the avatar; `onSuccess` runs once it is gone (the confirmation closes there). */
  removeAvatar: (options?: { onSuccess?: () => void }) => void;
  leave: () => void;
  /** Drop a stale avatar failure — the picker closing means it is done with. */
  clearAvatarError: () => void;
  /** Any studio edit is in flight — the basic-info form holds its fields read-only. */
  saving: boolean;
  /**
   * The in-flight edit is NOT a slug change — the name and description Save
   * spins off this one, so a rename does not make it claim to be saving.
   */
  savingDetails: boolean;
  /**
   * The in-flight edit is a SLUG change specifically.
   *
   * The rename dialog draws a spinner off this one, and ignores a press of its
   * Confirm button off `saving`. Keeping them apart matters in both directions:
   * a spinner is a claim about what is running, so the broad flag would have
   * the rename button claim to be renaming during a name save; and the guard
   * has to be the broad one, or a rename fires while another patch is still
   * out and two ride the single mutation at once.
   */
  renaming: boolean;
  uploadingAvatar: boolean;
  removingAvatar: boolean;
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
   * @returns Settles once the mounted studio read has refetched; a save whose
   *   button stays on screen awaits it, so the button keeps waiting until the
   *   studio shows what was saved, and not on unrelated reads (inner#1374).
   */
  const absorb = React.useCallback(
    (next: Studio): Promise<void> => {
      const renamed = next.slug !== studio.slug;
      if (renamed) {
        // Remove, never invalidate: the old slug is already gone server-side.
        queryClient.removeQueries({ queryKey: ['studio', studio.slug] });
      }
      // A studio's name, slug and avatar ride along in reads keyed by things
      // other than the studio (recent projects, the credits overlay's lists),
      // so mark everything stale: mounted reads refetch now, the rest on their
      // next mount. Only the studio read is waited on: it is what the settings
      // fields and the avatar are drawn from. `cancelRefetch: false` joins the
      // refetch the invalidation just started instead of restarting it.
      void queryClient.invalidateQueries();
      const refetched = queryClient.refetchQueries(
        { queryKey: ['studio', next.slug], exact: true, type: 'active' },
        { cancelRefetch: false },
      );

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
      return refetched;
    },
    [navigate, queryClient, studio.slug, studio.type],
  );

  const updateMutation = useMutation({
    mutationFn: ({ patch }: StudioSave) =>
      studiosApi.update(studio.slug, patch),
    // Awaited: until the studio refetch lands the fields still differ from
    // the stale studio, so Save would read as unsaved and live again.
    onSuccess: async (next) => {
      await absorb(next);
      toast.success(t('studio.container.settings.saved'));
    },
    // On the mutation itself, so it still runs after the settings tab has
    // unmounted mid-request.
    onError: async (err, { patch, slugFieldShown }) => {
      const shownByField =
        patch.slug !== undefined &&
        slugFieldShown !== undefined &&
        (await slugFieldShowsConflict(
          queryClient,
          err,
          patch.slug,
          slugFieldShown,
        ));
      if (!shownByField) {
        toast.error(messageFor(err));
      }
    },
  });

  const avatarMutation = useMutation({
    mutationFn: async (image: Blob) => {
      const assetId = await uploadPicture(image, {
        studioId: studio.id,
        purpose: 'studio_avatar',
      });
      return studiosApi.setAvatar(studio.slug, assetId);
    },
    // Cleared when a new attempt starts, not only when one succeeds: otherwise
    // a failure leaves the message set for good, and the next crop dialog opens
    // already showing an error about an upload the user has moved on from.
    onMutate: () => setAvatarError(null),
    // Awaited: the crop dialog stays open and busy until the studio refetch
    // shows the new avatar (inner#1374).
    onSuccess: async (next) => {
      await absorb(next);
      toast.success(t('studio.container.settings.avatarSaved'));
    },
    // Kept in state rather than only a toast: the crop dialog stays open on
    // failure so the user can retry without redoing their crop, and the reason
    // belongs next to the retry button.
    onError: (err) =>
      setAvatarError(
        pictureErrorMessage(err, t, {
          storage: 'studio.container.settings.avatarUploadError.storage',
          upload: 'studio.container.settings.avatarUploadError.upload',
        }),
      ),
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => studiosApi.removeAvatar(studio.slug),
    // Awaited: the confirmation closes once this settles, and until the
    // studio refetch lands the Remove entry is still on screen (inner#1374).
    onSuccess: async (next) => {
      await absorb(next);
      toast.success(t('studio.container.settings.avatarRemoved'));
    },
    onError: (err) => toast.error(messageFor(err)),
  });

  const leaveMutation = useMutation({
    mutationFn: () => studiosApi.leave(studio.slug),
    onSuccess: () => {
      // Every page of this studio would now answer 403.
      queryClient.removeQueries({ queryKey: ['studio', studio.slug] });
      // Its projects also sit in reads keyed elsewhere (recent projects, the
      // credits overlay's lists).
      void queryClient.invalidateQueries();
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
    (patch: UpdateStudioInput, slugFieldShown?: () => boolean): void =>
      mutateUpdate({ patch, slugFieldShown }),
    [mutateUpdate],
  );
  const uploadAvatar = React.useCallback(
    (image: Blob): void => mutateAvatar(image),
    [mutateAvatar],
  );
  const removeAvatar = React.useCallback(
    (options?: { onSuccess?: () => void }): void =>
      mutateRemoveAvatar(undefined, options),
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
    savingDetails:
      updateMutation.isPending && updateMutation.variables?.patch.slug === undefined,
    // Read off the patch that is actually out, so this answers "a rename is
    // running" rather than "something is running". `variables` holds the
    // arguments of the request in flight.
    renaming:
      updateMutation.isPending && updateMutation.variables?.patch.slug !== undefined,
    uploadingAvatar: avatarMutation.isPending,
    removingAvatar: removeAvatarMutation.isPending,
    leaving: leaveMutation.isPending,
    avatarError,
  };
}
