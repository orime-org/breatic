import React, { memo, useState, useEffect } from 'react';
import { Panel, useReactFlow, useStore, type Node } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';
import { Icon } from '@/components/base/icon';
import Dropdown from '@/components/base/dropdown';
import Divider from '@/components/base/divider';
import { useMixedEditorActions } from '@/hooks/useMixedEditorActions';
import type { ImageFlowNodeData } from '../types';
import { imageEditorImageNodeType } from '../types';

const toolbarGap = 20;
const toolbarHeight = 40;
const groupPadding = 40;
const defaultGroupBackgroundColor = 'rgba(12, 12, 13, 0.1)';

const transparentCheckerStyle: React.CSSProperties = {
  backgroundImage: 'linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)',
  backgroundSize: '6px 6px',
  backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0px',
  backgroundColor: '#fff',
};

const backgroundColorOptions: { value: string }[] = [
  { value: 'transparent' },
  { value: 'rgba(12, 12, 13, 0.1)' },
  { value: 'rgba(255, 214, 0, 0.2)' },
  { value: 'rgba(255, 146, 48, 0.2)' },
  { value: 'rgba(255, 55, 95, 0.2)' },
  { value: 'rgba(219, 52, 242, 0.2)' },
  { value: 'rgba(109, 124, 255, 0.2)' },
  { value: 'rgba(0, 218, 195, 0.2)' },
  { value: 'rgba(48, 209, 88, 0.2)' },
];

const selectedNodesSelector = (state: { nodes: Node[] }) => state.nodes.filter((n) => n.selected);
const GroupToolbarPanel: React.FC = () => {
  const { t } = useTranslation();
  const { getNodesBounds, getNodes } = useReactFlow();
  const { updateNode, setNodes } = useMixedEditorActions();
  const selectedNodes = useStore(selectedNodesSelector);
  const nodes = useStore((state) => state.nodes);
  const transform = useStore((state) => state.transform);

  const n = selectedNodes.length;
  const canGroup = n >= 2 && selectedNodes.every((node) => node.type !== 'group');
  let group: Node | null = null;
  if (n === 1 && selectedNodes[0].type === 'group') {
    group = selectedNodes[0];
  }

  const selection = group
    ? { show: true, isGroup: true, canGroup: false, collapsed: (group.data as { collapsed?: boolean })?.collapsed === true }
    : canGroup
      ? { show: true, isGroup: false, canGroup: true, collapsed: false }
      : { show: false, isGroup: false, canGroup: false, collapsed: false };

  let position: { left: number; top: number } | null = null;
  if (selection.show) {
    try {
      const targets = selection.isGroup && group ? [group] : selectedNodes;
      const bounds = getNodesBounds(targets);
      const x = transform[0] ?? 0;
      const y = transform[1] ?? 0;
      const zoom = transform[2] ?? 1;
      const left = (bounds.x + bounds.width / 2) * zoom + x;
      const top = bounds.y * zoom + y - toolbarGap - toolbarHeight;
      position = { left, top };
    } catch {
      position = null;
    }
  }

  const [bgOpen, setBgOpen] = useState(false);
  const [displayBgColor, setDisplayBgColor] = useState<string>(defaultGroupBackgroundColor);

  const selectedGroupBg =
    selection.isGroup && group ? (group.data as { backgroundColor?: string })?.backgroundColor : undefined;

  useEffect(() => {
    if (selectedGroupBg) setDisplayBgColor(selectedGroupBg);
  }, [selectedGroupBg]);

  const isLocked = selection.isGroup && group ? (group.data as { locked?: boolean })?.locked === true : false;

  const handleGroup = () => {
    if (!selection.canGroup || selectedNodes.length < 2) return;
    const allNodes = getNodes();
    const selectedIds = new Set(selectedNodes.map((n) => n.id));
    const bounds = getNodesBounds(selectedNodes);
    const groupId = `group-${nanoid(8)}`;

    const containerLeft = bounds.x - groupPadding;
    const containerTop = bounds.y - groupPadding;
    const containerWidth = bounds.width + groupPadding * 2;
    const containerHeight = bounds.height + groupPadding * 2;

    const groupNode: Node = {
      id: groupId,
      type: 'group',
      position: { x: containerLeft, y: containerTop },
      style: { width: containerWidth, height: containerHeight, border: 0, boxShadow: 'none' },
      data: { collapsed: false, backgroundColor: displayBgColor },
      selected: true,
    };

    // Children's positions become group-local (relative to container origin).
    const childNodes = selectedNodes.map((n) => ({
      ...n,
      parentId: groupId,
      position: { x: n.position.x - containerLeft, y: n.position.y - containerTop },
      selected: false,
    }));

    const restNodes = allNodes
      .filter((n) => !selectedIds.has(n.id))
      .map((n) => ({ ...n, selected: false }));

    // Single atomic setNodes — Yjs transact + UndoManager records this
    // as one undoable step (parity with main canvas GroupToolbarPanel).
    setNodes([groupNode, ...childNodes, ...restNodes]);
  };

  const handleUngroup = () => {
    if (!group || group.type !== 'group' || isLocked) return;
    const all = getNodes();
    const containerLeft = group.position.x;
    const containerTop = group.position.y;

    const nextNodes = all
      .filter((n) => n.id !== group.id)
      .map((n) => {
        if (n.parentId !== group.id) return { ...n, selected: false };
        const { parentId, extent, ...rest } = n;
        void parentId;
        void extent;
        return {
          ...rest,
          position: { x: n.position.x + containerLeft, y: n.position.y + containerTop },
          selected: false,
        };
      });

    setNodes(nextNodes);
  };

  if (!selection.show || !position) return null;

  // Multi-select (≥2 non-group nodes): only the Group button.
  if (selection.canGroup) {
    return (
      <Panel
        position='top-left'
        style={{
          left: position.left,
          top: position.top,
          display: 'inline-block',
          transform: 'translateX(-50%)',
          margin: 0,
        }}
      >
        <div
          className='flex items-center gap-[2px] h-[40px] min-h-[40px] p-[6px] bg-background-default-base rounded-[8px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] pointer-events-auto'
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type='button'
            className='cursor-pointer h-7 px-2 flex items-center gap-1.5 rounded-[4px] hover:bg-background-default-base-hover'
            title={t('project.toolbar.group', 'Group')}
            onClick={handleGroup}
          >
            <Icon name='project-group-icon' width={16} height={16} color='var(--color-icon-secondary)' />
            <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>
              {t('project.toolbar.group', 'Group')}
            </span>
          </button>
        </div>
      </Panel>
    );
  }

  // From here on we know it's a single-group selection.
  if (!group) return null;

  // Hide the panel while any image child is still loading content
  // (legacy guard kept for parity — handling-busy itself is enforced
  // upstream in `removeNode` / `onNodesChange` via `isFlowNodeBusy`).
  const hasLoadingImageChildInGroup = nodes.some((n) => {
    if (n.parentId !== group.id || n.type !== imageEditorImageNodeType) return false;
    const d = n.data as ImageFlowNodeData;
    const legacy = (n.data as unknown as { src?: string }).src;
    return !String(d.content ?? legacy ?? '').trim();
  });
  if (hasLoadingImageChildInGroup) return null;

  return (
    <Panel
      position='top-left'
      style={{
        left: position.left,
        top: position.top,
        display: 'inline-block',
        transform: 'translateX(-50%)',
        margin: 0,
      }}
    >
      <div
        className='flex items-center gap-[2px] h-[40px] min-h-[40px] p-[6px] bg-background-default-base rounded-[8px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] pointer-events-auto'
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <Dropdown
          trigger='click'
          placement='bottom-start'
          offset={15}
          open={bgOpen && !isLocked}
          onOpenChange={(open) => !isLocked && setBgOpen(open)}
          items={[]}
          popupRender={() => (
            <div className='px-2 py-4 bg-[var(--color-background-default-base)] rounded-full shadow-lg'>
              <div className='flex flex-col gap-[2px]'>
                {backgroundColorOptions.map(({ value }) => (
                  <div
                    key={value}
                    role='button'
                    tabIndex={0}
                    className='p-1 flex items-center justify-center w-full rounded-[2px] py-1.5 cursor-pointer'
                    onClick={() => {
                      setDisplayBgColor(value);
                      setBgOpen(false);
                      updateNode(group.id, { data: { ...group.data, backgroundColor: value } });
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      setDisplayBgColor(value);
                      setBgOpen(false);
                      updateNode(group.id, { data: { ...group.data, backgroundColor: value } });
                    }}
                  >
                    <span
                      className='w-5 h-5 rounded-full border border-[var(--color-border-default-base)] shrink-0 transition-transform hover:scale-110'
                      style={value === 'transparent' ? transparentCheckerStyle : { backgroundColor: value }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        >
          <button
            type='button'
            disabled={isLocked}
            className='h-7 px-2 flex items-center gap-1.5 rounded-[4px] cursor-pointer enabled:hover:bg-background-default-base-hover disabled:opacity-50 disabled:cursor-not-allowed'
            title={t('project.toolbar.backgroundColor', 'Background Color')}
          >
            <span
              className='w-5 h-5 rounded-full border border-[var(--color-border-default-base)] shrink-0'
              style={displayBgColor === 'transparent' ? transparentCheckerStyle : { backgroundColor: displayBgColor }}
            />
            <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>Background Color</span>
          </button>
        </Dropdown>
        <Divider type='vertical' className='h-[18px] mx-1 flex-shrink-0' />
        <button
          type='button'
          disabled={isLocked}
          className='cursor-pointer h-7 px-2 flex items-center gap-1.5 rounded-[4px] enabled:hover:bg-background-default-base-hover disabled:opacity-50 disabled:cursor-not-allowed'
          title={t('project.toolbar.ungroup', 'Ungroup')}
          onClick={handleUngroup}
        >
          <Icon name='project-ungroup-icon' width={16} height={16} color='var(--color-icon-secondary)' />
          <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>Ungroup</span>
        </button>
        <button
          type='button'
          disabled={isLocked}
          className='cursor-pointer h-7 px-2 flex items-center gap-1.5 rounded-[4px] enabled:hover:bg-background-default-base-hover disabled:opacity-50 disabled:cursor-not-allowed'
          title='Send to Create Area'
          onClick={() => {
            // TODO: wire actual "create area" action when API/store is ready.
          }}
        >
          <Icon
            name='project-chat-generated-add-to-input-icon'
            width={14}
            height={12}
            color='var(--color-icon-secondary)'
          />
          <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>Send to Create Area</span>
        </button>
        <Divider type='vertical' className='h-[18px] mx-1 flex-shrink-0' />
        <button
          type='button'
          className='cursor-pointer h-7 px-2 flex items-center gap-1.5 rounded-[4px] hover:bg-background-default-base-hover'
          title={isLocked ? t('project.toolbar.unlock', 'Unlock') : t('project.toolbar.lock', 'Lock')}
          onClick={() => {
            const nextLocked = !(group.data as { locked?: boolean })?.locked;
            updateNode(group.id, { data: { ...group.data, locked: nextLocked }, draggable: !nextLocked });
          }}
        >
          <Icon
            name={isLocked ? 'project-lock-icon' : 'project-unlock-icon'}
            width={16}
            height={16}
            color='var(--color-icon-secondary)'
          />
          <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>
            {isLocked ? 'Lock' : 'Unlock'}
          </span>
        </button>
      </div>
    </Panel>
  );
};

export default memo(GroupToolbarPanel);
