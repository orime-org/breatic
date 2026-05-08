/**
 * NodeLibraryPanel.tsx
 */
import { memo, useState, useEffect, useRef } from 'react';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/hooks/useCanvasUI';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { useReactFlow, type Node } from '@xyflow/react';
import { nanoid } from 'nanoid';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';

// Node icon map (format: dir-name-filename, hyphen separated)
import nodeIconMap from '@/pages/project/constants/nodeIconMap';
import { flowCenterFromCanvasPane } from '@/spaces/canvas/types';


/** Node group config displayed in the sidebar */
interface NodeGroupConfig {
  id: number;
  label: string;
  icon: unknown;
  nodeTypes: string[];
  /** Icon size; defaults to 28 if not provided */
  size?: number;
}

/** Node handle config */
interface NodeHandleConfig {
  type: string;
  handles: {
    source?: {
      handleType: string;
      number: number;
    }[];

    target?: {
      handleType: string;
      number: number;
    }[];
  };
}

/** Node template metadata structure (provided by backend / store) */
interface NodeTemplateDetail {
  template_name?: string;
  template_type?: string; // Node type identifier
  template_icon?: string; // Icon name key
  membership_level?: number;
  remark?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any; // Default node content / hint
}

/**
 * The following createXXXNodeForUpload functions mirror the implementations in
 * ClipboardPasteHandler to ensure consistent node structure for upload and paste actions.
 */
const createTextNode = (textContent: string, position: { x: number; y: number }, nodeId: string): Node => ({
  id: nodeId,
  type: '1001',
  position,
  selected: true,
  style: { width: 300 },
  data: {
    nodeSelectedResultData: {
      resultType: 'content',
      content: textContent,
      counter: textContent.trim() ? 1 : 0,
    },
    handles: {
      target: [{ handleType: 'Text', number: 1 }],
    },
  },
});

const createImageNodeForUpload = (position: { x: number; y: number }, nodeId: string, _file?: File): Node => {
  // File upload now uses presigned URL flow (useNodeUpload hook).
  return {
    id: nodeId,
    type: '1002',
    position,
    selected: true,
    data: {
      nodeSelectedResultData: {
        resultType: 'content',
        content: '',
        counter: 0,
      },
      handles: {
        target: [{ handleType: 'Image', number: 1 }],
      },
    },
  };
};

const createVideoNodeForUpload = (position: { x: number; y: number }, nodeId: string, _file?: File): Node => {
  return {
    id: nodeId,
    type: '1003',
    position,
    selected: true,
    data: {
      nodeSelectedResultData: {
        resultType: 'content',
        content: '',
        counter: 0,
      },
      handles: {
        target: [{ handleType: 'Video', number: 1 }],
      },
    },
  };
};

const createAudioNodeForUpload = (position: { x: number; y: number }, nodeId: string, _file?: File): Node => {
  return {
    id: nodeId,
    type: '1004',
    position,
    selected: true,
    data: {
      nodeSelectedResultData: {
        resultType: 'content',
        content: '',
        counter: 0,
      },
      handles: {
        target: [{ handleType: 'Audio', number: 1 }],
      },
    },
  };
};

/** Resolve node icon by icon name */
const getNodeIconName = (iconName: string): string => {
  return nodeIconMap[iconName] || '';
};

/** Subtitle text for data/edit nodes in the node library */
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

/**
 * Node handle configuration.
 * Defines valid handles for each node type.
 */
const nodeHandles: NodeHandleConfig[] = [
  // Data node - Text
  {
    type: '1001',
    handles: {
      target: [{ handleType: 'Text', number: 0 }],
    },
  },

  // Data node - Image
  {
    type: '1002',
    handles: {
      target: [{ handleType: 'Image', number: 0 }],
    },
  },

  // Data node - Video
  {
    type: '1003',
    handles: {
      target: [{ handleType: 'Video', number: 0 }],
    },
  },

  // Data node - Audio
  {
    type: '1004',
    handles: {
      target: [{ handleType: 'Audio', number: 0 }],
    },
  },

  // Editor node - Video editor
  {
    type: '6001',
    handles: {
      source: [
        { handleType: 'Text', number: 0 },
        { handleType: 'Image', number: 0 },
        { handleType: 'Audio', number: 0 },
        { handleType: 'Video', number: 0 },
      ],
    },
  },
];

/** Default size for placing library nodes with visual center at the canvas pane center (`position` is top-left). */
const libraryNodeDefaultSize: Record<string, { w: number; h: number }> = {
  '1001': { w: 300, h: 160 },
  '1002': { w: 300, h: 250 },
  '1003': { w: 300, h: 250 },
  '1004': { w: 472, h: 200 },
  '6001': { w: 400, h: 300 },
};

function libraryTopLeftFromCanvasCenter(
  centerFlow: { x: number; y: number },
  nodeTypeKey: string,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const { w, h } = libraryNodeDefaultSize[nodeTypeKey] ?? { w: 300, h: 200 };
  return { x: centerFlow.x - w / 2 + offset.x, y: centerFlow.y - h / 2 + offset.y };
}

/** Icon component that rotates on hover */
const RotatingIcon = ({ icon }: { icon: string }) => {
  const [hover, setHover] = useState(false);

  return (
    <div
      className='flex justify-center items-center'
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

/** NodeLibraryPanel component */
const NodeLibraryPanel: React.FC = () => {
  const [nodeGroups, setNodeGroups] = useState<NodeGroupConfig[]>([]);
  const [templateMap, setTemplateMap] = useState<Map<string, NodeTemplateDetail>>(new Map());

  const { nodes } = useCanvasData();
  const { addNode } = useCanvasActions();
  const { nodeTemplateData, commentMode: canvasCommentMode, setCanvasCommentMode, closeCanvasCommentComposer } = useCanvasUI();
  const { screenToFlowPosition } = useReactFlow();

  const { t } = useTranslation();

  /** Upload action in node library sidebar: selects a file first, then creates the corresponding node type */
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const triggerUploadFromLibrary = () => {
    uploadInputRef.current?.click();
  };

  const handleUploadInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;

    const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const centerFlow = flowCenterFromCanvasPane(screenToFlowPosition, fallback);

    const maxZIndex = nodes.reduce((max, node) => {
      const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, zIndex);
    }, 0);

    const gap = 40;
    files.forEach((file, index) => {
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

      let node: Node;
      if (file.type.startsWith('image/')) {
        const nodeId = `1002-${timestamp}-${randomString}-${index}`;
        node = createImageNodeForUpload(position, nodeId, file);
      } else if (file.type.startsWith('video/')) {
        const nodeId = `1003-${timestamp}-${randomString}-${index}`;
        node = createVideoNodeForUpload(position, nodeId, file);
      } else if (file.type.startsWith('audio/')) {
        const nodeId = `1004-${timestamp}-${randomString}-${index}`;
        node = createAudioNodeForUpload(position, nodeId, file);
      } else {
        const nodeId = `1001-${timestamp}-${randomString}-${index}`;
        node = createTextNode(file.name, position, nodeId);
      }
      const nodeWithZ: Node & { zIndex?: number } = {
        ...node,
        zIndex: maxZIndex + 1 + index,
      };
      addNode(nodeWithZ);
    });
  };

  /** Rebuild menu items when template data changes */
  useEffect(() => {
    const map = new Map(
      (nodeTemplateData as NodeTemplateDetail[])
        .filter((item): item is NodeTemplateDetail => 'template_type' in item && !!item.template_type)
        .map((item) => [item.template_type!, item]),
    );
    setTemplateMap(map);

    const groups: NodeGroupConfig[] = [
      {
        id: 1,
        label: t('nodeLibraryPanel.data_nodes'),
        icon: 'nodeLibraryPanel-data-nodes',
        nodeTypes: ['1001', '1002', '1003', '1004'],
      },
      {
        id: 2,
        label: '',
        icon: 'nodeLibraryPanel-editing-page-sidebaricon',
        nodeTypes: [],
        size: 26,
      },
      {
        id: 3,
        label: '',
        icon: 'nodeLibraryPanel-editing-page-sidebaricon-1',
        nodeTypes: [],
        size: 24,
      },
      {
        id: 4,
        label: '',
        icon: 'nodeLibraryPanel-editing-page-sidebaricon-2',
        nodeTypes: [],
      },
    ];
    setNodeGroups(groups);
  }, [nodeTemplateData, t]);

  /** Build dropdown menu items for a node group */
  const buildDropdownItems = (group: NodeGroupConfig): MenuItemType[] => {
    const menuItems: MenuItemType[] = [
      {
        key: `group-${group.id}`,
        label: (
          <div className='text-xs font-bold leading-[12px] text-text-default-base px-[12px] pt-[8px] pb-[10px]'>
            {group.label}
          </div>
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
              <div className='flex items-center justify-start rounded-[3px] h-[38px] w-full min-w-0 px-[5px]'>
                <Icon
                  name={getNodeIconName(item.template_type || key)}
                  width={24}
                  height={24}
                  color='var(--bg-icon-Default-Default)'
                />
                <div className='flex flex-col ml-1 justify-center h-full w-full relative overflow-hidden'>
                  <span className='text-sm font-bold leading-[16px] text-text-default-base -translate-y-[8px]'>
                    {item.template_name || String(key)}
                  </span>
                  <span
                    className='
                        absolute top-[20px] left-0 translate-y-0
                        w-full
                        text-[10px] font-bold leading-[12px] text-text-default-tertiary
                      '
                  >
                    {getNodeSubtitle(item.template_type || key) ?? item?.content?.tips?.content ?? ''}
                  </span>
                </div>
              </div>
            ) as React.ReactNode,
          } as MenuItemType;
        })
        .filter((item): item is MenuItemType => item !== null),
    ];

    return menuItems;
  };

  /**
   * Get handle config by node type.
   * @param type Node type identifier
   * @returns Handles config containing source / target
   */
  const getNodeHandlesByType = (type: string) => {
    const config = nodeHandles.find((item) => item.type === type);
    return config?.handles ?? { source: [], target: [] };
  };

  /**
   * Menu item click handler
   * @param key Corresponds to template_type
   */
  const handleMenuClick = (key: string) => {
    if (key === 'action-upload') {
      triggerUploadFromLibrary();
      return;
    }
    if (key.startsWith('group-')) return;
    const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const centerFlow = flowCenterFromCanvasPane(screenToFlowPosition, fallback);
    const position = libraryTopLeftFromCanvasCenter(centerFlow, key);

    // Calculate current maximum zIndex
    const maxZIndex = nodes.reduce((max, node) => {
      const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, zIndex);
    }, 0);

    const timestamp = Date.now();
    const randomString = nanoid(5);
    const newNodeId = `${key}-${timestamp}-${randomString}`;
    const newNode: Node & { zIndex?: number } = {
      id: newNodeId,
      type: key,
      position,
      selected: true,
      zIndex: maxZIndex + 1,
      data: {
        handles: getNodeHandlesByType(key),
      },
    };
    addNode(newNode, { select: true });
  };

  /** Icon-only group click on the right. id=2 upload, id=3 toggles comment mode. */
  const handleIconGroupClick = (groupId: number) => {
    if (groupId === 2) {
      triggerUploadFromLibrary();
      return;
    }
    if (groupId === 3) {
      const next = !canvasCommentMode;
      setCanvasCommentMode(next);
      if (!next) {
        closeCanvasCommentComposer();
      }
    }
  };

  const dataGroup = nodeGroups.find((g) => g.id === 1);
  const iconGroups = nodeGroups.filter((g) => g.id !== 1);

  return (
    <div className='z-20 fixed left-3 top-[50%] -translate-y-1/2 pointer-events-auto'>
      {/* Hidden file input: used for the Upload action in the Agent Nodes menu */}
      <input ref={uploadInputRef} type='file' multiple className='hidden' onChange={handleUploadInputChange} />
      {nodeGroups.length > 0 && (
        <div
          className='
            bg-background-default-base
            node-library-panel-menu-container
            w-14 rounded-t-[8px] rounded-b-[28px] border-0 outline-0 px-2 pt-2 pb-6
            shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]
            flex flex-col gap-[10px]
          '
        >
          {/* First group: data node group with Dropdown */}
          {dataGroup && (
            <Dropdown
              key={dataGroup.id}
              items={buildDropdownItems(dataGroup)}
              onClick={handleMenuClick}
              trigger='hover'
              placement='right-start'
              popupClassName='w-[200px] p-[6px] rounded-[8px]'
              offset={20}
            >
              <div className='flex justify-center items-center w-[40px] h-[40px] cursor-pointer rounded-[4px]'>
                <RotatingIcon icon={dataGroup.icon as string} />
              </div>
            </Dropdown>
          )}

          {/* Remaining groups: icon-only buttons without Dropdown */}
          {iconGroups.map((group) => (
            <div
              key={group.id}
              className={`flex justify-center items-center w-[40px] h-[40px] cursor-pointer rounded-[4px] ${
                group.id === 3 && canvasCommentMode
                  ? 'bg-background-default-secondary'
                  : 'hover:bg-background-default-secondary'
              }`}
              onClick={() => handleIconGroupClick(group.id)}
            >
              <div className='flex justify-center w-full'>
                <div className='flex items-center justify-center rounded-[4px] h-[40px] w-[40px]'>
                  <Icon
                    name={group.icon as string}
                    width={group.size ?? 28}
                    height={group.size ?? 28}
                    color='var(--bg-icon-base)'
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(NodeLibraryPanel);
