// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Archive } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { useProjectActions } from '@web/features/project-manage/use-project-actions';
import { useTranslation } from '@web/i18n/use-translation';

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
 * because it stays for as long as the project is archived. Restore is the same
 * action the studio card offers; it refetches the project, which takes the
 * banner away, and the members' connections are dropped by the server and
 * come back writable on their own.
 * @param props - The project and whether the reader may restore it.
 * @param props.projectId - The archived project.
 * @param props.canRestore - Whether to show the restore button.
 * @returns The banner.
 */
export function ArchivedBanner({ projectId, canRestore }: ArchivedBannerProps): React.JSX.Element {
  const t = useTranslation();
  const { restore, pending } = useProjectActions(projectId);
  const onRestore = React.useCallback((): void => restore(), [restore]);

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
          disabled={pending}
          onClick={onRestore}
        >
          {t('project.archived.restore')}
        </Button>
      ) : null}
    </div>
  );
}
