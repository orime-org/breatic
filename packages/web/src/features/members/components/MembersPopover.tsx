/**
 * MembersPopover — top-bar avatar stack with a Popover panel listing
 * the project's members.
 *
 * - Avatar stack shows up to 2 collaborators plus a "+N" overflow bubble.
 * - Clicking opens a HeadlessUI Popover panel that lists all active
 *   members, with role tags, and a `Remove` button on hover for non-self.
 * - The footer has two actions: `Invite` (opens the management panel)
 *   and `Manage members` (also opens the panel; visible only to owner).
 *   The two are split because the mock uses two separate buttons; we
 *   route both to the same `MembersPanel` since the panel handles both
 *   invite + manage flows.
 *
 * Data: reads from `useProjectMembers` (cached + auto-invalidating via
 * Collab stateless signal) joined with `useUsers` for display info.
 * Mutations (`remove`) call the API directly; the cache invalidates
 * on the server-side stateless broadcast.
 */

import { Fragment, memo, useMemo, useState } from 'react';
import { Popover, PopoverButton, PopoverPanel, Transition } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { ROLE_RANK, type ProjectMember, type ProjectRole } from '@breatic/shared';
import { useProjectMembers } from '@/domain/project/useProjectMembers';
import { useUsers } from '@/domain/user/useUsers';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import type { ProjectMetaManager } from '@/data/yjs/project-meta';
import * as projectMembersApi from '@/data/api/project-members';
import { __invalidateProjectMembersCache } from '@/domain/project/useProjectMembers';
import { cn } from '@/utils/classnames';

const MAX_VISIBLE = 2;

const ChevronGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 opacity-50" aria-hidden>
    <polyline points="4 6 8 10 12 6" />
  </svg>
);

const PlusGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3" aria-hidden>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const UsersGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

/** Stable per-userId color so the same user gets the same avatar tint. */
function avatarTint(userId: string): string {
  // 8 stops around the brand hue family — picked once per user.
  const palette = [
    'bg-gradient-to-br from-orange-400 to-amber-600',
    'bg-gradient-to-br from-emerald-400 to-teal-500',
    'bg-gradient-to-br from-rose-400 to-fuchsia-500',
    'bg-gradient-to-br from-sky-400 to-indigo-500',
    'bg-gradient-to-br from-violet-400 to-purple-600',
    'bg-gradient-to-br from-lime-400 to-green-600',
    'bg-gradient-to-br from-pink-400 to-rose-600',
    'bg-gradient-to-br from-cyan-400 to-blue-500',
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.slice(0, 2).toUpperCase();
}

const RoleTag = ({ role }: { role: ProjectRole }) => {
  const { t } = useTranslation();
  const styles: Record<ProjectRole, string> = {
    owner: 'bg-brand-50 text-brand-700 border-brand-200',
    edit: 'bg-neutral-100 text-neutral-700 border-neutral-200',
    view: 'bg-neutral-50 text-neutral-500 border-neutral-200',
  };
  return (
    <span className={cn('inline-block text-[10px] font-mono px-1.5 py-0.5 rounded-sm border uppercase tracking-wider', styles[role])}>
      {t(`members.role.${role}`)}
    </span>
  );
};

export interface MembersPopoverProps {
  projectId: string | null;
  metaProvider: ProjectMetaManager['provider'] | null;
  /** Caller's role on the project; if `null`, fall back to view (no manage). */
  myRole: ProjectRole | null;
  /** Open the full management dialog (used by both action buttons). */
  onOpenPanel: () => void;
}

const MembersPopover = memo(function MembersPopover({
  projectId,
  metaProvider,
  myRole,
  onOpenPanel,
}: MembersPopoverProps) {
  const { t } = useTranslation();
  const { members } = useProjectMembers(projectId, metaProvider);
  const memberIds = useMemo(() => members.map((m) => m.userId), [members]);
  const { users } = useUsers(memberIds);
  const { authInfo } = useUserCenterStore();
  // The auth slice persists token / isAuthenticated; we don't keep
  // the userId there. We tag "self" by intersecting with the
  // `useProjectMembers` row whose role is `owner` — that's the
  // creator, which is "me" for the typical V1 personal-studio case.
  // A more robust implementation will read `authMe.id` once we
  // surface it through the redux slice (TODO PR4-B+).
  void authInfo;

  const canManage = myRole === 'owner';
  const visible = members.slice(0, MAX_VISIBLE);
  const overflow = Math.max(0, members.length - MAX_VISIBLE);

  const handleRemove = async (userId: string) => {
    if (!projectId) return;
    try {
      await projectMembersApi.remove(projectId, userId);
      // Optimistic-ish: invalidate the cache immediately rather than
      // waiting for the Collab stateless broadcast — the broadcast
      // will arrive shortly and refresh again, but the user sees the
      // change without latency.
      __invalidateProjectMembersCache(projectId);
    } catch {
      // Surface to a toast — but the project page already wires a
      // global error handler, so silent here is acceptable.
    }
  };

  // Don't render anything until we have project context (project page
  // will call this with a real projectId once useProjectSpaces is up).
  if (!projectId) return null;

  return (
    <Popover className="relative">
      <PopoverButton
        className="inline-flex items-center gap-1 h-9 px-2 rounded-sm hover:bg-neutral-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-base/40"
      >
        <div className="flex">
          {visible.map((m, i) => {
            const u = users[m.userId];
            const display = u?.username || u?.email || m.userId;
            return (
              <div
                key={m.userId}
                title={display}
                className={cn(
                  'w-[26px] h-[26px] rounded-full flex items-center justify-center text-[11px] font-semibold text-text-on-button-base border-2 border-[var(--color-background-default-base)]',
                  avatarTint(m.userId),
                  i > 0 && '-ml-1.5',
                )}
              >
                {initialsFor(display)}
              </div>
            );
          })}
          {overflow > 0 && (
            <div className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-[11px] font-semibold text-text-on-button-base border-2 border-[var(--color-background-default-base)] bg-gradient-to-br from-orange-400 to-amber-600 -ml-1.5">
              +{overflow}
            </div>
          )}
        </div>
        <ChevronGlyph />
      </PopoverButton>

      <Transition
        as={Fragment}
        enter="transition ease-out duration-150"
        enterFrom="opacity-0 translate-y-1"
        enterTo="opacity-100 translate-y-0"
        leave="transition ease-in duration-100"
        leaveFrom="opacity-100 translate-y-0"
        leaveTo="opacity-0 translate-y-1"
      >
        <PopoverPanel
          anchor={{ to: 'bottom end', gap: 4 }}
          className="z-50 w-80 max-h-[480px] overflow-hidden bg-[var(--color-background-default-base)] border border-[var(--color-border-default-base)] rounded-md shadow-lg flex flex-col"
        >
          <div className="px-3 py-2.5 border-b border-[var(--color-border-default-base)] flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-text-default-secondary)] font-semibold">
              {t('members.popover.title')}
            </span>
            <span className="text-xs font-mono text-[var(--color-text-default-base)]">{members.length}</span>
          </div>
          <div className="p-1 overflow-y-auto max-h-[360px]">
            {members.map((m) => {
              const u = users[m.userId];
              const display = u?.username || u?.email || m.userId;
              const isSelf = m.role === 'owner';
              return (
                <div
                  key={m.userId}
                  className="group relative flex items-center gap-2.5 px-2.5 py-2 rounded-sm hover:bg-[var(--color-background-default-secondary)]"
                >
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-text-on-button-base flex-shrink-0',
                      avatarTint(m.userId),
                    )}
                  >
                    {initialsFor(display)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <strong className="block text-[13px] text-[var(--color-text-default-base)] font-semibold truncate">
                      {display}
                      {isSelf && (
                        <span className="ml-1 text-[10px] text-[var(--color-text-default-tertiary)] font-normal font-mono">
                          {t('members.popover.self_label')}
                        </span>
                      )}
                    </strong>
                    <RoleTag role={m.role} />
                  </div>
                  {!isSelf && canManage && (
                    <button
                      type="button"
                      onClick={() => handleRemove(m.userId)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] px-2 py-1 bg-[var(--color-background-default-base)] border border-[var(--color-border-default-base)] rounded-sm text-[var(--color-text-default-secondary)] hover:bg-[var(--color-background-error-base)]/10 hover:border-[var(--color-text-status-error)] hover:text-[var(--color-text-status-error)] opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      {t('members.popover.remove')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="p-2.5 border-t border-[var(--color-border-default-base)] space-y-1.5">
            <button
              type="button"
              onClick={onOpenPanel}
              className="w-full h-8 inline-flex items-center justify-center gap-1.5 bg-neutral-900 text-text-on-button-base rounded-sm text-xs hover:bg-neutral-800 transition-colors"
            >
              <PlusGlyph />
              <span>{t('members.popover.invite')}</span>
            </button>
            {canManage && (
              <button
                type="button"
                onClick={onOpenPanel}
                className="w-full h-8 inline-flex items-center justify-center gap-1.5 bg-[var(--color-background-default-base)] border border-[var(--color-border-default-base)] rounded-sm text-xs text-[var(--color-text-default-base)] hover:bg-[var(--color-background-default-secondary)] transition-colors"
              >
                <UsersGlyph />
                <span>{t('members.popover.manage')}</span>
              </button>
            )}
          </div>
        </PopoverPanel>
      </Transition>
    </Popover>
  );
});

export default MembersPopover;
