/**
 * Left floating node library for the local-only canvas — aligned with
 * `apps/project/.../canvas/ui/NodeLibraryPanel.tsx`, without Yjs or Redux canvas UI.
 */
import type { FC, ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import nodeIconMap from '@/apps/project/constants/nodeIconMap';
import { flowCenterFromCanvasPane } from '@/spaces/canvas/types';
import type { LocalCanvasNodeData } from '@/new/project/types';

interface NodeGroupConfig {
  id: number;
  label: string;
  icon: string;
  nodeTypes: string[];
  size?: number;
}

interface NodeHandleConfig {
  type: string;
  handles: {
    source?: { handleType: string; number: number }[];
    target?: { handleType: string; number: number }[];
  };
}

interface NodeTemplateDetail {
  template_name?: string;
  template_type?: string;
}

const nodeHandles: NodeHandleConfig[] = [
  { type: '1001', handles: { target: [{ handleType: 'Text', number: 0 }] } },
  { type: '1002', handles: { target: [{ handleType: 'Image', number: 0 }] } },
  { type: '1003', handles: { target: [{ handleType: 'Video', number: 0 }] } },
  { type: '1004', handles: { target: [{ handleType: 'Audio', number: 0 }] } },
];

const libraryNodeDefaultSize: Record<string, { w: number; h: number }> = {
  '1001': { w: 300, h: 250 },
  '1002': { w: 300, h: 250 },
  '1003': { w: 300, h: 250 },
  '1004': { w: 472, h: 200 },
};

function libraryTopLeftFromCanvasCenter(
  centerFlow: { x: number; y: number },
  nodeTypeKey: string,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const { w, h } = libraryNodeDefaultSize[nodeTypeKey] ?? { w: 300, h: 200 };
  return { x: centerFlow.x - w / 2 + offset.x, y: centerFlow.y - h / 2 + offset.y };
}

const getNodeIconName = (iconName: string): string => nodeIconMap[iconName] || '';

const getNodeSubtitle = (templateType: string | undefined): string | undefined => {
  if (!templateType) return undefined;
  switch (templateType) {
    case '1001':
    case 'Text':
      return 'Loads/Creates text content';
    case '1002':
    case 'Image':
      return 'Loads/Generates images';
    case '1003':
    case 'Video':
      return 'Loads/Generates video clips';
    case '1004':
    case 'Audio':
      return 'Loads/Creates audio content';
    default:
      return undefined;
  }
};

const getNodeHandlesByType = (type: string) => {
  const config = nodeHandles.find((item) => item.type === type);
  return config?.handles ?? { source: [], target: [] };
};

const RotatingIcon = ({ icon }: { icon: string }) => {
  const [hover, setHover] = useState(false);

  return (
    <div
      className='flex items-center justify-center'
      style={{
        width: 40,
        height: 40,
        overflow: 'visible',
        transform: hover ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 200ms ease',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon name={icon} width={40} height={40} />
    </div>
  );
};

const builtInTemplates: NodeTemplateDetail[] = [
  { template_type: '1001', template_name: 'Text' },
  { template_type: '1002', template_name: 'Image' },
  { template_type: '1003', template_name: 'Video' },
  { template_type: '1004', template_name: 'Audio' },
];

const NodeLibraryPanel: FC = () => {
  const [nodeGroups, setNodeGroups] = useState<NodeGroupConfig[]>([]);
  const [templateMap, setTemplateMap] = useState<Map<string, NodeTemplateDetail>>(new Map());
  const [canvasCommentMode, setCanvasCommentMode] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const { screenToFlowPosition, getNodes, setNodes } = useReactFlow();
  const { t } = useTranslation();

  const triggerUploadFromLibrary = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const appendNode = useCallback(
    (node: Node<LocalCanvasNodeData> & { zIndex?: number }) => {
      setNodes((nds) => {
        const cleared = nds.map((n) => ({ ...n, selected: false }));
        return [...cleared, { ...node, selected: true }];
      });
    },
    [setNodes],
  );

  const handleUploadInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (!files.length) return;

      const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const centerFlow = flowCenterFromCanvasPane(screenToFlowPosition, fallback);
      const maxZIndex = getNodes().reduce((max, node) => {
        const z = (node as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);

      const gap = 40;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const typeKey = file.type.startsWith('image/')
          ? '1002'
          : file.type.startsWith('video/')
            ? '1003'
            : file.type.startsWith('audio/')
              ? '1004'
              : '1001';
        const position = libraryTopLeftFromCanvasCenter(centerFlow, typeKey, {
          x: index * gap,
          y: index * gap * 0.2,
        });
        const timestamp = Date.now();
        const randomString = nanoid(5);
        const nodeId = `${typeKey}-${timestamp}-${randomString}-${index}`;

        let node: Node<LocalCanvasNodeData> & { zIndex?: number };

        if (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')) {
          const url = URL.createObjectURL(file);
          node = {
            id: nodeId,
            type: typeKey,
            position,
            zIndex: maxZIndex + 1 + index,
            data: {
              name: file.name.replace(/\.[^/.]+$/, '') || file.name,
              url,
              handles: getNodeHandlesByType(typeKey),
            },
          };
        } else {
          let textBody = '';
          try {
            textBody = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(new Error('read failed'));
              reader.readAsText(file);
            });
          } catch {
            textBody = file.name;
          }
          node = {
            id: nodeId,
            type: '1001',
            position,
            zIndex: maxZIndex + 1 + index,
            data: {
              name: file.name,
              text: textBody,
              handles: getNodeHandlesByType('1001'),
            },
          };
        }
        appendNode(node);
      }
    },
    [appendNode, getNodes, screenToFlowPosition],
  );

  useEffect(() => {
    setTemplateMap(new Map(builtInTemplates.map((item) => [item.template_type!, item])));
    setNodeGroups([
      {
        id: 1,
        label: t('nodeLibraryPanel.data_nodes'),
        icon: 'nodeLibraryPanel-data-nodes',
        nodeTypes: ['1001', '1002', '1003', '1004'],
      },
      { id: 2, label: '', icon: 'nodeLibraryPanel-editing-page-sidebaricon', nodeTypes: [], size: 26 },
      { id: 3, label: '', icon: 'nodeLibraryPanel-editing-page-sidebaricon-1', nodeTypes: [], size: 24 },
      { id: 4, label: '', icon: 'nodeLibraryPanel-editing-page-sidebaricon-2', nodeTypes: [] },
    ]);
  }, [t]);

  const buildDropdownItems = useCallback(
    (group: NodeGroupConfig): MenuItemType[] => {
      const menuItems: MenuItemType[] = [
        {
          key: `group-${group.id}`,
          label: (
            <div className='px-[12px] pb-[10px] pt-[8px] text-xs font-bold leading-[12px] text-text-default-base'>{group.label}</div>
          ),
          interactive: false,
        },
        ...group.nodeTypes
          .map((key) => {
            const item = templateMap.get(key);
            if (!item) return null;
            return {
              key,
              label: (
                <div className='flex h-[38px] w-full min-w-0 items-center justify-start rounded-[3px] px-[5px]'>
                  <Icon
                    name={getNodeIconName(item.template_type || key)}
                    width={24}
                    height={24}
                    color='var(--bg-icon-Default-Default)'
                  />
                  <div className='relative ml-1 flex h-full w-full flex-col justify-center overflow-hidden'>
                    <span className='-translate-y-[8px] text-sm font-bold leading-[16px] text-text-default-base'>
                      {item.template_name || String(key)}
                    </span>
                    <span className='absolute left-0 top-[20px] w-full translate-y-0 text-[10px] font-bold leading-[12px] text-text-default-tertiary'>
                      {getNodeSubtitle(item.template_type || key) ?? ''}
                    </span>
                  </div>
                </div>
              ) as ReactNode,
            } as MenuItemType;
          })
          .filter((item): item is MenuItemType => item !== null),
      ];
      return menuItems;
    },
    [templateMap],
  );

  const handleMenuClick = useCallback(
    (key: string) => {
      if (key === 'action-upload') {
        triggerUploadFromLibrary();
        return;
      }
      if (key.startsWith('group-')) return;

      const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const centerFlow = flowCenterFromCanvasPane(screenToFlowPosition, fallback);
      const position = libraryTopLeftFromCanvasCenter(centerFlow, key);
      const maxZIndex = getNodes().reduce((max, node) => {
        const z = (node as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      const timestamp = Date.now();
      const randomString = nanoid(5);
      const newNodeId = `${key}-${timestamp}-${randomString}`;

      const templateName = templateMap.get(key)?.template_name ?? key;
      const baseData: LocalCanvasNodeData = {
        name: templateName,
        handles: getNodeHandlesByType(key),
      };

      if (key === '1001') {
        appendNode({
          id: newNodeId,
          type: key,
          position,
          zIndex: maxZIndex + 1,
          data: { ...baseData, text: '' },
        });
        return;
      }

      appendNode({
        id: newNodeId,
        type: key,
        position,
        zIndex: maxZIndex + 1,
        data: { ...baseData, url: '' },
      });
    },
    [appendNode, getNodes, screenToFlowPosition, templateMap, triggerUploadFromLibrary],
  );

  const handleIconGroupClick = useCallback(
    (groupId: number) => {
      if (groupId === 2) {
        triggerUploadFromLibrary();
        return;
      }
      if (groupId === 3) {
        setCanvasCommentMode((v) => !v);
      }
    },
    [triggerUploadFromLibrary],
  );

  const dataGroup = useMemo(() => nodeGroups.find((g) => g.id === 1), [nodeGroups]);
  const iconGroups = useMemo(() => nodeGroups.filter((g) => g.id !== 1), [nodeGroups]);

  return (
    <div className='pointer-events-auto fixed left-3 top-[50%] z-20 -translate-y-1/2'>
      <input ref={uploadInputRef} type='file' multiple className='hidden' onChange={handleUploadInputChange} />
      {nodeGroups.length > 0 && (
        <div
          className='
            node-library-panel-menu-container flex w-14 flex-col gap-[10px]
            rounded-t-[8px] rounded-b-[28px] border-0 bg-background-default-base
            px-2 pb-6 pt-2 outline-0
            shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]
          '
        >
          {dataGroup && (
            <Dropdown
              key={dataGroup.id}
              items={buildDropdownItems(dataGroup)}
              onClick={handleMenuClick}
              trigger='hover'
              placement='right-start'
              popupClassName='w-[200px] rounded-[8px] p-[6px]'
              offset={20}
            >
              <div className='flex h-[40px] w-[40px] cursor-pointer items-center justify-center rounded-[4px]'>
                <RotatingIcon icon={dataGroup.icon} />
              </div>
            </Dropdown>
          )}
          {iconGroups.map((group) => (
            <div
              key={group.id}
              className={`flex h-[40px] w-[40px] cursor-pointer items-center justify-center rounded-[4px] ${
                group.id === 3 && canvasCommentMode ? 'bg-background-default-secondary' : 'hover:bg-background-default-secondary'
              }`}
              onClick={() => handleIconGroupClick(group.id)}
            >
              <div className='flex h-[40px] w-[40px] items-center justify-center rounded-[4px]'>
                <Icon name={group.icon} width={group.size ?? 28} height={group.size ?? 28} color='var(--bg-icon-base)' />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(NodeLibraryPanel);
