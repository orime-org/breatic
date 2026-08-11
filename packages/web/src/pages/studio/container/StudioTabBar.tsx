// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { useTranslation } from '@web/i18n/use-translation';
import { CENTER_COLUMN } from '@web/pages/studio/container/container-layout';
import {
  studioTabPath,
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
  /** The section being shown, marked `aria-current="page"`. */
  current: StudioTabKey;
  /** The studio these sections belong to — each link's address is built from it. */
  slug: string;
}

/** Shared by every section link; the current one adds the activation border. */
const LINK_BASE =
  'inline-flex items-center gap-1.5 -mb-px border-b border-transparent px-3 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * The studio container's section strip (spec §2.2) — six sections for a team
 * studio, each a link to its own address.
 *
 * LINKS, NOT A TABLIST, and the difference is not cosmetic. The ARIA tabs
 * widget moves focus with the arrow keys and activates whatever focus lands
 * on; that is the right trade when activating means swapping a panel that is
 * already loaded, and W3C recommends it for exactly that reason. Here
 * activating means going to an address, so arrowing along the strip to LOOK
 * wrote a history entry at every stop and a keyboard user had to press Back
 * once per keystroke to get back out. Focus movement and navigation are two
 * different acts and links keep them apart: Tab moves, Enter goes.
 *
 * Being links also restores what a tab can never offer — open in a new tab,
 * copy link address, and seeing the destination on hover.
 *
 * The active section gets the neutral activation border (`border-active-border`,
 * the single source for neutral selected/active borders — ruled 2026-07-11,
 * enforced by breatic/active-border); the others are muted and darken on hover.
 * Each label may carry a muted count chip.
 * @param props the studio type, counts, current section and studio slug.
 * @param props.studioType whether the studio is personal or team.
 * @param props.counts per-tab item counts (chip shown when present).
 * @param props.current the section currently shown.
 * @param props.slug the studio whose sections these are.
 * @returns the section strip.
 */
export function StudioTabBar({
  studioType,
  counts,
  current,
  slug,
}: StudioTabBarProps): React.JSX.Element {
  const t = useTranslation();
  const tabs = visibleStudioTabs(studioType);
  return (
    <nav
      aria-label={t('studio.container.tabs.navLabel')}
      className={`${CENTER_COLUMN} mt-3.5 flex justify-start gap-0.5 border-b border-border`}
    >
      {tabs.map((tab) => {
        const count = counts?.[tab.key];
        const isCurrent = tab.key === current;
        return (
          <Link
            key={tab.key}
            to={studioTabPath(slug, tab.key)}
            // `aria-current` rather than a selected state: the reader is not
            // choosing among options, they are somewhere, and this says where.
            aria-current={isCurrent ? 'page' : undefined}
            className={
              isCurrent
                ? `${LINK_BASE} border-active-border text-foreground`
                : LINK_BASE
            }
          >
            {t(tab.labelKey)}
            {count !== undefined ? (
              <span className='rounded-full bg-muted px-1.5 text-xs font-medium leading-[18px] text-muted-foreground'>
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
