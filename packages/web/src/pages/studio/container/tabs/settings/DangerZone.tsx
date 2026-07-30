// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { useTranslation } from '@web/i18n/use-translation';
import { TransferStudioSection } from '@web/pages/studio/container/tabs/settings/TransferStudioSection';
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { StudioMember } from '@web/pages/studio/container/container-types';

interface DangerZoneProps {
  studio: StudioDetail;
  members: readonly StudioMember[];
  leaving: boolean;
  onLeave: () => void;
}

const DANGER_BUTTON =
  'h-[30px] rounded-chrome border border-status-error-foreground px-3 text-xs font-medium text-status-error-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The governance actions that cannot be undone.
 *
 * Rendered for any member of a TEAM studio, with the contents split by role
 * rather than the whole box hidden from non-admins. That split is the point:
 * the admin's irreversible action is handing the studio over or deleting it,
 * and the non-admin's is walking away from it — and the person who most needs
 * the leave button is precisely the person an admin-only box would hide it
 * from.
 *
 * A personal studio has none of these: there is no one to transfer to, nothing
 * to leave, and deleting it would delete the account's own identity.
 * @param props - The studio, its members and the leave wiring.
 * @param props.studio - The studio being governed.
 * @param props.members - The studio's members (the transfer picker's source).
 * @param props.leaving - Whether a leave request is in flight.
 * @param props.onLeave - Called once the user confirms leaving.
 * @returns The danger zone, or nothing for a personal studio.
 */
export function DangerZone({
  studio,
  members,
  leaving,
  onLeave,
}: DangerZoneProps): React.JSX.Element | null {
  const t = useTranslation();
  const [confirmingLeave, setConfirmingLeave] = React.useState(false);

  if (studio.type !== 'team' || studio.myStudioRole === null) return null;
  const isAdmin = studio.myStudioRole === 'admin';

  return (
    <section className='flex flex-col gap-2 rounded-chrome border border-status-error-foreground p-4'>
      <h3 className='text-sm font-bold text-status-error-foreground'>
        {t('studio.container.settings.dangerTitle')}
      </h3>
      <p className='text-xs text-muted-foreground'>
        {isAdmin
          ? t('studio.container.settings.dangerHint')
          : t('studio.container.settings.dangerHintMember')}
      </p>
      <div className='mt-1 flex gap-2.5'>
        {isAdmin ? (
          <>
            <TransferStudioSection slug={studio.slug} members={members} />
            <button type='button' className={DANGER_BUTTON}>
              {t('studio.container.settings.delete')}
            </button>
          </>
        ) : (
          <button
            type='button'
            className={DANGER_BUTTON}
            disabled={leaving}
            onClick={() => setConfirmingLeave(true)}
            data-testid='settings-leave-open'
          >
            {t('studio.container.settings.leave')}
          </button>
        )}
      </div>

      <AlertDialog open={confirmingLeave} onOpenChange={setConfirmingLeave}>
        <AlertDialogContent data-testid='settings-leave-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('studio.container.settings.leaveTitle', {
                studio: studio.name,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('studio.container.settings.leaveBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className='list-disc pl-5 text-xs text-muted-foreground'>
            <li>{t('studio.container.settings.leaveLosesProjects')}</li>
            <li>{t('studio.container.settings.leaveHandsOver')}</li>
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('studio.container.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onLeave}
              data-testid='settings-leave-confirm'
            >
              {t('studio.container.settings.leave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
