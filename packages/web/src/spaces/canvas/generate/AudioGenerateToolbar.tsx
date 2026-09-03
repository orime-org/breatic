// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { ToggleTool } from '@web/spaces/canvas/generate/generate-tools';

interface AudioGenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /** Whether the reference pick is running — highlights the button. */
  referenceActive?: boolean;
}

/**
 * The audio Generate panel's top tool row.
 *
 * Reference alone, and that is what an audio node's edges allow: `audio` takes
 * only `text` (`lib/connection-rules.ts:30`), and a text row IS prompt material
 * (`ReferenceRail.tsx:66`). So the entry is here for the same reason the edge
 * is — a line already written on the canvas becomes the lines to speak without
 * being typed again. Focus crops a region of an IMAGE and Style holds a picked
 * image; both would collect something this panel can never send.
 *
 * Built from the same {@link ToggleTool} the image and video rows are, so the
 * three rows cannot drift in look or in behaviour.
 * @param root0 - Component props.
 * @param root0.onReference - Enter / exit the reference pick.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @returns The tool row.
 */
export const AudioGenerateToolbar = React.memo(function AudioGenerateToolbar({
  onReference,
  referenceActive = false,
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
    </div>
  );
});
