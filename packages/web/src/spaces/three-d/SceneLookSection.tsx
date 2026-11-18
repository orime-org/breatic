// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import {
  SCENE_LOOK_DEFAULT_PART, SCENE_LOOK_EMISSIVE_DEFAULT, SCENE_LOOK_PICTURE_COLOR, SCENE_LOOK_REPEAT_MAX, SCENE_LOOK_REPEAT_MIN, type SceneLook,
  type SceneLookPart,
} from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Slider } from '@web/components/ui/slider';
import type { SceneCommand, SceneLookSet } from '@web/data/yjs/scene-document';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { SceneColorField } from '@web/spaces/three-d/SceneDirectorFields';

/** One part as its model loaded it, from the viewport's part table. */
export interface SceneLookPartRow {
  key: string;
  /** The material's name in the model, or null. */
  name: string | null;
  color: string;
  hasMap: boolean;
  unlit: boolean;
  line: boolean;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  transmission?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** The own picture's tiling, offset and rotation in degrees, when it has one. */
  mapRepeat?: [number, number];
  mapOffset?: [number, number];
  mapRotation?: number;
  /** A small picture of the model's own picture. */
  thumbnail?: string;
}

/** A slider or colour drag that previews and is written once on release (inner#1693 design 3.3). */
export interface SceneLookGesture {
  begin: () => number;
  preview: (part: string, fields: SceneLookPart) => boolean;
  commit: () => void;
  cancel: (press?: number) => void;
  stepKey: (event: React.KeyboardEvent) => void;
}

export interface SceneLookSectionProps {
  objectId: string;
  parts: readonly SceneLookPartRow[] | 'loading' | 'failed';
  look: SceneLook;
  selectedPart: string | null;
  /** Whether the user can edit this unlocked object. */
  mutable: boolean;
  onSelectPart: (part: string | null) => void;
  onCommand: (command: Extract<SceneCommand, { type: 'look' }>) => void;
  onChoosePicture: (part: string) => void;
  gesture?: SceneLookGesture;
  spaceId?: string;
  /** A part's running upload progress in whole percent, or null. */
  uploadPercentOf?: (part: string) => number | null;
  /** Whether a picked Project picture is being checked against the limits. */
  checking?: boolean;
  /** A user picture's URL for its thumbnail, when known. */
  pictureUrl?: (assetId: string) => string | undefined;
  /** The user pictures the scene shows now; one still loading, failed or over the budget shows the model's own colour. */
  showingPictures?: ReadonlySet<string>;
}

/**
 * A colour field's press when there is no gesture.
 * @returns -1, a refused press.
 */
const NO_PRESS = (): number => -1;
/**
 * A colour field's commit or cancel when there is no gesture.
 * @returns Nothing.
 */
const NOTHING = (): void => undefined;

/** Finish presets (inner#1693 design 3.4); each writes all four values as one command. */
const PRESETS = {
  matte: { roughness: 0.9, metalness: 0, opacity: 1, transmission: 0 },
  glossy: { roughness: 0.2, metalness: 0, opacity: 1, transmission: 0 },
  metal: { roughness: 0.15, metalness: 1, opacity: 1, transmission: 0 },
  brushedMetal: { roughness: 0.45, metalness: 1, opacity: 1, transmission: 0 },
  glass: { roughness: 0.05, metalness: 0, opacity: 1, transmission: 1 },
  rubber: { roughness: 0.7, metalness: 0, opacity: 1, transmission: 0 },
} as const;
const PRESET_NAMES = Object.keys(PRESETS) as (keyof typeof PRESETS)[];
const TILING_FIELDS = { map: null, mapRepeat: null, mapOffset: null, mapRotation: null } as const;

/**
 * Whether a stored map is a user picture.
 * @param map - The stored map.
 * @returns True for an asset id.
 */
function isPicture(map: string | undefined): map is string {
  return map !== undefined && map !== 'none';
}

/**
 * One labelled row.
 * @param root0 - Props.
 * @param root0.label - The row's name.
 * @param root0.labelId - The id the control is labelled by.
 * @param root0.children - The control.
 * @returns The row.
 */
function Row({ label, labelId, children }: { label: string; labelId: string; children: React.ReactNode }): React.JSX.Element {
  return <div className='flex min-h-[var(--btn-inline)] items-center justify-between gap-3'>
    <span id={labelId} className='shrink-0 text-xs text-muted-foreground'>{label}</span>
    <div className='flex min-w-0 items-center justify-end gap-2'>{children}</div>
  </div>;
}

/**
 * A 0–1 (or other range) slider that previews while dragged and is written once on release.
 * @param root0 - Props.
 * @param root0.label - Its name.
 * @param root0.labelId - Its label id.
 * @param root0.value - The shown value.
 * @param root0.min - Lowest value.
 * @param root0.max - Highest value.
 * @param root0.step - Step.
 * @param root0.disabled - Whether it is unavailable.
 * @param root0.suffix - Text after the number.
 * @param root0.testId - Its test id.
 * @param root0.gesture - The drag owner.
 * @param root0.onPreview - Previews a value.
 * @returns The row.
 */
function LookSlider({ label, labelId, value, min = 0, max = 1, step = 0.01, disabled, suffix = '', testId, gesture, onPreview }: {
  label: string; labelId: string; value: number; min?: number; max?: number; step?: number; disabled: boolean; suffix?: string; testId: string;
  gesture?: SceneLookGesture; onPreview: (value: number) => void;
}): React.JSX.Element {
  return <Row label={label} labelId={labelId}>
    <Slider aria-labelledby={labelId} className='w-28' min={min} max={max} step={step} value={[value]} disabled={disabled || !gesture} data-testid={testId}
      onValueChange={([next]) => { if (next !== undefined) onPreview(next); }} onPointerDown={gesture?.begin} onKeyDown={gesture?.stepKey} onPointerUp={gesture?.commit} />
    <span className='w-10 text-right text-xs tabular-nums text-muted-foreground'>{`${Number(value.toFixed(step < 1 ? 2 : 0))}${suffix}`}</span>
  </Row>;
}

/**
 * Whether a tiling count is one a part takes, either way, a negative count mirroring the picture.
 * @param value - The typed count.
 * @returns True when it is in range.
 */
const acceptsRepeat = (value: number): boolean => Math.abs(value) >= SCENE_LOOK_REPEAT_MIN && Math.abs(value) <= SCENE_LOOK_REPEAT_MAX;

/**
 * Whether an offset is one a part takes.
 * @param value - The typed offset.
 * @returns True from -100 to 100.
 */
const acceptsOffset = (value: number): boolean => value >= -100 && value <= 100;

/**
 * Two numbers written on Enter or on leaving the box.
 * @param root0 - Props.
 * @param root0.label - Its name.
 * @param root0.labelId - Its label id.
 * @param root0.value - The shown pair.
 * @param root0.accepts - Whether a typed number is in the field's range.
 * @param root0.disabled - Whether it is unavailable.
 * @param root0.testId - Its test id.
 * @param root0.onCommit - Writes the pair.
 * @returns The row.
 */
function LookPair({ label, labelId, value, accepts, disabled, testId, onCommit }: {
  label: string; labelId: string; value: readonly [number, number]; accepts: (value: number) => boolean; disabled: boolean; testId: string;
  onCommit: (pair: [number, number]) => void;
}): React.JSX.Element {
  return <Row label={label} labelId={labelId}>
    {[0, 1].map((index) => <Input key={`${index}:${value[index]}`} aria-labelledby={labelId} autoComplete='off' className='h-[var(--btn-inline)] w-16 px-2 text-xs tabular-nums'
      defaultValue={String(value[index])} disabled={disabled} data-testid={`${testId}-${index}`}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      onBlur={(event) => {
        const next = Number(event.currentTarget.value);
        if (event.currentTarget.value.trim() === '' || !Number.isFinite(next) || !accepts(next)) {
          event.currentTarget.value = String(value[index]);
          return;
        }
        const pair: [number, number] = [value[0], value[1]];
        pair[index] = next;
        if (pair[index] !== value[index]) onCommit(pair);
      }} />)}
  </Row>;
}

/** No user picture is shown. */
const NO_PICTURES: ReadonlySet<string> = new Set();

/**
 * The appearance section of the properties panel (inner#1693 design 3.1-3.6): the object's parts, and the selected
 * part's finish, colour, picture and tiling.
 * @param props - The object, its parts and look, the selected part and the writers.
 * @returns The section.
 */
export const SceneLookSection = React.memo(function SceneLookSection(props: SceneLookSectionProps): React.JSX.Element {
  const { objectId, parts, look, selectedPart, mutable, onSelectPart, onCommand, onChoosePicture, gesture, spaceId = '', uploadPercentOf, checking, pictureUrl,
    showingPictures = NO_PICTURES } = props;
  const t = useTranslation();
  const ids = React.useId();
  const write = React.useCallback((part: string | null, set: SceneLookSet): void => {
    onCommand({ type: 'look', id: objectId, part, set });
  }, [onCommand, objectId]);
  const previewColor = React.useCallback((color: string): boolean => (selectedPart === null ? false : gesture?.preview(selectedPart, { color }) ?? false), [gesture, selectedPart]);
  const writeColor = React.useCallback((color: string): void => { if (selectedPart !== null) write(selectedPart, { color }); }, [write, selectedPart]);
  const previewEmissive = React.useCallback((emissive: string): boolean => (selectedPart === null ? false : gesture?.preview(selectedPart, { emissive }) ?? false), [gesture, selectedPart]);
  const writeEmissive = React.useCallback((emissive: string): void => { if (selectedPart !== null) write(selectedPart, { emissive }); }, [write, selectedPart]);

  const title = <div className='flex items-center justify-between'>
    <h3 className='text-xs font-medium'>{t('spaces.threeD.look.title')}</h3>
    {Array.isArray(parts) ? <Button variant='outline' size='compact' disabled={!mutable || Object.keys(look).length === 0} data-testid='scene-look-reset-all'
      onClick={() => write(null, {})}>{t('spaces.threeD.look.resetAll')}</Button> : null}
  </div>;
  if (parts === 'loading' || parts === 'failed') {
    return <section className='space-y-2' data-testid='scene-look-section'>{title}
      {parts === 'loading'
        ? <p className='text-xs text-muted-foreground' data-testid='scene-look-loading'>{t('spaces.threeD.look.loadingParts')}</p>
        : <p className='text-xs text-muted-foreground' data-testid='scene-look-unavailable'>{t('spaces.threeD.look.partsUnavailable')}</p>}
    </section>;
  }

  const seen = new Set<string>();
  const labels = parts.map((part, index) => {
    if (part.key === SCENE_LOOK_DEFAULT_PART) return t('spaces.threeD.look.defaultPart');
    const unique = part.name !== null && part.name.trim() !== '' && !seen.has(part.name);
    if (part.name !== null) seen.add(part.name);
    return unique ? part.name! : t('spaces.threeD.look.part', { index: index + 1 });
  });
  const row = parts.find((part) => part.key === selectedPart);
  const stored: SceneLookPart = row ? look[row.key] ?? {} : {};
  const shownUserPicture = isPicture(stored.map);
  const shownPicture = stored.map === 'none' ? false : shownUserPicture || (row?.hasMap ?? false);
  const restricted = !row || row.unlit || row.line;
  const uploadPercent = row ? uploadPercentOf?.(row.key) : null;
  // A user picture starts untiled; the model's own picture starts from its own transform (design 3.3).
  const ownTransform = shownUserPicture ? undefined : row;
  const fieldPicture = shownUserPicture ? pictureUrl?.(stored.map!) : stored.map === undefined ? row?.thumbnail : undefined;
  const disabled = !mutable;
  /**
   * Preview a dragged field of the selected part.
   * @param fields - The dragged values.
   */
  const preview = (fields: SceneLookPart): void => { if (row) gesture?.preview(row.key, fields); };

  return <section className='space-y-2' data-testid='scene-look-section'>
    {title}
    <ul className='flex flex-col gap-1'>
      {parts.map((part, index) => {
        const fields = look[part.key] ?? {};
        const picture = isPicture(fields.map) ? pictureUrl?.(fields.map) : fields.map === undefined ? part.thumbnail : undefined;
        const color = fields.color ?? (isPicture(fields.map) && showingPictures.has(fields.map) ? SCENE_LOOK_PICTURE_COLOR : part.color);
        const active = part.key === selectedPart;
        const uploading = uploadPercentOf?.(part.key);
        return <li key={part.key}>
          <Button variant={null} size={null} data-testid={`scene-look-part-${part.key}`} aria-pressed={active}
            className={cn('flex h-[var(--btn-inline)] w-full items-center gap-2 rounded-chrome border px-2 text-left text-xs',
              active ? 'border-active-border' : 'border-transparent hover-enabled:bg-accent')}
            onClick={() => onSelectPart(active ? null : part.key)}>
            <span className='size-4 shrink-0 rounded-chrome-sm border border-swatch-border bg-cover bg-center'
              style={picture ? { backgroundImage: `url(${picture})` } : { backgroundColor: color }} />
            <span className='min-w-0 flex-1 truncate'>{labels[index]}</span>
            {uploading !== null && uploading !== undefined
              ? <span className='shrink-0 tabular-nums text-muted-foreground' data-testid={`scene-look-upload-${part.key}`}>{`${uploading}%`}</span>
              : Object.keys(fields).length > 0 ? <span className='size-1.5 shrink-0 rounded-full bg-foreground' data-testid={`scene-look-modified-${part.key}`} /> : null}
          </Button>
        </li>;
      })}
    </ul>
    {row ? <div className='space-y-2 rounded-content-sm border border-border p-3' data-testid='scene-look-part-fields'>
      <div className='grid grid-cols-3 gap-1'>{PRESET_NAMES.map((name) => <Button key={name} variant='outline' size='compact' disabled={disabled || restricted}
        data-testid={`scene-look-preset-${name}`} onClick={() => write(row.key, PRESETS[name])}>{t(`spaces.threeD.look.presets.${name}`)}</Button>)}</div>
      <Row label={t('spaces.threeD.look.color')} labelId={`${ids}-color`}>
        <SceneColorField value={stored.color ?? (shownUserPicture && showingPictures.has(stored.map!) ? SCENE_LOOK_PICTURE_COLOR : row.color)} disabled={disabled || !gesture} labelId={`${ids}-color`} spaceId={spaceId}
          onPressStart={gesture?.begin ?? NO_PRESS} onPreview={previewColor}
          onCommit={gesture?.commit ?? NOTHING} onCancel={gesture?.cancel ?? NOTHING} onWrite={writeColor} />
      </Row>
      <Row label={t('spaces.threeD.look.image')} labelId={`${ids}-image`}>
        {checking ? <span className='text-xs text-muted-foreground' data-testid='scene-look-checking'>{t('spaces.threeD.look.checking')}</span>
          : uploadPercent !== null && uploadPercent !== undefined
            ? <span className='text-xs tabular-nums text-muted-foreground' data-testid='scene-look-uploading'>{`${uploadPercent}%`}</span>
            : <>
              {fieldPicture ? <img src={fieldPicture} alt='' className='size-8 rounded-chrome-sm border border-swatch-border object-cover' /> : null}
              <Button variant='outline' size='compact' disabled={disabled || row.line} data-testid='scene-look-choose-image'
                onClick={() => onChoosePicture(row.key)}>{t(shownPicture ? 'spaces.threeD.look.replaceImage' : 'spaces.threeD.look.chooseImage')}</Button>
              {shownPicture ? <Button variant='outline' size='compact' disabled={disabled || row.line} data-testid='scene-look-remove-image'
                onClick={() => write(row.key, shownUserPicture ? TILING_FIELDS : { map: 'none' })}>{t('spaces.threeD.look.removeImage')}</Button> : null}
            </>}
      </Row>
      {shownPicture && !row.line ? <>
        <LookPair label={t('spaces.threeD.look.repeat')} labelId={`${ids}-repeat`} value={stored.mapRepeat ?? ownTransform?.mapRepeat ?? [1, 1]} accepts={acceptsRepeat} disabled={disabled}
          testId='scene-look-repeat' onCommit={(mapRepeat) => write(row.key, { mapRepeat })} />
        <LookPair label={t('spaces.threeD.look.offset')} labelId={`${ids}-offset`} value={stored.mapOffset ?? ownTransform?.mapOffset ?? [0, 0]} accepts={acceptsOffset} disabled={disabled}
          testId='scene-look-offset' onCommit={(mapOffset) => write(row.key, { mapOffset })} />
        <LookSlider label={t('spaces.threeD.look.rotation')} labelId={`${ids}-rotation`} value={stored.mapRotation ?? ownTransform?.mapRotation ?? 0} min={-180} max={180} step={1} suffix='°'
          disabled={disabled} testId='scene-look-rotation' gesture={gesture} onPreview={(mapRotation) => preview({ mapRotation })} />
      </> : null}
      <LookSlider label={t('spaces.threeD.look.gloss')} labelId={`${ids}-gloss`} value={1 - (stored.roughness ?? row.roughness ?? 1)} disabled={disabled || restricted}
        testId='scene-look-gloss' gesture={gesture} onPreview={(gloss) => preview({ roughness: Math.round((1 - gloss) * 100) / 100 })} />
      <LookSlider label={t('spaces.threeD.look.metalness')} labelId={`${ids}-metalness`} value={stored.metalness ?? row.metalness ?? 0} disabled={disabled || restricted}
        testId='scene-look-metalness' gesture={gesture} onPreview={(metalness) => preview({ metalness })} />
      <LookSlider label={t('spaces.threeD.look.opacity')} labelId={`${ids}-opacity`} value={stored.opacity ?? row.opacity ?? 1} disabled={disabled}
        testId='scene-look-opacity' gesture={gesture} onPreview={(opacity) => preview({ opacity })} />
      <LookSlider label={t('spaces.threeD.look.transmission')} labelId={`${ids}-transmission`} value={stored.transmission ?? row.transmission ?? 0} disabled={disabled || restricted}
        testId='scene-look-transmission' gesture={gesture} onPreview={(transmission) => preview({ transmission })} />
      <Row label={t('spaces.threeD.look.emission')} labelId={`${ids}-emission`}>
        <SceneColorField value={stored.emissive ?? row.emissive ?? SCENE_LOOK_EMISSIVE_DEFAULT} disabled={disabled || restricted || !gesture} labelId={`${ids}-emission`} spaceId={spaceId}
          onPressStart={gesture?.begin ?? NO_PRESS} onPreview={previewEmissive}
          onCommit={gesture?.commit ?? NOTHING} onCancel={gesture?.cancel ?? NOTHING} onWrite={writeEmissive} />
        <Slider aria-labelledby={`${ids}-emission`} className='w-20' min={0} max={10} step={0.1} value={[stored.emissiveIntensity ?? row.emissiveIntensity ?? 1]}
          disabled={disabled || restricted || !gesture} data-testid='scene-look-emission-intensity'
          onValueChange={([value]) => { if (value !== undefined) preview({ emissiveIntensity: value }); }}
          onPointerDown={gesture?.begin} onKeyDown={gesture?.stepKey} onPointerUp={gesture?.commit} />
      </Row>
      {row.unlit ? <p className='text-xs text-muted-foreground' data-testid='scene-look-unlit-note'>{t('spaces.threeD.look.unlitNote')}</p> : null}
      {row.line ? <p className='text-xs text-muted-foreground' data-testid='scene-look-line-note'>{t('spaces.threeD.look.lineNote')}</p> : null}
      <Button variant='outline' size='compact' className='w-full' disabled={disabled || Object.keys(stored).length === 0} data-testid='scene-look-reset-part'
        onClick={() => write(row.key, Object.fromEntries(Object.keys(stored).map((field) => [field, null])))}>{t('spaces.threeD.look.resetPart')}</Button>
    </div> : null}
  </section>;
});
