// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Archive } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@web/components/ui/button';
import { projectsApi } from '@web/data/api';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { isStudioProjectsListKey } from '@web/pages/project/use-rename-project';

interface ArchivedBannerProps {
  projectId: string;
  /** Whether this reader may restore it (the studio's admin). */
  canRestore: boolean;
}

/**
 * The strip across the top of an archived project: it says the project can
 * only be viewed, and gives a studio admin the restore button.
 *
 * It sits in the page flow above the top bar rather than overlaying it,
 * because it stays for as long as the project is archived. A restore refetches
 * the project, which takes the banner away; the members' connections are
 * dropped by the server and come back writable on their own.
 * @param props - The project and whether the reader may restore it.
 * @param props.projectId - The archived project.
 * @param props.canRestore - Whether to show the restore button.
 * @returns The banner.
 */
export function ArchivedBanner({ projectId, canRestore }: ArchivedBannerProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () => projectsApi.restore(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({
        predicate: (query) => isStudioProjectsListKey(query.queryKey),
      });
      void queryClient.invalidateQueries({ queryKey: ['studios', 'recent'] });
      toast.success(t('project.archived.restored'));
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      toast.error(t('project.archived.restoreFailed'), { description: message || undefined });
    },
  });
  const { mutate } = restore;
  const onRestore = React.useCallback((): void => mutate(), [mutate]);

  return (
    <div
      role='status'
      data-testid='archived-banner'
      className='flex h-10 shrink-0 items-center justify-center gap-3 border-b border-border bg-muted px-3 text-sm text-foreground'
    >
      <Archive className='h-4 w-4 shrink-0 text-muted-foreground' aria-hidden='true' />
      <span className='truncate'>{t('project.archived.banner')}</span>
      {canRestore ? (
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={restore.isPending}
          onClick={onRestore}
        >
          {t('project.archived.restore')}
        </Button>
      ) : null}
    </div>
  );
}
