// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Clock } from 'lucide-react';
import { toast } from '@web/lib/toast';
import { expiresInLabel } from '@web/lib/expires-in';

import { cn } from '@web/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Button } from '@web/components/ui/button';
import { Textarea } from '@web/components/ui/textarea';
import { roleUpgradeRequestsApi } from '@web/data/api/role-upgrade-requests';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import type { ProjectRole } from '@web/stores';

/**
 * Role → i18n key. Roles are frozen product vocabulary (#1336): the key
 * resolves to the same Title-Case English label ('Owner' / 'Editor' /
 * 'Viewer') in every locale, so the chip never localizes the role name.
 */
const ROLE_KEY: Record<ProjectRole, string> = {
  owner: 'role.owner',
  editor: 'role.editor',
  viewer: 'role.viewer',
};

interface RoleTagProps {
  role: ProjectRole;
  projectId: string;
}

/**
 * Top-bar role chip.
 *
 * - `owner` / `editor` → read-only neutral pill (cursor default).
 * - `viewer` → clickable; the popover is either the request form or, once a
 *   request is outstanding, its status and a withdraw button.
 *
 * The upgrade entry point lives on the chip rather than a separate button
 * because viewers see "Viewer" and intuitively know to click it — and the same
 * reasoning puts the PENDING state here too: a viewer who already asked looks
 * in the one place they asked from.
 *
 * The chip's own label stays the role, which is still Viewer while the request
 * waits; a clock icon replaces the arrow so the pending state is visible
 * without opening the popover.
 * @param root0 - Role tag props.
 * @param root0.role - Viewer's role in the project; decides whether the chip is read-only or clickable.
 * @param root0.projectId - Id of the project the upgrade request targets.
 * @returns a read-only role chip for owners/editors, or a clickable request-edit-access chip for viewers.
 */
export function RoleTag({ role, projectId }: RoleTagProps): React.JSX.Element {
  if (role !== 'viewer') {
    return <ReadOnlyRoleTag role={role} />;
  }
  return <ClickableViewerRoleTag projectId={projectId} />;
}

/**
 * Static role chip shown to owners and editors (no interaction).
 * @param root0 - Read-only role tag props.
 * @param root0.role - Role to label; owner text is emphasized over editor.
 * @returns the non-interactive role chip.
 */
function ReadOnlyRoleTag({ role }: { role: ProjectRole }): React.JSX.Element {
  const t = useTranslation();
  const isOwner = role === 'owner';
  return (
    <span
      data-testid='role-tag'
      className={cn(
        'inline-flex shrink-0 items-center rounded-chrome bg-muted text-2xs font-medium',
        isOwner ? 'text-foreground' : 'text-muted-foreground',
      )}
      style={{ padding: '2px var(--space-3)' }}
    >
      {t(ROLE_KEY[role])}
    </span>
  );
}

/**
 * Viewer role chip that opens a popover to request edit access.
 * @param root0 - Clickable viewer role tag props.
 * @param root0.projectId - Id of the project the role-upgrade request is submitted against.
 * @returns the clickable viewer chip with its request-edit-access popover form.
 */
function ClickableViewerRoleTag({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const liveKey = React.useMemo(
    () => ['role-upgrade-request', 'mine', projectId],
    [projectId],
  );

  const liveQuery = useQuery({
    queryKey: liveKey,
    queryFn: () => roleUpgradeRequestsApi.mine(projectId),
  });
  const live = liveQuery.data ?? null;

  const submitMutation = useMutation({
    mutationFn: (body: { message?: string }) =>
      roleUpgradeRequestsApi.submit(projectId, body),
    onSuccess: async () => {
      toast.success(t('roleTag.upgradeRequest.toast.sent'));
      setOpen(false);
      setMessage('');
      // The chip flips to its pending state off this read, so it has to happen
      // before the popover is opened again.
      await queryClient.invalidateQueries({ queryKey: liveKey });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiException ? err.message : t('roleTag.upgradeRequest.toast.failed');
      toast.error(msg);
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: (requestId: string) =>
      roleUpgradeRequestsApi.cancel(requestId),
    onSuccess: async () => {
      toast.success(t('roleTag.upgradeRequest.toast.withdrawn'));
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: liveKey });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiException
          ? err.message
          : t('roleTag.upgradeRequest.toast.withdrawFailed');
      toast.error(msg);
    },
  });

  const onWithdraw = React.useCallback(() => {
    if (live) withdrawMutation.mutate(live.id);
  }, [live, withdrawMutation]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          // The chip carries its own resting fill (`bg-muted`), which keeps
          // the default variant's fill from ever painting; `menu-item` is the
          // auto-height size, so the ~20px pill the popover offset is tuned to
          // survives.
          variant={null}
          size={null}
          type='button'
          data-testid='role-tag'
          aria-label={
            live
              ? t('roleTag.upgradeRequest.pendingAriaLabel')
              : t('roleTag.upgradeRequest.ariaLabel')
          }
          className='inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-chrome bg-muted text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
          style={{ padding: '2px var(--space-3)' }}
        >
          <span>{t(ROLE_KEY.viewer)}</span>
          {live ? (
            <Clock
              className='h-3 w-3'
              aria-hidden='true'
              data-testid='role-tag-pending-icon'
            />
          ) : (
            <ArrowUp className='h-3 w-3' aria-hidden='true' />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        // The role chip is a short pill (~20px) vs the full-height chrome
        // buttons (~32px); both are centred in the 40px top-bar row, so the
        // chip's bottom sits ~6px higher. With the default sideOffset (8) the
        // popover would open ~2px INTO the top-bar. Bump to 14 so it lands
        // 4px below the top-bar row — matching the theme/lang popovers
        // (chrome-overlay rhythm, [[project_chrome_overlay_rhythm]]).
        sideOffset={14}
        className='w-80 p-3'
        data-testid='role-tag-popover'
      >
        {live ? (
          <PendingRequest
            expiresAt={live.expiresAt}
            withdrawing={withdrawMutation.isPending}
            onWithdraw={onWithdraw}
          />
        ) : (
          <div className='flex flex-col gap-2'>
            <div className='text-sm font-medium'>
              {t('roleTag.upgradeRequest.title')}
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('roleTag.upgradeRequest.description')}
            </p>
            <Textarea
              placeholder={t('roleTag.upgradeRequest.placeholder')}
              value={message}
              maxLength={500}
              onChange={(e) => setMessage(e.target.value)}
              className='min-h-[80px] text-xs'
              data-testid='role-tag-message'
            />
            <div className='flex items-center justify-end gap-2'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setOpen(false)}
                disabled={submitMutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size='sm'
                disabled={submitMutation.isPending}
                onClick={() =>
                  submitMutation.mutate({
                    message: message.trim() || undefined,
                  })
                }
                data-testid='role-tag-submit'
              >
                {submitMutation.isPending
                  ? t('roleTag.upgradeRequest.sending')
                  : t('roleTag.upgradeRequest.submit')}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface PendingRequestProps {
  expiresAt: string;
  withdrawing: boolean;
  onWithdraw: () => void;
}

/**
 * What the chip's popover shows while a request is outstanding.
 *
 * Without this a viewer who already asked sees the request form again and has
 * no way to tell whether their first ask landed — and no way to take it back.
 * That matters more than it sounds: one live request per person per project,
 * so an unanswered one locks them out of asking again until it times out, and
 * the withdraw button is the only key.
 * @param root0 - Pending request props.
 * @param root0.expiresAt - When the request stops being answerable.
 * @param root0.withdrawing - Whether a withdrawal is in flight.
 * @param root0.onWithdraw - Called when the requester withdraws.
 * @returns the pending state with its countdown and withdraw button.
 */
function PendingRequest({
  expiresAt,
  withdrawing,
  onWithdraw,
}: PendingRequestProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex flex-col gap-2' data-testid='role-tag-pending'>
      <div className='text-sm font-medium'>
        {t('roleTag.upgradeRequest.pendingTitle')}
      </div>
      <p className='text-xs text-muted-foreground'>
        {t('roleTag.upgradeRequest.pendingDescription')}
      </p>
      <div className='flex items-center justify-between gap-2'>
        <span
          className='text-2xs text-muted-foreground'
          data-testid='role-tag-pending-expiry'
        >
          {expiresInLabel(expiresAt, t)}
        </span>
        <Button
          variant='outline'
          size='sm'
          disabled={withdrawing}
          onClick={onWithdraw}
          data-testid='role-tag-withdraw'
        >
          {withdrawing
            ? t('roleTag.upgradeRequest.withdrawing')
            : t('roleTag.upgradeRequest.withdraw')}
        </Button>
      </div>
    </div>
  );
}
