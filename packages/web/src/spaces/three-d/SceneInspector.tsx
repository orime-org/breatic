// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Euler, Quaternion } from 'three';
import type { SceneObject } from '@breatic/shared';
import type { SceneEditorProps } from '@web/spaces/three-d/SceneEditor';
import { SceneField } from '@web/spaces/three-d/SceneField';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

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
 * @returns The current selection inspector.
 * @throws {never} Command refusals are reported by the session owner.
 */
export function SceneInspector({ session, snapshot, readObjects, namedPeers }: Pick<SceneEditorProps, 'session' | 'snapshot' | 'readObjects' | 'namedPeers'>): React.JSX.Element {
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
  const commitNumber = (id: string, field: 'position' | 'rotation' | 'scale', axis: number, text: string): boolean => {
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
  };

  const object = selected.length === 1 ? selected[0] : undefined;
  const geometries = selected.map(inspectorGeometry);
  const geometry = object ? geometries[0] : null;
  const geometryLabels = { position: t('spaces.threeD.position'), rotation: t('spaces.threeD.rotation'), scale: t('spaces.threeD.scale') };
  return <div className='space-y-4 p-4' data-testid='scene-properties-panel'>
    {selected.length === 0 ? <p className='text-xs text-muted-foreground'>{t('spaces.threeD.selectObject')}</p> : <>
      {object && geometry ? <><SceneField key={`${object.id}:name`} label={t('spaces.threeD.name')} value={object.name} disabled={!mutable}
        onCommit={(value) => session.execute({ type: 'patch', patches: [{ id: object.id, name: value }] }).ok} />
      {(['position', 'rotation', 'scale'] as const).map((field) => <fieldset key={field} className='min-w-0 space-y-2'><legend className='text-xs font-medium'>{geometryLabels[field]}</legend>
        <div className='grid grid-cols-3 gap-1'>{(['X', 'Y', 'Z'] as const).map((axis, index) => <SceneField key={`${object.id}:${field}:${axis}`}
          label={axis} numeric value={numberText(geometry[field][index])} disabled={!mutable} onCommit={(text) => commitNumber(object.id, field, index, text)} />)}</div>
      </fieldset>)}</> : <><p className='text-xs font-medium'>{t('spaces.threeD.selectedCount', { count: selected.length })}</p><p className='text-xs text-muted-foreground'>{t('spaces.threeD.multiTransform')}</p>
        {(['position', 'rotation', 'scale'] as const).map((field) => <p key={field} className='text-xs'>{geometryLabels[field]}: {geometries.every((item) => JSON.stringify(item[field]) === JSON.stringify(geometries[0]?.[field])) ? geometries[0]?.[field].map(numberText).join(', ') : t('spaces.threeD.mixed')}</p>)}</>}
    </>}
    {namedPeers.map((peer) => <p key={peer.clientId} className={cn('text-xs', peer.selectedIds.length === 0 && 'hidden')} style={{ color: peer.color }}>{t('spaces.threeD.peerSelection', { name: peer.name, count: peer.selectedIds.length })}</p>)}
  </div>;
}
