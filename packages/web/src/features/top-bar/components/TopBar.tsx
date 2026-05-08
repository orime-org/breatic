/**
 * TopBar — full-width chrome at the top of the project page.
 *
 * Replaces the pre-PR-Y2 layout where:
 *   - The leaf-icon dropdown + project title lived inside the
 *     chat-panel's 56px header (`AiChatRecordPanel`).
 *   - The members + credits pills floated as an absolute-positioned
 *     overlay above the canvas (PR4-A).
 *
 * Now both groups sit in one horizontal bar that spans the entire
 * project page width, mirroring mock 05's structure: logo + title
 * on the left, member / credit / account widgets on the right.
 *
 * The chat-panel's header is now reduced to chat-specific affordances
 * (New conversation, History) — see `AiChatRecordPanel`.
 *
 * `userId` flows in for `MembersPopover` (which derives `myRole` via
 * `useUserRole`). `metaProvider` from `useProjectSpaces` powers the
 * stateless invalidate channel for the members cache.
 */

import { memo, useState } from 'react';
import type { ProjectMetaManager } from '@/data/yjs/project-meta';
import type { ProjectRole } from '@breatic/shared';
import UserCenter from '@/apps/userCenter';
import { MembersPopover, MembersPanel } from '@/features/members';
import { CreditsPill, RechargeDialog } from '@/features/credits';
import ProjectHeader from './ProjectHeader';

export interface TopBarProps {
  projectId: string | null;
  metaProvider: ProjectMetaManager['provider'] | null;
  /** Caller's role on the project — gates members management UI. */
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
        role="banner"
        className="flex items-center justify-between gap-3 h-14 px-3 shrink-0 bg-[var(--color-background-default-base)] border-b border-[var(--color-border-default-base)]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ProjectHeader
            projectName={projectName}
            onProjectNameCommit={onProjectNameCommit}
            className="min-w-0 max-w-[280px]"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <MembersPopover
            projectId={projectId}
            metaProvider={metaProvider}
            myRole={myRole}
            onOpenPanel={() => setMembersPanelOpen(true)}
          />
          <CreditsPill onClick={() => setRechargeOpen(true)} />
          <UserCenter className="shrink-0" hideUpgradeButtonText={hideUpgradeButtonText} />
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
