// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * When a canvas video still is the video a Motion Space exported (#1490 design §9.2, §9.3): only a video whose content
 * is the exported video's address offers "Open source animation"; one regenerated, uploaded over or replaced does not.
 */

/** The Motion result a video stands for. */
export interface SourceAnimationTarget {
  spaceId: string;
  executionId: string;
}

/** The part of a node this reads. */
interface NodeLike {
  type: string;
  data: object;
}

/**
 * The Motion result a node still shows, if any.
 * @param node - The node.
 * @returns Its Space and execution, or null.
 * @throws {never} Never.
 */
export function sourceAnimationOf(node: NodeLike): SourceAnimationTarget | null {
  if (node.type !== 'video') return null;
  const data = node.data as { content?: unknown; sourceAnimation?: { spaceId: string; executionId: string; videoUrl: string } };
  const link = data.sourceAnimation;
  if (link === undefined || data.content !== link.videoUrl) return null;
  return { spaceId: link.spaceId, executionId: link.executionId };
}
