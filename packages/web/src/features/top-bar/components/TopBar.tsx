/**
 * TopBar — full-width chrome at the top of the project page.
 *
 * Layout matches `design/project/mocks/05-canvas-native-tailwind.html`
 * @1083-1115 (`TopBar`):
 *
 *   ┌───────────────────────────────────────────────────────────────────────────────┐
 *   │ [Logo] [< Workspace] [/] [ProjectTitle] [Role]   …   [Members] [Lang] [Theme] │
 *   │                                                       [Credits] [Export]      │
 *   │                                                       [Share] [Bell] [User]   │
 *   └───────────────────────────────────────────────────────────────────────────────┘
 *
 * The chat-toggle moved to the TabBar left (PR #94 + #95). System
 * messages bell is a visual placeholder until PR-Y3 lands the
 * backend. Share popover is a basic shell (copies the URL) — the
 * full invite-link popover lands in a follow-up.
 */
import { memo, useState } from 'react';
import type { ProjectMetaManager } from '@/data/yjs/project-meta';
import type { ProjectRole } from '@breatic/shared';
import UserCenter from '@/pages/user-center';
import { MembersPopover, MembersPanel } from '@/features/members';
import { CreditsPill, RechargeDialog } from '@/features/credits';
import Logo from './Logo';
import BackToWorkspaceLink from './BackToWorkspaceLink';
import ProjectTitle from './ProjectTitle';
import RoleBadge from './RoleBadge';
import LangPicker from './LangPicker';
import ThemePicker from './ThemePicker';
import ExportPicker from './ExportPicker';
import SharePopover from './SharePopover';
import NotificationsBell from './NotificationsBell';

export interface TopBarProps {
  projectId: string | null;
  metaProvider: ProjectMetaManager['provider'] | null;
  /** Caller's role on the project — gates members management UI + drives role badge. */
  myRole: ProjectRole | null;
  projectName: string;
  onProjectNameCommit: (name: string) => void;
  /** Forwarded to UserCenter — hide the upgrade-button text in compact layouts. */
  hideUpgradeButtonText?: boolean;
}

const TopBar: React.FC<TopBarProps> = memo(function TopBar({
  projectId,
  metaProvider,
  myRole,
  projectName,
  onProjectNameCommit,
  hideUpgradeButtonText = true,
}) {
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);

  return (
    <>
      <div
        role='banner'
        className='h-12 flex items-center px-4 gap-4 bg-background-default-base border-b border-border-default-base flex-shrink-0'
      >
        {/* Left cluster: logo + breadcrumb + title + role. */}
        <div className='flex items-center gap-2.5 min-w-0'>
          <Logo />
          <BackToWorkspaceLink />
          <span className='text-text-default-tertiary'>/</span>
          <ProjectTitle projectName={projectName} onCommit={onProjectNameCommit} />
          <RoleBadge role={myRole} />
        </div>

        {/* Spacer — pushes the right cluster to the edge. */}
        <div className='flex-1' />

        {/* Right cluster: members / lang / theme / credits / export / share / bell / user. */}
        <div className='flex items-center gap-2 shrink-0'>
          <MembersPopover
            projectId={projectId}
            metaProvider={metaProvider}
            myRole={myRole}
            onOpenPanel={() => setMembersPanelOpen(true)}
          />
          <LangPicker />
          <ThemePicker />
          <CreditsPill onClick={() => setRechargeOpen(true)} />
          <ExportPicker projectName={projectName} />
          <SharePopover />
          <NotificationsBell />
          <UserCenter className='shrink-0' hideUpgradeButtonText={hideUpgradeButtonText} />
        </div>
      </div>

      <MembersPanel
        open={membersPanelOpen}
        onClose={() => setMembersPanelOpen(false)}
        projectId={projectId}
        metaProvider={metaProvider}
        myRole={myRole}
      />
      <RechargeDialog open={rechargeOpen} onClose={() => setRechargeOpen(false)} />
    </>
  );
});

export default TopBar;
