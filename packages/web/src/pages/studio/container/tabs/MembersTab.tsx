// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import type {
  StudioRole,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

interface MembersTabProps {
  members: readonly StudioMember[];
  /** Invite / remove / role changes are Admin-only (DD §5.2); `null` = guest. */
  studioRole: StudioRole | null;
  /**
   * Personal studios are permanently single-member (decision A, 2026-06-08): the tab
   * is read-only — no invite button, no per-member actions.
   */
  studioType: StudioType;
}

/**
 * The Members tab (spec §3.7). Lists members (avatar / name / email / studio
 * role / join date). For a **team** studio the "Invite member" action + the
 * per-member row menu show to Admins only (DD §5.2). A **personal** studio is
 * single-member: a read-only roster (just the creator) with no invite and no row
 * actions, plus a note that personal studios cannot invite (decision A, 2026-06-08).
 * @param props the members, the viewer's studio role and the studio type.
 * @param props.members the studio members.
 * @param props.studioRole the viewer's studio role.
 * @param props.studioType whether the studio is personal or team.
 * @returns the Members tab content.
 */
export function MembersTab({
  members,
  studioRole,
  studioType,
}: MembersTabProps): React.JSX.Element {
  const t = useTranslation();
  // Manage = invite + per-member actions. Off for personal studios (always
  // single-member) and for non-admins.
  const canManage = studioRole === 'admin' && studioType === 'team';
  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-4'>
      {canManage ? (
        <div>
          <Button type='button'>
            {t('studio.container.members.invite')}
          </Button>
        </div>
      ) : studioType === 'personal' ? (
        <p className='text-xs text-muted-foreground'>
          {t('studio.container.members.cannotInvitePersonal')}
        </p>
      ) : null}
      <table className='w-full text-left text-sm'>
        <thead className='text-xs text-muted-foreground'>
          <tr>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colName')}
            </th>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colJoined')}
            </th>
            <th className='pb-2 font-medium'>
              {t('studio.container.members.colRole')}
            </th>
            {canManage ? <th className='pb-2' /> : null}
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
                {canManage ? (
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
