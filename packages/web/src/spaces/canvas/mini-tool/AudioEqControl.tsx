// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import {
  EQ_BANDS_HZ,
  EQ_GAIN_RANGE,
  EQ_PRESETS,
  EQ_PRESET_LABELS,
  eqValueOfPreset,
  type EqPreset,
  type EqValue,
} from '@breatic/shared';

import { Slider } from '@web/components/ui/slider';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';

/**
 * A band's centre as it is printed under its slider.
 * @param hz - The centre.
 * @returns `31` … `500`, then `1k` … `16k`.
 */
function bandName(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/**
 * A gain as it reads above its band, with its sign.
 * @param gain - The gain in dB.
 * @returns The reading.
 */
function gainReading(gain: number): string {
  return gain > 0 ? `+${gain}` : String(gain);
}

interface AudioEqControlProps {
  /** The draft value, or undefined before one is held. */
  value: EqValue | undefined;
  label: string;
  onChange: (value: EqValue) => void;
}

/**
 * The audio equaliser (inner#1305 §8): a row of presets over ten vertical
 * band sliders. A preset fills every band; moving a band makes the curve
 * Custom, which shows as a preset only then. Each band is written once per
 * gesture, as `ParamSliderRow` writes its value.
 * @param root0 - Props.
 * @param root0.value - The draft value.
 * @param root0.label - The presets' heading.
 * @param root0.onChange - Called with the whole new value.
 * @returns The control.
 */
export const AudioEqControl = React.memo(function AudioEqControl({
  value,
  label,
  onChange,
}: AudioEqControlProps): React.JSX.Element {
  const held = value ?? eqValueOfPreset('flat');
  const [draft, setDraft] = React.useState<{ band: number; gain: number } | null>(null);
  const presets = React.useMemo(
    () => [
      ...(Object.keys(EQ_PRESETS) as EqPreset[]).map((preset) => ({ value: preset, label: EQ_PRESET_LABELS[preset] })),
      ...(held.preset === 'custom' ? [{ value: 'custom', label: EQ_PRESET_LABELS.custom }] : []),
    ],
    [held.preset],
  );
  return (
    <div className='flex flex-col gap-2.5'>
      <ParamOptionGroup
        label={label}
        options={presets}
        value={held.preset}
        onSelect={(preset) => {
          if (preset !== 'custom') onChange(eqValueOfPreset(preset as EqPreset));
        }}
        testIdPrefix='mini-tool-eq-preset'
        even
      />
      <div className='grid grid-cols-10 gap-0.5'>
        {EQ_BANDS_HZ.map((hz, band) => {
          const gain = draft?.band === band ? draft.gain : (held.gains[band] ?? 0);
          return (
            <div key={hz} className='flex flex-col items-center gap-1'>
              <span data-testid={`mini-tool-eq-band-${band}-value`} className='text-2xs tabular-nums text-foreground'>
                {gainReading(gain)}
              </span>
              <Slider
                data-testid={`mini-tool-eq-band-${band}-slider`}
                aria-label={`${bandName(hz)} Hz`}
                orientation='vertical'
                min={EQ_GAIN_RANGE.min}
                max={EQ_GAIN_RANGE.max}
                step={EQ_GAIN_RANGE.step}
                origin={0}
                value={[gain]}
                onValueChange={([next]) => {
                  if (next !== undefined) setDraft({ band, gain: next });
                }}
                onValueCommit={([next]) => {
                  setDraft(null);
                  if (next === undefined) return;
                  const gains = [...held.gains];
                  gains[band] = next;
                  onChange({ preset: 'custom', gains });
                }}
                className='h-24 text-foreground'
              />
              <span data-testid={`mini-tool-eq-band-${band}-label`} className='text-2xs tabular-nums text-muted-foreground'>
                {bandName(hz)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
