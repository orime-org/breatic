// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@web/components/ui/button';
import { JoinProjectDialog } from '@web/features/project-join/JoinProjectDialog';
import { useTranslation } from '@web/i18n/use-translation';
import { ProjectCoverMenu } from '@web/pages/studio/container/cards/ProjectCoverMenu';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { ItemCardBody } from '@web/pages/studio/shared/ItemCardBody';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import type { ItemRole } from '@web/pages/studio/shared/studio-types';

const ROLE_KEY: Record<ItemRole, string> = {
  owner: 'studio.container.badge.roleOwner',
  editor: 'studio.container.badge.roleEditor',
  viewer: 'studio.container.badge.roleViewer',
};

interface ProjectCardProps {
  project: ContainerProject;
  /** The studio the card is listed in, refreshed after the cover changes. */
  studioSlug: string;
}

/**
 * A project card in the studio container Projects tab (spec §3.3). Its body is
 * the same `ItemCardBody` the Recent landing uses — cover, name, and one meta
 * line reading "created {time}" with the viewer's role as plain text at its
 * right end — plus a `⋯` menu shown only to the project Owner, whose one entry
 * uploads the cover (#21). A member's card links to
 * `/project/{slug}-{uuid}`; for a project the viewer is not on, the card opens
 * the join dialog in place and shows no role.
 * @param props the project and the studio slug.
 * @param props.project the project to render.
 * @param props.studioSlug the studio the card is listed in.
 * @returns the project card.
 */
export function ProjectCard({
  project,
  studioSlug,
}: ProjectCardProps): React.JSX.Element {
  const t = useTranslation();
  const [joinOpen, setJoinOpen] = React.useState(false);
  const openJoin = React.useCallback(() => setJoinOpen(true), []);
  const body = (
    <ItemCardBody
      thumbnailUrl={project.thumbnailUrl}
      name={project.name}
      role={project.myRole === null ? null : t(ROLE_KEY[project.myRole])}
      meta={
        <span className='truncate'>
          {t('studio.container.card.createdAt', {
            time: formatRelativeTime(project.createdAt, t),
          })}
        </span>
      }
    />
  );
  return (
    <div
      data-testid={`project-card-${project.id}`}
      className='group relative overflow-hidden rounded-chrome border border-border bg-card transition-colors hover:border-foreground-disabled has-[>:first-child:focus-visible]:ring-1 has-[>:first-child:focus-visible]:ring-ring'
    >
      {project.myRole !== null ? (
        <Link
          to={`/project/${project.slug}-${project.id}`}
          className='flex flex-col focus-visible:outline-none'
        >
          {body}
        </Link>
      ) : (
        <>
          <Button
            type='button'
            variant={null}
            size={null}
            onClick={openJoin}
            className='flex w-full flex-col items-stretch justify-start whitespace-normal rounded-none text-left text-base font-normal focus-visible:ring-0'
          >
            {body}
          </Button>
          <JoinProjectDialog projectId={project.id} open={joinOpen} onOpenChange={setJoinOpen} />
        </>
      )}
      {project.myRole === 'owner' ? (
        <ProjectCoverMenu projectId={project.id} studioSlug={studioSlug} />
      ) : null}
    </div>
  );
}
