// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { MoreHorizontal } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface MembersTabProps {
  members: readonly StudioMember[];
  /** Invite / remove / role changes are Admin-only (DD §5.2); `null` = guest. */
  studioRole: StudioRole | null;
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
            className='rounded-chrome bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90'
          >
            {t('studio.container.members.invite')}
          </button>
        </div>
      ) : null}
      <table className='w-full text-left text-sm'>
        <thead className='text-xs text-muted-foreground'>
          <tr className='border-b border-border'>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colName')}
            </th>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colJoined')}
            </th>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colRole')}
            </th>
            {isAdmin ? <th className='pb-2' /> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const admin = member.studioRole === 'admin';
            return (
              <tr key={member.id} className='border-t border-border'>
                {/* Member: avatar + name over email (locked mock .mrow .who). */}
                <td className='py-2.5'>
                  <span className='flex items-center gap-3'>
                    <span
                      aria-hidden='true'
                      className='flex h-8 w-8 items-center justify-center rounded-full bg-[var(--neutral-200)] text-[13px] font-bold text-[var(--neutral-600)]'
                    >
                      {member.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className='flex min-w-0 flex-col'>
                      <span className='truncate font-semibold text-foreground'>
                        {member.name}
                      </span>
                      <span className='truncate text-xs text-muted-foreground'>
                        {member.email}
                      </span>
                    </span>
                  </span>
                </td>
                <td className='py-2.5 font-mono text-xs text-muted-foreground'>
                  {member.joinedAt.slice(0, 10)}
                </td>
                <td className='py-2.5'>
                  <span
                    className={`inline-flex h-5 min-w-[64px] items-center justify-center rounded-content-sm border border-border bg-background px-2 text-[11px] font-semibold ${
                      admin ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {admin
                      ? t('studio.container.members.roleAdmin')
                      : t('studio.container.members.roleMember')}
                  </span>
                </td>
                {isAdmin ? (
                  <td className='py-2.5 text-right'>
                    <button
                      type='button'
                      aria-label={t('studio.container.members.remove')}
                      className='inline-flex h-7 w-7 items-center justify-center rounded-content-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                    >
                      <MoreHorizontal className='h-4 w-4' />
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
