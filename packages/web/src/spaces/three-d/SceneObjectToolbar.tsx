// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Copy, Focus, Move, RotateCw, Scaling, Trash2 } from 'lucide-react';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { useTranslation } from '@web/i18n/use-translation';
import type { SceneTransformMode } from '@web/spaces/three-d/viewport/scene-viewport-props';

const icons = {
  move: <Move className='size-4' />, rotate: <RotateCw className='size-4' />, scale: <Scaling className='size-4' />,
  focus: <Focus className='size-4' />, duplicate: <Copy className='size-4' />, delete: <Trash2 className='size-4' />,
};

/**
 * Present actions for the current scene selection at the bottom centre.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.mode - Current native transform tool.
 * @param root0.jointMode - Whether joints are being posed, when no transform tool is current.
 * @param root0.mutable - Whether every selected object may be changed.
 * @param root0.canRotate - Whether the selection can turn; a point light cannot.
 * @param root0.canScale - Whether the selection can scale; a camera or light cannot.
 * @param root0.canDuplicate - Whether selected objects may be copied.
 * @param root0.onMode - Ends the current gesture and selects a tool.
 * @param root0.onFocus - Frames the selected content in the personal camera.
 * @param root0.onDuplicate - Creates independent selected copies.
 * @param root0.onDelete - Deletes the eligible current selection.
 * @returns The floating action controls.
 * @throws {never} Actions delegate to existing commands.
 */
export const SceneObjectToolbar = React.memo(function SceneObjectToolbar({ mode, jointMode, mutable, canRotate, canScale, canDuplicate, onMode, onFocus, onDuplicate, onDelete }: {
  mode: SceneTransformMode; jointMode: boolean; mutable: boolean; canRotate: boolean; canScale: boolean; canDuplicate: boolean; onMode: (mode: SceneTransformMode) => void;
  onFocus: () => void; onDuplicate: () => void; onDelete: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  /**
   * Select translation after cancelling a draft.
   * @throws {never} Delegates to the host.
   */
  const move = React.useCallback((): void => onMode('translate'), [onMode]);
  /**
   * Select rotation after cancelling a draft.
   * @throws {never} Delegates to the host.
   */
  const rotate = React.useCallback((): void => onMode('rotate'), [onMode]);
  /**
   * Select scale after cancelling a draft.
   * @throws {never} Delegates to the host.
   */
  const scale = React.useCallback((): void => onMode('scale'), [onMode]);
  return <div className='flex rounded-md border border-border bg-popover py-1 shadow' data-testid='scene-object-menu'>
    <div className='flex items-center gap-0.5 border-r border-border px-1'><SceneIconButton label={t('spaces.threeD.move')} active={!jointMode && mode === 'translate'} disabled={!mutable} onClick={move}>{icons.move}</SceneIconButton>
      <SceneIconButton label={t('spaces.threeD.rotate')} active={!jointMode && mode === 'rotate'} disabled={!mutable || !canRotate} onClick={rotate}>{icons.rotate}</SceneIconButton>
      <SceneIconButton label={t('spaces.threeD.scale')} active={!jointMode && mode === 'scale'} disabled={!mutable || !canScale} onClick={scale}>{icons.scale}</SceneIconButton></div>
    <div className='flex items-center gap-0.5 px-1'><SceneIconButton label={t('spaces.threeD.focus')} onClick={onFocus}>{icons.focus}</SceneIconButton>
      <SceneIconButton label={t('spaces.threeD.duplicate')} disabled={!canDuplicate} onClick={onDuplicate}>{icons.duplicate}</SceneIconButton>
      <SceneIconButton label={t('spaces.threeD.delete')} disabled={!mutable} onClick={onDelete}>{icons.delete}</SceneIconButton></div>
  </div>;
});
