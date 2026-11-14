// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { HexColorInput, HexColorPicker } from 'react-colorful';

import {
  SCENE_FOCAL_LENGTH_MAX, SCENE_FOCAL_LENGTH_MIN, SCENE_LIGHT_INTENSITY, SCENE_SPOT_ANGLE_DEFAULT, SCENE_SPOT_ANGLE_MAX,
  SCENE_SPOT_ANGLE_MIN, VIEWFINDER_RATIOS, isSceneCamera, isSceneLight, type SceneObject,
} from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { Switch } from '@web/components/ui/switch';
import type { ScenePatch } from '@web/data/yjs/scene-document';
import type { SceneSession } from '@web/data/yjs/scene-session';
import { useTranslation } from '@web/i18n/use-translation';
import type { SceneField, SceneFieldDraftOwner } from '@web/spaces/three-d/SceneField';
import { commitAfterChange, useControlPress } from '@web/spaces/three-d/use-control-press';

/** Lens presets in millimetres (inner#1694 design 3.2). */
const FOCAL_PRESETS = [14, 24, 35, 50, 70, 100, 200] as const;
const CUSTOM = 'custom';

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
    <span id={labelId} className='shrink-0 text-xs'>{label}</span>
    <div className='flex min-w-0 items-center justify-end gap-2'>{children}</div>
  </div>;
}

/**
 * A drag that previews and is written once on release, as one undo step (design 3.8).
 * @param session - The command owner.
 * @param id - The object being changed.
 * @returns Preview and commit callbacks, and the commit a Slider's `onValueCommit` takes.
 */
function useContinuousPatch(session: SceneSession, id: string): { preview: (patch: Omit<ScenePatch, 'id'>) => void; commit: () => void; commitAfterChange: () => void } {
  const press = useControlPress();
  // The session owns whether the drag is still open: Escape, a lock or an undo may have ended it.
  const preview = React.useCallback((patch: Omit<ScenePatch, 'id'>): void => {
    if (press.change(() => session.beginGesture()) && session.getSnapshot().gestureActive) session.previewGesture([{ ...patch, id }]);
    else press.drop();
  }, [session, id, press]);
  const commit = React.useCallback((): void => {
    if (press.release() && session.getSnapshot().gestureActive) session.endGesture(true);
  }, [session, press]);
  const commitLater = React.useMemo(() => commitAfterChange(commit), [commit]);
  return { preview, commit, commitAfterChange: commitLater };
}

/**
 * A colour chosen in a react-colorful picker inside a Popover; written on each release of the picker, on each colour
 * typed into the hex input, and when the picker closes (design 3.8).
 * @param root0 - Props.
 * @param root0.value - The current colour.
 * @param root0.disabled - Whether it can be changed.
 * @param root0.labelId - What names it.
 * @param root0.onPreview - Shows a colour while picking.
 * @param root0.onCommit - Writes the picked colour.
 * @returns The swatch and its picker.
 */
export const SceneColorField = React.memo(function SceneColorField({ value, disabled, labelId, onPreview, onCommit }: {
  value: string; disabled: boolean; labelId: string; onPreview: (hex: string) => void; onCommit: () => void;
}): React.JSX.Element {
  const onOpenChange = React.useCallback((open: boolean): void => { if (!open) onCommit(); }, [onCommit]);
  // The hex input accepts three digits as well as six; the scene stores six.
  const pick = React.useCallback((hex: string): void => onPreview((hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}` : hex).toLowerCase()), [onPreview]);
  const type = React.useCallback((hex: string): void => { pick(hex); onCommit(); }, [pick, onCommit]);
  // react-colorful follows the drag on the window, so its release is caught there too.
  const press = React.useCallback((): void => { window.addEventListener('pointerup', onCommit, { once: true }); }, [onCommit]);
  return <Popover onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <Button variant={null} size={null} aria-labelledby={labelId} disabled={disabled}
        className='size-6 rounded-full border border-border disabled:cursor-not-allowed disabled:opacity-50' style={{ backgroundColor: value }} />
    </PopoverTrigger>
    <PopoverContent side='left' align='start' className='w-auto space-y-2 p-2'>
      <div onPointerDown={press}><HexColorPicker color={value} onChange={pick} /></div>
      <HexColorInput color={value} onChange={type} prefixed autoComplete='off' className='h-[var(--btn-inline)] w-full rounded-md border border-input bg-background px-2 text-xs' />
    </PopoverContent>
  </Popover>;
});

export interface SceneDirectorFieldsProps extends SceneFieldDraftOwner {
  object: SceneObject;
  session: SceneSession;
  canEdit: boolean;
  spaceId: string;
  Field: typeof SceneField;
  /** Show the name and the lock as well, as inside the director console. */
  compact: boolean;
}

/**
 * A camera's lens and frame or a light's colour, intensity, shadow and angle (design 3.2), shared by the director
 * console and the properties panel.
 * @param props - See {@link SceneDirectorFieldsProps}.
 * @returns The fields, or nothing for another kind of object.
 */
export const SceneDirectorFields = React.memo(function SceneDirectorFields(props: SceneDirectorFieldsProps): React.JSX.Element | null {
  const { object, session, canEdit, spaceId, Field, compact, fieldDrafts, onFieldDraftChange } = props;
  const t = useTranslation();
  const ids = React.useId();
  const disabled = !canEdit || object.locked;
  const continuous = useContinuousPatch(session, object.id);
  /**
   * Write one field change.
   * @param patch - The fields.
   */
  const patch = React.useCallback((fields: Omit<ScenePatch, 'id'>): void => {
    session.execute({ type: 'patch', patches: [{ ...fields, id: object.id }] });
  }, [session, object.id]);
  const commitName = React.useCallback((text: string): boolean => {
    const next = text.trim();
    return next === '' || session.execute({ type: 'patch', patches: [{ id: object.id, name: next }] }).ok;
  }, [session, object.id]);
  const commitFocal = React.useCallback((text: string): boolean => {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) return false;
    return session.execute({ type: 'patch', patches: [{ id: object.id, focalLength: Math.min(SCENE_FOCAL_LENGTH_MAX, Math.max(SCENE_FOCAL_LENGTH_MIN, value)) }] }).ok;
  }, [session, object.id]);
  const toggleLock = React.useCallback((locked: boolean): void => { session.execute({ type: 'lock', ids: [object.id], locked }); }, [session, object.id]);

  const head = compact ? <>
    <Field key={`${object.id}:name`} label={t('spaces.threeD.name')} value={object.name} disabled={disabled} spaceId={spaceId}
      draftKey={`${object.id}:name`} draft={fieldDrafts.get(`${object.id}:name`)} onFieldDraftChange={onFieldDraftChange} onCommit={commitName} />
  </> : null;
  const lock = compact ? <Row label={t('spaces.threeD.lock')} labelId={`${ids}-lock`}>
    <Switch aria-labelledby={`${ids}-lock`} checked={object.locked} disabled={!canEdit} onCheckedChange={toggleLock} />
  </Row> : null;

  if (isSceneCamera(object)) {
    const preset = FOCAL_PRESETS.find((value) => value === object.focalLength);
    return <div className='space-y-2' data-testid={`scene-director-fields-${object.id}`}>
      {head}
      <Row label={t('spaces.threeD.focalLength')} labelId={`${ids}-focal`}>
        <Select value={preset === undefined ? CUSTOM : String(preset)} disabled={disabled}
          onValueChange={(next) => { if (next !== CUSTOM) patch({ focalLength: Number(next) }); }}>
          <SelectTrigger aria-labelledby={`${ids}-focal`} className='h-[var(--btn-inline)] w-auto min-w-20 gap-2 px-2 text-xs'><SelectValue /></SelectTrigger>
          <SelectContent>
            {FOCAL_PRESETS.map((value) => <SelectItem key={value} value={String(value)}>{`${value} mm`}</SelectItem>)}
            <SelectItem value={CUSTOM}>{t('spaces.threeD.director.customFocal')}</SelectItem>
          </SelectContent>
        </Select>
        <div className='w-16'>
          <Field key={`${object.id}:focal`} label='mm' numeric value={String(Number(object.focalLength.toFixed(1)))} disabled={disabled} spaceId={spaceId}
            draftKey={`${object.id}:focal`} draft={fieldDrafts.get(`${object.id}:focal`)} onFieldDraftChange={onFieldDraftChange} onCommit={commitFocal} />
        </div>
      </Row>
      <Row label={t('spaces.threeD.frame')} labelId={`${ids}-frame`}>
        <Select value={object.frame} disabled={disabled} onValueChange={(next) => {
          const frame = VIEWFINDER_RATIOS.find((key) => key === next);
          if (frame) patch({ frame });
        }}>
          <SelectTrigger aria-labelledby={`${ids}-frame`} className='h-[var(--btn-inline)] w-auto min-w-16 gap-2 px-2 text-xs'><SelectValue /></SelectTrigger>
          <SelectContent>{VIEWFINDER_RATIOS.map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}</SelectContent>
        </Select>
      </Row>
      {lock}
    </div>;
  }
  if (!isSceneLight(object)) return null;
  const { max } = SCENE_LIGHT_INTENSITY[object.model.type];
  const step = object.model.type === 'directional' ? 0.1 : 1;
  return <div className='space-y-2' data-testid={`scene-director-fields-${object.id}`}>
    {head}
    <Row label={t('spaces.threeD.color')} labelId={`${ids}-color`}>
      <SceneColorField value={object.color} disabled={disabled} labelId={`${ids}-color`}
        onPreview={(color) => continuous.preview({ color })} onCommit={continuous.commit} />
    </Row>
    <Row label={t('spaces.threeD.intensity')} labelId={`${ids}-intensity`}>
      <Slider aria-labelledby={`${ids}-intensity`} className='w-28' min={0} max={max} step={step} value={[object.intensity]} disabled={disabled}
        onValueChange={([value]) => { if (value !== undefined) continuous.preview({ intensity: value }); }} onValueCommit={continuous.commitAfterChange} onPointerUp={continuous.commit} />
      <span className='w-10 text-right text-xs tabular-nums text-muted-foreground'>{Number(object.intensity.toFixed(1))}</span>
    </Row>
    <Row label={t('spaces.threeD.castShadow')} labelId={`${ids}-shadow`}>
      <Switch aria-labelledby={`${ids}-shadow`} checked={object.castShadow} disabled={disabled} onCheckedChange={(castShadow) => patch({ castShadow })} />
    </Row>
    {object.model.type === 'spot' ? <Row label={t('spaces.threeD.angle')} labelId={`${ids}-angle`}>
      <Slider aria-labelledby={`${ids}-angle`} className='w-28' min={SCENE_SPOT_ANGLE_MIN} max={SCENE_SPOT_ANGLE_MAX} step={1} value={[object.angle ?? SCENE_SPOT_ANGLE_DEFAULT]}
        disabled={disabled} onValueChange={([value]) => { if (value !== undefined) continuous.preview({ angle: value }); }} onValueCommit={continuous.commitAfterChange} onPointerUp={continuous.commit} />
      <span className='w-10 text-right text-xs tabular-nums text-muted-foreground'>{`${Math.round(object.angle ?? SCENE_SPOT_ANGLE_DEFAULT)}°`}</span>
    </Row> : null}
    {lock}
  </div>;
});
