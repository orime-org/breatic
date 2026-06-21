// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { GroupBackgroundPicker } from '@web/spaces/canvas/GroupBackgroundPicker';

interface GroupSelectionToolbarProps {
  /** What the selection offers: group a fresh multi-selection, or ungroup a selected group. */
  offer: 'group' | 'ungroup';
  /** Group the current multi-selection into a new group. */
  onGroup: () => void;
  /** Ungroup the selected group. */
  onUngroup: () => void;
  /** Background-tint picker open state (ungroup only). */
  bgOpen: boolean;
  /** Background-tint picker open-state change. */
  onBgOpenChange: (open: boolean) => void;
  /** The group's current tint token, or undefined for none. */
  bgValue: string | undefined;
  /** Apply / clear the group tint. */
  onPickBg: (value: string | undefined) => void;
}

/**
 * The floating toolbar shown above a canvas selection: a single "Group" button
 * for a fresh multi-selection, or a background-tint picker + "Ungroup" button
 * for a selected group. Extracted from CanvasSpace so the offer rendering is
 * unit-testable in isolation and the toolbar chrome can carry `select-none`
 * (ReactFlow's NodeToolbar portals it outside the canvas node, so it escapes
 * the node's user-select:none — without it a stray marquee/drag highlights the
 * button label text and the button reads as "selected").
 * @param root0 - Component props.
 * @param root0.offer - Whether to offer group or ungroup.
 * @param root0.onGroup - Group the current selection.
 * @param root0.onUngroup - Ungroup the selected group.
 * @param root0.bgOpen - Background picker open state.
 * @param root0.onBgOpenChange - Background picker open-state change.
 * @param root0.bgValue - Current group tint token (undefined for none).
 * @param root0.onPickBg - Apply / clear the group tint.
 * @returns The floating selection toolbar element.
 */
export function GroupSelectionToolbar({
  offer,
  onGroup,
  onUngroup,
  bgOpen,
  onBgOpenChange,
  bgValue,
  onPickBg,
}: GroupSelectionToolbarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='group-selection-toolbar'
      // `select-none`: ReactFlow's NodeToolbar portals this toolbar outside the
      // canvas node, so it escapes the node's user-select:none — without it a
      // stray marquee/drag selects the button label text (reads as "selected").
      className='flex select-none items-center gap-1 rounded-chrome border border-border bg-popover p-1 shadow-md'
    >
      {offer === 'ungroup' ? (
        <>
          {/* Color picker sits to the LEFT of ungroup. */}
          <GroupBackgroundPicker
            open={bgOpen}
            onOpenChange={onBgOpenChange}
            value={bgValue}
            onPick={onPickBg}
          />
          <button
            type='button'
            data-testid='group-toolbar-ungroup'
            onClick={onUngroup}
            className='rounded-chrome px-2 py-1 text-xs text-popover-foreground hover:bg-accent'
          >
            {t('canvas.group.ungroup')}
          </button>
        </>
      ) : (
        <button
          type='button'
          data-testid='group-toolbar-group'
          onClick={onGroup}
          className='rounded-chrome px-2 py-1 text-xs text-popover-foreground hover:bg-accent'
        >
          {t('canvas.group.group')}
        </button>
      )}
    </div>
  );
}
