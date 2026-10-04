// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Archive } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';

interface ArchivedTabProps {
  projects: readonly ContainerProject[];
}

// Same grid as the Projects tab: an archived card is the same card.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3';

/**
 * The Archived tab, the studio admin's alone: the studio's archived projects as
 * the same cards the Projects tab uses, each carrying the archived badge and a
 * menu that only restores. Nothing is created from here.
 * @param props - The archived projects.
 * @param props.projects - The studio's archived projects.
 * @returns The Archived tab content.
 */
export function ArchivedTab({ projects }: ArchivedTabProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <>
      <ContainerToolbar title={t('studio.container.tabs.archived')} count={projects.length} />
      {projects.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={t('studio.container.archived.emptyTitle')}
          hint={t('studio.container.archived.emptyHint')}
        />
      ) : (
        <div className={GRID}>
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </>
  );
}
