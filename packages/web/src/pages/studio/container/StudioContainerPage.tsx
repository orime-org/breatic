// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useParams } from 'react-router-dom';

import { Tabs, TabsContent } from '@web/components/ui/tabs';
import { getStubStudioView } from '@web/pages/studio/container/container-stub';
import { StudioHeader } from '@web/pages/studio/container/StudioHeader';
import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioTabKey } from '@web/pages/studio/container/studio-tabs';
import { CollectionsTab } from '@web/pages/studio/container/tabs/CollectionsTab';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { MembersTab } from '@web/pages/studio/container/tabs/MembersTab';
import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import {
  STUB_GUEST_PROJECT_COUNT,
  STUB_STUDIOS,
} from '@web/pages/studio/recent/recent-stub';
import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';

/**
 * Studio container page (`/studio/{slug}`, spec §2.2) — the per-studio
 * workspace: the app top bar (switcher showing the current studio) over the
 * studio header and a 5-tab body (projects / collections / members / credits /
 * settings; 4 for personal studios). Tab content is stubbed in slice 3
 * (frontend-on-stub); Phase 2 wires the real per-tab APIs.
 * @returns the studio container page.
 */
export default function StudioContainerPage(): React.JSX.Element {
  const { slug = '' } = useParams();
  const view = getStubStudioView(slug);
  const role = view.studio.myStudioRole;
  const [tab, setTab] = React.useState<StudioTabKey>('projects');
  return (
    <div className='flex h-screen flex-col bg-background text-foreground'>
      <StudioTopBar
        current={{ name: view.studio.name }}
        studios={STUB_STUDIOS}
        activeSlug={slug}
        guestProjectCount={STUB_GUEST_PROJECT_COUNT}
      />
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as StudioTabKey)}
        className='flex min-h-0 flex-1 flex-col'
      >
        <StudioHeader studio={view.studio} />
        <StudioTabBar studioType={view.studio.type} />
        <div className='min-h-0 flex-1 overflow-auto p-4'>
          <TabsContent value='projects'>
            <ProjectsTab projects={view.projects} studioRole={role} />
          </TabsContent>
          <TabsContent value='collections'>
            <CollectionsTab collections={view.collections} studioRole={role} />
          </TabsContent>
          {view.studio.type === 'team' ? (
            <TabsContent value='members'>
              <MembersTab members={view.members} studioRole={role} />
            </TabsContent>
          ) : null}
          <TabsContent value='credits'>
            <CreditsTab wallet={view.wallet} studioRole={role} />
          </TabsContent>
          <TabsContent value='settings'>
            <SettingsTab studio={view.studio} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
