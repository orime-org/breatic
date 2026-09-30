// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Pause, Play } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/**
 * What the sample button wears while its voice is the one playing
 * (design §6.3, user 2026-09-01).
 *
 * Painted OUTSIDE the button as a pseudo-element, so the 24px target the
 * pointer-size standard is measured against keeps its size — a ring laid out
 * in the box would have grown it. Only one voice plays at a time, so only one
 * ring turns, and the eye finds the playing row without reading the glyphs.
 *
 * Under `prefers-reduced-motion` it holds still as a complete ring rather than
 * disappearing: the row still has to say which voice is speaking.
 */
const PLAYING_RING = [
  'after:pointer-events-none after:absolute after:-inset-[3px]',
  'after:rounded-full after:border after:border-border',
  'after:border-t-foreground after:animate-spin after:content-[""]',
  'motion-reduce:after:animate-none motion-reduce:after:border-foreground',
].join(' ');

interface SampleButtonProps {
  /** The voice's name, for the button's label. */
  name: string;
  /** Whether this sample is the one playing. */
  playing: boolean;
  /** Start or stop it. */
  onToggle: () => void;
  /** The button's test id. */
  testId: string;
}

/**
 * The round play / stop button at the end of a voice row.
 * @param root0 - Props.
 * @param root0.name - The voice's name.
 * @param root0.playing - Whether it is playing.
 * @param root0.onToggle - Start or stop it.
 * @param root0.testId - The button's test id.
 * @returns The button.
 */
export function SampleButton({ name, playing, onToggle, testId }: SampleButtonProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Button
      type='button'
      variant={null}
      size={null}
      data-testid={testId}
      data-playing={playing}
      aria-label={t('canvas.generatePanel.voiceSample', { name })}
      className={cn(
        'relative mr-1 flex h-[var(--btn-compact)] w-[var(--btn-compact)] shrink-0 items-center justify-center rounded-full border border-border transition-colors hover:bg-accent-strong',
        playing && PLAYING_RING,
      )}
      onClick={onToggle}
    >
      {playing ? (
        <Pause className='h-3 w-3' aria-hidden='true' />
      ) : (
        <Play className='h-3 w-3' aria-hidden='true' />
      )}
    </Button>
  );
}
