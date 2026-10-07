// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { studiosApi } from '@web/data/api/studios';
import { ApiException } from '@web/data/api/types';
import { NotFoundScreen } from '@web/components/not-found-screen';
import { ResourceLoadError } from '@web/components/resource-load-error';
import { useTranslation } from '@web/i18n/use-translation';
import { CENTER_COLUMN } from '@web/pages/studio/container/container-layout';
import { getEmptyContainerView } from '@web/pages/studio/container/container-stub';
import type { StudioMember } from '@web/pages/studio/container/container-types';
import { useStudioListPrefs } from '@web/pages/studio/container/list-prefs';
import { useStudioProjectsPaging } from '@web/pages/studio/container/use-studio-projects-paging';
import {
  creatableStudios,
  defaultCreateStudioId,
} from '@web/pages/studio/container/dialogs/studio-create';
import { useCreateProject } from '@web/pages/studio/container/dialogs/use-create-project';
import { NonMemberView } from '@web/pages/studio/container/NonMemberView';
import { StudioHeader } from '@web/pages/studio/container/StudioHeader';
import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import {
  isAddressableTabSegment,
  isTabOnThisPage,
  studioTabFromParam,
} from '@web/pages/studio/container/studio-tabs';
import { CollectionsTab } from '@web/pages/studio/container/tabs/CollectionsTab';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { ArchivedTab } from '@web/pages/studio/container/tabs/ArchivedTab';
import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { WorksTab } from '@web/pages/studio/container/tabs/WorksTab';

/**
 * Studio container page (`/studio/{slug}`, spec §6) — the per-studio
 * workspace. The rail + top bar live in the layout route; this page renders
 * the studio header + center area, forking on the viewer's role:
 * - **member** (`myStudioRole !== null`): projects / collections / works /
 *   members / settings, the same for personal studios — their Members section
 *   is read-only rather than absent (decision A, 2026-06-08). Works sits at the
 *   3rd position (spec §6.1). The studio's admin also gets Archived, right
 *   after Projects, and Credits, between members and settings.
 * - **non-member** (`myStudioRole === null`, decision A: 200 + null): the
 *   header + `NonMemberView` (a "Works" empty state), with NO sections — no
 *   studio data is rendered, so private content cannot leak (spec §6.3).
 *
 * The studio header comes from the real API (`GET /studio/:slug`, with the
 * viewer's role); projects come from `GET /studio/:slug/projects` a page at a
 * time, each list in the sort and layout this browser remembers for it.
 * The remaining sections render EMPTY (not faked) until their own slices
 * wire real backends. A missing slug renders the error state (the service returns 404);
 * React Query dedupes the queries so StrictMode's double mount fetches once.
 * @returns the studio container page.
 */
export default function StudioContainerPage(): React.JSX.Element {
  const { slug = '', tab: tabParam } = useParams();
  const t = useTranslation();
  const studioQuery = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => studiosApi.get(slug),
  });
  // Remembered per studio by id, so renaming the studio keeps the choice.
  const studioId = studioQuery.data?.id ?? '';
  const projectPrefs = useStudioListPrefs(studioId, 'projects');
  const archivedPrefs = useStudioListPrefs(studioId, 'archived');
  // A non-member's façade shows no projects; nobody else is refused them.
  const isMember = studioQuery.data !== undefined && studioQuery.data.myStudioRole !== null;
  const projects = useStudioProjectsPaging({
    slug,
    archived: false,
    sort: projectPrefs.sort,
    enabled: isMember,
  });
  // Archived projects are the studio admin's alone; nobody else is sent for them.
  const isStudioAdmin = studioQuery.data?.myStudioRole === 'admin';
  const archivedProjects = useStudioProjectsPaging({
    slug,
    archived: true,
    sort: archivedPrefs.sort,
    enabled: isStudioAdmin,
  });
  const membersQuery = useQuery({
    queryKey: ['studio', slug, 'members'],
    queryFn: () => studiosApi.listMembers(slug),
    enabled: studioQuery.isSuccess,
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
  // The address is the tab. Holding it in component state instead made every
  // tab the same address: a link could only ever say "that studio", a refresh
  // dropped the reader back on Projects, and Back skipped past the switches
  // the user had made. So the segment is read here rather than mirrored — one
  // value, no chance of the page and the address bar disagreeing.
  const tab = studioTabFromParam(tabParam);

  const { refetch } = studioQuery;
  const retry = React.useCallback(() => { void refetch(); }, [refetch]);
  const studio = studioQuery.data;
  const membersView = membersQuery.data;
  const members: StudioMember[] = (membersView?.members ?? []).map((m) => ({
    id: m.userId,
    name: m.name,
    email: m.email,
    avatarUrl: m.avatarUrl,
    studioRole: m.role,
    joinedAt: m.addedAt,
  }));
  // Pending invitations are returned only to an admin viewer (the server gates
  // it); the Members tab renders them in a separate "invited" section.
  const pendingInvitations = membersView?.pendingInvitations ?? [];
  const view = studio ? { ...getEmptyContainerView(), studio } : null;
  // The selector lists the studios the viewer may create in; the default is the
  // current studio when the viewer is its admin, else the personal studio (§7.1).
  const creatable = creatableStudios(studios);
  const defaultStudioId = defaultCreateStudioId(studios, studio);

  // A real tab name for a section this viewer's strip does not carry — a
  // non-member (whose public façade renders no strip at all) or a member who
  // is not the admin standing on Credits. Both would leave the address
  // claiming a section that is not on the page. Asked of the same list the
  // strip is built from, so the link and the address can never disagree; and
  // it has to wait for the studio to load, since until then the viewer's role
  // is unknown.
  const tabIsNotOnThisPage =
    tabParam !== undefined &&
    studio !== undefined &&
    isAddressableTabSegment(tabParam) &&
    !isTabOnThisPage(tabParam, studio.type, studio.myStudioRole);
  if (studioQuery.error instanceof ApiException && studioQuery.error.status === 404) return <NotFoundScreen />;
  if (studioQuery.isError && !studioQuery.data) return <ResourceLoadError onRetry={retry} />;
  if (tabIsNotOnThisPage) {
    return <Navigate to={`/studio/${slug}`} replace />;
  }

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
          {/* ScrollArea (#1773): overlay scrollbar — appears only while
              scrolling, no layout space, hover changes color only. */}
          <ScrollArea className='min-h-0 flex-1'>
            <NonMemberView />
          </ScrollArea>
        </div>
      ) : (
        <div className='flex w-full min-h-0 flex-1 flex-col'>
          <StudioHeader studio={view.studio} />
          <StudioTabBar
            studioType={view.studio.type}
            viewerRole={view.studio.myStudioRole}
            current={tab}
            slug={slug}
            counts={{
              // A list's chip waits for its first page: until then the total is unknown.
              ...(projects.total !== null ? { projects: projects.total } : {}),
              ...(isStudioAdmin && archivedProjects.total !== null
                ? { archived: archivedProjects.total }
                : {}),
              collections: view.collections.length,
              members: members.length,
            }}
          />
          {/* The list being read pages as its end scrolls into view; only
              one of the two is on screen, so only it watches the scroller. */}
          <div
            ref={
              tab === 'projects'
                ? projects.scrollerRef
                : tab === 'archived'
                  ? archivedProjects.scrollerRef
                  : undefined
            }
            className='min-h-0 flex-1'
          >
            <ScrollArea className='h-full'>
              <div className={`${CENTER_COLUMN} pt-[18px] pb-12`}>
                {tab === 'projects' ? (
                  <ProjectsTab
                    list={projects}
                    sort={projectPrefs.sort}
                    onSortChange={projectPrefs.setSort}
                    view={projectPrefs.view}
                    onViewChange={projectPrefs.setView}
                    studioRole={view.studio.myStudioRole}
                    onCreateProject={createProject}
                    creatableStudios={creatable}
                    defaultStudioId={defaultStudioId}
                  />
                ) : null}
                {tab === 'archived' ? (
                  <ArchivedTab
                    list={archivedProjects}
                    sort={archivedPrefs.sort}
                    onSortChange={archivedPrefs.setSort}
                    view={archivedPrefs.view}
                    onViewChange={archivedPrefs.setView}
                  />
                ) : null}
                {tab === 'collections' ? (
                  <CollectionsTab
                    collections={view.collections}
                    studioRole={view.studio.myStudioRole}
                  />
                ) : null}
                {tab === 'works' ? <WorksTab /> : null}
                {tab === 'members' ? (
                  <MembersTab
                    slug={slug}
                    members={members}
                    pendingInvitations={pendingInvitations}
                    studioRole={view.studio.myStudioRole}
                    studioType={view.studio.type}
                  />
                ) : null}
                {tab === 'credits' ? (
                  <CreditsTab slug={slug} />
                ) : null}
                {tab === 'settings' ? (
                  <SettingsTab studio={view.studio} members={members} />
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
}
