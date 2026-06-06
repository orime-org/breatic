// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { useTranslation } from '@web/i18n/use-translation';
import { visibleStudioTabs } from '@web/pages/studio/container/studio-tabs';
import type { StudioType } from '@web/pages/studio/shared/studio-types';

interface StudioTabBarProps {
  /** Decides whether the team-only Members tab shows (spec §2.2). */
  studioType: StudioType;
}

/**
 * The studio container tab bar (spec §2.2) — a horizontal 5-tab strip (4 for
 * personal studios). The active tab gets a brand-colored bottom border (spec
 * §1.2 studio brand exemption); inactive tabs are muted and darken on hover.
 * Renders into a parent `<Tabs>` Root, which supplies keyboard arrow
 * navigation + the ARIA tablist roles.
 * @param props the studio type controlling tab visibility.
 * @param props.studioType whether the studio is personal or team.
 * @returns the tab bar list.
 */
export function StudioTabBar({
  studioType,
}: StudioTabBarProps): React.JSX.Element {
  const t = useTranslation();
  const tabs = visibleStudioTabs(studioType);
  return (
    <TabsList className='w-full justify-start gap-1 border-b border-border px-6'>
      {tabs.map((tab) => (
        <TabsTrigger
          key={tab.key}
          value={tab.key}
          className='-mb-px border-b-2 border-transparent px-3 py-2.5 text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground'
        >
          {t(tab.labelKey)}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
