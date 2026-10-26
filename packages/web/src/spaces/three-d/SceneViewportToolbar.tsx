// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Layers, MoreHorizontal, PictureInPicture2, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { useTranslation } from '@web/i18n/use-translation';
export type ScenePanel = 'properties' | 'objects' | 'tasks';

const icons = {
  undo: <Undo2 className='size-3.5' />, redo: <Redo2 className='size-3.5' />,
  properties: <SlidersHorizontal className='size-4' />, objects: <Layers className='size-4' />,
  tasks: <MoreHorizontal className='size-4' />, minimap: <PictureInPicture2 className='size-3.5' />,
};

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
export const SceneViewportToolbar = React.memo(function SceneViewportToolbar({ undo, redo, onHistory, hasSelection, onPanel, minimap, onMinimap }: {
  undo: boolean; redo: boolean; onHistory: (step: 'undo' | 'redo') => void; hasSelection: boolean;
  onPanel: (panel: ScenePanel) => void; minimap: boolean; onMinimap: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  /**
   * Undo the current personal command.
   * @throws {never} Delegates to the session.
   */
  const undoStep = React.useCallback((): void => onHistory('undo'), [onHistory]);
  /**
   * Redo the current personal command.
   * @throws {never} Delegates to the session.
   */
  const redoStep = React.useCallback((): void => onHistory('redo'), [onHistory]);
  /**
   * Toggle selected-object properties.
   * @throws {never} Delegates to the host.
   */
  const showProperties = React.useCallback((): void => onPanel('properties'), [onPanel]);
  /**
   * Toggle the scene object list.
   * @throws {never} Delegates to the host.
   */
  const showObjects = React.useCallback((): void => onPanel('objects'), [onPanel]);
  /**
   * Toggle the generation task list.
   * @throws {never} Delegates to the host.
   */
  const showTasks = React.useCallback((): void => onPanel('tasks'), [onPanel]);
  return <div className='absolute bottom-[var(--space-5)] right-[var(--space-5)] z-10 flex rounded-md border border-border bg-popover py-1 shadow' data-testid='scene-viewport-toolbar'>
    <div className='flex items-center gap-0.5 border-r border-border px-1'><SceneIconButton label={t('spaces.threeD.undo')} disabled={!undo} onClick={undoStep}>{icons.undo}</SceneIconButton><SceneIconButton label={t('spaces.threeD.redo')} disabled={!redo} onClick={redoStep}>{icons.redo}</SceneIconButton></div>
    <div className='flex items-center gap-0.5 border-r border-border px-1'>
      <SceneIconButton data-testid='scene-properties-trigger' label={t('spaces.threeD.properties')} disabled={!hasSelection} onClick={showProperties}>{icons.properties}</SceneIconButton>
      <SceneIconButton data-testid='scene-objects-trigger' label={t('spaces.threeD.objects')} onClick={showObjects}>{icons.objects}</SceneIconButton>
      <SceneIconButton data-testid='scene-tasks-trigger' label={t('spaces.threeD.tasks')} onClick={showTasks}>{icons.tasks}</SceneIconButton>
    </div><div className='flex px-1'><SceneIconButton label={t('spaces.threeD.minimap')} active={minimap} onClick={onMinimap}>{icons.minimap}</SceneIconButton></div>
  </div>;
});
