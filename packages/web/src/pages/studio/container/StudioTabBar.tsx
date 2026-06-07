// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { useTranslation } from '@web/i18n/use-translation';
import {
  visibleStudioTabs,
  type StudioTabKey,
} from '@web/pages/studio/container/studio-tabs';
import type { StudioType } from '@web/pages/studio/shared/studio-types';

interface StudioTabBarProps {
  /** Decides whether the team-only Members tab shows (spec §2.2). */
  studioType: StudioType;
  /**
   * Per-tab item counts shown as a muted chip after the label (locked mock:
   * projects / collections / members carry a count; credits / settings do
   * not). A tab whose key is absent renders no chip.
   */
  counts?: Partial<Record<StudioTabKey, number>>;
}

/**
 * The studio container tab bar (spec §2.2) — a horizontal 5-tab strip (4 for
 * personal studios). The active tab gets a neutral foreground bottom border
 * (the studio chrome is neutral — visual ADR 2026-06-06, no longer
 * brand-exempt); inactive tabs are muted and darken on hover. Each label may
 * carry a muted count chip. Renders into a parent `<Tabs>` Root, which
 * supplies keyboard arrow navigation + the ARIA tablist roles.
 * @param props the studio type and optional per-tab counts.
 * @param props.studioType whether the studio is personal or team.
 * @param props.counts per-tab item counts (chip shown when present).
 * @returns the tab bar list.
 */
export function StudioTabBar({
  studioType,
  counts,
}: StudioTabBarProps): React.JSX.Element {
  const t = useTranslation();
  const tabs = visibleStudioTabs(studioType);
  return (
    <TabsList className='w-full justify-start gap-0.5 border-b border-border px-6'>
      {tabs.map((tab) => {
        const count = counts?.[tab.key];
        return (
          <TabsTrigger
            key={tab.key}
            value={tab.key}
            className='-mb-px gap-1.5 border-b-2 border-transparent px-3 py-2.5 font-semibold text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground'
          >
            {t(tab.labelKey)}
            {count !== undefined ? (
              <span className='rounded-full bg-muted px-1.5 text-xs font-medium leading-[18px] text-muted-foreground'>
                {count}
              </span>
            ) : null}
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}
