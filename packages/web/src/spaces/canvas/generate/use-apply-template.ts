// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { t, type CanvasProposal, type GenerationTemplate, type ModelEntry } from '@breatic/shared';

import { readCanvasGraph } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { NODE_GATE_TOAST_KEY, planTemplateApply, type ExistingNode, type PlacedProposal } from '@breatic/shared/canvas-model';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import type { SpaceRefusal } from '@web/data/yjs/space-write';

/** Places a template's proposal around nodes already on the canvas: `CanvasSpace`'s callback. */
export type PlaceTemplate = (proposal: CanvasProposal, existing: ReadonlyMap<number, ExistingNode>, order: readonly number[]) => PlacedProposal | SpaceRefusal;

/**
 * Applies a picked template to a generate panel's node (inner#977,
 * inner#1345).
 *
 * The board is read fresh from Yjs at click time, and what the template already
 * has around the node is found by the same match the agent's proposals are
 * checked with (`matchTemplateInstance`): its nodes by their tags, its inputs
 * among the references wired in, in rail order. Every node of the template the
 * board does not have yet is added, wired and @'d, and the template's mode,
 * model, params and prompts are written over the node and every generation it
 * reuses -- all through `placeTemplate`, the same placing an agent's proposal
 * goes through.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The panel's node.
 * @param models - Every model this deployment serves, across node types.
 * @param placeTemplate - Places the proposal around the nodes it reuses.
 * @returns The pick handler.
 */
export function useApplyTemplate(
  projectId: string,
  spaceId: string,
  nodeId: string,
  models: readonly ModelEntry[],
  placeTemplate: PlaceTemplate,
): (template: GenerationTemplate) => void {
  return React.useCallback(
    (template: GenerationTemplate) => {
      const plan = planTemplateApply(template, readCanvasGraph(projectId, spaceId), nodeId, models);
      if ('reason' in plan) {
        // The catalog refetched and dropped a model since the menu drew it.
        if (plan.reason === 'model_unavailable') toast.error(t('canvas.generatePanel.modelUnavailable'));
        else if (plan.reason === 'group_locked') toast.warning(t('canvas.template.groupLocked'));
        else if (plan.reason === 'locked') warnNodeGate(t(NODE_GATE_TOAST_KEY.locked));
        return;
      }
      const { proposal, existing, order } = plan;
      let placed: PlacedProposal | SpaceRefusal;
      try {
        placed = placeTemplate(proposal, existing, order);
      } catch {
        toast.error(t('canvas.template.applyFailed'));
        return;
      }
      // Refused for room, with its own warning.
      if ('ok' in placed) return;
      // An empty node to fill or words in braces to write are left for the
      // user; nothing stops them generating as it is.
      if (plan.toFill) toast.info(t('canvas.generatePanel.editProposalMarks'));
    },
    [projectId, spaceId, nodeId, models, placeTemplate],
  );
}
