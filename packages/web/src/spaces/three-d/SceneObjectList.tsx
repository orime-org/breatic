// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Box, Lock } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type { SceneEditorProps } from '@web/spaces/three-d/SceneEditor';
import type { SceneModelState } from '@web/spaces/three-d/viewport/scene-viewport-props';

/**
 * List valid and unreadable scene records with their existing selection and load feedback.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.session - The document-scoped command and selection owner.
 * @param root0.snapshot - Current committed content and personal editing projection.
 * @param root0.modelStates - Current load outcomes from the native viewport.
 * @param root0.onSelect - Shows the inspector after list selection.
 * @returns Current scene object rows and empty feedback.
 * @throws {never} Selection delegates to the document-scoped session.
 */
export function SceneObjectList({ session, snapshot, modelStates, onSelect }: Pick<SceneEditorProps, 'session' | 'snapshot'> & {
  modelStates: ReadonlyMap<string, SceneModelState>; onSelect: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  return <div className='p-2' data-testid='scene-objects-panel'>
    {snapshot.objects.map((item) => <Button key={item.id} variant={snapshot.selectedIds.includes(item.id) ? 'secondary' : 'ghost'} size={null}
      className='mb-1 flex w-full items-center gap-2 px-2 py-2 text-left' data-testid={`scene-object-${item.id}`}
      onClick={(event) => { session.select(item.id, event.shiftKey); onSelect(); }}>
      <Box className='size-4 shrink-0' /><span className='min-w-0 flex-1 truncate text-xs'>{item.name}</span>
      {item.locked ? <Lock className='size-3 shrink-0' /> : null}
      {modelStates.get(item.id) === 'failed' ? <span className='text-xs text-destructive'>!</span> : null}
    </Button>)}
    {snapshot.invalidObjects.map((item) => <p key={item.id} className='break-all p-2 text-xs text-destructive'>{t('spaces.threeD.invalidObject', { id: item.id })}</p>)}
    {snapshot.status === 'ready' && snapshot.objects.length === 0 ? <p className='px-2 py-3 text-xs text-muted-foreground'>{t('spaces.threeD.empty')}</p> : null}
  </div>;
}
