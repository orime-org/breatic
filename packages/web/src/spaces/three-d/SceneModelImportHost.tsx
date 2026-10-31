// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { SceneModelImportDialog } from '@web/spaces/three-d/SceneModelImportDialog';
import type { ModelImportController } from '@web/spaces/three-d/model-import-controller';

interface SceneModelImportHostProps {
  controller: ModelImportController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  maxInputBytes: number;
  onPlaced: (id: string) => void;
}

const importIcon = <Upload className='size-4' />;

/**
 * Keep an unfinished import reachable while its dialog is tucked away.
 * @param props - Active view bindings to the document's import owner.
 * @param props.controller - Operation retained by the current document.
 * @param props.open - Whether its dialog is visible.
 * @param props.onOpenChange - Opens or hides the same operation's view.
 * @param props.canEdit - Current scene write permission.
 * @param props.maxInputBytes - Configured input-byte budget.
 * @param props.onPlaced - Selects and focuses a newly created object.
 * @returns The controlled dialog and temporary progress opener.
 * @throws {never} Import state carries operational failures.
 */
export default function SceneModelImportHost({ controller, open, onOpenChange, canEdit, maxInputBytes, onPlaced }: SceneModelImportHostProps): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const t = useTranslation();
  const successText = t('spaces.threeD.importModel.success');
  const seen = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (snapshot.phase !== 'placed' || !snapshot.objectId || seen.current === snapshot.objectId) return;
    seen.current = snapshot.objectId;
    onOpenChange(false);
    onPlaced(snapshot.objectId);
    controller.reset();
    toast.success(successText);
  }, [snapshot.phase, snapshot.objectId, onOpenChange, onPlaced, controller, successText]);
  /**
   * Reopen this document's retained import view.
   * @throws {never} Never directly.
   */
  const show = React.useCallback((): void => onOpenChange(true), [onOpenChange]);
  return <>
    {!open && !['idle', 'placed', 'disposed'].includes(snapshot.phase) && <Button variant='outline'
      className='absolute left-[76px] top-1/2 z-10 -translate-y-1/2 bg-popover'
      icon={importIcon} onClick={show}>
      {snapshot.phase === 'checking' ? t('spaces.threeD.importModel.checking')
        : snapshot.phase === 'uploading' ? t('spaces.threeD.importModel.uploading', { progress: Math.round(snapshot.progress * 100) })
          : snapshot.phase === 'registering' ? t('spaces.threeD.importModel.registering') : t('spaces.threeD.importModel.title')}
    </Button>}
    <SceneModelImportDialog controller={controller} open={open} onOpenChange={onOpenChange} canEdit={canEdit} maxInputBytes={maxInputBytes} />
  </>;
}
