// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { studiosApi } from '@web/data/api/studios';
import { useTranslation } from '@web/i18n/use-translation';
import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import { toRecentItemView } from '@web/pages/studio/recent/recent-mapper';

/**
 * The cross-studio "Recent" landing (spec §4.5) — the index child of the studio
 * layout route, rendered at `/studio` (the login-default view). `/studio` IS the
 * Recent view (URL design §5.7): Recent is per-user / account-bound, so there is
 * no `/studio/recent` URL. Renders ONLY the recent content — the rail + top bar
 * come from `StudioLayout`.
 *
 * Fetches the cross-studio recent feed (`GET /studios/recent`) and maps each
 * wire row to the card view model. Distinct states: a spinner while loading, a
 * muted error line on failure (the rail still lets the user create — they are
 * not blocked), and the data-driven landing on success (which itself shows the
 * shared empty state when the viewer has opened nothing yet). Collections are
 * deferred (V2) — that section stays empty.
 * @returns the cross-studio recent landing content.
 */
export default function StudioRecentPage(): React.JSX.Element {
  const t = useTranslation();
  const recentQuery = useQuery({
    queryKey: ['studios', 'recent'],
    queryFn: () => studiosApi.getRecent(),
  });
  const projects = React.useMemo(
    () => (recentQuery.data ?? []).map(toRecentItemView),
    [recentQuery.data],
  );

  return (
    <div className='h-full overflow-auto'>
      {recentQuery.isPending ? (
        <div className='flex h-full items-center justify-center'>
          <Loader2
            className='h-5 w-5 animate-spin text-muted-foreground'
            aria-label={t('loading')}
          />
        </div>
      ) : recentQuery.isError ? (
        <div className='flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground'>
          {t('studio.recent.loadError')}
        </div>
      ) : (
        <RecentLanding projects={projects} collections={[]} />
      )}
    </div>
  );
}
