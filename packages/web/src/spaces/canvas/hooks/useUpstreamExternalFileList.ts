import { useTranslation } from 'react-i18next';
import type { Node, Edge } from '@xyflow/react';
import type { CanvasWorkflowNodeData, ResourceType } from '@/spaces/canvas/types';

export interface UpstreamExternalFileItem {
  uid: string;
  name: string;
  type: ResourceType;
  content?: string;
}

const getResourceTypeByNodeType = (nodeType: Node['type']): ResourceType => {
  switch (nodeType) {
    case '1002':
      return 'image';
    case '1003':
      return 'video';
    case '1004':
      return 'audio';
    case '1001':
      return 'text';
    default:
      return 'file';
  }
};

export const useUpstreamExternalFileList = (
  nodes: Node[],
  edges: Edge[],
  targetId: string,
): UpstreamExternalFileItem[] => {
  const { t } = useTranslation();
  const fallbackNameByType: Record<ResourceType, string> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    text: t('canvas.upstream.text', 'Text'),
    file: t('canvas.upstream.file', 'File'),
  };

  const inboundEdges = edges.filter((e) => e.target === targetId);
  if (!inboundEdges.length) return [];

  const upstreamIds = inboundEdges.map((e) => e.source);
  const upstreamNodes = nodes.filter((n) => upstreamIds.includes(n.id) && n.id !== targetId);

  return upstreamNodes
    .map((node) => {
      const data = node.data as Partial<CanvasWorkflowNodeData> | undefined;
      // Canvas-native schema: resolve URL directly from data.content.
      const content = data?.content;
      if (typeof content !== 'string' || !content.trim()) return null;

      const url = content;
      const type = getResourceTypeByNodeType(node.type);

      let nameFromUrl = '';
      if (typeof url === 'string' && type !== 'text') {
        const lastSlashIndex = url.lastIndexOf('/');
        const lastPart = lastSlashIndex >= 0 ? url.slice(lastSlashIndex + 1) : url;
        const [base] = lastPart.split('?');
        nameFromUrl = base || '';
      }

      const displayName = typeof data?.name === 'string' && data.name.trim() ? data.name : '';
      const name =
        type === 'text'
          ? fallbackNameByType.text
          : displayName || nameFromUrl || fallbackNameByType[type] || fallbackNameByType.file;

      return {
        uid: `${node.id}-${type}`,
        name,
        type,
        content: url as string,
      };
    })
    .filter(Boolean) as UpstreamExternalFileItem[];
};
