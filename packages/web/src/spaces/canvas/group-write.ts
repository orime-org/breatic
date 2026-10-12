// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createGroup } from '@web/data/yjs/canvas-space';
import type { GroupCreationPlan } from '@web/spaces/canvas/group-creation';
import { createGroupNode } from '@web/spaces/canvas/node-factory';

/**
 * Write a planned Group and bind its members to it.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to write into.
 * @param plan - The Group's stored rect and each member's relative position.
 * @param createdBy - Whoever is making it.
 * @param backgroundColor - Tint token to open with; absent leaves it untinted.
 * @param name - The name to open with; absent takes the default.
 */
export function writeGroup(
  projectId: string,
  spaceId: string,
  plan: GroupCreationPlan,
  createdBy: string,
  backgroundColor?: string,
  name?: string,
): void {
  createGroup(
    projectId,
    spaceId,
    createGroupNode(
      plan.groupId,
      plan.position,
      plan.width,
      plan.height,
      createdBy,
      backgroundColor,
      name,
    ),
    plan.members,
  );
}
