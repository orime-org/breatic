import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
}

/**
 * Project top bar — 11 elements per chrome-baseline spec:
 *   Logo28 · BackButton · TitleEditable · RoleTag · TweaksPopover ·
 *   MembersStack · LangSwitcher · ThemeToggle · CreditsChip · ExportMenu ·
 *   ShareDialog · BellMenu
 *
 * Visual fidelity to chrome-baseline finalized.html is iterated in later
 * polish PRs once the structural shell + invariants are in place.
 */
export function TopBar({
  projectId,
  projectName,
  role,
  credits,
  onRename,
}: TopBarProps) {
  return (
    <header
      data-testid='top-bar'
      className='flex h-12 items-center gap-2 border-b border-border bg-background px-3'
    >
      <Logo28 />
      <BackButton />
      <TitleEditable value={projectName} onChange={onRename} />
      <RoleTag role={role} />
      <div className='ml-auto flex items-center gap-1'>
        <TweaksPopover />
        <MembersStack projectId={projectId} />
        <LangSwitcher />
        <ThemeToggle />
        <CreditsChip credits={credits} />
        <ExportMenu />
        <ShareDialog projectId={projectId} />
        <BellMenu />
      </div>
    </header>
  );
}

function Logo28() {
  return (
    <Link
      to='/studio'
      aria-label='Home'
      className='inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground'
    >
      B
    </Link>
  );
}

function BackButton() {
  return (
    <Button asChild variant='ghost' size='icon' aria-label='Back to studio'>
      <Link to='/studio'>
        <ArrowLeft className='h-4 w-4' />
      </Link>
    </Button>
  );
}

const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: 'Owner',
  edit: 'Edit',
  view: 'View',
};

function RoleTag({ role }: { role: ProjectRole }) {
  return (
    <Badge variant='outline' className='shrink-0' data-testid='role-tag'>
      {ROLE_LABEL[role]}
    </Badge>
  );
}

function CreditsChip({ credits }: { credits: number }) {
  return (
    <Badge
      variant='secondary'
      className='shrink-0 tabular-nums'
      data-testid='credits-chip'
    >
      {credits} cr
    </Badge>
  );
}
