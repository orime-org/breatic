import { ArrowLeft, Plus, Star } from 'lucide-react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { Logo28 } from '@/pages/project/chrome/top-bar/Logo28';
import { TitleEditable } from '@/pages/project/chrome/top-bar/TitleEditable';
import { MembersModal } from '@/pages/project/chrome/top-bar/MembersModal';
import { MembersStack } from '@/pages/project/chrome/top-bar/MembersStack';
import { LangSwitcher } from '@/pages/project/chrome/top-bar/LangSwitcher';
import { ThemeToggle } from '@/pages/project/chrome/top-bar/ThemeToggle';
import { ExportMenu } from '@/pages/project/chrome/top-bar/ExportMenu';
import { ShareDialog } from '@/pages/project/chrome/top-bar/ShareDialog';
import { BellMenu } from '@/pages/project/chrome/top-bar/BellMenu';

import type { ProjectRole } from '@/stores';

interface TopBarProps {
  projectId: string;
  projectName: string;
  role: ProjectRole;
  credits: number;
  onRename: (next: string) => void;
  onAddCredits?: () => void;
}

/**
 * Project top bar — 11 elements per `chrome-baseline-20260516`
 * finalized.html ground truth.
 *
 * Layout (mock § TopBar v4.0):
 *   - height 40px (aligned with TabBar 40px below)
 *   - 12px horizontal padding (`--space-5`)
 *   - .left  = Logo · BackLink · TitleEditable · RoleTag
 *   - .right = 2 topbar-groups separated by `--space-3` (6px) gap:
 *       group A (4 text-icon): Members · Lang · Theme · Credits
 *       group B (3 icon-only): Export · Share · Bell
 *
 *   (Tweaks removed 2026-05-19 per user — defaults fixed in tokens.css.)
 */
export function TopBar({
  projectId,
  projectName,
  role,
  credits,
  onRename,
  onAddCredits,
}: TopBarProps) {
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
        <TitleEditable value={projectName} onChange={onRename} />
        <RoleTag role={role} />
      </div>
      <div className='flex items-center' style={{ gap: 'var(--space-2)' }}>
        <div
          className='flex items-center'
          style={{ gap: 'var(--space-2)' }}
          data-testid='topbar-group-text-icon'
        >
          <MembersStack projectId={projectId} />
          <LangSwitcher />
          <ThemeToggle />
          <CreditsPill credits={credits} onAdd={onAddCredits} />
        </div>
        <div
          className='flex items-center'
          style={{ gap: 'var(--space-2)', marginLeft: 'var(--space-3)' }}
          data-testid='topbar-group-icon-only'
        >
          <ExportMenu />
          <ShareDialog projectId={projectId} />
          <BellMenu projectId={projectId} />
        </div>
      </div>
      <MembersModal />
    </header>
  );
}

function BackLink() {
  return (
    <Link
      to='/studio'
      aria-label='Back to Studio'
      data-testid='top-bar-back'
      className='inline-flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground'
    >
      <ArrowLeft className='h-3.5 w-3.5' />
      <span>Studio</span>
    </Link>
  );
}

const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: 'OWNER',
  edit: 'EDITOR',
  view: 'VIEWER',
};

function RoleTag({ role }: { role: ProjectRole }) {
  // All three roles share `.role-badge` shape — neutral pill, no brand color
  // (ground truth `finalized.html:476` v4.2 monochrome). Owner uses a
  // slightly darker text shade than viewer/editor to signal authority
  // without leaning on brand orange.
  const isOwner = role === 'owner';
  return (
    <span
      data-testid='role-tag'
      className={cn(
        'inline-flex shrink-0 items-center rounded-chrome bg-muted text-[11px] font-medium',
        isOwner ? 'text-foreground' : 'text-muted-foreground',
      )}
      style={{ padding: '2px var(--space-3)' }}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

function CreditsPill({
  credits,
  onAdd,
}: {
  credits: number;
  onAdd?: () => void;
}) {
  return (
    <span
      data-testid='credits-chip'
      aria-label='Credits balance'
      className='inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-popover text-[12px] tabular-nums'
      style={{ padding: '0 2px 0 var(--space-4)', gap: 'var(--space-3)' }}
    >
      <Star className='h-3.5 w-3.5 text-muted-foreground' aria-hidden='true' />
      <span>{credits.toLocaleString()}</span>
      <button
        type='button'
        onClick={onAdd}
        aria-label='Add credits'
        className='inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-muted'
        data-testid='credits-add'
      >
        <Plus className='h-3.5 w-3.5' />
      </button>
    </span>
  );
}
