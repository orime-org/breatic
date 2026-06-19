// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Package } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { CENTER_COLUMN } from '@web/pages/studio/container/container-layout';

/**
 * The non-member center view (spec §6.3) — what a non-member (`myStudioRole ===
 * null`, decision A: the studio is a public façade returning 200 + null) sees
 * inside someone else's studio: a "Works" section title and a "no published
 * works" empty state, with **no tabs at all**. It has zero backend dependency
 * (a fixed empty state); since nothing of the studio's data is rendered,
 * private content cannot leak (IA #267 §6.4). The real published-works gallery
 * arrives with the Works slice (IA §6.2).
 * @returns the non-member center view.
 */
export function NonMemberView(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className={`${CENTER_COLUMN} pt-[18px] pb-12`}>
      <h2 className='text-base font-semibold tracking-tight text-foreground'>
        {t('studio.container.nonMember.worksTitle')}
      </h2>
      <div className='flex flex-col items-center justify-center gap-2 py-16 text-center'>
        <Package className='h-8 w-8 text-muted-foreground' aria-hidden='true' />
        <p className='max-w-sm text-sm text-muted-foreground'>
          {t('studio.container.nonMember.empty')}
        </p>
      </div>
    </div>
  );
}
