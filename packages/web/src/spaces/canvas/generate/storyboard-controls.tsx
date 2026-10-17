// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The multi-shot mode's controls, laid out after Kling's own: a list of shots
 * in place of the prompt box, each with its seconds and its own prompt box,
 * and under it, centred, "+ Add shot", or in its place the reason a shot
 * cannot be added.
 *
 * Presentational: which buttons can act is read off the duration rules in
 * `@breatic/shared`, and every write is a callback the container owns.
 */

import { Minus, Plus } from 'lucide-react';
import * as React from 'react';
import { addShot, stepShot } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';

interface AddShotRowProps {
  /** The most shots the mode takes for this model. */
  maxShots: number;
  /** The i18n key of why a shot cannot be added, or undefined when one can. */
  addBlocked: string | undefined;
  /** Add a shot at the end. */
  onAdd: () => void;
}

/**
 * The row under the shots: "+ Add shot" in the middle, sized to its words, or
 * in its place, when a shot cannot be added, the reason why.
 * @param root0 - Component props.
 * @param root0.maxShots - The shot cap.
 * @param root0.addBlocked - Why a shot cannot be added.
 * @param root0.onAdd - Adds a shot.
 * @returns The row.
 */
export const AddShotRow = React.memo(function AddShotRow({
  maxShots,
  addBlocked,
  onAdd,
}: AddShotRowProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div data-testid='generate-storyboard-add-row' className='flex items-center justify-center'>
      {addBlocked !== undefined ? (
        <span data-testid='generate-storyboard-add-blocked' className='text-xs text-muted-foreground'>
          {t(addBlocked, { max: maxShots })}
        </span>
      ) : (
        <Button
          type='button'
          variant='outline'
          size='compact'
          data-testid='generate-storyboard-add'
          onClick={onAdd}
          className='shrink-0 gap-1 text-xs'
        >
          <Plus className='h-3.5 w-3.5' aria-hidden='true' />
          {t('canvas.generatePanel.storyboard.addShot')}
        </Button>
      )}
    </div>
  );
});

/** One shot as the list draws it. */
export interface ShotRow {
  readonly id: string;
  readonly duration: number;
}

interface ShotListProps<Shot extends ShotRow> {
  /** The shots, in order. */
  shots: readonly Shot[];
  /** Move one second into or out of a shot. */
  onStep: (shotId: string, delta: 1 | -1) => void;
  /** Remove a shot. */
  onRemove: (shotId: string) => void;
  /** The prompt box of each shot, drawn by the container. */
  renderEditor: (shot: Shot, index: number) => React.ReactNode;
}

/**
 * Why "+ shot" cannot act, or undefined when it can.
 * @param durations - Each shot's seconds.
 * @param total - The total seconds.
 * @param maxShots - The shot cap.
 * @returns The i18n key of the reason.
 */
export function addBlockedKey(
  durations: readonly number[],
  total: number,
  maxShots: number,
): string | undefined {
  if (addShot(durations, total, maxShots) !== null) return undefined;
  return durations.length >= maxShots
    ? 'canvas.generatePanel.storyboard.shotCapReached'
    : 'canvas.generatePanel.storyboard.noSecondToSpare';
}

/**
 * The multi-shot mode's cards, one per shot.
 * @param root0 - Component props.
 * @param root0.shots - The shots.
 * @param root0.onStep - Steps a shot's seconds.
 * @param root0.onRemove - Removes a shot.
 * @param root0.renderEditor - Draws a shot's prompt box.
 * @returns The list.
 */
export function ShotList<Shot extends ShotRow>({
  shots,
  onStep,
  onRemove,
  renderEditor,
}: ShotListProps<Shot>): React.JSX.Element {
  const t = useTranslation();
  const durations = shots.map((shot) => shot.duration);
  return (
    <div className='flex flex-col gap-2' data-testid='generate-storyboard-shots'>
      {shots.map((shot, index) => (
        <div
          key={shot.id}
          data-testid={`generate-storyboard-shot-${index + 1}`}
          className='flex flex-col gap-1.5 rounded-overlay border border-border p-2'
        >
          <div className='flex items-center gap-2'>
            <span className='min-w-16 text-xs font-medium text-foreground'>
              {t('canvas.generatePanel.storyboard.shot', { n: index + 1 })}
            </span>
            <div className='flex items-center rounded-overlay border border-border'>
              <Button
                type='button'
                variant='ghost'
                size={null}
                data-testid={`generate-storyboard-shot-${index + 1}-less`}
                disabled={stepShot(durations, index, -1) === null}
                onClick={() => onStep(shot.id, -1)}
                className='flex h-6 w-6 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50'
              >
                <Minus className='h-3.5 w-3.5' aria-hidden='true' />
              </Button>
              <span
                data-testid={`generate-storyboard-shot-${index + 1}-seconds`}
                className='min-w-10 text-center text-xs tabular-nums text-foreground'
              >
                {t('canvas.generatePanel.durationSeconds', { n: shot.duration })}
              </span>
              <Button
                type='button'
                variant='ghost'
                size={null}
                data-testid={`generate-storyboard-shot-${index + 1}-more`}
                disabled={stepShot(durations, index, 1) === null}
                onClick={() => onStep(shot.id, 1)}
                className='flex h-6 w-6 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50'
              >
                <Plus className='h-3.5 w-3.5' aria-hidden='true' />
              </Button>
            </div>
            <Button
              type='button'
              variant='chrome-ghost'
              size='compact'
              data-testid={`generate-storyboard-shot-${index + 1}-remove`}
              disabled={shots.length <= 1}
              onClick={() => onRemove(shot.id)}
              className='ml-auto text-xs disabled:cursor-not-allowed disabled:opacity-50'
            >
              {t('canvas.generatePanel.storyboard.removeShot')}
            </Button>
          </div>
          {renderEditor(shot, index)}
        </div>
      ))}
    </div>
  );
}
