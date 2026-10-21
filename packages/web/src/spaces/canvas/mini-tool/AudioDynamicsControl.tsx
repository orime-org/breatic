// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import {
  DYNAMICS_PRESETS,
  DYNAMICS_PRESET_LABELS,
  DYNAMICS_RANGES,
  dynamicsValueOfPreset,
  type DynamicsField,
  type DynamicsPreset,
  type DynamicsValue,
} from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';

/** How each setting reads beside its slider, in its own unit. */
const READING: Readonly<Record<DynamicsField, (value: number) => string>> = {
  threshold: (value) => `${value} dB`,
  ratio: (value) => `${value}:1`,
  attack: (value) => `${value} ms`,
  release: (value) => `${value} ms`,
  makeup: (value) => `+${value} dB`,
};

const FIELDS = Object.keys(DYNAMICS_RANGES) as DynamicsField[];

interface AudioDynamicsControlProps {
  value: DynamicsValue | undefined;
  label: string;
  onChange: (value: DynamicsValue) => void;
}

/**
 * The audio compressor (inner#1305 §8): a row of presets over the five
 * settings. A preset fills every setting; moving one makes the settings
 * Custom, which shows as a preset only then.
 * @param root0 - Props.
 * @param root0.value - The draft value.
 * @param root0.label - The presets' heading.
 * @param root0.onChange - Called with the whole new value.
 * @returns The control.
 */
export const AudioDynamicsControl = React.memo(function AudioDynamicsControl({
  value,
  label,
  onChange,
}: AudioDynamicsControlProps): React.JSX.Element {
  const t = useTranslation();
  const held = value ?? dynamicsValueOfPreset('medium');
  const presets = React.useMemo(
    () => [
      ...(Object.keys(DYNAMICS_PRESETS) as DynamicsPreset[]).map((preset) => ({
        value: preset,
        label: DYNAMICS_PRESET_LABELS[preset],
      })),
      ...(held.preset === 'custom' ? [{ value: 'custom', label: DYNAMICS_PRESET_LABELS.custom }] : []),
    ],
    [held.preset],
  );
  const onField = React.useCallback(
    (partial: Record<string, number>) => onChange({ ...held, ...partial, preset: 'custom' }),
    [held, onChange],
  );
  return (
    <div className='flex flex-col gap-2.5'>
      <ParamOptionGroup
        label={label}
        options={presets}
        value={held.preset}
        onSelect={(preset) => {
          if (preset !== 'custom') onChange(dynamicsValueOfPreset(preset as DynamicsPreset));
        }}
        testIdPrefix='mini-tool-dynamics-preset'
        even
      />
      {FIELDS.map((field) => (
        <ParamSliderRow
          key={field}
          name={field}
          label={t(`canvas.miniTool.dynamics.${field}`)}
          min={DYNAMICS_RANGES[field].min}
          max={DYNAMICS_RANGES[field].max}
          step={DYNAMICS_RANGES[field].step}
          value={held[field]}
          format={READING[field]}
          onChange={onField}
          testIdPrefix='mini-tool-dynamics'
          className={undefined}
        />
      ))}
    </div>
  );
});
