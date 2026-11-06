// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { SceneModelImportDialog } from '@web/spaces/three-d/SceneModelImportDialog';
import type { ModelImportController } from '@web/spaces/three-d/model-import-controller';

interface SceneModelImportHostProps {
  controller: ModelImportController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  maxInputBytes: number;
  onStarted: (taskId: string) => void;
}

/**
 * The lazily loaded import dialog of one document.
 * @param props - Active view bindings to the document's import owner.
 * @param props.controller - Input retained by the current document.
 * @param props.open - Whether its dialog is visible.
 * @param props.onOpenChange - Opens or hides the dialog.
 * @param props.canEdit - Current scene write permission.
 * @param props.maxInputBytes - Configured input-byte budget.
 * @param props.onStarted - Told the new task row once the upload has one.
 * @returns The controlled dialog.
 * @throws {never} Import state carries operational failures.
 */
export default function SceneModelImportHost({ controller, open, onOpenChange, canEdit, maxInputBytes, onStarted }: SceneModelImportHostProps): React.JSX.Element {
  return <SceneModelImportDialog controller={controller} open={open} onOpenChange={onOpenChange} canEdit={canEdit} maxInputBytes={maxInputBytes} onStarted={onStarted} />;
}
