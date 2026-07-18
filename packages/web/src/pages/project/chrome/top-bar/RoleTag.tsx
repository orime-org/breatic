// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { toast } from '@web/lib/toast';

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
 * - `viewer` → clickable; opens a Popover with a request-edit-access
 *   form. Submitting POSTs `/api/v1/projects/:pid/role-upgrade-requests`
 *   which lands a notification in the owner's BellMenu.
 *
 * Per spec § 6.3 — the upgrade entry point lives on RoleTag (not a
 * separate button) because viewers see "Viewer" and intuitively know
 * to click it.
 *
 * Spec: access-permission design (2026-05-28) § 6.3.
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
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState('');

  const submitMutation = useMutation({
    mutationFn: (body: { message?: string }) =>
      roleUpgradeRequestsApi.submit(projectId, body),
    onSuccess: () => {
      toast.success(t('roleTag.upgradeRequest.toast.sent'));
      setOpen(false);
      setMessage('');
    },
    onError: (err) => {
      const msg =
        err instanceof ApiException ? err.message : t('roleTag.upgradeRequest.toast.failed');
      toast.error(msg);
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-testid='role-tag'
          aria-label={t('roleTag.upgradeRequest.ariaLabel')}
          className='inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-chrome bg-muted text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
          style={{ padding: '2px var(--space-3)' }}
        >
          <span>{t(ROLE_KEY.viewer)}</span>
          <ArrowUp className='h-3 w-3' aria-hidden='true' />
        </button>
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
      </PopoverContent>
    </Popover>
  );
}
