// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Archive,
  Building2,
  LineChart,
  List,
  ShoppingCart,
  Undo2,
  UserCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** One entry in the overlay's index. */
export interface CreditsSection {
  /** Which panel it shows. */
  id: CreditsSectionId;
  /** Its label's translation key. */
  labelKey: string;
  /** Its icon. */
  icon: LucideIcon;
}

/** One group of entries, under a heading. */
export interface CreditsSectionGroup {
  /** The group's heading key. */
  labelKey: string;
  /** Its entries, in the order they are shown. */
  items: CreditsSection[];
}

/** Which panel the overlay is showing. */
export type CreditsSectionId =
  | 'overview'
  | 'lots'
  | 'ledger'
  | 'studios'
  | 'buy'
  | 'assign'
  | 'refunds';

/**
 * The index, in two groups.
 *
 * The split is what a reader came to do: the first group answers questions
 * about money already spent or held, the second changes something. Buying
 * comes before assigning because a purchase has to exist before it can be
 * pointed anywhere, and refunding comes last because it undoes both.
 */
export const CREDITS_SECTION_GROUPS: readonly CreditsSectionGroup[] = [
  {
    labelKey: 'credits.group.records',
    items: [
      { id: 'overview', labelKey: 'credits.section.overview', icon: LineChart },
      { id: 'lots', labelKey: 'credits.section.lots', icon: Archive },
      { id: 'ledger', labelKey: 'credits.section.ledger', icon: List },
      { id: 'studios', labelKey: 'credits.section.studios', icon: Building2 },
    ],
  },
  {
    labelKey: 'credits.group.actions',
    items: [
      { id: 'buy', labelKey: 'credits.section.buy', icon: ShoppingCart },
      { id: 'assign', labelKey: 'credits.section.assign', icon: UserCheck },
      { id: 'refunds', labelKey: 'credits.section.refunds', icon: Undo2 },
    ],
  },
];

/** Every section, flattened, in index order. */
export const CREDITS_SECTIONS: readonly CreditsSection[] =
  CREDITS_SECTION_GROUPS.flatMap((group) => group.items);
