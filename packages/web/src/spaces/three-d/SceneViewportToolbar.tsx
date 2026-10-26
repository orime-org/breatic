// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Layers, MoreHorizontal, PictureInPicture2, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { useTranslation } from '@web/i18n/use-translation';
export type ScenePanel = 'properties' | 'objects' | 'tasks';

/**
 * Keep personal history, scene panels and the overview switch in the approved order.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.undo - Whether personal history can undo a shared edit.
 * @param root0.redo - Whether personal history can redo a shared edit.
 * @param root0.onHistory - Runs a personal history step.
 * @param root0.hasSelection - Whether properties can be opened.
 * @param root0.onPanel - Opens or toggles the requested right panel.
 * @param root0.minimap - Whether the native overview is visible.
 * @param root0.onMinimap - Toggles the native overview allocation.
 * @returns The floating action controls.
 * @throws {never} Actions delegate to the existing scene owner.
 */
export function SceneViewportToolbar({ undo, redo, onHistory, hasSelection, onPanel, minimap, onMinimap }: {
  undo: boolean; redo: boolean; onHistory: (step: 'undo' | 'redo') => void; hasSelection: boolean;
  onPanel: (panel: ScenePanel) => void; minimap: boolean; onMinimap: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  return <div className='absolute bottom-[var(--space-5)] right-[var(--space-5)] z-10 flex rounded-md border border-border bg-popover py-1 shadow' data-testid='scene-viewport-toolbar'>
    <div className='flex items-center gap-0.5 border-r border-border px-1'><SceneIconButton label={t('spaces.threeD.undo')} disabled={!undo} onClick={() => onHistory('undo')}><Undo2 className='size-3.5' /></SceneIconButton><SceneIconButton label={t('spaces.threeD.redo')} disabled={!redo} onClick={() => onHistory('redo')}><Redo2 className='size-3.5' /></SceneIconButton></div>
    <div className='flex items-center gap-0.5 border-r border-border px-1'>
      <SceneIconButton data-testid='scene-properties-trigger' label={t('spaces.threeD.properties')} disabled={!hasSelection} onClick={() => onPanel('properties')}><SlidersHorizontal className='size-4' /></SceneIconButton>
      <SceneIconButton data-testid='scene-objects-trigger' label={t('spaces.threeD.objects')} onClick={() => onPanel('objects')}><Layers className='size-4' /></SceneIconButton>
      <SceneIconButton data-testid='scene-tasks-trigger' label={t('spaces.threeD.tasks')} onClick={() => onPanel('tasks')}><MoreHorizontal className='size-4' /></SceneIconButton>
    </div><div className='flex px-1'><SceneIconButton label={t('spaces.threeD.minimap')} active={minimap} onClick={onMinimap}><PictureInPicture2 className='size-3.5' /></SceneIconButton></div>
  </div>;
}
