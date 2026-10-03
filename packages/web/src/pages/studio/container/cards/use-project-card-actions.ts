// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { projectsApi } from '@web/data/api/projects';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';

/** The card menu's server-side actions, each settling with a toast. */
export interface ProjectCardActions {
  duplicate: () => void;
  archive: () => void;
  restore: () => void;
  /** True while any of the three is in flight. */
  pending: boolean;
}

/**
 * Duplicate, archive and restore for one project card.
 *
 * Every one of them changes which list a project sits in, so each success
 * refetches both of the studio's lists (live and archived share the
 * `['studio', slug, 'projects']` prefix), the Recent landing, and the project's
 * own detail for anyone who has it open. A failure toasts the server's
 * sentence, which names the reason (a full studio, an already-archived
 * project).
 * @param projectId - The project the card shows.
 * @param studioSlug - The studio whose lists the card sits in.
 * @returns The three actions and whether one is running.
 */
export function useProjectCardActions(projectId: string, studioSlug: string): ProjectCardActions {
  const t = useTranslation();
  const queryClient = useQueryClient();

  /**
   * Refetch everything that shows which list this project is in.
   */
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['studio', studioSlug, 'projects'] });
    void queryClient.invalidateQueries({ queryKey: ['studios', 'recent'] });
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  };

  /**
   * Toast a failed action with the server's own reason underneath.
   * @param title - The action's failure headline.
   * @returns The `onError` handler.
   */
  const failWith = (title: string) => (err: unknown): void => {
    const message = err instanceof Error ? err.message : '';
    toast.error(title, { description: message || undefined });
  };

  const duplicate = useMutation({
    mutationFn: () => projectsApi.duplicate(projectId),
    onSuccess: (copy) => {
      refresh();
      toast.success(t('studio.container.card.duplicated', { name: copy.name }));
    },
    onError: failWith(t('studio.container.card.duplicateFailed')),
  });
  const archive = useMutation({
    mutationFn: () => projectsApi.archive(projectId),
    onSuccess: () => {
      refresh();
      toast.success(t('studio.container.card.archived'));
    },
    onError: failWith(t('studio.container.card.archiveFailed')),
  });
  const restore = useMutation({
    mutationFn: () => projectsApi.restore(projectId),
    onSuccess: () => {
      refresh();
      toast.success(t('studio.container.card.restored'));
    },
    onError: failWith(t('studio.container.card.restoreFailed')),
  });

  return {
    duplicate: duplicate.mutate,
    archive: archive.mutate,
    restore: restore.mutate,
    pending: duplicate.isPending || archive.isPending || restore.isPending,
  };
}
