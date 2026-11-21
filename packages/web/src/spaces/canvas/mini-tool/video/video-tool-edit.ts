// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { newId } from '@breatic/shared';
import type { MiniToolPresentationRef, VideoToolDraftById, VideoToolId, VideoToolSourceRef } from '@breatic/shared/mini-tools';

/**
 * Creates a complete tool draft bound to the current registered source and, when given, the selected version its frame
 * numbers belong to (frames-split §7.13).
 * @throws {never} Never.
 * @param toolId - The selected supported video tool.
 * @param source - The registered source and its authoritative media information.
 * @param presentationRef - The selected version's ref.
 * @returns The current value derived from these inputs.
 */
export function createVideoToolDraft<K extends VideoToolId>(toolId: K, source: VideoToolSourceRef, presentationRef?: MiniToolPresentationRef): VideoToolDraftById[K] {
  const common = { version: 1 as const, draftId: newId(), revision: newId(), source, inputs: [], ...(presentationRef === undefined ? {} : { presentationRef: structuredClone(presentationRef) }) };
  const drafts: VideoToolDraftById = {
    'video.extract-frames': { ...common, params: { mode: 'current', frameIndex: 0 } },
    'video.split': { ...common, params: { cuts: [] } },
  };
  return drafts[toolId];
}
