// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The video panel's storyboard controls (#2218, design §5.2), laid out after
 * Kling's own: a switch under the prompt box that turns on the automatic tier
 * with a way into the per-shot tier beside it, and in that tier a list of
 * shots, each with its seconds and its own prompt box.
 *
 * Presentational: which buttons can act is read off the duration rules in
 * `@breatic/shared`, and every write is a callback the container owns.
 */

import { ArrowLeft, Minus, Plus } from 'lucide-react';
import * as React from 'react';
import { addShot, stepShot, type StoryboardKind } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Switch } from '@web/components/ui/switch';
import { useTranslation } from '@web/i18n/use-translation';

interface StoryboardSwitchRowProps {
  /** The tier stored for this mode. */
  kind: StoryboardKind;
  /** Turn the storyboard on (automatic tier) or off. */
  onToggle: (on: boolean) => void;
  /** Go into the per-shot tier. */
  onEnterShots: () => void;
}

/**
 * The switch under the prompt box, with the way into the per-shot tier.
 * @param root0 - Component props.
 * @param root0.kind - The stored tier.
 * @param root0.onToggle - Turns the storyboard on or off.
 * @param root0.onEnterShots - Goes into the per-shot tier.
 * @returns The row.
 */
export const StoryboardSwitchRow = React.memo(function StoryboardSwitchRow({
  kind,
  onToggle,
  onEnterShots,
}: StoryboardSwitchRowProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-2'>
      <label className='flex cursor-pointer items-center gap-1.5'>
        <Switch
          checked={kind !== 'off'}
          onCheckedChange={onToggle}
          data-testid='generate-storyboard-switch'
        />
        <span className='text-xs font-medium text-foreground'>
          {t('canvas.generatePanel.storyboard.label')}
        </span>
        {/* The track alone does not read as on or off against the panel, so
            the state is said in words, as ParamToggleRow does. */}
        <span aria-hidden='true' data-testid='generate-storyboard-state' className='text-xs text-muted-foreground'>
          {kind === 'off' ? t('canvas.generatePanel.switchOff') : t('canvas.generatePanel.switchOn')}
        </span>
      </label>
      {kind === 'custom' ? (
        <span className='text-xs text-muted-foreground'>
          {t('canvas.generatePanel.storyboard.mainPromptKept')}
        </span>
      ) : (
        <>
          <Button
            type='button'
            variant='outline'
            size='compact'
            data-testid='generate-storyboard-per-shot'
            onClick={onEnterShots}
            className='text-xs'
          >
            {t('canvas.generatePanel.storyboard.perShot')}
          </Button>
          {kind === 'auto' ? (
            <span className='text-xs text-muted-foreground'>
              {t('canvas.generatePanel.storyboard.autoHint')}
            </span>
          ) : null}
        </>
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
  /** The model's total seconds. */
  total: number;
  /** The most shots the model takes; undefined when uncapped. */
  maxShots: number | undefined;
  /** Leave the per-shot tier for the automatic one. */
  onBack: () => void;
  /** Move one second into or out of a shot. */
  onStep: (shotId: string, delta: 1 | -1) => void;
  /** Remove a shot. */
  onRemove: (shotId: string) => void;
  /** Add a shot at the end. */
  onAdd: () => void;
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
function addBlockedKey(
  durations: readonly number[],
  total: number,
  maxShots: number | undefined,
): string | undefined {
  if (addShot(durations, total, maxShots ?? Number.POSITIVE_INFINITY) !== null) return undefined;
  return maxShots !== undefined && durations.length >= maxShots
    ? 'canvas.generatePanel.storyboard.shotCapReached'
    : 'canvas.generatePanel.storyboard.noSecondToSpare';
}

/**
 * The per-shot tier: a way back, one card per shot, and "+ shot".
 * @param root0 - Component props.
 * @param root0.shots - The shots.
 * @param root0.total - The total seconds.
 * @param root0.maxShots - The shot cap.
 * @param root0.onBack - Returns to the automatic tier.
 * @param root0.onStep - Steps a shot's seconds.
 * @param root0.onRemove - Removes a shot.
 * @param root0.onAdd - Adds a shot.
 * @param root0.renderEditor - Draws a shot's prompt box.
 * @returns The list.
 */
export function ShotList<Shot extends ShotRow>({
  shots,
  total,
  maxShots,
  onBack,
  onStep,
  onRemove,
  onAdd,
  renderEditor,
}: ShotListProps<Shot>): React.JSX.Element {
  const t = useTranslation();
  const durations = shots.map((shot) => shot.duration);
  const addBlocked = addBlockedKey(durations, total, maxShots);
  return (
    <div className='flex flex-col gap-2' data-testid='generate-storyboard-shots'>
      <Button
        type='button'
        variant='outline'
        size='compact'
        data-testid='generate-storyboard-back'
        onClick={onBack}
        className='gap-1 self-start text-xs'
      >
        <ArrowLeft className='h-3.5 w-3.5' aria-hidden='true' />
        {t('canvas.generatePanel.storyboard.back')}
      </Button>
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
      <div className='flex flex-col items-start gap-1'>
        <Button
          type='button'
          variant='outline'
          size='compact'
          data-testid='generate-storyboard-add'
          disabled={addBlocked !== undefined}
          onClick={onAdd}
          className='gap-1 text-xs disabled:cursor-not-allowed disabled:opacity-50'
        >
          <Plus className='h-3.5 w-3.5' aria-hidden='true' />
          {t('canvas.generatePanel.storyboard.addShot')}
        </Button>
        {addBlocked !== undefined ? (
          <span data-testid='generate-storyboard-add-blocked' className='text-xs text-muted-foreground'>
            {t(addBlocked, { max: maxShots ?? 0 })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
