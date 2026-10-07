// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@web/components/ui/button';
import { JoinProjectDialog } from '@web/features/project-join/JoinProjectDialog';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import type { ItemRole } from '@web/pages/studio/shared/studio-types';

/** The locale key naming each project role. */
export const ROLE_KEY: Record<ItemRole, string> = {
  owner: 'studio.container.badge.roleOwner',
  editor: 'studio.container.badge.roleEditor',
  viewer: 'studio.container.badge.roleViewer',
};

interface ProjectOpenTargetProps {
  project: ContainerProject;
  /** Classes for whichever element it renders. */
  className: string;
  children: React.ReactNode;
}

/**
 * What clicking a project in a studio list does, around the card or row that
 * shows it. A member opens the project at `/project/{slug}-{uuid}`; a viewer
 * who is not on a live project gets the join dialog in place; an archived
 * project the viewer is not on does nothing, since it takes no join requests.
 * @param props - The project, the classes and the content.
 * @param props.project - The project.
 * @param props.className - Classes for the rendered element.
 * @param props.children - What it wraps.
 * @returns The link, the join button with its dialog, or an inert wrapper.
 */
export function ProjectOpenTarget({ project, className, children }: ProjectOpenTargetProps): React.JSX.Element {
  const [joinOpen, setJoinOpen] = React.useState(false);
  const openJoin = React.useCallback(() => setJoinOpen(true), []);
  if (project.myRole !== null) {
    return (
      <Link to={`/project/${project.slug}-${project.id}`} className={className}>
        {children}
      </Link>
    );
  }
  if (project.archivedAt !== null) return <div className={className}>{children}</div>;
  return (
    <>
      <Button type='button' variant={null} size={null} onClick={openJoin} className={className}>
        {children}
      </Button>
      <JoinProjectDialog projectId={project.id} open={joinOpen} onOpenChange={setJoinOpen} />
    </>
  );
}
