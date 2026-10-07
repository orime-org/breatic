// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { hasCardMenu, ProjectCardMenu } from '@web/pages/studio/container/cards/ProjectCardMenu';
import { ProjectOpenTarget, ROLE_KEY } from '@web/pages/studio/container/cards/ProjectOpenTarget';
import type { ContainerProject, ProjectTimeKind } from '@web/pages/studio/container/container-types';
import { projectTimeLine } from '@web/pages/studio/container/project-time';
import { ItemCardBody } from '@web/pages/studio/shared/ItemCardBody';
import { ArchivedBadge } from '@web/pages/studio/shared/badges';

// The link, join button or inert wrapper fills the card above its menu. The
// button's own type and alignment are reset so all three lay the body out alike.
const OPEN_TARGET =
  'flex w-full flex-col items-stretch justify-start whitespace-normal rounded-none text-left text-base font-normal focus-visible:outline-none focus-visible:ring-0';

interface ProjectCardProps {
  project: ContainerProject;
  /** Which of the project's times the meta line shows; follows the list's sort. */
  timeKind: ProjectTimeKind;
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
export function ProjectCard({ project, timeKind }: ProjectCardProps): React.JSX.Element {
  const t = useTranslation();
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
  // `isolate` keeps the menu's and badge's layers inside the card, below the
  // toolbar pinned over the list.
  return (
    <div
      data-testid={`project-card-${project.id}`}
      className='group relative isolate overflow-hidden rounded-chrome border border-border bg-card transition-colors hover:border-foreground-disabled has-[>:first-child:focus-visible]:ring-1 has-[>:first-child:focus-visible]:ring-ring'
    >
      <ProjectOpenTarget project={project} className={OPEN_TARGET}>
        {body}
      </ProjectOpenTarget>
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
