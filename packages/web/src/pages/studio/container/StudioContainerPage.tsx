// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { ProjectSummary } from '@breatic/shared';
import { Tabs, TabsContent } from '@web/components/ui/tabs';
import { projectsApi } from '@web/data/api/projects';
import { studiosApi } from '@web/data/api/studios';
import { useTranslation } from '@web/i18n/use-translation';
import { getStubStudioView } from '@web/pages/studio/container/container-stub';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import type { NewItemValues } from '@web/pages/studio/container/dialogs/NewItemDialog';
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
 * container's `ContainerProject` view model: `isOwner` is derived from
 * `myRole` (the contract drops it as redundant), and the date fields the card
 * does not render are dropped.
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
    isOwner: p.myRole === 'owner',
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
  const queryClient = useQueryClient();
  const studioQuery = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => studiosApi.get(slug),
  });
  const projectsQuery = useQuery({
    queryKey: ['studio', slug, 'projects'],
    queryFn: () => studiosApi.listProjects(slug),
    enabled: slug !== '',
  });
  const createProject = useMutation({
    mutationFn: (values: NewItemValues) => {
      // `create` always targets the studio whose container this is. The
      // GitHub-owner-style studio selector (picking a *different* studio) is
      // a later slice (§7); until then the studioId is the current studio.
      const studioId = studioQuery.data?.id;
      if (studioId === undefined) {
        return Promise.reject(new Error('studio not loaded'));
      }
      return projectsApi.create({
        studioId,
        name: values.name,
        slug: values.slug,
        visibility: values.visibility,
        spaceType: values.spaceType ?? 'canvas',
        description: values.description || undefined,
      });
    },
    onSuccess: () => {
      // The new project lands in the caller's studio; refetch so its card
      // appears. The owner row is written with the project, so opening it
      // never needs the open-baseline materialize path.
      void queryClient.invalidateQueries({
        queryKey: ['studio', slug, 'projects'],
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      toast.error(t('studio.container.projects.createError'), {
        description: message || undefined,
      });
    },
  });
  const [tab, setTab] = React.useState<StudioTabKey>('projects');

  const studio = studioQuery.data;
  // Projects come from the real API (slice 2); the other tab CONTENTS stay on
  // stub until their own slices.
  const projects: ContainerProject[] = (projectsQuery.data ?? []).map(
    toContainerProject,
  );
  const view = studio ? { ...getStubStudioView(slug), studio } : null;

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
        <div className='mx-auto flex w-full min-h-0 max-w-[1320px] flex-1 flex-col'>
          <StudioHeader studio={view.studio} />
          <div className='min-h-0 flex-1 overflow-auto'>
            <NonMemberView />
          </div>
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as StudioTabKey)}
          className='mx-auto flex w-full min-h-0 max-w-[1320px] flex-1 flex-col'
        >
          <StudioHeader studio={view.studio} />
          <StudioTabBar
            studioType={view.studio.type}
            counts={{
              projects: projects.length,
              collections: view.collections.length,
              members: view.members.length,
            }}
          />
          <div className='min-h-0 flex-1 overflow-auto px-6 py-5'>
            <TabsContent value='projects'>
              <ProjectsTab
                projects={projects}
                studioRole={view.studio.myStudioRole}
                onCreateProject={(values) => createProject.mutate(values)}
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
            {view.studio.type === 'team' ? (
              <TabsContent value='members'>
                <MembersTab
                  members={view.members}
                  studioRole={view.studio.myStudioRole}
                />
              </TabsContent>
            ) : null}
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
        </Tabs>
      )}
    </div>
  );
}
