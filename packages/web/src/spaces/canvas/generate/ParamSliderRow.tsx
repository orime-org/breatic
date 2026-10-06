// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Slider } from '@web/components/ui/slider';
import { cn } from '@web/lib/utils';

/**
 * Whether the value has landed on a named stop.
 *
 * Radix rounds to the step's decimal count before reporting, and the stops are
 * written at that precision, so the two meet exactly — the tolerance is what
 * keeps that true if a step ever divides less evenly.
 * @param shown - The value the slider is showing.
 * @param stop - The stop's value.
 * @returns True when the slider is sitting on that stop.
 */
function atStop(shown: number | undefined, stop: number): boolean {
  return shown !== undefined && Math.abs(shown - stop) < 1e-9;
}

/** A named position on a slider's range. */
export interface SliderStop {
  value: number;
  /** What the position is called, already in the reader's language. */
  label: string;
}

interface ParamSliderRowProps {
  /** The param name, which is also what the committed value is keyed by. */
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Positions on the range with a name, ascending; absent when none have one. */
  stops?: readonly SliderStop[];
  value: number | undefined;
  /** A value to show in place of `value` without writing it, while another control is dragged. */
  draft?: number;
  /** Called with the value the thumb is moved to, before it is written. */
  onDraft?: (value: number) => void;
  /** Called when a pointer drag ends, whether or not it wrote anything. */
  onDraftEnd?: () => void;
  /** How a value reads beside the label, in its own unit. */
  format: (value: number) => string;
  onChange: (partial: Record<string, number>) => void;
  /** Prefix of every test id this row renders. */
  testIdPrefix: string;
  className: string | undefined;
}

/**
 * One numeric param as a slider, written to the document once per gesture.
 *
 * A drag crosses every step between where it starts and where it ends, and
 * Radix reports each one. Each report written straight through is one canvas
 * undo entry — that stack holds 50 and merges nothing by time — so a single
 * drag across `volume` (100 positions on minimax-speech-2.8-hd) could push out
 * everything the user could still undo. `onValueCommit` fires once when a gesture ends and once per key
 * press, which is the granularity a person would name as one change.
 * @param root0 - Props.
 * @param root0.name - The param name.
 * @param root0.label - The param's name as the reader reads it.
 * @param root0.min - The range's floor.
 * @param root0.max - The range's ceiling.
 * @param root0.step - The range's increment.
 * @param root0.stops - Named positions on the range, if any.
 * @param root0.value - The stored value.
 * @param root0.draft - A value to show without writing it.
 * @param root0.onDraft - Called with the value the thumb is moved to.
 * @param root0.onDraftEnd - Called when a pointer drag ends.
 * @param root0.format - How a value reads beside the label.
 * @param root0.onChange - Called with the committed param.
 * @param root0.testIdPrefix - Prefix of every test id.
 * @param root0.className - Row spacing.
 * @returns The row.
 */
export function ParamSliderRow({
  name,
  label,
  min,
  max,
  step,
  stops,
  value,
  draft,
  onDraft,
  onDraftEnd,
  format,
  onChange,
  testIdPrefix,
  className,
}: ParamSliderRowProps): React.JSX.Element {
  // Where the thumb sits until the gesture ends. Held apart from `value` so
  // the control follows the pointer while the document does not.
  const [dragged, setDragged] = React.useState<number | null>(null);
  const shown = dragged ?? draft ?? value;

  // A key the browser is repeating, and the step the last repeat reached.
  const repeatingRef = React.useRef(false);
  const repeatedToRef = React.useRef<number | null>(null);

  const onValueChange = React.useCallback(
    ([next]: number[]) => {
      setDragged(next);
      if (next !== undefined) onDraft?.(next);
    },
    [onDraft],
  );

  const onValueCommit = React.useCallback(
    ([next]: number[]) => {
      // Radix commits on every repeat of a held key. The press is the
      // decision and the repeats are it continuing, so they wait for the
      // release rather than each becoming its own undo entry.
      if (repeatingRef.current) {
        repeatedToRef.current = next;
        return;
      }
      setDragged(null);
      onChange({ [name]: next });
    },
    [onChange, name],
  );

  // Every gesture, by key or by pointer, ends here: the row's draft and the
  // one it handed out go together. Radix reports a keyboard commit BEFORE it
  // reports the change, so a draft cleared inside the commit is written
  // straight back, and a drag released where it began commits nothing; a
  // draft left set shows this client's number over whatever is stored.
  const endDraft = React.useCallback((): void => {
    setDragged(null);
    onDraftEnd?.();
  }, [onDraftEnd]);

  const endKeyGesture = React.useCallback((): void => {
    repeatingRef.current = false;
    const reached = repeatedToRef.current;
    repeatedToRef.current = null;
    endDraft();
    if (reached !== null) onChange({ [name]: reached });
  }, [onChange, name, endDraft]);

  // Four ways a key gesture ends, and every one of them has to write. Keyup
  // alone leaves the flag set when the release lands on another window, and
  // a set flag holds back every commit after it — the pointer's included, so
  // the thumb would move under drags the node never hears about.
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.repeat) {
        repeatingRef.current = true;
        return;
      }
      endKeyGesture();
    },
    [endKeyGesture],
  );

  return (
    <div className={className}>
      <div className='mb-1.5 flex items-center justify-between'>
        <span className='text-xs font-medium text-muted-foreground'>{label}</span>
        <span
          data-testid={`${testIdPrefix}-${name}-value`}
          // Digits line up as the value changes rather than shifting the label.
          className='text-xs tabular-nums text-muted-foreground'
        >
          {shown === undefined ? '' : format(shown)}
        </span>
      </div>
      <Slider
        className='text-foreground'
        data-testid={`${testIdPrefix}-${name}-slider`}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={shown === undefined ? [min] : [shown]}
        // Radix reports a value already rounded to the step's decimal count
        // (`roundValue(…, getDecimalCount(step))` in its own snapping), so the
        // float error of repeated addition never reaches here.
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
        onKeyDown={onKeyDown}
        onKeyUp={endKeyGesture}
        onBlur={endKeyGesture}
        onPointerDown={endKeyGesture}
        onPointerUp={endDraft}
      />
      {stops && (
        // Under the track, each word centred on the value it names. A word at
        // either end of the range is pinned to that end instead, so it lines
        // up with the track's edge rather than hanging half past it; the
        // negative margin pulls a pinned word's own padding back off the edge.
        <div className='relative -mx-1 mt-1.5 h-6'>
          {stops.map((stop) => {
            const edge = stop.value === min ? 'start' : stop.value === max ? 'end' : undefined;
            const left = ((stop.value - min) / (max - min)) * 100;
            return (
              <Button
                key={stop.value}
                type='button'
                variant='ghost'
                size={null}
                aria-pressed={atStop(shown, stop.value)}
                data-testid={`${testIdPrefix}-${name}-stop-${stop.value}`}
                data-edge={edge}
                style={edge === 'end' ? { right: 0 } : { left: `${edge === 'start' ? 0 : left}%` }}
                className={cn(
                  // 24px tall so the word is a pointer target the standard takes
                  // (WCAG 2.2 SC 2.5.8 AA). The words sit 6px under a 12px slider
                  // thumb, close enough that the spacing exception cannot rescue
                  // an undersized one: at 16px the two 24px circles were 20.3px
                  // apart, so a click meant for a label dragged the value instead.
                  // The text keeps its own size — only the box around it grows.
                  'absolute top-0 h-6 whitespace-nowrap px-1 text-2xs',
                  edge === undefined && '-translate-x-1/2',
                  atStop(shown, stop.value)
                    ? 'text-foreground'
                    : 'font-normal text-muted-foreground',
                )}
                onClick={() => onChange({ [name]: stop.value })}
              >
                {stop.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
