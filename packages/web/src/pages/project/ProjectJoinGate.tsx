// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import {
  JoinProjectDialog,
  joinRequestQueryKey,
} from '@web/features/project-join/JoinProjectDialog';
import type { MyJoinRequest } from '@web/data/api/project-join-requests';

interface ProjectJoinGateProps {
  projectId: string;
}

/**
 * What a studio member who is not on the project sees when they open its
 * address: an empty page with the join dialog over it. The address stays as
 * it is; closing the dialog goes back to the project's studio, or to the
 * studio landing when the dialog never learned which studio that is.
 * @param props - The project.
 * @param props.projectId - The project the caller cannot enter.
 * @returns The page.
 */
export function ProjectJoinGate({ projectId }: ProjectJoinGateProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (open) return;
      const view = queryClient.getQueryData<MyJoinRequest>(joinRequestQueryKey(projectId));
      navigate(view ? `/studio/${view.project.studioSlug}/projects` : '/studio', { replace: true });
    },
    [navigate, projectId, queryClient],
  );
  return (
    <main className='min-h-screen bg-background'>
      <JoinProjectDialog projectId={projectId} open onOpenChange={onOpenChange} />
    </main>
  );
}
