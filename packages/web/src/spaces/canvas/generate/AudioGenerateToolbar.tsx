// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import type {
  AudioSlot,
  AudioSlotUrls,
} from '@web/spaces/canvas/generate/audio-slots';
import {
  SlotTool,
  ToggleTool,
} from '@web/spaces/canvas/generate/generate-tools';

interface AudioGenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /** Whether the reference pick is running — highlights the button. */
  referenceActive?: boolean;
  /** The source slots the active mode collects, in display order. */
  slots: readonly AudioSlot[];
  /** What is picked, by slot; a slot missing from here renders empty. */
  slotUrls: AudioSlotUrls;
  /**
   * What to PAINT for each pick. A slot missing from here is not empty: it
   * covers itself with the asset node's icon instead (#1946), which is what
   * every audio pick does — an audio node carries no poster. Fullness is
   * `slotUrls`, never this.
   */
  slotThumbnails: AudioSlotUrls;
  /** The slot whose pick is running, if any — highlights that one control. */
  activeSlot?: AudioSlot;
  /** Toggle a slot's pick. */
  onPickSlot: (slot: AudioSlot) => void;
  /** Clear a slot (its ✕ badge). */
  onClearSlot: (slot: AudioSlot) => void;
}

/**
 * The audio Generate panel's top tool row: Reference, then one control per
 * source slot the active mode collects.
 *
 * Reference is present in every mode, and that is what an audio node's edges
 * allow: `audio` takes only `text` (`lib/connection-rules.ts:30`), and a text
 * row IS prompt material (`ReferenceRail.tsx:66`). So the entry is here for the
 * same reason the edge is — a line already written on the canvas becomes the
 * lines to speak without being typed again — and that holds whichever model is
 * selected. Focus crops a region of an IMAGE and Style holds a picked image;
 * both would collect something this panel can never send.
 *
 * The slots come from the mode, so text to speech shows none and voice cloning shows
 * the recording to clone (#1960 PR2). Which modes collect what is not decided
 * here: the container reads it off the catalog's `sourcesByMode`, the same
 * field the server's own gate reads before enqueueing.
 *
 * Built from the same {@link ToggleTool} and {@link SlotTool} the image and
 * video rows are, so the three rows cannot drift in look or in behaviour.
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
export const AudioGenerateToolbar = React.memo(function AudioGenerateToolbar({
  onReference,
  referenceActive = false,
  slots,
  slotUrls,
  slotThumbnails,
  activeSlot,
  onPickSlot,
  onClearSlot,
}: AudioGenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-1' role='group'>
      <ToggleTool
        testId='generate-audio-tool-reference'
        label={t('canvas.generatePanel.reference')}
        // Its own tip, not the one the image and video rows share: those name
        // images, and an audio node accepts a text node alone
        // (`lib/connection-rules.ts:30`), which is the pick this button starts.
        tip={t('canvas.generatePanel.referenceTipAudio')}
        Icon={Plus}
        onClick={onReference}
        active={referenceActive}
      />
      {slots.map((slot) => {
        const spec = AUDIO_SLOTS[slot];
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
            // unpickable.
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
