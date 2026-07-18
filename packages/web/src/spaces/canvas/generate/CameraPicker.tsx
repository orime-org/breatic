// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Camera, ChevronUp, ChevronDown } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Switch } from '@web/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';

/** The camera-cluster params this control edits (all on `data.params`, #1788). */
export interface CameraValue {
  camera?: string;
  lens?: string;
  /** Focal length in mm — a NUMBER in the catalog (values `[14,24,…,200]`). */
  focal_length?: number;
  aperture?: string;
  /** Master opt-in gate; the worker omits the `technical` block when false. */
  enable_camera?: boolean;
}

type ParamValue = string | number;

/** Column config: which param each wheel edits + how its glyph renders. */
const COLUMNS = [
  { key: 'camera', capKey: 'cameraBody', glyph: 'camera' },
  { key: 'lens', capKey: 'lens', glyph: 'lens' },
  { key: 'focal_length', capKey: 'focalLength', glyph: 'num' },
  { key: 'aperture', capKey: 'aperture', glyph: 'iris' },
] as const;

/**
 * A param's allowed values, preserving numbers (focal_length) vs strings.
 * @param model - The current model.
 * @param key - The camera-cluster param key.
 * @returns The catalog values, or an empty list when the model omits the param.
 */
function paramValues(model: ModelEntry, key: string): ParamValue[] {
  const values = model.params?.[key]?.values;
  if (!values) return [];
  return values.map((v) => (typeof v === 'number' ? v : String(v)));
}

interface GlyphProps {
  glyph: (typeof COLUMNS)[number]['glyph'];
  value: ParamValue;
}

/**
 * Renders the grayscale glyph for a column's current value.
 * @param root0 - The glyph props.
 * @param root0.glyph - The glyph kind (camera / lens / num / iris).
 * @param root0.value - The current selection (sizes the iris / shows the focal number).
 * @returns The glyph element.
 */
function Glyph({ glyph, value }: GlyphProps): React.JSX.Element {
  if (glyph === 'num') {
    return (
      <span className='text-[38px] font-semibold leading-none tracking-tight text-foreground'>
        {value}
      </span>
    );
  }
  if (glyph === 'iris') {
    // Iris opening shrinks as the f-number grows.
    const f = parseFloat(String(value).replace('f/', '')) || 2.8;
    const open = Math.max(3, 15 - f * 0.8);
    return (
      <svg viewBox='0 0 80 64' className='h-14 w-[72px]' aria-hidden='true'>
        <circle cx='40' cy='32' r='22' fill='#1c1c1c' stroke='#4a4a4a' strokeWidth='2' />
        <polygon
          points='40,18 53,27 48,45 32,45 27,27'
          fill='#2a2a2a'
          stroke='#8f8f8f'
          strokeWidth='2'
        />
        <circle cx='40' cy='32' r={open} fill='#0e0e0e' />
      </svg>
    );
  }
  if (glyph === 'lens') {
    return (
      <svg viewBox='0 0 80 64' className='h-14 w-[72px]' fill='none' stroke='#9a9a9a' strokeWidth='2.4' aria-hidden='true'>
        <rect x='18' y='18' width='44' height='28' rx='6' fill='#2c2c2c' />
        <ellipse cx='40' cy='32' rx='12' ry='12' fill='#1a1a1a' />
        <ellipse cx='40' cy='32' rx='6' ry='6' fill='#333' stroke='none' />
        <line x1='24' y1='24' x2='56' y2='24' stroke='#444' />
        <line x1='24' y1='40' x2='56' y2='40' stroke='#444' />
      </svg>
    );
  }
  return (
    <svg viewBox='0 0 80 64' className='h-14 w-[72px]' fill='none' stroke='#9a9a9a' strokeWidth='2.4' aria-hidden='true'>
      <rect x='12' y='22' width='42' height='28' rx='4' fill='#2c2c2c' />
      <circle cx='33' cy='36' r='9' fill='#1c1c1c' />
      <circle cx='33' cy='36' r='4' fill='#3a3a3a' stroke='none' />
      <rect x='54' y='28' width='16' height='16' rx='2' fill='#262626' />
      <rect x='20' y='14' width='16' height='9' rx='2' fill='#242424' />
    </svg>
  );
}

interface CameraWheelProps {
  cap: string;
  glyph: (typeof COLUMNS)[number]['glyph'];
  values: ParamValue[];
  value: ParamValue | undefined;
  unit?: string;
  onSelect: (value: ParamValue) => void;
  prevLabel: string;
  nextLabel: string;
}

/**
 * One carousel column: chevrons + wheel scroll move the selection through the
 * param's catalog values; the centered value renders large with faded
 * neighbours above/below. Clamped at the ends (no wrap).
 * @param root0 - The wheel props.
 * @param root0.cap - The column caption (section header).
 * @param root0.glyph - The glyph kind for the centered value.
 * @param root0.values - The catalog values for this param.
 * @param root0.value - The current selection.
 * @param root0.unit - Optional unit suffix appended to labels (e.g. ` mm`).
 * @param root0.onSelect - Called with the newly selected value.
 * @param root0.prevLabel - The faded label above the centered value.
 * @param root0.nextLabel - The faded label below the centered value.
 * @returns The wheel column.
 */
function CameraWheel({
  cap,
  glyph,
  values,
  value,
  unit,
  onSelect,
  prevLabel,
  nextLabel,
}: CameraWheelProps): React.JSX.Element {
  const idx = Math.max(
    0,
    values.findIndex((v) => v === value),
  );
  /**
   * Shifts the selection by `delta` positions, clamped to the value range.
   * @param delta - Positions to move (−1 up, +1 down).
   */
  const move = (delta: number): void => {
    const next = Math.min(values.length - 1, Math.max(0, idx + delta));
    if (next !== idx) onSelect(values[next]!);
  };
  const nameLabel = value === undefined ? '' : `${value}${unit ?? ''}`;
  return (
    <div
      className='flex flex-col items-center'
      onWheel={(e) => {
        e.preventDefault();
        move(e.deltaY > 0 ? 1 : -1);
      }}
    >
      <button
        type='button'
        aria-label={`${cap} ▲`}
        disabled={idx <= 0}
        onClick={() => move(-1)}
        className='rounded-content-xs px-3 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30'
      >
        <ChevronUp className='h-4 w-4' aria-hidden='true' />
      </button>
      <span className='h-[18px] max-w-full truncate text-[11.5px] text-muted-foreground/70'>
        {prevLabel}
      </span>
      <div className='my-0.5 flex min-h-[112px] w-full flex-col items-center justify-center gap-1.5 rounded-content border border-border bg-card px-2 py-3'>
        <span className='text-xs text-muted-foreground'>{cap}</span>
        <Glyph glyph={glyph} value={value ?? ''} />
      </div>
      <span className='h-[18px] max-w-full truncate text-[11.5px] text-muted-foreground/70'>
        {nextLabel}
      </span>
      <button
        type='button'
        aria-label={`${cap} ▼`}
        disabled={idx >= values.length - 1}
        onClick={() => move(1)}
        className='rounded-content-xs px-3 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30'
      >
        <ChevronDown className='h-4 w-4' aria-hidden='true' />
      </button>
      <span className='mt-1.5 min-h-[16px] max-w-full truncate text-center text-xs text-foreground'>
        {nameLabel}
      </span>
    </div>
  );
}

interface CameraPickerProps {
  /** The current model, whose params define the camera-cluster catalogs. */
  model: ModelEntry;
  /** The current camera-cluster selection (from `data.params`). */
  value: CameraValue;
  /** Merge a changed camera param (or the enable gate) into `data.params`. */
  onChange: (partial: CameraValue) => void;
}

/**
 * The Generate panel's Camera control (#1788): a footer icon button that opens
 * a four-wheel popover (camera / lens / focal length / aperture) sourced from
 * the active model's catalog enums. A top-right switch is the master
 * `enable_camera` opt-in gate (replaces a close ×; the popover closes on
 * outside click / Escape like the ratio picker); the trigger's tooltip reports
 * the on/off state. The control is only rendered when the active model declares
 * the cluster — the panel hides it otherwise (unsupported models show nothing,
 * not a greyed-out control). Focal length round-trips as a NUMBER (the catalog
 * values are numeric — a string would fail the worker's enum check and silently
 * reset to the default).
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.value - The current camera-cluster selection.
 * @param root0.onChange - Merge a changed param into `data.params`.
 * @returns The camera control.
 */
export const CameraPicker = React.memo(function CameraPicker({
  model,
  value,
  onChange,
}: CameraPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const enabled = value.enable_camera === true;

  const triggerClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
    (enabled
      ? ' text-foreground hover:bg-accent'
      : ' text-muted-foreground hover:bg-accent hover:text-foreground');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type='button'
              data-testid='generate-camera'
              aria-label={t('canvas.generatePanel.camera')}
              className={triggerClass}
            >
              <Camera className='h-4 w-4' aria-hidden='true' />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='top'>
          {enabled
            ? t('canvas.generatePanel.cameraOn')
            : t('canvas.generatePanel.cameraOff')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side='top'
        align='start'
        aria-label={t('canvas.generatePanel.camera')}
        className='w-[min(520px,88vw)] p-4'
      >
        <div className='mb-2 flex items-center justify-between'>
          <span className='text-xs text-muted-foreground'>
            {t('canvas.generatePanel.camera')}
          </span>
          <label className='flex cursor-pointer items-center gap-2'>
            <span className='text-xs text-muted-foreground'>
              {enabled
                ? t('canvas.generatePanel.cameraOn')
                : t('canvas.generatePanel.cameraOff')}
            </span>
            <Switch
              data-testid='generate-camera-toggle'
              checked={enabled}
              onCheckedChange={(checked) => onChange({ enable_camera: checked })}
            />
          </label>
        </div>
        <div className='grid grid-cols-4 gap-2.5'>
          {COLUMNS.map((col) => {
            const values = paramValues(model, col.key);
            const current = value[col.key];
            const idx = Math.max(
              0,
              values.findIndex((v) => v === current),
            );
            const unit = col.key === 'focal_length' ? ' mm' : '';
            return (
              <CameraWheel
                key={col.key}
                cap={t(`canvas.generatePanel.${col.capKey}`)}
                glyph={col.glyph}
                values={values}
                value={current}
                unit={unit}
                prevLabel={idx > 0 ? `${values[idx - 1]}${unit}` : ''}
                nextLabel={
                  idx < values.length - 1 ? `${values[idx + 1]}${unit}` : ''
                }
                onSelect={(v) => onChange({ [col.key]: v })}
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
});
