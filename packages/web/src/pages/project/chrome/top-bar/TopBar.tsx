// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowLeft, Plus, Star } from 'lucide-react';
import type * as React from 'react';
import { Link } from 'react-router-dom';

import { Logo28 } from '@web/pages/project/chrome/top-bar/Logo28';
import { TitleEditable } from '@web/pages/project/chrome/top-bar/TitleEditable';
import { MembersModal } from '@web/pages/project/chrome/top-bar/MembersModal';
import { MembersStack } from '@web/pages/project/chrome/top-bar/MembersStack';
import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { ThemeToggle } from '@web/features/preferences/ThemeToggle';
import { ShareDialog } from '@web/pages/project/chrome/top-bar/ShareDialog';
import { BellMenu } from '@web/features/notifications/BellMenu';
import { RoleTag } from '@web/pages/project/chrome/top-bar/RoleTag';
import { useTranslation } from '@web/i18n/use-translation';

import type { ProjectRole } from '@web/stores';
import type { Member } from '@web/data/api/members';

interface TopBarProps {
  projectId: string;
  projectName: string;
  role: ProjectRole;
  credits: number;
  onRename: (next: string) => void;
  onAddCredits?: () => void;
  /**
   * Real project members for the MembersStack. Omitted in tests so the
   * stack falls back to its STUB_MEMBERS default.
   */
  members?: ReadonlyArray<Member>;
  /** Current user's id, used by MembersStack to mark the "me" row. */
  currentUserId?: string;
}

/**
 * Project top bar — 10 elements per the chrome-baseline mock
 * ground truth.
 *
 * Layout (mock § TopBar v4.0):
 *   - height 40px (aligned with TabBar 40px below)
 *   - 12px horizontal padding (`--space-5`)
 *   - .left  = Logo · BackLink · TitleEditable · RoleTag
 *   - .right = 2 topbar-groups separated by `--space-3` (6px) gap:
 *       group A (4 text-icon): Members · Lang · Theme · Credits
 *       group B (2 icon-only): Share · Bell
 *
 *   (Tweaks removed 2026-05-19 per user — defaults fixed in tokens.css.)
 * @param root0 - Top-bar props.
 * @param root0.projectId - Id of the current project, passed to membership, share, role and bell children.
 * @param root0.projectName - Current project name shown in the editable title.
 * @param root0.role - Viewer's role in this project, surfaced via the role tag.
 * @param root0.credits - Current credit balance shown in the credits pill.
 * @param root0.onRename - Called with the new title when the user finishes editing the project name.
 * @param root0.onAddCredits - Called when the user clicks the add-credits button on the credits pill.
 * @param root0.members - Real project members for the MembersStack; omitted in tests for the stub fallback.
 * @param root0.currentUserId - Current user's id, used by MembersStack to mark the "me" row.
 * @returns the project chrome top bar with its left identity block and right action groups.
 */
export function TopBar({
  projectId,
  projectName,
  role,
  credits,
  onRename,
  onAddCredits,
  members,
  currentUserId,
}: TopBarProps): React.JSX.Element {
  return (
    <header
      data-testid='top-bar'
      role='banner'
      style={{ height: 40, padding: '0 var(--space-5)', gap: 'var(--space-4)' }}
      className='flex shrink-0 items-center border-b border-border bg-background'
    >
      <div
        className='flex min-w-0 flex-1 items-center'
        style={{ gap: 'var(--space-5)' }}
      >
        <Logo28 />
        <BackLink />
        <TitleEditable
          value={projectName}
          onChange={onRename}
          editable={role !== 'viewer'}
        />
        <RoleTag role={role} projectId={projectId} />
      </div>
      <div className='flex items-center' style={{ gap: 'var(--space-2)' }}>
        <div
          className='flex items-center'
          style={{ gap: 'var(--space-2)' }}
          data-testid='topbar-group-text-icon'
        >
          <MembersStack
            members={members}
            currentUserId={currentUserId}
            currentUserRole={role}
          />
          <LangSwitcher />
          <ThemeToggle />
          <CreditsPill credits={credits} onAdd={onAddCredits} />
        </div>
        <div
          className='flex items-center'
          style={{ gap: 'var(--space-2)', marginLeft: 'var(--space-3)' }}
          data-testid='topbar-group-icon-only'
        >
          {/* Share is an owner-only affordance (B model — hidden, not
              disabled, for non-owners). Backend `requireRole` enforces
              the real boundary; this hide is UX only. */}
          {role === 'owner' ? <ShareDialog projectId={projectId} /> : null}
          <BellMenu />
        </div>
      </div>
      <MembersModal
        projectId={projectId}
        members={members}
        currentUserId={currentUserId}
        currentUserRole={role}
      />
    </header>
  );
}

/**
 * Back-to-Studio navigation link rendered in the top bar's left block.
 * @returns the back link pointing to the Studio route.
 */
function BackLink(): React.JSX.Element {
  const t = useTranslation();
  return (
    <Link
      to='/studio'
      aria-label={t('chrome.aria.backToStudio')}
      data-testid='top-bar-back'
      className='inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground'
    >
      <ArrowLeft className='h-3.5 w-3.5' />
      <span>Studio</span>
    </Link>
  );
}

/**
 * Credits pill — shows the formatted credit balance with an add-credits button.
 * @param root0 - Credits pill props.
 * @param root0.credits - Current credit balance, rendered with locale grouping.
 * @param root0.onAdd - Called when the user clicks the add-credits button.
 * @returns the top-bar credits chip with its balance and add button.
 */
function CreditsPill({
  credits,
  onAdd,
}: {
  credits: number;
  onAdd?: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <span
      data-testid='credits-chip'
      aria-label={t('chrome.aria.creditsBalance')}
      className='inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-popover text-xs tabular-nums'
      style={{ padding: '0 2px 0 var(--space-4)', gap: 'var(--space-3)' }}
    >
      <Star className='h-3.5 w-3.5 text-muted-foreground' aria-hidden='true' />
      <span>{credits.toLocaleString()}</span>
      <button
        type='button'
        onClick={onAdd}
        aria-label={t('chrome.aria.addCredits')}
        className='inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-accent'
        data-testid='credits-add'
      >
        <Plus className='h-3.5 w-3.5' />
      </button>
    </span>
  );
}
