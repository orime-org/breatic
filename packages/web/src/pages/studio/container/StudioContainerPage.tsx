// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { ProjectSummary } from '@breatic/shared';
import { ScrollArea } from '@web/components/ui/scroll-area';
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
import {
  isAddressableTabSegment,
  studioTabFromParam,
} from '@web/pages/studio/container/studio-tabs';
import { CollectionsTab } from '@web/pages/studio/container/tabs/CollectionsTab';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { WorksTab } from '@web/pages/studio/container/tabs/WorksTab';

/**
 * Map a backend `ProjectSummary` (the studio-projects API contract) onto the
 * container's `ContainerProject` view model. Owner is derived at the callsite
 * as `myRole === 'owner'` (no redundant field); `createdAt` is normalized to an
 * ISO string for the card's "created {time}" label (the catalog shows a stable
 * creation time, not last-activity).
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
    createdAt: new Date(p.createdAt).toISOString(),
  };
}

/**
 * Studio container page (`/studio/{slug}`, spec §6) — the per-studio
 * workspace. The rail + top bar live in the layout route; this page renders
 * the studio header + center area, forking on the viewer's role:
 * - **member** (`myStudioRole !== null`): six sections (projects / collections
 *   / works / members / credits / settings), the same six for personal studios
 *   — their Members section is read-only rather than absent (decision A,
 *   2026-06-08). Works sits at the 3rd position (spec §6.1).
 * - **non-member** (`myStudioRole === null`, decision A: 200 + null): the
 *   header + `NonMemberView` (a "Works" empty state), with NO sections — no
 *   studio data is rendered, so private content cannot leak (spec §6.3).
 *
 * The studio header comes from the real API (`GET /studio/:slug`, with the
 * viewer's role); projects come from `GET /studio/:slug/projects` (slice 2).
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
  // The address is the tab. Holding it in component state instead made every
  // tab the same address: a link could only ever say "that studio", a refresh
  // dropped the reader back on Projects, and Back skipped past the switches
  // the user had made. So the segment is read here rather than mirrored — one
  // value, no chance of the page and the address bar disagreeing.
  const tab = studioTabFromParam(tabParam);

  const studio = studioQuery.data;
  // Projects (slice 2) + members (slice 3) come from the real API; the other
  // tab CONTENTS stay EMPTY (not faked) until their own slices wire real APIs.
  const projects: ContainerProject[] = (projectsQuery.data ?? []).map(
    toContainerProject,
  );
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

  // Two addresses resolve to the studio itself rather than being rendered or
  // left in the bar. Both are reached the ordinary way — a typo, an old link,
  // or somebody's own settings link pasted to someone else — so each gets the
  // one address that is certainly right instead of a page that contradicts it.
  //
  // A segment this scheme would never have produced. Answerable without
  // waiting for anything. It is the address being judged rather than the name,
  // which is why this is not called "names no tab": `projects` IS a tab name,
  // but the default section's address carries no segment, so spelling it out
  // is a second address for a page that has one — and the strip's first link,
  // marked as the current page, would point somewhere other than the bar.
  const segmentIsNotOneWeEmit =
    tabParam !== undefined && !isAddressableTabSegment(tabParam);
  // A real tab name on a studio the viewer is not in. The public façade below
  // renders no tabs at all, so the address would claim a tab that is not on
  // the page. This one has to wait for the studio to load: until then we do
  // not know whether the viewer is a member.
  const tabIsNotOnThisPage =
    tabParam !== undefined && studio?.myStudioRole === null;
  if (segmentIsNotOneWeEmit || tabIsNotOnThisPage) {
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
            current={tab}
            slug={slug}
            counts={{
              projects: projects.length,
              collections: view.collections.length,
              members: members.length,
            }}
          />
          <ScrollArea className='min-h-0 flex-1'>
            <div className={`${CENTER_COLUMN} pt-[18px] pb-12`}>
              {tab === 'projects' ? (
                <ProjectsTab
                  projects={projects}
                  studioRole={view.studio.myStudioRole}
                  onCreateProject={createProject}
                  creatableStudios={creatable}
                  defaultStudioId={defaultStudioId}
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
                <CreditsTab
                  slug={slug}
                  studioRole={view.studio.myStudioRole}
                />
              ) : null}
              {tab === 'settings' ? (
                <SettingsTab studio={view.studio} members={members} />
              ) : null}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
