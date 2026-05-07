import type { Edge, Node } from '@xyflow/react';
import type { CanvasWorkflowNodeData } from '@/spaces/canvas/types';
import type { LocalCanvasNodeData } from '@/new/project/types';

/** Upstream chip for {@link GenComposerToolbar}. */
export type UpstreamItem = {
  id: string;
  previewUrl: string;
  name?: string;
  mediaType: 'image' | 'video' | 'audio' | 'text' | 'file';
  /** React Flow source node id (for removing the inbound edge). */
  sourceNodeId: string;
};

const stripHtmlToPlain = (html: string): string => {
  if (!html.trim()) return '';
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, ' ').trim();
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\u00A0/g, ' ').trim();
};

const mediaTypeForNodeType = (nodeType: Node['type']): UpstreamItem['mediaType'] => {
  switch (nodeType) {
    case '1002':
    case 'gen1002':
      return 'image';
    case '1003':
    case 'gen1003':
      return 'video';
    case '1004':
    case 'gen1004':
      return 'audio';
    case '1001':
    case 'gen1001':
      return 'text';
    default:
      return 'file';
  }
};

/**
 * Builds upstream preview items from inbound edges to `targetNodeId`, using Yjs `history` when
 * present, otherwise `LocalCanvasNodeData` (`url`, `content`, `text`).
 *
 * @param nodes - Current flow nodes
 * @param edges - Current flow edges
 * @param targetNodeId - Generator (or any) node id
 */
export function buildUpstreamItems(nodes: Node[], edges: Edge[], targetNodeId: string): UpstreamItem[] {
  const inbound = edges.filter((e) => e.target === targetNodeId);
  if (!inbound.length) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));

  return inbound
    .map((edge) => {
      const node = byId.get(edge.source);
      if (!node || node.id === targetNodeId) return null;

      const data = node.data as Partial<CanvasWorkflowNodeData> & Partial<LocalCanvasNodeData> | undefined;
      const { activeHistoryId, history } = data ?? {};
      const activeItem = Array.isArray(history) && activeHistoryId
        ? history.find((h) => h.id === activeHistoryId)
        : undefined;
      let previewUrl = typeof activeItem?.url === 'string' ? activeItem.url.trim() : '';

      if (!previewUrl && typeof data?.url === 'string') previewUrl = data.url.trim();
      if (!previewUrl && node.type === '1003' && typeof data?.content === 'string') previewUrl = data.content.trim();

      if (!previewUrl && (node.type === '1001' || node.type === 'gen1001') && typeof data?.text === 'string') {
        const plain = stripHtmlToPlain(data.text);
        if (plain) {
          previewUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(plain.slice(0, 8000))}`;
        }
      }

      if (!previewUrl) return null;

      const mediaType = mediaTypeForNodeType(node.type);
      const displayName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : undefined;

      return {
        id: `upstream-${node.id}`,
        previewUrl,
        name: displayName,
        mediaType,
        sourceNodeId: node.id,
      } satisfies UpstreamItem;
    })
    .filter(Boolean) as UpstreamItem[];
}
