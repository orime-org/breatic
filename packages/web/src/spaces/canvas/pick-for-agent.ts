// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picked piece of the canvas as "Add to agent" hands it over (#2218),
 * read fresh from the document at the press.
 *
 * The catalog tells each generating node what it would run right now. An
 * audio node with no voice picked runs the first voice of its model's list,
 * so a first voice that is not cached yet is asked for first, by the query
 * the audio panel uses, and the pick is read again once it is in.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Voice } from '@breatic/shared';

import { nodeDataMap, readCanvasGraph } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { itemForPick } from '@web/spaces/canvas/attach-nodes';
import { firstVoiceKey, firstVoiceQuery } from '@web/spaces/canvas/generate/first-voice-query';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';

/**
 * The picked piece of the canvas as one item for the agent.
 * @param queryClient - Holds the catalog and each model's first voice.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - The canvas space.
 * @param ids - The picked node ids; a group brings its members.
 * @returns The item, or null for nothing to hand over.
 * @throws {Error} When the catalog cannot be read.
 */
export async function pickForAgent(
  queryClient: QueryClient,
  projectId: string,
  spaceId: string,
  ids: readonly string[],
): Promise<ReturnType<typeof itemForPick>> {
  const catalog = await queryClient.ensureQueryData(modelCatalogQuery());
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const unknownVoices = new Set<string>();
  /**
   * The pick as the document and the cache hold it now.
   * @returns The item, or null for nothing to hand over.
   */
  const pick = (): ReturnType<typeof itemForPick> =>
    itemForPick(readCanvasGraph(projectId, spaceId), ids, {
      dataOf: (id) => nodeDataMap(doc, id),
      catalog,
      firstVoiceOf: (model) => {
        const first = queryClient.getQueryData<Voice | null>(firstVoiceKey(model));
        if (first === undefined) unknownVoices.add(model);
        return first;
      },
    });
  const item = pick();
  if (unknownVoices.size === 0) return item;
  // A list that cannot be read leaves that voice out, as it does in the panel.
  await Promise.allSettled(
    [...unknownVoices].map((model) => queryClient.fetchQuery(firstVoiceQuery(queryClient, model))),
  );
  return pick();
}
