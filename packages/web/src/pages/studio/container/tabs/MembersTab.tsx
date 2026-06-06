// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface MembersTabProps {
  members: readonly StudioMember[];
  /** Invite / remove / role changes are Admin-only (DD §5.2). */
  studioRole: StudioRole;
}

/**
 * The Members tab (spec §3.7) — team studios only. Lists members (avatar /
 * name / email / studio role / join date). The "Invite member" action and
 * per-member remove are shown only to studio Admins (DD §5.2); a plain
 * Member sees a read-only roster.
 * @param props the members and the viewer's studio role.
 * @param props.members the studio members.
 * @param props.studioRole the viewer's studio role.
 * @returns the Members tab content.
 */
export function MembersTab({
  members,
  studioRole,
}: MembersTabProps): React.JSX.Element {
  const t = useTranslation();
  const isAdmin = studioRole === 'admin';
  return (
    <div className='flex max-w-3xl flex-col gap-4'>
      {isAdmin ? (
        <div>
          <button
            type='button'
            className='rounded-chrome bg-[var(--brand-accent)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90'
          >
            {t('studio.container.members.invite')}
          </button>
        </div>
      ) : null}
      <table className='w-full text-left text-sm'>
        <thead className='text-xs text-muted-foreground'>
          <tr>
            <th className='py-1 font-medium'>
              {t('studio.container.members.colName')}
            </th>
            <th className='py-1 font-medium'>
              {t('studio.container.members.colEmail')}
            </th>
            <th className='py-1 font-medium'>
              {t('studio.container.members.colRole')}
            </th>
            <th className='py-1 font-medium'>
              {t('studio.container.members.colJoined')}
            </th>
            {isAdmin ? <th className='py-1' /> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} className='border-t border-border'>
              <td className='py-2'>
                <span className='flex items-center gap-2'>
                  <span
                    aria-hidden='true'
                    className='flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground'
                  >
                    {member.name.slice(0, 1).toUpperCase()}
                  </span>
                  {member.name}
                </span>
              </td>
              <td className='py-2 text-muted-foreground'>{member.email}</td>
              <td className='py-2'>
                {member.studioRole === 'admin'
                  ? t('studio.container.members.roleAdmin')
                  : t('studio.container.members.roleMember')}
              </td>
              <td className='py-2 text-muted-foreground'>
                {member.joinedAt.slice(0, 10)}
              </td>
              {isAdmin ? (
                <td className='py-2 text-right'>
                  <button
                    type='button'
                    className='text-xs text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  >
                    {t('studio.container.members.remove')}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
