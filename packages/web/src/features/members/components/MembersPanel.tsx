/**
 * MembersPanel — full-screen modal for member management.
 *
 * Combines two flows:
 *   1. **Invite**  — top section: email + role select + Invite button.
 *      `POST /projects/:id/members` with the email and role.
 *   2. **Manage** — list of current members. Owners have a role
 *      `<select>` for non-owner rows (changes call
 *      `PUT /projects/:id/members/:uid`); a hover-revealed remove
 *      button calls `DELETE /projects/:id/members/:uid`.
 *
 * Owner transfer is intentionally omitted (V1 personal-Studio
 * keeps owner permanently bound to the project creator); that
 * surfaces as a Studio-phase feature.
 *
 * Cache invalidation: every mutation calls
 * `__invalidateProjectMembersCache(projectId)`. The Collab
 * `members:changed` stateless broadcast will arrive shortly after
 * and refresh again — the local invalidate just removes the latency
 * blip.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ProjectRole } from '@breatic/shared';
import Dialog from '@/ui/dialog';
import { useProjectMembers } from '@/domain/project/useProjectMembers';
import { useUsers } from '@/domain/user/useUsers';
import { __invalidateProjectMembersCache } from '@/domain/project/useProjectMembers';
import * as projectMembersApi from '@/data/api/project-members';
import type { ProjectMetaManager } from '@/data/yjs/project-meta';
import { cn } from '@/utils/classnames';

const TXT_BASE = 'text-[var(--color-text-default-base)]';
const TXT_SECONDARY = 'text-[var(--color-text-default-secondary)]';
const TXT_TERTIARY = 'text-[var(--color-text-default-tertiary)]';
const TXT_ERROR = 'text-[var(--color-text-status-error)]';
const BG_BASE = 'bg-[var(--color-background-default-base)]';
const BG_SECONDARY = 'bg-[var(--color-background-default-secondary)]';
const BORDER_BASE = 'border-[var(--color-border-default-base)]';

function avatarTint(userId: string): string {
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
    owner: 'bg-status-selected/10 text-status-selected border-status-selected/30',
    edit: 'bg-neutral-100 text-neutral-700 border-neutral-200',
    view: 'bg-neutral-50 text-neutral-500 border-neutral-200',
  };
  return (
    <span className={cn('inline-block text-[10px] font-mono px-1.5 py-0.5 rounded-sm border uppercase tracking-wider', styles[role])}>
      {t(`members.role.${role}`)}
    </span>
  );
};

const CloseGlyph = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' className='w-3.5 h-3.5' aria-hidden>
    <line x1='18' y1='6' x2='6' y2='18' />
    <line x1='6' y1='6' x2='18' y2='18' />
  </svg>
);

export interface MembersPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  metaProvider: ProjectMetaManager['provider'] | null;
  /** Caller's role on the project. Decides whether mutation controls render. */
  myRole: ProjectRole | null;
}

const MembersPanel: React.FC<MembersPanelProps> = ({
  open,
  onClose,
  projectId,
  metaProvider,
  myRole,
}) => {
  const { t } = useTranslation();
  const { members, loading } = useProjectMembers(projectId, metaProvider);
  const memberIds = useMemo(() => members.map((m) => m.userId), [members]);
  const { users } = useUsers(memberIds);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<ProjectRole>('edit');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = myRole === 'owner';

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || !projectId) return;
    setPending(true);
    setError(null);
    try {
      await projectMembersApi.invite(projectId, { email, role: inviteRole });
      setInviteEmail('');
      __invalidateProjectMembersCache(projectId);
    } catch (e) {
      setError((e as Error)?.message || 'Invite failed');
    } finally {
      setPending(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: ProjectRole) => {
    if (!projectId) return;
    try {
      await projectMembersApi.changeRole(projectId, userId, { role: newRole });
      __invalidateProjectMembersCache(projectId);
    } catch (e) {
      setError((e as Error)?.message || 'Role change failed');
    }
  };

  const handleRemove = async (userId: string) => {
    if (!projectId) return;
    if (!window.confirm(t('members.panel.confirm_remove'))) return;
    try {
      await projectMembersApi.remove(projectId, userId);
      __invalidateProjectMembersCache(projectId);
    } catch (e) {
      setError((e as Error)?.message || 'Remove failed');
    }
  };

  return (
    <Dialog
      show={open}
      onClose={onClose}
      title={t('members.panel.title')}
      width={640}
      bodyClassName='pt-1'
    >
      <p className={cn('text-[12px] mb-4', TXT_SECONDARY)}>
        {t('members.panel.subtitle')}
      </p>

      {/* Invite section — owners only. View / edit collaborators don't
          see the invite controls. */}
      {canManage && (
        <div className={cn('rounded-md p-4 mb-4', BG_SECONDARY)}>
          <div className={cn('text-[11px] font-medium mb-2 uppercase tracking-wider', TXT_SECONDARY)}>
            {t('members.panel.invite_section')}
          </div>
          <div className='flex gap-2'>
            <input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={t('members.panel.invite_placeholder')}
              disabled={pending}
              className={cn(
                'flex-1 h-9 px-3 border rounded-md text-[13px] outline-none transition',
                BG_BASE,
                BORDER_BASE,
                TXT_BASE,
                'placeholder:text-[var(--color-text-default-tertiary)]',
                'focus:border-status-selected focus:ring-2 focus:ring-status-selected/15',
                pending && 'opacity-60',
              )}
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as ProjectRole)}
              disabled={pending}
              className={cn(
                'h-9 px-2 border rounded-md text-[13px] outline-none cursor-pointer',
                BG_BASE,
                BORDER_BASE,
                TXT_BASE,
                'focus:border-status-selected',
              )}
            >
              <option value='view'>{t('members.role.view')}</option>
              <option value='edit'>{t('members.role.edit')}</option>
            </select>
            <button
              type='button'
              onClick={handleInvite}
              disabled={pending || !inviteEmail.trim()}
              className='h-9 px-4 bg-neutral-900 text-text-on-button-base rounded-md text-[13px] font-medium hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            >
              {t('members.panel.invite_button')}
            </button>
          </div>
          {error && (
            <div className={cn('mt-2 text-[12px]', TXT_ERROR)}>{error}</div>
          )}
        </div>
      )}

      <div className='overflow-y-auto max-h-[420px] -mx-2 px-2'>
        <div className={cn('px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider flex items-center justify-between', TXT_SECONDARY)}>
          <span>{t('members.panel.list_count', { count: members.length })}</span>
          <span className={cn('text-[10px] font-mono normal-case tracking-normal', TXT_TERTIARY)}>
            {t('members.panel.list_note')}
          </span>
        </div>

        {loading && members.length === 0 && (
          <div className={cn('px-3 py-6 text-center text-[12px]', TXT_SECONDARY)}>
            …
          </div>
        )}

        {members.map((m) => {
          const u = users[m.userId];
          const display = u?.username || u?.email || m.userId;
          const isOwner = m.role === 'owner';
          return (
            <div
              key={m.userId}
              className='group flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-[var(--color-background-default-secondary)] transition-colors'
            >
              <div className={cn('w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-semibold text-text-on-button-base flex-shrink-0', avatarTint(m.userId))}>
                {initialsFor(display)}
              </div>
              <div className='flex-1 min-w-0'>
                <div className={cn('text-[13px] font-semibold truncate', TXT_BASE)}>
                  {display}
                </div>
                <div className={cn('text-[11px] font-mono truncate', TXT_TERTIARY)}>
                  {m.userId}
                </div>
              </div>
              {isOwner ? (
                <RoleTag role='owner' />
              ) : canManage ? (
                <select
                  value={m.role}
                  onChange={(e) => handleRoleChange(m.userId, e.target.value as ProjectRole)}
                  className={cn(
                    'h-7 px-2 border rounded-sm text-[12px] outline-none cursor-pointer',
                    BG_BASE,
                    BORDER_BASE,
                    TXT_BASE,
                    'focus:border-status-selected',
                  )}
                >
                  <option value='view'>{t('members.role.view')}</option>
                  <option value='edit'>{t('members.role.edit')}</option>
                </select>
              ) : (
                <RoleTag role={m.role} />
              )}
              {!isOwner && canManage && (
                <button
                  type='button'
                  onClick={() => handleRemove(m.userId)}
                  title={t('members.popover.remove')}
                  className='opacity-0 group-hover:opacity-100 w-7 h-7 inline-flex items-center justify-center rounded-sm hover:bg-[var(--color-background-error-base)]/10 hover:text-[var(--color-text-status-error)] transition-all'
                >
                  <CloseGlyph />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={cn('flex items-center justify-end pt-3 mt-3 border-t', BORDER_BASE)}>
        <button
          type='button'
          onClick={onClose}
          className={cn(
            'h-8 px-4 border rounded-md text-[12px] hover:bg-[var(--color-background-default-secondary)] transition-colors',
            BG_BASE,
            BORDER_BASE,
            TXT_BASE,
          )}
        >
          {t('members.panel.done')}
        </button>
      </div>
    </Dialog>
  );
};

export default MembersPanel;
