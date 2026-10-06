// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { LeaveProjectDialog } from '@web/features/project-manage/LeaveProjectDialog';
import { useLeaveProject } from '@web/features/project-manage/use-leave-project';
import { LEFT_PROJECT_STATE } from '@web/pages/project/LeaveProjectGuard';

interface LeaveProjectFromPageProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Leaving the project from inside it: the confirmation, then the recent
 * page — where the top bar's back link goes — in place of the project.
 *
 * The landing carries `LEFT_PROJECT_STATE` so `LeaveProjectGuard` lets it
 * through: whatever front-end work is still running belongs to a project the
 * caller can no longer open.
 * @param props - The project and the dialog's open state.
 * @param props.projectId - The project.
 * @param props.projectName - Its name, quoted in the dialog and the toast.
 * @param props.open - Whether the confirmation is shown.
 * @param props.onOpenChange - Called when the confirmation asks to open or close.
 * @returns The confirmation dialog.
 */
export function LeaveProjectFromPage({
  projectId,
  projectName,
  open,
  onOpenChange,
}: LeaveProjectFromPageProps): React.JSX.Element {
  const navigate = useNavigate();
  const goToRecent = React.useCallback((): void => {
    void navigate('/studio', { replace: true, state: LEFT_PROJECT_STATE });
  }, [navigate]);
  const { leave, pending } = useLeaveProject(projectId, projectName, goToRecent);
  return (
    <LeaveProjectDialog
      open={open}
      onOpenChange={onOpenChange}
      name={projectName}
      onConfirm={leave}
      pending={pending}
    />
  );
}
