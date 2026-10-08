// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { t, type GenerationTemplate, type ModelEntry } from '@breatic/shared';

import {
  getPromptFragment,
  readCanvasGraph,
  setNodeMode,
  setNodeModel,
} from '@web/data/yjs/canvas-space';
import { asContentView } from '@web/data/yjs/node-view';
import { toast } from '@web/lib/toast';
import { writeProposalPrompt } from '@web/spaces/canvas/generate/proposal-prompt';
import { templateWrites } from '@web/spaces/canvas/generate/template-writes';

/**
 * Applies a picked template to a generate panel's node (inner#977): the
 * template's mode, model and params, then that mode's prompt replaced by the
 * template's; the reader `@`-mentions the pictures it asks for by hand. The same writes
 * the reader makes setting the panel by hand, read fresh at click time like
 * every other panel write. A toast reminds the reader to edit the marked
 * parts; nothing stops them generating without doing so.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The panel's node.
 * @param models - The models this deployment serves for the node type.
 * @returns The pick handler.
 */
export function useApplyTemplate(
  projectId: string,
  spaceId: string,
  nodeId: string,
  models: readonly ModelEntry[],
): (template: GenerationTemplate) => void {
  return React.useCallback(
    (template: GenerationTemplate) => {
      const picked = models.find((m) => m.name === template.model);
      if (!picked) {
        // The catalog refetched and dropped the model since the menu drew it.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      const graph = readCanvasGraph(projectId, spaceId);
      const content = asContentView(graph.nodes.find((n) => n.id === nodeId)?.data);
      const writes = templateWrites(template, content, picked);
      setNodeMode(projectId, spaceId, nodeId, writes.mode, writes.model, writes.paramsByModel);
      // Also an explicit pick, so the mode remembers the template's model.
      setNodeModel(projectId, spaceId, nodeId, writes.mode, writes.model, writes.paramsByModel);
      const fragment = getPromptFragment(projectId, spaceId, nodeId, writes.mode);
      // The reader @s the pictures the template asks for by hand.
      if (fragment) writeProposalPrompt(fragment, writes.prompt);
      toast.info(t('canvas.generatePanel.editMarks'));
    },
    [projectId, spaceId, nodeId, models],
  );
}
