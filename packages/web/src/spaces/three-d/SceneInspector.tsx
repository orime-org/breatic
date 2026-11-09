// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Euler, Quaternion } from 'three';
import { SceneObjectValuesSchema, type SceneObject } from '@breatic/shared';
import type { SceneEditorProps } from '@web/spaces/three-d/SceneEditor';
import type { SceneField, SceneFieldDraftOwner } from '@web/spaces/three-d/SceneField';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { Button } from '@web/components/ui/button';
import { Switch } from '@web/components/ui/switch';
import { POSE_PRESETS } from '@web/spaces/three-d/viewport/pose-presets';
import type { SceneSkeletonState } from '@web/spaces/three-d/viewport/scene-viewport-props';

const PRESET_NAMES = ['stand', 'sit', 'lie', 'walk', 'wave'] as const;

export interface ScenePoseInputs {
  /** What the viewport reported for each loaded object's skeleton. */
  skeletonStates: ReadonlyMap<string, SceneSkeletonState>;
  /** Whether joint mode is on, owned by the editor. */
  jointMode: boolean;
  onJointModeChange: (next: boolean) => void;
}

/**
 * The selected object's pose controls (inner#1692, design 5.1): presets for a
 * humanoid, joint mode and reset for any skeleton, a note for none.
 * @param root0 - The posed object and its controls.
 * @param root0.objectId - The single selected object.
 * @param root0.state - What its skeleton allows.
 * @param root0.mutable - Whether this member may change it, as for the transform fields.
 * @param root0.session - The command owner.
 * @param root0.jointMode - Whether joint mode is on.
 * @param root0.onJointModeChange - Asks the editor for a joint mode.
 * @returns The pose section.
 * @throws {never} Command refusals are reported by the session owner.
 */
const PoseSection = React.memo(function PoseSection({ objectId, state, mutable, session, jointMode, onJointModeChange }: {
  objectId: string; state: SceneSkeletonState; mutable: boolean; session: SceneEditorProps['session'];
  jointMode: boolean; onJointModeChange: (next: boolean) => void;
}): React.JSX.Element {
  const t = useTranslation();
  const labelId = React.useId();
  return <section className='space-y-2' data-testid='scene-pose-section'>
    <h3 className='text-xs font-medium'>{t('spaces.threeD.pose.title')}</h3>
    {state === 'none' ? <p className='text-xs text-muted-foreground' data-testid='scene-pose-no-skeleton'>{t('spaces.threeD.pose.noSkeleton')}</p> : <>
      {state === 'humanoid'
        ? <div className='flex flex-wrap gap-1'>{PRESET_NAMES.map((name) => <Button key={name} variant='outline' size='compact' disabled={!mutable}
          data-testid={`scene-pose-preset-${name}`} onClick={() => session.execute({ type: 'pose', id: objectId, set: POSE_PRESETS[name], replace: true })}>
          {t(`spaces.threeD.pose.${name}`)}</Button>)}</div>
        : <p className='text-xs text-muted-foreground' data-testid='scene-pose-humanoid-only'>{t('spaces.threeD.pose.humanoidOnly')}</p>}
      <div className='flex items-center justify-between gap-3'>
        <span id={labelId} className='text-xs'>{t('spaces.threeD.pose.jointMode')}</span>
        <Switch aria-labelledby={labelId} checked={jointMode} disabled={!mutable} data-testid='scene-pose-joint-mode' onCheckedChange={onJointModeChange} />
      </div>
      <Button variant='outline' size='compact' disabled={!mutable} data-testid='scene-pose-reset'
        onClick={() => session.execute({ type: 'pose', id: objectId, set: {}, replace: true })}>{t('spaces.threeD.pose.reset')}</Button>
    </>}
  </section>;
});

/**
 * Format editable geometry without exposing floating point tails.
 * @param value - Current numeric value to format or committed field text.
 * @returns Display text with floating-point tails removed.
 * @throws {never} Never.
 */
function numberText(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * Present transforms in the inspector's units for single and multiple selections.
 * @param object - Valid scene object whose quaternion is stored in the document.
 * @returns Position, rotation in XYZ degrees and scale for the inspector.
 * @throws {never} Never.
 */
function inspectorGeometry(object: SceneObject): Record<'position' | 'rotation' | 'scale', readonly number[]> {
  const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(object.rotation), 'XYZ');
  return { position: object.position, rotation: [euler.x, euler.y, euler.z].map((value) => value * 180 / Math.PI), scale: object.scale };
}

/**
 * Present committed geometry and existing draft controls for the current selection.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.session - The document-scoped command and selection owner.
 * @param root0.snapshot - Current committed content and personal editing projection.
 * @param root0.readObjects - Reads the latest complete committed fields.
 * @param root0.namedPeers - Resolved collaborator names and selection hints.
 * @param root0.spaceId - Space that owns field blur and visibility.
 * @param root0.Field - Eager field control keeping shared input helpers outside this lazy geometry module.
 * @param root0.fieldDrafts - Temporary input retained by the owning editor.
 * @param root0.onFieldDraftChange - Updates the current object's temporary field input.
 * @param root0.skeletonStates - What each loaded object's skeleton allows.
 * @param root0.jointMode - Whether joint mode is on.
 * @param root0.onJointModeChange - Asks the editor for a joint mode.
 * @returns The current selection inspector.
 * @throws {never} Command refusals are reported by the session owner.
 */
export const SceneInspector = React.memo(function SceneInspector({ session, snapshot, readObjects, namedPeers, spaceId, Field, fieldDrafts, onFieldDraftChange, skeletonStates, jointMode, onJointModeChange }: Pick<SceneEditorProps, 'session' | 'snapshot' | 'readObjects' | 'namedPeers' | 'spaceId'> & SceneFieldDraftOwner & ScenePoseInputs & { Field: typeof SceneField }): React.JSX.Element {
  const t = useTranslation();
  const selected = snapshot.objects.filter((object) => snapshot.selectedIds.includes(object.id));
  const mutable = snapshot.canEdit && selected.length > 0 && selected.every((object) => !object.locked);
  /**
   * Commit a numeric field against the latest complete transform, preserving peer attributes.
   * @param id - Stable identity of the selected object.
   * @param field - Complete transform property being edited.
   * @param axis - Zero-based X, Y or Z component.
   * @param text - User-entered numeric draft.
   * @returns Whether the valid complete transform field was applied.
   * @throws {never} Command refusals are returned by the session.
   */
  const commitNumber = React.useCallback((id: string, field: 'position' | 'rotation' | 'scale', axis: number, text: string): boolean => {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value) || (field === 'scale' && value <= 0)) return false;
    const current = readObjects().find((object) => object.id === id);
    if (!current) return false;
    if (field === 'rotation') {
      const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(current.rotation), 'XYZ');
      const angles = [euler.x, euler.y, euler.z]; angles[axis] = value * Math.PI / 180;
      const rotation = new Quaternion().setFromEuler(new Euler(angles[0], angles[1], angles[2], 'XYZ')).normalize().toArray();
      return session.execute({ type: 'patch', patches: [{ id, rotation }] }).ok;
    }
    const vector = [...current[field]] as [number, number, number]; vector[axis] = value;
    return session.execute({ type: 'patch', patches: [{ id, [field]: vector }] }).ok;
  }, [session, readObjects]);

  const object = selected.length === 1 ? selected[0] : undefined;
  const objectId = object?.id;
  /** Build stable commits for the selected identity, reading peer geometry at action time. */
  const commits = React.useMemo(() => {
    /**
     * Apply the same trimmed, clipped, nonblank rename used by Canvas.
     * @param text - The current name draft.
     * @returns Whether the draft was accepted or an empty draft discarded.
     * @throws {never} Refusals are returned.
     */
    const name = (text: string): boolean => {
      const next = text.trim().slice(0, SceneObjectValuesSchema.shape.name.maxLength ?? undefined);
      if (!next) return true;
      return objectId !== undefined && session.execute({ type: 'patch', patches: [{ id: objectId, name: next }] }).ok;
    };
    return { name, geometry: (['position', 'rotation', 'scale'] as const).map((field) =>
      [0, 1, 2].map((axis) => (text: string): boolean => objectId !== undefined && commitNumber(objectId, field, axis, text))) };
  }, [objectId, session, commitNumber]);
  const geometries = selected.map(inspectorGeometry);
  const geometry = object ? geometries[0] : null;
  const skeleton = object ? skeletonStates.get(object.id) : undefined;
  const geometryLabels = { position: t('spaces.threeD.position'), rotation: t('spaces.threeD.rotation'), scale: t('spaces.threeD.scale') };
  return <div className='space-y-4 p-4' data-testid='scene-properties-panel'>
    {selected.length === 0 ? <p className='text-xs text-muted-foreground'>{t('spaces.threeD.selectObject')}</p> : <>
      {object && geometry ? <><Field key={`${object.id}:name`} label={t('spaces.threeD.name')} value={object.name} disabled={!mutable} spaceId={spaceId}
        draftKey={`${object.id}:name`} draft={fieldDrafts.get(`${object.id}:name`)} onFieldDraftChange={onFieldDraftChange}
        maxLength={SceneObjectValuesSchema.shape.name.maxLength ?? undefined} onCommit={commits.name} />
      {(['position', 'rotation', 'scale'] as const).map((field, fieldIndex) => <fieldset key={field} className='min-w-0 space-y-2'><legend className='text-xs font-medium'>{geometryLabels[field]}</legend>
        <div className='grid grid-cols-3 gap-1'>{(['X', 'Y', 'Z'] as const).map((axis, index) => <Field key={`${object.id}:${field}:${axis}`}
          draftKey={`${object.id}:${field}:${axis}`} draft={fieldDrafts.get(`${object.id}:${field}:${axis}`)} onFieldDraftChange={onFieldDraftChange}
          label={axis} numeric value={numberText(geometry[field][index])} disabled={!mutable} spaceId={spaceId} onCommit={commits.geometry[fieldIndex][index]} />)}</div>
      </fieldset>)}
      {skeleton ? <PoseSection objectId={object.id} state={skeleton} mutable={mutable} session={session}
        jointMode={jointMode} onJointModeChange={onJointModeChange} /> : null}</> : <><p className='text-xs font-medium'>{t('spaces.threeD.selectedCount', { count: selected.length })}</p><p className='text-xs text-muted-foreground'>{t('spaces.threeD.multiTransform')}</p>
        {(['position', 'rotation', 'scale'] as const).map((field) => <p key={field} className='text-xs'>{geometryLabels[field]}: {geometries.every((item) => JSON.stringify(item[field]) === JSON.stringify(geometries[0]?.[field])) ? geometries[0]?.[field].map(numberText).join(', ') : t('spaces.threeD.mixed')}</p>)}</>}
    </>}
    {namedPeers.map((peer) => <p key={peer.clientId} className={cn('text-xs', peer.selectedIds.length === 0 && 'hidden')} style={{ color: peer.color }}>{t('spaces.threeD.peerSelection', { name: peer.name, count: peer.selectedIds.length })}</p>)}
  </div>;
});
