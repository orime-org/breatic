// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { getLocale, t, type GenerationTemplate } from '@breatic/shared';

import {
  getPromptFragment,
  readCanvasGraph,
  setNodeMode,
  setNodeModel,
} from '@web/data/yjs/canvas-space';
import { asContentView } from '@web/data/yjs/node-view';
import { toast } from '@web/lib/toast';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';
import { writeProposalPrompt } from '@web/spaces/canvas/generate/proposal-prompt';
import { templateFeeders, templateWrites } from '@web/spaces/canvas/generate/template-writes';

/** Text bodies are not read here: only which images are wired in matters. */
const NO_TEXT: ReadonlyMap<string, string> = new Map();

/**
 * Applies a picked template to a generate panel's node (inner#977): the
 * template's mode, model and params, then that mode's prompt replaced by the
 * template's, its asset marks mentioning the images wired in. The same writes
 * the reader makes setting the panel by hand, read fresh at click time like
 * every other panel write. A toast reminds the reader to edit the marked
 * parts; nothing stops them generating without doing so.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The panel's node.
 * @returns The pick handler.
 */
export function useApplyTemplate(
  projectId: string,
  spaceId: string,
  nodeId: string,
): (template: GenerationTemplate) => void {
  return React.useCallback(
    (template: GenerationTemplate) => {
      const graph = readCanvasGraph(projectId, spaceId);
      const content = asContentView(graph.nodes.find((n) => n.id === nodeId)?.data);
      const writes = templateWrites(template, content?.paramsByModel, getLocale());
      setNodeMode(projectId, spaceId, nodeId, writes.mode, writes.model, writes.paramsByModel);
      // Also an explicit pick, so the mode remembers the template's model.
      setNodeModel(projectId, spaceId, nodeId, writes.mode, writes.model, writes.paramsByModel);
      const fragment = getPromptFragment(projectId, spaceId, nodeId, writes.mode);
      if (fragment) {
        const references = deriveReferences(nodeId, graph.nodes, graph.edges, NO_TEXT);
        writeProposalPrompt(fragment, writes.prompt, templateFeeders(references));
      }
      toast.info(t('canvas.generatePanel.editMarks'));
    },
    [projectId, spaceId, nodeId],
  );
}
