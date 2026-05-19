import { ArrowLeft, Plus, Star } from 'lucide-react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { Logo28 } from './Logo28';
import { TitleEditable } from './TitleEditable';
import { TweaksPopover } from './TweaksPopover';
import { MembersStack } from './MembersStack';
import { LangSwitcher } from './LangSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { ExportMenu } from './ExportMenu';
import { ShareDialog } from './ShareDialog';
import { BellMenu } from './BellMenu';

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
 *       group A (5 text-icon): Tweaks · Members · Lang · Theme · Credits
 *       group B (3 icon-only): Export · Share · Bell
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
      className='flex items-center border-b border-border bg-background'
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
          <TweaksPopover />
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
          <BellMenu />
        </div>
      </div>
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
  const isOwner = role === 'owner';
  return (
    <span
      data-testid='role-tag'
      className={cn(
        'inline-flex shrink-0 items-center text-[11px] font-semibold',
        isOwner
          ? 'px-0 text-primary'
          : 'rounded-content-sm bg-muted px-2 py-[2px] text-muted-foreground',
      )}
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
      className='inline-flex h-7 shrink-0 items-center rounded-content-sm border border-border bg-card text-[12px] tabular-nums'
      style={{ padding: '0 var(--space-3)', gap: 'var(--space-2)' }}
    >
      <Star className='h-3.5 w-3.5 text-muted-foreground' aria-hidden='true' />
      <span>{credits.toLocaleString()}</span>
      <button
        type='button'
        onClick={onAdd}
        aria-label='Add credits'
        className='-mr-2 inline-flex h-7 w-7 items-center justify-center rounded-r-content-sm hover:bg-muted'
        data-testid='credits-add'
      >
        <Plus className='h-3.5 w-3.5' />
      </button>
    </span>
  );
}
