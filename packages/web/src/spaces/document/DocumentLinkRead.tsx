// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The face a link shows when there is nothing to type: its address, and the
 * two things that can be done to it.
 *
 * Two controls raise it — the panel over a selection that already holds a
 * link, and the toolbar a hover or the caret brings up — and both want the
 * same row, so the row lives here and each of them says what the presses mean.
 */

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { Button } from '@web/components/ui/button';
import { isLinkAddressFollowable } from '@web/spaces/document/document-link';

/**
 * The address line and the two buttons beside it.
 * @param props - The address to show and what the two presses do.
 * @param props.href - The address, as stored on the link.
 * @param props.onEdit - Run when the reader asks to change the address.
 * @param props.onRemove - Run when the reader asks to take the link off.
 * @returns The row.
 */
export function DocumentLinkRead({
  href,
  onEdit,
  onRemove,
}: {
  href: string | null;
  onEdit: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-1.5'>
      <a
        data-testid='doc-link-url'
        href={href !== null && isLinkAddressFollowable(href) ? href : undefined}
        target='_blank'
        rel='noopener noreferrer'
        className='max-w-[250px] truncate px-1 text-sm leading-[1.6] text-content-link underline underline-offset-2'
      >
        {href}
      </a>
      <Button
        variant='outline'
        size={null}
        onClick={onEdit}
        data-testid='doc-link-edit'
        className='h-[var(--btn-inline)] bg-transparent px-2.5 text-sm'
      >
        {t('spaces.document.link.edit')}
      </Button>
      <Button
        variant='outline'
        size={null}
        onClick={onRemove}
        data-testid='doc-link-remove'
        className='h-[var(--btn-inline)] bg-transparent px-2.5 text-sm'
      >
        {t('spaces.document.link.remove')}
      </Button>
    </div>
  );
}
