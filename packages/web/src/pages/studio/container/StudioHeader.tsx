// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

interface StudioHeaderProps {
  studio: StudioDetail;
}

/**
 * The studio header strip ("shead", spec §2.2) shown below the top bar inside
 * the container: studio avatar + name + a personal/team pill, with the slug
 * and (team studios only) the member count aligned right. Brand tint is
 * allowed here (spec §1.2 studio exemption); personal studios hide the member
 * count (single-member).
 * @param props the studio detail to render.
 * @param props.studio the studio detail to render.
 * @returns the studio header.
 */
export function StudioHeader({
  studio,
}: StudioHeaderProps): React.JSX.Element {
  const t = useTranslation();
  const initial = studio.name.slice(0, 1).toUpperCase();
  const isTeam = studio.type === 'team';
  return (
    <div className='flex shrink-0 items-center gap-3 px-6 pt-4'>
      <span
        aria-hidden='true'
        className='flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground'
      >
        {initial}
      </span>
      <span className='text-lg font-bold'>{studio.name}</span>
      <span className='rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground'>
        {isTeam
          ? t('studio.container.header.teamTag')
          : t('studio.container.header.personalTag')}
      </span>
      <span className='ml-auto flex items-center gap-1.5 text-xs text-muted-foreground'>
        <span className='font-mono'>{studio.slug}</span>
        {isTeam ? (
          <>
            <span aria-hidden='true'>·</span>
            <span>
              {t('studio.container.header.memberCount', {
                count: studio.memberCount,
              })}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}
