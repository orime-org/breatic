// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { CENTER_COLUMN } from '@web/pages/studio/container/container-layout';
import {
  studioTabPath,
  visibleStudioTabs,
  type StudioTabKey,
} from '@web/pages/studio/container/studio-tabs';
import type {
  StudioRole,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

interface StudioTabBarProps {
  /**
   * Which sections are on offer. It decides nothing today: no section is
   * marked team-only, so both kinds of studio get all six — a personal
   * studio's Members section is read-only rather than absent (decision A,
   * 2026-06-08). The filter behind it is kept for a future section that is
   * genuinely team-only.
   */
  studioType: StudioType;
  /**
   * The viewer's role here. Credits is the studio's money, so only its admin
   * is offered that section; the other five are the same for everyone.
   */
  viewerRole: StudioRole;
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
 * The studio container's section strip (spec §2.2) — each section a link to
 * its own address. Which ones are on offer depends on the reader: Credits is
 * the studio admin's alone, so everyone else sees five.
 *
 * LINKS, NOT A TABLIST, and the difference is not cosmetic. The ARIA tabs
 * widget moves focus with the arrow keys and activates whatever focus lands
 * on; that is the right trade when activating means swapping a panel that is
 * already loaded, and W3C recommends it for exactly that reason. Here
 * activating means going to an address, so arrowing along the strip to LOOK
 * would write a history entry at every stop and a keyboard user would need one
 * Back per keystroke to get out. (It never did: before this change the section
 * was component state and went nowhere. The cost is what the widget would have
 * made of an address, which is why the widget went rather than the address.) Focus movement and navigation are two
 * different acts and links keep them apart: Tab moves, Enter goes.
 *
 * Being links also restores what a tab can never offer — open in a new tab,
 * copy link address, and seeing the destination on hover.
 *
 * The active section gets the neutral activation border (`border-active-border`,
 * the single source for neutral selected/active borders — ruled 2026-07-11,
 * enforced by breatic/active-border); the others are muted and darken on hover.
 * Each label may carry a muted count chip.
 * @param props the studio type, viewer role, counts, current section and slug.
 * @param props.studioType whether the studio is personal or team.
 * @param props.viewerRole the viewer's role in this studio.
 * @param props.counts per-tab item counts (chip shown when present).
 * @param props.current the section currently shown.
 * @param props.slug the studio whose sections these are.
 * @returns the section strip.
 */
export function StudioTabBar({
  studioType,
  viewerRole,
  counts,
  current,
  slug,
}: StudioTabBarProps): React.JSX.Element {
  const t = useTranslation();
  const tabs = visibleStudioTabs(studioType, viewerRole);
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
            // `cn` and not a template literal. Both halves of each pair are
            // plain utilities of equal specificity, so with concatenation the
            // one that happens to sit later in the compiled sheet wins — which
            // is `border-transparent` and `text-muted-foreground`, the two this
            // is trying to override. The current section then paints exactly
            // like the five it is meant to be told apart from. twMerge drops
            // the loser instead of leaving the outcome to file order.
            className={cn(
              LINK_BASE,
              isCurrent && 'border-active-border text-foreground',
            )}
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
