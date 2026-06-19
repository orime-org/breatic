// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { ArrowUpDown, Crown, MoreHorizontal, UserMinus } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import type { StudioMember } from '@web/pages/studio/container/container-types';

interface MemberRowMenuProps {
  member: StudioMember;
  /** Whether any mutation targeting this row is in flight (disables the items). */
  pending: boolean;
  /** Promote a member to maintainer / demote a maintainer to guest (maintainer ↔ guest). */
  onToggleRole: (member: StudioMember) => void;
  /** Remove (kick) the member from the studio. */
  onRemove: (member: StudioMember) => void;
  /** Start the transfer-admin handshake to this member. */
  onTransferAdmin: (member: StudioMember) => void;
}

/**
 * The per-member row action menu (spec §3.7), Admin-only. A `⋯` trigger opens a
 * popover (the project-wide menu pattern, matching `StudioAccountMenu`) with:
 * change role (maintainer ↔ guest), remove member, and transfer admin. The admin
 * row never renders a menu (handled by the caller — an admin manages others,
 * not themselves), so every item here is safe for a non-admin target. Each item
 * closes the popover before invoking its handler so the focus returns to the
 * trigger.
 * @param props the member, pending flag and the three action callbacks.
 * @param props.member the member this row's menu acts on.
 * @param props.pending whether a mutation for this row is in flight.
 * @param props.onToggleRole called to flip the member's role (maintainer ↔ guest).
 * @param props.onRemove called to remove the member.
 * @param props.onTransferAdmin called to start the transfer-admin handshake.
 * @returns the row action menu.
 */
export function MemberRowMenu({
  member,
  pending,
  onToggleRole,
  onRemove,
  onTransferAdmin,
}: MemberRowMenuProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const isMaintainer = member.studioRole === 'maintainer';

  /**
   * Close the popover, then run the given action on the member.
   * @param action the row action to run after closing.
   */
  const runClosing = (action: (member: StudioMember) => void): void => {
    setOpen(false);
    action(member);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={t('studio.container.members.rowMenu')}
          disabled={pending}
          className='inline-flex h-7 w-7 items-center justify-center rounded-content-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
          data-testid={`member-row-menu-${member.id}`}
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-52 p-1'
        data-testid={`member-row-menu-content-${member.id}`}
      >
        <Button
          variant='ghost'
          size='menu-item'
          className='w-full justify-start'
          onClick={() => runClosing(onToggleRole)}
          data-testid={`member-toggle-role-${member.id}`}
        >
          <ArrowUpDown className='h-4 w-4' />
          {isMaintainer
            ? t('studio.container.members.demoteToGuest')
            : t('studio.container.members.promoteToMaintainer')}
        </Button>
        <Button
          variant='ghost'
          size='menu-item'
          className='w-full justify-start'
          onClick={() => runClosing(onTransferAdmin)}
          data-testid={`member-transfer-admin-${member.id}`}
        >
          <Crown className='h-4 w-4' />
          {t('studio.container.members.transferAdmin')}
        </Button>
        <Button
          variant='ghost'
          size='menu-item'
          className='w-full justify-start text-status-error-foreground hover:text-status-error-foreground'
          onClick={() => runClosing(onRemove)}
          data-testid={`member-remove-${member.id}`}
        >
          <UserMinus className='h-4 w-4' />
          {t('studio.container.members.remove')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
