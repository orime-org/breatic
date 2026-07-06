// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

interface CreatableNodeMenuItemsProps {
  /** Called with the chosen creatable node type when a row is selected. */
  onPick: (type: CreatableNodeType) => void;
}

/**
 * The 4 creatable-node rows (modality icon + localized label), shared by the
 * node-library dropdown (chrome) and the canvas right-click menu so both
 * offer the same set in the same order. Renders `DropdownMenuItem`s, so it
 * must live inside a `DropdownMenuContent`.
 * @param root0 - Component props.
 * @param root0.onPick - Called with the chosen creatable node type.
 * @returns The 4 creatable-node dropdown items.
 */
export function CreatableNodeMenuItems({
  onPick,
}: CreatableNodeMenuItemsProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <>
      {CREATABLE_NODE_TYPES.map((type) => {
        const Icon = MODALITY_ICONS[type];
        return (
          <DropdownMenuItem
            key={type}
            data-testid={`create-node-${type}`}
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
