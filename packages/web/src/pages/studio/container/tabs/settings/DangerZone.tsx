// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { ChangeSlugSection } from '@web/pages/studio/container/tabs/settings/ChangeSlugSection';
import { DANGER_BUTTON } from '@web/pages/studio/container/tabs/settings/danger-button';
import { TransferStudioSection } from '@web/pages/studio/container/tabs/settings/TransferStudioSection';
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import type { UpdateStudioInput } from '@breatic/shared';

interface DangerZoneProps {
  studio: StudioDetail;
  members: readonly StudioMember[];
  leaving: boolean;
  onLeave: () => void;
  /** Whether any settings save is in flight — holds the slug entry back. */
  saving: boolean;
  /** Whether a SLUG change in particular is in flight — draws its spinner. */
  renaming: boolean;
  onSave: (patch: UpdateStudioInput) => void;
}

/**
 * The actions that cannot be taken back.
 *
 * Each cell carries its own condition rather than the box carrying one for all
 * of them:
 *
 * | Cell            | Shown when                                |
 * | --------------- | ----------------------------------------- |
 * | Change Slug     | the viewer is the admin, any studio type  |
 * | Transfer/Delete | a TEAM studio, and the viewer is admin    |
 * | Leave           | a TEAM studio, and the viewer is not      |
 *
 * Changing the slug is gated on the role alone because that is the server's
 * own gate; leaning on "a personal studio has one member" would be inferring
 * the same answer from something that only happens to be true.
 *
 * A personal studio does render this box, holding that one action. Transfer,
 * delete and leave are all meaningless for one — there is nobody to hand it
 * to, deleting it would delete the account's own identity, and you cannot walk
 * out on yourself — but that is a fact about those three actions, not about
 * the box. A personal studio's slug IS its owner's handle, and changing it
 * breaks every link to them and frees the name for the next claimant.
 * @param props - The studio, its members, and the leave and save wiring.
 * @param props.studio - The studio being governed.
 * @param props.members - The studio's members (the transfer picker's source).
 * @param props.leaving - Whether a leave request is in flight.
 * @param props.onLeave - Called once the user confirms leaving.
 * @param props.saving - Whether any settings save is in flight.
 * @param props.renaming - Whether a slug change in particular is in flight.
 * @param props.onSave - Called with the slug patch once a rename is confirmed.
 * @returns The danger zone, or nothing when the viewer has no action in it.
 */
export function DangerZone({
  studio,
  members,
  leaving,
  onLeave,
  saving,
  renaming,
  onSave,
}: DangerZoneProps): React.JSX.Element | null {
  const t = useTranslation();
  const [confirmingLeave, setConfirmingLeave] = React.useState(false);

  const isAdmin = studio.myStudioRole === 'admin';
  const isTeam = studio.type === 'team';
  const canChangeSlug = isAdmin;
  const canGovern = isTeam && isAdmin;
  const canLeave = isTeam && !isAdmin;

  if (studio.myStudioRole === null) return null;
  if (!canChangeSlug && !canGovern && !canLeave) return null;

  return (
    <section className='flex flex-col gap-2 rounded-chrome border border-status-error-foreground p-4'>
      <h3 className='text-sm font-bold text-status-error-foreground'>
        {t('studio.container.settings.dangerTitle')}
      </h3>
      <p className='text-xs text-muted-foreground'>
        {isAdmin
          ? isTeam
            ? t('studio.container.settings.dangerHint')
            : t('studio.container.settings.dangerHintPersonal')
          : t('studio.container.settings.dangerHintMember')}
      </p>
      <div className='mt-1 flex flex-wrap gap-2.5'>
        {canGovern ? (
          <>
            <TransferStudioSection slug={studio.slug} members={members} />
            <Button
              type='button'
              variant={null}
              size={null}
              className={DANGER_BUTTON}
              data-testid='settings-delete'
            >
              {t('studio.container.settings.delete')}
            </Button>
          </>
        ) : null}
        {canChangeSlug ? (
          <ChangeSlugSection
            studio={studio}
            saving={saving}
            renaming={renaming}
            onSave={onSave}
          />
        ) : null}
        {canLeave ? (
          <Button
            type='button'
            variant={null}
            size={null}
            className={DANGER_BUTTON}
            disabled={leaving}
            onClick={() => setConfirmingLeave(true)}
            data-testid='settings-leave-open'
          >
            {t('studio.container.settings.leave')}
          </Button>
        ) : null}
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
