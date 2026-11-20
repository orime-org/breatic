// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';

import { agentAccessApi, commentAssignmentsKey, type SpaceAssignment } from '@web/data/api/agent-access';

/**
 * The viewer's own hand-over of one thread, from the Space's records (#1488
 * §11.7): undefined when they handed it to nobody, which is all a
 * collaborator ever reads.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param threadId - The thread.
 * @returns The record, or undefined.
 */
export function useHandOverRecord(projectId: string, spaceId: string, threadId: string): SpaceAssignment | undefined {
  const records = useQuery({
    queryKey: commentAssignmentsKey(projectId, spaceId),
    queryFn: () => agentAccessApi.spaceAssignments(projectId, spaceId),
  });
  return records.data?.find((r) => r.threadId === threadId);
}
