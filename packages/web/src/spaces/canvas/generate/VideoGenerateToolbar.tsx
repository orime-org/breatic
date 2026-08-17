// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  SlotTool,
  ToggleTool,
} from '@web/spaces/canvas/generate/generate-tools';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type {
  VideoSlot,
  VideoSlotUrls,
} from '@web/spaces/canvas/generate/video-slots';

interface VideoGenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /** Whether the reference pick is running — highlights the button. */
  referenceActive?: boolean;
  /** The source slots the active mode collects, in display order. */
  slots: readonly VideoSlot[];
  /** What is picked, by slot; a slot missing from here renders empty. */
  slotUrls: VideoSlotUrls;
  /**
   * What to PAINT for each pick — the picked image itself for an image slot,
   * the copied poster for a slot holding something an `<img>` cannot paint.
   * A slot missing from here is not empty: it covers itself with the asset
   * node's icon instead (#1946). Fullness is `slotUrls`, never this.
   */
  slotThumbnails: VideoSlotUrls;
  /** The slot whose pick is running, if any — highlights that one control. */
  activeSlot?: VideoSlot;
  /** Toggle a slot's pick. */
  onPickSlot: (slot: VideoSlot) => void;
  /** Clear a slot (its ✕ badge). */
  onClearSlot: (slot: VideoSlot) => void;
}

/**
 * The video Generate panel's top tool row: Reference first, then one control
 * per source slot the active mode collects (design §4.2 — "leftmost is always
 * Reference").
 *
 * Reference is present in every mode: a connected node feeds the prompt's `@`
 * mentions whatever the model generates from. The slots come from the mode,
 * so a mode that takes no source shows no slot rather than offering a pick the
 * submit then ignores, and a new slot is a registry entry rather than another
 * branch here.
 *
 * Its own row rather than a mode of the image toolbar: the image panel's tools
 * are Style and Focus, which mean nothing here. What the two rows are built
 * FROM is shared — {@link ToggleTool} and {@link SlotTool}.
 * @param root0 - Component props.
 * @param root0.onReference - Enter / exit the reference pick.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @param root0.slots - The slots the active mode collects.
 * @param root0.slotUrls - What is picked, by slot.
 * @param root0.slotThumbnails - What to show for each pick, by slot.
 * @param root0.activeSlot - The slot whose pick is running.
 * @param root0.onPickSlot - Enter / exit a slot's pick.
 * @param root0.onClearSlot - Clear a slot.
 * @returns The tool row.
 */
export const VideoGenerateToolbar = React.memo(function VideoGenerateToolbar({
  onReference,
  referenceActive = false,
  slots,
  slotUrls,
  slotThumbnails,
  activeSlot,
  onPickSlot,
  onClearSlot,
}: VideoGenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-1' role='group'>
      <ToggleTool
        testId='generate-video-tool-reference'
        label={t('canvas.generatePanel.reference')}
        tip={t('canvas.generatePanel.referenceTip')}
        Icon={Plus}
        onClick={onReference}
        active={referenceActive}
      />
      {slots.map((slot) => {
        const spec = VIDEO_SLOTS[slot];
        const url = slotUrls[slot];
        return (
          <SlotTool
            key={slot}
            testId={spec.testId}
            thumbnailTestId={spec.thumbnailTestId}
            clearTestId={spec.clearTestId}
            Icon={spec.Icon}
            onPick={() => onPickSlot(slot)}
            active={activeSlot === slot}
            // The asset URL is what makes a slot full — a thumbnail is only
            // what it can PAINT, and audio never has one (#1946).
            pick={
              url === undefined
                ? undefined
                : {
                  kind: spec.accepts,
                  url,
                  thumbnail: slotThumbnails[slot],
                }
            }
            onClear={() => onClearSlot(slot)}
            // Never gated once shown: a slot only renders for the modes that
            // collect it, so there is no state where it is visible but
            // unpickable (Style needs that gate because it renders in both
            // image modes and only some models accept it).
            disabled={false}
            clearLabel={t(spec.clearLabelKey)}
            label={t(spec.labelKey)}
            tip={t(spec.tipKey)}
          />
        );
      })}
    </div>
  );
});
