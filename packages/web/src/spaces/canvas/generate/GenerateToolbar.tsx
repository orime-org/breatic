// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Box, Focus, MapPin, Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';

/** The three not-yet-built tool buttons rendered as disabled placeholders (slice-1 decision B). */
const PLACEHOLDER_TOOLS = [
  { key: 'style', testId: 'generate-tool-style', Icon: Box },
  { key: 'mark', testId: 'generate-tool-mark', Icon: MapPin },
  { key: 'focus', testId: 'generate-tool-focus', Icon: Focus },
] as const;

interface GenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /**
   * Whether the reference pick is running — renders the button in its active
   * (highlighted) state so it reads as a toggle (user 2026-07-12 G).
   */
  referenceActive?: boolean;
  /**
   * Disable the Reference button — set in text-to-image, which generates from
   * scratch and ignores source images (mode toggle 2026-07-09 §2.5).
   */
  referenceDisabled?: boolean;
}

/**
 * The Generate panel's top tool row: Style / Mark / Focus / Reference. In
 * slice 1 only Reference is live (it enters the canvas reference-pick mode);
 * Style / Mark / Focus render as disabled placeholders until their slices ship
 * (slice-1 decision B — the full panel UI is shown, unbuilt controls disabled).
 * @param root0 - Component props.
 * @param root0.onReference - Enter the reference-pick mode.
 * @returns The tool row.
 */
export const GenerateToolbar = React.memo(function GenerateToolbar({
  onReference,
  referenceActive = false,
  referenceDisabled = false,
}: GenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  const buttonClass =
    'flex flex-col items-center gap-1 rounded-overlay px-2 py-1.5 text-xs ' +
    'text-muted-foreground transition-colors focus-visible:outline-none ' +
    'focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ' +
    'disabled:cursor-not-allowed enabled:hover:bg-accent enabled:hover:text-accent-foreground';
  return (
    <div className='flex items-center gap-1' role='group'>
      {PLACEHOLDER_TOOLS.map(({ key, testId, Icon }) => (
        <button
          key={key}
          type='button'
          data-testid={testId}
          disabled
          className={buttonClass}
        >
          <Icon className='h-4 w-4' aria-hidden='true' />
          {t(`canvas.generatePanel.${key}`)}
        </button>
      ))}
      <button
        type='button'
        data-testid='generate-tool-reference'
        onClick={onReference}
        disabled={referenceDisabled}
        aria-pressed={referenceActive}
        className={
          buttonClass +
          (referenceActive ? ' bg-accent text-accent-foreground' : '')
        }
      >
        <Plus className='h-4 w-4' aria-hidden='true' />
        {t('canvas.generatePanel.reference')}
      </button>
    </div>
  );
});
