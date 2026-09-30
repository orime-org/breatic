// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useAppUpdate } from '@web/data/deployment/use-app-update';
import type { ConnectionStatus } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/** Reload through the existing Project beforeunload guard, including its cancel path. */
function reloadProject(): void {
  window.location.reload();
}

/** Neutral, opt-in release notice. Connection errors take precedence over its popover. */
export const ProjectUpdateNotice = React.memo(function ProjectUpdateNotice({
  status,
}: { status: ConnectionStatus }): React.JSX.Element | null {
  const { version, dismiss } = useAppUpdate();
  if (!version || status === 'disconnected' || status === 'authFailed') return null;
  return <UpdatePopover key={version} onDismiss={dismiss} />;
});

/**
 * Show front-end work as context, never as a second save or confirmation mechanism.
 * @param root0 - Notice actions.
 * @param root0.onDismiss - Defer this release for the current tab.
 * @returns The release popover.
 */
function UpdatePopover({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  const t = useTranslation();
  const busy = useSpaceOperationsStore((state) => state.hasAnyOperations());
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant='chrome-ghost' size='sm' className='shrink-0 gap-1.5'
              aria-label={t('project.update.available')} data-testid='project-update-trigger'>
              <RefreshCw className='h-3.5 w-3.5' aria-hidden />
              <span className='hidden md:inline'>{t('project.update.available')}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('project.update.available')}</TooltipContent>
      </Tooltip>
      <PopoverContent align='end' className='max-w-[calc(100vw-32px)]' aria-label={t('project.update.title')}>
        <p className='text-sm font-medium'>{t('project.update.title')}</p>
        <p className='mt-2 text-sm text-muted-foreground' role='status'>
          {t(busy ? 'project.update.busy' : 'project.update.description')}
        </p>
        <div className='mt-4 flex justify-end gap-2'>
          <Button variant='ghost' size='sm' onClick={onDismiss}>{t('project.update.later')}</Button>
          <Button variant='outline' size='sm' onClick={reloadProject} data-testid='project-update-refresh'>
            {t('project.update.refresh')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
