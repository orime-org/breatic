// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';
import { Image as ImageIcon, MoreHorizontal } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { JoinProjectDialog } from '@web/features/project-join/JoinProjectDialog';
import { useTranslation } from '@web/i18n/use-translation';
import { canManageItem } from '@web/pages/studio/container/access';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { RoleBadge } from '@web/pages/studio/shared/badges';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface ProjectCardProps {
  project: ContainerProject;
  /** The viewer's studio role (`null` = non-member) — gates the governance (`⋯`) menu (invariant 2). */
  studioRole: StudioRole | null;
}

/**
 * A project card in the studio container Projects tab (spec §3.3): a 16:9
 * thumbnail, the name, a role badge, and a governance (`⋯`) entry shown only
 * to the project Owner or a studio Admin (spec §4 invariant 2). Inside the
 * container the source-studio label is omitted (only the cross-studio Recent
 * landing shows provenance). A member's card links to `/project/{slug}-{uuid}`;
 * for a project the viewer is not on, the card opens the join dialog in place
 * and shows no role badge.
 *
 * No visibility badge: projects have no visibility. CollectionCard does show
 * one, which is why the badge component itself survives.
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
  const canManage = canManageItem(studioRole, project.myRole === 'owner');
  const [joinOpen, setJoinOpen] = React.useState(false);
  const openJoin = React.useCallback(() => setJoinOpen(true), []);
  const body = (
    <>
      <div className='relative flex aspect-[16/9] items-center justify-center bg-muted text-muted-foreground'>
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
      <div className='p-2.5'>
        <p className='truncate text-base font-semibold text-foreground'>
          {project.name}
        </p>
        <div className='mt-2 flex items-center gap-2'>
          <span className='text-xs text-muted-foreground'>
            {t('studio.container.card.createdAt', {
              time: formatRelativeTime(project.createdAt, t),
            })}
          </span>
          {project.myRole !== null ? (
            <span className='ml-auto inline-flex'>
              <RoleBadge itemRole={project.myRole} />
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
  return (
    <div className='group relative overflow-hidden rounded-chrome border border-border bg-card transition-colors hover:border-foreground-disabled'>
      {project.myRole !== null ? (
        <Link to={`/project/${project.slug}-${project.id}`} className='flex flex-col'>
          {body}
        </Link>
      ) : (
        <>
          <Button
            type='button'
            variant={null}
            size={null}
            onClick={openJoin}
            className='flex w-full flex-col text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          >
            {body}
          </Button>
          <JoinProjectDialog projectId={project.id} open={joinOpen} onOpenChange={setJoinOpen} />
        </>
      )}
      {canManage ? (
        <Button
          type='button'
          aria-label={t('studio.container.card.more')}
          variant={null}
          size={null}
          className='absolute right-[7px] top-[7px] z-10 flex h-[22px] w-[22px] items-center justify-center rounded-chrome bg-black/45 text-white opacity-0 transition-opacity hover:bg-black/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100'
        >
          <MoreHorizontal className='h-3.5 w-3.5' />
        </Button>
      ) : null}
    </div>
  );
}
