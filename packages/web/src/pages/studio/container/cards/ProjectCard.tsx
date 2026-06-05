// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { Image as ImageIcon, MoreHorizontal } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  canManageItem,
  effectiveItemRole,
} from '@web/pages/studio/container/access';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { RoleBadge, VisibilityBadge } from '@web/pages/studio/shared/badges';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface ProjectCardProps {
  project: ContainerProject;
  /** The viewer's studio role — gates the governance (`⋯`) menu (invariant 2). */
  studioRole: StudioRole;
}

/**
 * A project card in the studio container Projects tab (spec §3.3): a 16:10
 * thumbnail, the name, visibility + role badges, and a governance (`⋯`) entry
 * shown only to the project Owner or a studio Admin (spec §4 invariant 2).
 * Inside the container the source-studio label is omitted (only the
 * cross-studio Recent landing shows provenance). The card links to
 * `/project/{slug}-{uuid}`.
 * @param props the project and the viewer's studio role.
 * @param props.project the project to render.
 * @param props.studioRole the viewer's studio role.
 * @returns the project card.
 */
export function ProjectCard({
  project,
  studioRole,
}: ProjectCardProps): React.JSX.Element {
  const t = useTranslation();
  const canManage = canManageItem(studioRole, project.isOwner);
  return (
    <div className='group relative overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-neutral-300'>
      <Link
        to={`/project/${project.slug}-${project.id}`}
        className='flex flex-col'
      >
        <div className='flex aspect-[16/10] items-center justify-center bg-muted text-muted-foreground'>
          {project.thumbnailUrl ? (
            <img
              src={project.thumbnailUrl}
              alt=''
              className='h-full w-full object-cover'
            />
          ) : (
            <ImageIcon className='h-6 w-6' aria-hidden='true' />
          )}
        </div>
        <div className='p-3'>
          <p className='truncate text-sm font-semibold text-foreground'>
            {project.name}
          </p>
          <div className='mt-2 flex flex-wrap items-center gap-1.5'>
            <VisibilityBadge visibility={project.visibility} />
            <RoleBadge itemRole={effectiveItemRole(project.myRole)} />
          </div>
        </div>
      </Link>
      {canManage ? (
        <button
          type='button'
          aria-label={t('studio.container.card.more')}
          className='absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-chrome bg-background text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      ) : null}
    </div>
  );
}
