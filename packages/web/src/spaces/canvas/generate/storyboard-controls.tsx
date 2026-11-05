// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import { addShot, getLocale, stepShot } from '@breatic/shared';
import type * as Y from 'yjs';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { PromptGroup, type PromptGroupItem } from '@web/spaces/canvas/generate/PromptGroup';

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
  /** Its words, whose first line its row shows while it is closed. */
  readonly prompt: Y.XmlFragment;
}

interface ShotListProps<Shot extends ShotRow> {
  /** The shots, in order. */
  shots: readonly Shot[];
  /** The id of the shot whose box is open. */
  expanded: string;
  /** The reader opened another shot. */
  onExpand: (shotId: string) => void;
  /** What a closed shot with no words shows. */
  placeholder: string;
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
 * The shot whose box is open after the list changes (#1201), found by id so
 * shots added or moved in the same change never shift it: the open shot while
 * it is there; when it was removed, the first shot still there after it in the
 * old list, else the last one still there before it; else the first shot.
 * @param seen - The shots before the change.
 * @param shots - The shots now.
 * @param opened - The id of the shot that was open, or null when none was.
 * @returns The id of the shot to open, or null when there are no shots.
 */
export function nextOpenShot(
  seen: readonly { readonly id: string }[],
  shots: readonly { readonly id: string }[],
  opened: string | null,
): string | null {
  const kept = new Set(shots.map((shot) => shot.id));
  if (opened !== null && kept.has(opened)) return opened;
  const at = seen.findIndex((shot) => shot.id === opened);
  if (at >= 0) {
    const after = seen.slice(at + 1).find((shot) => kept.has(shot.id));
    const before = seen.slice(0, at).findLast((shot) => kept.has(shot.id));
    const next = after ?? before;
    if (next) return next.id;
  }
  return shots[0]?.id ?? null;
}

/**
 * The multi-shot mode's cards, one per shot, one open at a time (#1201): a
 * closed card is its title row with the first line of its words, and its
 * seconds and remove button work while it is closed.
 * @param root0 - Component props.
 * @param root0.shots - The shots.
 * @param root0.expanded - The open shot.
 * @param root0.onExpand - Opens a shot.
 * @param root0.placeholder - What an empty closed shot shows.
 * @param root0.onStep - Steps a shot's seconds.
 * @param root0.onRemove - Removes a shot.
 * @param root0.renderEditor - Draws a shot's prompt box.
 * @returns The list.
 */
export function ShotList<Shot extends ShotRow>({
  shots,
  expanded,
  onExpand,
  placeholder,
  onStep,
  onRemove,
  renderEditor,
}: ShotListProps<Shot>): React.JSX.Element {
  const t = useTranslation();
  // `t` stays the same function across a language switch; the locale is what
  // the names and labels below follow.
  const locale = getLocale();
  // Built once per shot list, so opening another shot leaves every box as it is.
  const items = React.useMemo(() => {
    const durations = shots.map((shot) => shot.duration);
    return shots.map((shot, index): PromptGroupItem => ({
      id: shot.id,
      name: t('canvas.generatePanel.storyboard.shot', { n: index + 1 }),
      fragment: shot.prompt,
      placeholder,
      editor: renderEditor(shot, index),
      testId: `generate-storyboard-shot-${index + 1}`,
      controls: (
        <>
          <div className='flex shrink-0 items-center rounded-overlay border border-border'>
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
        </>
      ),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read the words when the locale changes
  }, [shots, placeholder, renderEditor, onStep, onRemove, t, locale]);
  return (
    <div data-testid='generate-storyboard-shots'>
      <PromptGroup
        items={items}
        value={expanded}
        onValueChange={onExpand}
        itemClassName='rounded-overlay border border-border p-2'
        nameClassName='min-w-16 text-xs font-medium text-foreground'
      />
    </div>
  );
}
