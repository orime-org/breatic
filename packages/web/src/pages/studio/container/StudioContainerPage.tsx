// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { Tabs, TabsContent } from '@web/components/ui/tabs';
import { studiosApi } from '@web/data/api/studios';
import { useTranslation } from '@web/i18n/use-translation';
import { getStubStudioView } from '@web/pages/studio/container/container-stub';
import { StudioHeader } from '@web/pages/studio/container/StudioHeader';
import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioTabKey } from '@web/pages/studio/container/studio-tabs';
import { CollectionsTab } from '@web/pages/studio/container/tabs/CollectionsTab';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { STUB_GUEST_PROJECT_COUNT } from '@web/pages/studio/recent/recent-stub';
import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';

/**
 * Studio container page (`/studio/{slug}`, spec §2.2) — the per-studio
 * workspace: the app top bar (switcher showing the current studio) over the
 * studio header and a 5-tab body (projects / collections / members / credits /
 * settings; 4 for personal studios).
 *
 * Slice 1 wires the **shell** to real APIs: the studio header
 * (`GET /studio/:slug`, with the viewer's role — `null` = guest, decision A)
 * and the switcher list (`GET /studios`). The tab **contents** stay on stub
 * until their own slices (projects=2 / members=3 / credits=4 / collections=5)
 * build their backends. A missing slug renders the error state (the service
 * returns 404); React Query dedupes the queries so StrictMode's double mount
 * fetches once.
 * @returns the studio container page.
 */
export default function StudioContainerPage(): React.JSX.Element {
  const { slug = '' } = useParams();
  const t = useTranslation();
  const studioQuery = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => studiosApi.get(slug),
  });
  const studiosQuery = useQuery({
    queryKey: ['studios', 'user'],
    queryFn: () => studiosApi.listUserStudios(),
  });
  const [tab, setTab] = React.useState<StudioTabKey>('projects');

  const studio = studioQuery.data;
  const studios = studiosQuery.data ?? [];
  // Shell from the real query; tab CONTENTS stay on stub until their slices.
  const view = studio ? { ...getStubStudioView(slug), studio } : null;

  return (
    <div className='flex h-screen flex-col bg-background text-foreground'>
      <StudioTopBar
        current={studio ? { name: studio.name } : undefined}
        studios={studios}
        activeSlug={slug}
        guestProjectCount={STUB_GUEST_PROJECT_COUNT}
      />
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
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as StudioTabKey)}
          className='mx-auto flex w-full min-h-0 max-w-[1080px] flex-1 flex-col'
        >
          <StudioHeader studio={view.studio} />
          <StudioTabBar studioType={view.studio.type} />
          <div className='min-h-0 flex-1 overflow-auto px-6 py-5'>
            <TabsContent value='projects'>
              <ProjectsTab
                projects={view.projects}
                studioRole={view.studio.myStudioRole}
              />
            </TabsContent>
            <TabsContent value='collections'>
              <CollectionsTab
                collections={view.collections}
                studioRole={view.studio.myStudioRole}
              />
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
