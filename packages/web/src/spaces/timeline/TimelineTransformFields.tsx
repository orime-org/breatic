// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Link2, Unlink2 } from 'lucide-react';
import { TIMELINE_LAYER_TRANSFORM_LIMITS, type TimelineLayerTransform } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { normalizeTimelineLayerTransform, sameTimelineLayerTransform } from '@web/spaces/timeline/layer-transform';

/** One clip's position, scale and rotation. */
interface TimelineTransformFieldsProps {
  spaceId: string;
  transform: TimelineLayerTransform;
  readOnly: boolean;
  /** Writes a changed transform. */
  onCommit: (transform: TimelineLayerTransform) => void;
}

type Field = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation';

const FIELDS: ReadonlyArray<{ field: Field; testId: string; label: string }> = [
  { field: 'x', testId: 'timeline-clip-x', label: 'timeline.edit.positionX' },
  { field: 'y', testId: 'timeline-clip-y', label: 'timeline.edit.positionY' },
  { field: 'scaleX', testId: 'timeline-clip-scale-x', label: 'timeline.edit.scaleX' },
  { field: 'scaleY', testId: 'timeline-clip-scale-y', label: 'timeline.edit.scaleY' },
  { field: 'rotation', testId: 'timeline-clip-rotation', label: 'timeline.edit.rotation' },
];
const LABEL = 'text-xs text-muted-foreground';
const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;
const { scale } = TIMELINE_LAYER_TRANSFORM_LIMITS;

/**
 * A stored part as the field shows it: whole canvas pixels, a percentage or degrees with one decimal.
 * @param field - The part.
 * @param value - Its stored value.
 * @returns The shown text.
 * @throws {never} Never.
 */
function shownOf(field: Field, value: number): string {
  if (field === 'x' || field === 'y') return String(Math.round(value));
  return String(Math.round((field === 'rotation' ? value : value * 100) * 10) / 10);
}

/**
 * The stored part a field's text means, or null when it is not a value the field takes.
 * @param field - The part.
 * @param text - The typed text.
 * @returns The value, unrounded.
 * @throws {never} Never.
 */
function parsedOf(field: Field, text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (field === 'scaleX' || field === 'scaleY') {
    const ratio = value / 100;
    return ratio < scale.min || ratio > scale.max ? null : ratio;
  }
  return value;
}

/** One field's text, the shown value it started from, and whether it was judged invalid. */
interface FieldDraft { shown: string; value: string; error: boolean }

/**
 * The drafts for the stored transform: a field keeps the user's text while its stored value is unchanged.
 * @param drafts - The current drafts, if any.
 * @param transform - The stored transform.
 * @returns The same drafts when nothing restarts, else new ones.
 * @throws {never} Never.
 */
function syncDrafts(drafts: Record<Field, FieldDraft> | null, transform: TimelineLayerTransform): Record<Field, FieldDraft> {
  let changed = drafts === null;
  const next = {} as Record<Field, FieldDraft>;
  for (const { field } of FIELDS) {
    const shown = shownOf(field, transform[field]);
    const kept = drafts?.[field];
    if (kept?.shown === shown) next[field] = kept;
    else {
      next[field] = { shown, value: shown, error: false };
      changed = true;
    }
  }
  return changed ? next : drafts ?? next;
}

/**
 * The "Position and size" group of a video or web-animation copy (#1410 design §5): X and Y in canvas pixels, width and
 * height scale in percent with a ratio lock, and rotation in degrees. A field commits on Enter or blur only when its
 * text changed; an invalid entry is marked and not written, and Escape restores the shown value.
 * @param props - The transform and its commit.
 * @param props.spaceId - The Space, for field ids.
 * @param props.transform - The stored transform.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.onCommit - Writes a changed transform.
 * @returns The fields.
 * @throws {never} Never.
 */
export function TimelineTransformFields({ spaceId, transform, readOnly, onCommit }: TimelineTransformFieldsProps): React.JSX.Element {
  const t = useTranslation();
  const [drafts, setDrafts] = React.useState(() => syncDrafts(null, transform));
  const current = syncDrafts(drafts, transform);
  if (current !== drafts) setDrafts(current);
  const [locked, setLocked] = React.useState(true);
  const toggleLock = React.useCallback((): void => setLocked((value) => !value), []);
  const update = React.useCallback((field: Field, patch: Partial<FieldDraft>): void => {
    setDrafts((previous) => ({ ...previous, [field]: { ...previous[field], ...patch } }));
  }, []);
  const commit = React.useCallback((field: Field): void => {
    const draft = current[field];
    if (draft.value === draft.shown) { if (draft.error) update(field, { error: false }); return; }
    const value = parsedOf(field, draft.value);
    if (value === null) { update(field, { error: true }); return; }
    update(field, { value: draft.shown, error: false });
    const next = { ...transform, [field]: value };
    // Locked, a scale edit carries the other axis by the same ratio; any other edit changes only its own part.
    if (locked && field === 'scaleX' && transform.scaleX !== 0) next.scaleY = transform.scaleY * value / transform.scaleX;
    if (locked && field === 'scaleY' && transform.scaleY !== 0) next.scaleX = transform.scaleX * value / transform.scaleY;
    const sent = normalizeTimelineLayerTransform(next);
    if (!sameTimelineLayerTransform(sent, transform)) onCommit(sent);
  }, [current, transform, locked, onCommit, update]);
  const restore = React.useCallback((field: Field): void => update(field, { value: current[field].shown, error: false }), [current, update]);

  return <div className='flex flex-col gap-2'>
    <div className='flex items-center justify-between'>
      <span className='text-xs font-semibold'>{t('timeline.edit.transform')}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button data-testid='timeline-clip-lock-ratio' variant='outline' size='compact' aria-pressed={locked} aria-label={t('timeline.edit.lockRatio')} disabled={readOnly}
            onClick={toggleLock} icon={locked ? <Link2 className='size-3.5' /> : <Unlink2 className='size-3.5' />} className='aria-pressed:border-active-border' />
        </TooltipTrigger>
        <TooltipContent>{t('timeline.edit.lockRatio')}</TooltipContent>
      </Tooltip>
    </div>
    <div className='grid grid-cols-2 gap-2'>
      {FIELDS.map(({ field, testId, label }) => {
        const id = `${testId}-${spaceId}`;
        const draft = current[field];
        return <div key={field} className={cn('flex flex-col gap-1', field === 'rotation' && 'col-span-2')}>
          <Label htmlFor={readOnly ? undefined : id} className={LABEL}>{t(label)}</Label>
          {readOnly
            ? <span data-testid={testId} className='flex h-8 items-center text-sm tabular-nums'>{draft.shown}</span>
            : <Input id={id} data-testid={testId} type='text' inputMode='decimal' autoComplete='off' value={draft.value} className='h-8 w-full tabular-nums'
              aria-invalid={draft.error} onChange={(event) => update(field, { value: event.target.value, error: false })} onBlur={() => commit(field)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(field); }
                if (event.key === 'Escape') { event.preventDefault(); restore(field); }
              }} />}
          {draft.error && <span data-testid='timeline-clip-field-error' className='text-xs text-status-error-foreground'>{t('timeline.errors.invalid_range')}</span>}
        </div>;
      })}
    </div>
  </div>;
}
