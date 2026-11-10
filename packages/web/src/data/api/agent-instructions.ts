// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { AgentInstructionsView } from '@breatic/shared';
import { apiGet, apiPut } from '@web/data/api/request';

/**
 * The query key of one Project's instructions for the Agent (#1400).
 * @param projectId - The Project.
 * @returns The key.
 */
export function agentInstructionsKey(projectId: string): readonly ['agent-instructions', string] {
  return ['agent-instructions', projectId];
}

/**
 * Read a Project's instructions for the Agent.
 * @param projectId - The Project.
 * @returns The instructions, empty when there are none.
 * @throws {ApiException} When the server refuses or cannot be reached.
 */
export function fetchAgentInstructions(projectId: string): Promise<AgentInstructionsView> {
  return apiGet<AgentInstructionsView>('/chat/instructions', { params: { project_id: projectId } });
}

/**
 * Save a Project's instructions for the Agent exactly as typed.
 * @param projectId - The Project.
 * @param text - The text as typed; one that is empty or only whitespace clears them.
 * @returns The instructions now in place.
 * @throws {ApiException} When the server refuses or cannot be reached.
 */
export function saveAgentInstructions(projectId: string, text: string): Promise<AgentInstructionsView> {
  return apiPut<AgentInstructionsView>('/chat/instructions', { project_id: projectId, text });
}

/**
 * A Project's instructions for the Agent, read once the panel mounts.
 * @param projectId - The Project.
 * @returns The query.
 */
export function useAgentInstructions(projectId: string): UseQueryResult<AgentInstructionsView> {
  return useQuery({
    queryKey: agentInstructionsKey(projectId),
    queryFn: () => fetchAgentInstructions(projectId),
  });
}
