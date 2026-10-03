// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the block handle's menus share: where a rule goes between block type
 * rows, how a row out of the command's reach is drawn, and how wide the menus
 * listing block types are.
 *
 * The handle menu (`DocumentBlockMenu.tsx`) and the plus menu
 * (`DocumentInsertChoices.tsx`) both draw rows this way.
 */

import type * as React from 'react';

import type {
  DropdownMenuItem,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import {
  DIMENSION_OF_ROW,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import { UNAVAILABLE_KEYBOARD_FOCUS_ONLY } from '@web/spaces/document/document-unavailable-control';

/**
 * The narrowest a menu listing block types is drawn: the handle menu's own
 * floor (`components/ui/dropdown-menu.tsx`'s content) and the bubble bar's
 * (`document-bubble-menu.tsx`), so the menus side by side read as one family.
 * A submenu's own floor is 8rem, which user 2026-10-02 found too narrow for
 * these rows. Longer labels still widen it.
 */
export const TYPE_MENU_WIDTH = 'min-w-[10rem]';

/**
 * Whether a rule goes after this row.
 *
 * Drawn wherever the order crosses from one of the three dimensions to the
 * next, which is how the bubble bar's own type menu groups the same rows. Read
 * off `DIMENSION_OF_ROW` so a row added to a group lands inside its rules by
 * saying which group it is in — the one place that already has to say so.
 * @param id - The row being drawn.
 * @param next - The row after it, or undefined at the end of the list.
 * @returns True when a rule belongs between the two.
 */
export function rulesAfter(id: BlockTypeId, next: BlockTypeId | undefined): boolean {
  return next !== undefined && DIMENSION_OF_ROW[id] !== DIMENSION_OF_ROW[next];
}

/**
 * The keys Radix opens a submenu with, reading left to right.
 *
 * `MenuSubTrigger`'s own handler opens on these three and cancels the event;
 * cancelling them first is what keeps a row out of reach from opening. Every
 * other key is left alone, so arrowing up and down the menu still works on a
 * greyed row — which is the whole reason it is `aria-disabled` rather than
 * Radix's `disabled` (the ARIA authoring practices: "Disabled menu items are
 * focusable but cannot be activated").
 */
const OPENS_SUBMENU = new Set(['ArrowRight', 'Enter', ' ']);

/**
 * What every row out of reach carries, trigger or item: dimmed, reachable by
 * the keyboard (`aria-disabled`, not Radix's `disabled`), and not lit up
 * under the pointer.
 */
const GREYED = {
  'aria-disabled': 'true',
  className: UNAVAILABLE_KEYBOARD_FOCUS_ONLY,
  onPointerMove: (event: React.PointerEvent): void => {
    event.preventDefault();
  },
} as const;

/**
 * What a submenu trigger carries while the hovered row is out of the
 * command's reach.
 *
 * A row that greys owes three things (`document-bubble-slots.tsx`), and in a
 * menu the first of them — take the menu away — means this one must not open
 * at all. GREYING ALONE DOES NOT DO THAT: Radix's `MenuSubTrigger` hands
 * `MenuItemImpl` its own `onClick` and `onPointerMove`, and those consult
 * `props.disabled` and `event.defaultPrevented` and nothing else, so
 * `aria-disabled` and a class are invisible to them. Cancelling the event is
 * what they read.
 *
 * The third thing — say so — is the treatment itself, the same dimming the
 * reader has already met on the bubble bar's own two slots when the selection
 * moved out of reach. No extra words: the commands ARE built, so a "not open
 * yet" note would say something false here.
 * @param unavailable - Whether the command is out of reach on this row.
 * @returns Attributes to spread onto the trigger, empty where it can act.
 */
export function whenOutOfReach(
  unavailable: boolean,
): React.ComponentProps<typeof DropdownMenuSubTrigger> {
  if (!unavailable) {
    return {};
  }
  return {
    ...GREYED,
    onClick: (event) => {
      event.preventDefault();
    },
    onKeyDown: (event) => {
      if (OPENS_SUBMENU.has(event.key)) {
        event.preventDefault();
      }
    },
  };
}

/**
 * What a menu row carries, depending on whether its command reaches the
 * hovered row.
 *
 * The item's version of {@link whenOutOfReach}. A row out of reach is dimmed,
 * keeps the keyboard able to land on it (`aria-disabled`, not Radix's
 * `disabled`), does not light up under the pointer, and does nothing when
 * chosen.
 * @param reachable - Whether the command reaches this row.
 * @param run - What choosing the row does when it does.
 * @returns Attributes to spread onto the item.
 */
export function itemWithin(
  reachable: boolean,
  run: () => void,
): React.ComponentProps<typeof DropdownMenuItem> {
  if (reachable) {
    return { onSelect: run };
  }
  return {
    ...GREYED,
    onSelect: (event) => {
      event.preventDefault();
    },
  };
}
