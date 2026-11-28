// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as React from 'react';

import { DropdownMenuItem } from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import {
  CREATABLE_NODE_TYPES,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { MODALITY_ICONS } from '@web/spaces/canvas/nodes/_shared/modality';

/**
 * i18n label key per creatable type — reuses the existing `canvas.handle.*`
 * node labels (present in all 5 locales) rather than minting new keys.
 */
const NODE_LABEL_KEY: Record<CreatableNodeType, string> = {
  text: 'canvas.handle.nodeText',
  image: 'canvas.handle.nodeImage',
  audio: 'canvas.handle.nodeAudio',
  video: 'canvas.handle.nodeVideo',
};

/** The default for `disabledTypes`: one stable empty list. */
const NONE_DISABLED: readonly CreatableNodeType[] = [];

interface CreatableNodeMenuItemsProps {
  /** Called with the chosen creatable node type when a row is selected. */
  onPick: (type: CreatableNodeType) => void;
  /**
   * The types to offer, in the given order. Defaults to all 4 creatable
   * modalities; the connect-create menu passes the rule-compatible subset.
   */
  types?: readonly CreatableNodeType[];
  /**
   * Types listed but not pickable: the selection plus lists all four and
   * greys out the ones no node it would wire in connects into (inner#2216).
   */
  disabledTypes?: readonly CreatableNodeType[];
}

/**
 * Creatable-node rows (modality icon + localized label), shared by the
 * node-library dropdown (chrome), the canvas right-click menu, and the
 * connect-create menu so all offer the same rows in the same order. Renders
 * `DropdownMenuItem`s, so it must live inside a `DropdownMenuContent`.
 * @param root0 - Component props.
 * @param root0.onPick - Called with the chosen creatable node type.
 * @param root0.types - The types to offer (defaults to all 4).
 * @param root0.disabledTypes - Types shown greyed out and not pickable.
 * @returns The creatable-node dropdown items.
 */
export function CreatableNodeMenuItems({
  onPick,
  types = CREATABLE_NODE_TYPES,
  disabledTypes = NONE_DISABLED,
}: CreatableNodeMenuItemsProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <>
      {types.map((type) => {
        const Icon = MODALITY_ICONS[type];
        return (
          <DropdownMenuItem
            key={type}
            data-testid={`create-node-${type}`}
            disabled={disabledTypes.includes(type)}
            // The vendor row drops pointer events when disabled, which hides
            // the not-allowed cursor; same override as NodeContextMenu's
            // snapshot row. Radix still ignores the press.
            className='data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
            onSelect={() => onPick(type)}
          >
            <Icon className='mr-2 h-4 w-4' aria-hidden='true' />
            {t(NODE_LABEL_KEY[type])}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
