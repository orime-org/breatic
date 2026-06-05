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
    <div className='flex h-10 shrink-0 items-center gap-3 border-b border-border px-4'>
      <span
        aria-hidden='true'
        className='flex h-7 w-7 items-center justify-center rounded-md bg-[var(--brand-tint)] text-xs font-semibold text-[var(--brand-accent)]'
      >
        {initial}
      </span>
      <span className='text-sm font-semibold'>{studio.name}</span>
      <span className='rounded-full bg-[var(--brand-tint)] px-2 py-0.5 text-xs font-medium text-[var(--brand-accent)]'>
        {isTeam
          ? t('studio.container.header.teamTag')
          : t('studio.container.header.personalTag')}
      </span>
      <span className='ml-auto flex items-center gap-1.5 text-xs text-muted-foreground'>
        <span>{studio.slug}</span>
        {isTeam && studio.memberCount != null ? (
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
