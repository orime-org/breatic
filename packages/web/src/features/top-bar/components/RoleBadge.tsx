/**
 * RoleBadge — small text-only pill showing the caller's role on the
 * current project (owner / edit / view). Sits beside the project
 * title (mock 05 @1103, `RoleTag`).
 *
 * Color treatment: owner uses the brand-on-tint pair; edit uses
 * neutral on tint; view uses neutral on tint. Matches mock @739-743.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectRole } from '@breatic/shared';
import { cn } from '@/utils/classnames';

const ROLE_CLS: Record<ProjectRole, string> = {
  owner:  'bg-brand-500/14 text-brand-700',
  edit:   'bg-background-default-secondary text-text-default-base',
  view:   'bg-background-default-secondary text-text-default-tertiary',
};

const ROLE_LABEL_KEY: Record<ProjectRole, string> = {
  owner:  'project.header.roleOwner',
  edit:   'project.header.roleEdit',
  view:   'project.header.roleView',
};

const ROLE_FALLBACK: Record<ProjectRole, string> = {
  owner:  '所有者',
  edit:   '编辑',
  view:   '只读',
};

export interface RoleBadgeProps {
  role: ProjectRole | null;
}

const RoleBadge: React.FC<RoleBadgeProps> = memo(function RoleBadge({ role }) {
  const { t } = useTranslation();
  if (!role) return null;
  return (
    <span
      className={cn(
        'inline-block text-[10px] px-1.5 py-px rounded-full font-mono whitespace-nowrap',
        ROLE_CLS[role],
      )}
    >
      {t(ROLE_LABEL_KEY[role], { defaultValue: ROLE_FALLBACK[role] })}
    </span>
  );
});

export default RoleBadge;
