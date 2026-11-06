// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { BookOpen, CircleHelp, ExternalLink, Mail } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { SUPPORT_EMAIL, TUTORIALS_URL } from '@web/lib/official-home';

/**
 * The top bar's Help menu, the same in the Studio and Project top bars: the
 * user manual on the official website and a message to the support mailbox.
 * @returns The Help trigger and its menu.
 */
export function HelpMenu(): React.JSX.Element {
  const t = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={t('chrome.help.trigger')}
          data-testid='help-menu-trigger'
        >
          <CircleHelp className='h-[18px] w-[18px]' />
        </Button>
      </DropdownMenuTrigger>
      {/* 8, not the primitive's 6: the bell, language and theme panels beside
          this one hang 8 below their triggers, so they all open level. */}
      <DropdownMenuContent align='end' sideOffset={8} data-testid='help-menu'>
        <DropdownMenuItem asChild>
          <a href={TUTORIALS_URL} target='_blank' rel='noopener noreferrer'>
            <BookOpen aria-hidden='true' />
            {t('chrome.help.manual')}
            <ExternalLink className='ml-auto !size-3.5 text-muted-foreground' aria-hidden='true' />
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          {/* Opened beside this page: a mail link in this document would run the
              project page's leave guard and ask the reader to leave first. */}
          <a href={`mailto:${SUPPORT_EMAIL}`} target='_blank' rel='noopener noreferrer' className='items-start'>
            <Mail className='mt-0.5' aria-hidden='true' />
            <span className='flex flex-col'>
              <span>{t('chrome.help.contact')}</span>
              <span className='text-xs text-muted-foreground'>{SUPPORT_EMAIL}</span>
            </span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
