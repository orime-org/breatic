// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Copy, Focus, Move, RotateCw, Scaling, Trash2 } from 'lucide-react';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { useTranslation } from '@web/i18n/use-translation';
import type { SceneTransformMode } from '@web/spaces/three-d/viewport/scene-viewport-props';

/**
 * Present actions for the current scene selection at the bottom centre.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.mode - Current native transform tool.
 * @param root0.mutable - Whether every selected object may be changed.
 * @param root0.canDuplicate - Whether selected objects may be copied.
 * @param root0.onMode - Ends the current gesture and selects a tool.
 * @param root0.onFocus - Frames the selected content in the personal camera.
 * @param root0.onDuplicate - Creates independent selected copies.
 * @param root0.onDelete - Deletes the eligible current selection.
 * @returns The floating action controls.
 * @throws {never} Actions delegate to existing commands.
 */
export function SceneObjectToolbar({ mode, mutable, canDuplicate, onMode, onFocus, onDuplicate, onDelete }: {
  mode: SceneTransformMode; mutable: boolean; canDuplicate: boolean; onMode: (mode: SceneTransformMode) => void;
  onFocus: () => void; onDuplicate: () => void; onDelete: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  return <div className='absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-overlay border border-border bg-popover p-1 shadow' data-testid='scene-object-menu'>
    <SceneIconButton label={t('spaces.threeD.move')} active={mode === 'translate'} disabled={!mutable} onClick={() => onMode('translate')}><Move className='size-4' /></SceneIconButton>
    <SceneIconButton label={t('spaces.threeD.rotate')} active={mode === 'rotate'} disabled={!mutable} onClick={() => onMode('rotate')}><RotateCw className='size-4' /></SceneIconButton>
    <SceneIconButton label={t('spaces.threeD.scale')} active={mode === 'scale'} disabled={!mutable} onClick={() => onMode('scale')}><Scaling className='size-4' /></SceneIconButton><span className='mx-1 h-4 border-l border-border' />
    <SceneIconButton label={t('spaces.threeD.focus')} onClick={onFocus}><Focus className='size-4' /></SceneIconButton>
    <SceneIconButton label={t('spaces.threeD.duplicate')} disabled={!canDuplicate} onClick={onDuplicate}><Copy className='size-4' /></SceneIconButton>
    <SceneIconButton label={t('spaces.threeD.delete')} disabled={!mutable} onClick={onDelete}><Trash2 className='size-4' /></SceneIconButton>
  </div>;
}
