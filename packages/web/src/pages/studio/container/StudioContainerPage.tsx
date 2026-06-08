// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { ProjectSummary } from '@breatic/shared';
import { Tabs, TabsContent } from '@web/components/ui/tabs';
import { studiosApi } from '@web/data/api/studios';
import { useTranslation } from '@web/i18n/use-translation';
import { CENTER_COLUMN } from '@web/pages/studio/container/container-layout';
import { getEmptyContainerView } from '@web/pages/studio/container/container-stub';
import type {
  ContainerProject,
  StudioMember,
} from '@web/pages/studio/container/container-types';
import {
  creatableStudios,
  defaultCreateStudioId,
} from '@web/pages/studio/container/dialogs/studio-create';
import { useCreateProject } from '@web/pages/studio/container/dialogs/use-create-project';
import { NonMemberView } from '@web/pages/studio/container/NonMemberView';
import { StudioHeader } from '@web/pages/studio/container/StudioHeader';
import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioTabKey } from '@web/pages/studio/container/studio-tabs';
import { CollectionsTab } from '@web/pages/studio/container/tabs/CollectionsTab';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { WorksTab } from '@web/pages/studio/container/tabs/WorksTab';

/**
 * Map a backend `ProjectSummary` (the studio-projects API contract) onto the
 * container's `ContainerProject` view model. Owner is derived at the callsite
 * as `myRole === 'owner'` (no redundant field); `updatedAt` is normalized to an
 * ISO string for the card's relative-time label.
 * @param p the project summary from `GET /studio/:slug/projects`.
 * @returns the project card view model.
 */
function toContainerProject(p: ProjectSummary): ContainerProject {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    thumbnailUrl: p.thumbnailUrl,
    visibility: p.visibility,
    myRole: p.myRole,
    updatedAt: new Date(p.updatedAt).toISOString(),
  };
}

/**
 * Studio container page (`/studio/{slug}`, spec §6) — the per-studio
 * workspace. The rail + top bar live in the layout route; this page renders
 * the studio header + center area, forking on the viewer's role:
 * - **member** (`myStudioRole !== null`): a 6-tab body (projects / collections
 *   / works / members / credits / settings; 5 for personal studios, which drop
 *   the team-only Members tab). Works sits at the 3rd position (spec §6.1).
 * - **non-member** (`myStudioRole === null`, decision A: 200 + null): the
 *   header + `NonMemberView` (a "Works" empty state), with NO tabs — no studio
 *   data is rendered, so private content cannot leak (spec §6.3).
 *
 * The studio header comes from the real API (`GET /studio/:slug`, with the
 * viewer's role); projects come from `GET /studio/:slug/projects` (slice 2).
 * The other tab **contents** stay on stub until their own slices build their
 * backends. A missing slug renders the error state (the service returns 404);
 * React Query dedupes the queries so StrictMode's double mount fetches once.
 * @returns the studio container page.
 */
export default function StudioContainerPage(): React.JSX.Element {
  const { slug = '' } = useParams();
  const t = useTranslation();
  const studioQuery = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => studiosApi.get(slug),
  });
  const projectsQuery = useQuery({
    queryKey: ['studio', slug, 'projects'],
    queryFn: () => studiosApi.listProjects(slug),
    enabled: slug !== '',
  });
  const membersQuery = useQuery({
    queryKey: ['studio', slug, 'members'],
    queryFn: () => studiosApi.listMembers(slug),
    enabled: slug !== '',
  });
  // The viewer's studios feed the create-project selector (spec §7.1). This is
  // the same query the layout route runs (same key) — React Query dedupes it,
  // so the container adds no extra request.
  const studiosQuery = useQuery({
    queryKey: ['studios', 'user'],
    queryFn: () => studiosApi.listUserStudios(),
  });
  const studios = studiosQuery.data ?? [];
  const createProject = useCreateProject(studios);
  const [tab, setTab] = React.useState<StudioTabKey>('projects');

  const studio = studioQuery.data;
  // Projects (slice 2) + members (slice 3) come from the real API; the other
  // tab CONTENTS stay EMPTY (not faked) until their own slices wire real APIs.
  const projects: ContainerProject[] = (projectsQuery.data ?? []).map(
    toContainerProject,
  );
  const members: StudioMember[] = (membersQuery.data ?? []).map((m) => ({
    id: m.userId,
    name: m.name,
    email: m.email,
    avatarUrl: m.avatarUrl,
    studioRole: m.role,
    joinedAt: m.addedAt,
  }));
  const view = studio ? { ...getEmptyContainerView(), studio } : null;
  // The selector lists the studios the viewer may create in; the default is the
  // current studio when the viewer is its admin, else the personal studio (§7.1).
  const creatable = creatableStudios(studios);
  const defaultStudioId = defaultCreateStudioId(studios, studio);

  return (
    <div className='flex h-full flex-col'>
      {studioQuery.isPending ? (
        <div
          role='status'
          className='flex flex-1 items-center justify-center text-sm text-muted-foreground'
        >
          {t('studio.container.shell.loading')}
        </div>
      ) : view === null ? (
        <div
          role='alert'
          className='flex flex-1 items-center justify-center text-sm text-muted-foreground'
        >
          {t('studio.container.shell.loadError')}
        </div>
      ) : view.studio.myStudioRole === null ? (
        // Non-member (decision A: public façade, 200 + null role) — header +
        // works empty state, NO tabs (spec §6.3). No studio data is rendered.
        <div className='flex w-full min-h-0 flex-1 flex-col'>
          <StudioHeader studio={view.studio} />
          <div className='min-h-0 flex-1 overflow-auto'>
            <NonMemberView />
          </div>
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as StudioTabKey)}
          className='flex w-full min-h-0 flex-1 flex-col'
        >
          <StudioHeader studio={view.studio} />
          <StudioTabBar
            studioType={view.studio.type}
            counts={{
              projects: projects.length,
              collections: view.collections.length,
              members: members.length,
            }}
          />
          <div className='min-h-0 flex-1 overflow-auto'>
            <div className={`${CENTER_COLUMN} pt-[18px] pb-12`}>
              <TabsContent value='projects'>
                <ProjectsTab
                  projects={projects}
                  studioRole={view.studio.myStudioRole}
                  onCreateProject={createProject}
                  creatableStudios={creatable}
                  defaultStudioId={defaultStudioId}
                />
              </TabsContent>
              <TabsContent value='collections'>
                <CollectionsTab
                  collections={view.collections}
                  studioRole={view.studio.myStudioRole}
                />
              </TabsContent>
              <TabsContent value='works'>
                <WorksTab />
              </TabsContent>
              <TabsContent value='members'>
                <MembersTab
                  members={members}
                  studioRole={view.studio.myStudioRole}
                  studioType={view.studio.type}
                />
              </TabsContent>
              <TabsContent value='credits'>
                <CreditsTab
                  wallet={view.wallet}
                  studioRole={view.studio.myStudioRole}
                />
              </TabsContent>
              <TabsContent value='settings'>
                <SettingsTab studio={view.studio} />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      )}
    </div>
  );
}
