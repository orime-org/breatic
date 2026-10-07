// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@web/components/ui/button';
import { JoinProjectDialog } from '@web/features/project-join/JoinProjectDialog';
import { useTranslation } from '@web/i18n/use-translation';
import { hasCardMenu, ProjectCardMenu } from '@web/pages/studio/container/cards/ProjectCardMenu';
import type { ContainerProject, ProjectTimeKind } from '@web/pages/studio/container/container-types';
import { projectTimeLine } from '@web/pages/studio/container/project-time';
import { ItemCardBody } from '@web/pages/studio/shared/ItemCardBody';
import { ArchivedBadge } from '@web/pages/studio/shared/badges';
import type { ItemRole } from '@web/pages/studio/shared/studio-types';

const ROLE_KEY: Record<ItemRole, string> = {
  owner: 'studio.container.badge.roleOwner',
  editor: 'studio.container.badge.roleEditor',
  viewer: 'studio.container.badge.roleViewer',
};

interface ProjectCardProps {
  project: ContainerProject;
  /** Which of the project's times the meta line shows; follows the list's sort. */
  timeKind?: ProjectTimeKind;
}

/**
 * A project card in the studio container Projects tab (spec §3.3). Its body is
 * the same `ItemCardBody` the Recent landing uses — cover, name, and one meta
 * line carrying one of the project's times (the one the list is sorted by,
 * creation by default) with the viewer's role as plain text at its
 * right end — plus the `⋯` menu whenever the server says the viewer may do
 * something from it. A member's card links to `/project/{slug}-{uuid}`; for a
 * project the viewer is not on, the card opens the join dialog in place and
 * shows no role. An archived card carries the archived badge, still opens for
 * a member (read-only), and does nothing for anyone else: an archived project
 * takes no join requests.
 * @param props the card's props.
 * @param props.project the project to render.
 * @param props.timeKind which time the meta line shows.
 * @returns the project card.
 */
export function ProjectCard({ project, timeKind = 'created' }: ProjectCardProps): React.JSX.Element {
  const t = useTranslation();
  const [joinOpen, setJoinOpen] = React.useState(false);
  const openJoin = React.useCallback(() => setJoinOpen(true), []);
  const body = (
    <ItemCardBody
      thumbnailUrl={project.thumbnailUrl}
      name={project.name}
      role={project.myRole === null ? null : t(ROLE_KEY[project.myRole])}
      meta={
        <span className='truncate'>{projectTimeLine(project, timeKind, t)}</span>
      }
    />
  );
  return (
    <div
      data-testid={`project-card-${project.id}`}
      className='group relative overflow-hidden rounded-chrome border border-border bg-card transition-colors hover:border-foreground-disabled has-[>:first-child:focus-visible]:ring-1 has-[>:first-child:focus-visible]:ring-ring'
    >
      {project.myRole === null && project.archivedAt !== null ? (
        <div className='flex flex-col'>{body}</div>
      ) : project.myRole !== null ? (
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
      {project.archivedAt !== null ? (
        <span className='pointer-events-none absolute left-[7px] top-[7px] z-[1]'>
          <ArchivedBadge />
        </span>
      ) : null}
      {hasCardMenu(project) ? (
        <ProjectCardMenu project={project} />
      ) : null}
    </div>
  );
}
