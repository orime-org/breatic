// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Package } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';

/**
 * The Works tab (spec §6.2) — a placeholder empty shell. "Works" are the
 * finished products a project publishes (a video, a mini-game, …); they have
 * NO data model today. The real entity (data model / publish flow / visibility
 * / heterogeneous artifacts / lifecycle) is deferred to a dedicated DD + Works
 * slice (IA #267 §9/§13); this tab only holds the 3rd navigation slot with a
 * fixed empty state — zero backend calls, zero business props, same nature as
 * the other stub tabs.
 * @returns the Works tab empty state.
 */
export function WorksTab(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex flex-col items-center justify-center gap-2 py-16 text-center'>
      <Package className='h-8 w-8 text-muted-foreground' aria-hidden='true' />
      <p className='text-sm font-medium text-foreground'>
        {t('studio.container.works.empty')}
      </p>
      <p className='max-w-sm text-sm text-muted-foreground'>
        {t('studio.container.works.emptyHint')}
      </p>
    </div>
  );
}
