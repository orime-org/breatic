/**
 * Group toolbar: canvas-layer Panel, shown when multi-select can be grouped or single-select is a group
 * Contains positioning + toolbar content (background color, group/ungroup, expand/collapse, layout)
 */
import React, { memo, useMemo, useState, useEffect } from 'react';
import { Panel, useReactFlow, useStore, type Node } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';
import { Icon } from '@/ui/icon';
import Dropdown from '@/ui/dropdown';
import Divider from '@/ui/divider';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';

const toolbarGap = 20;
const toolbarHeight = 40;
const groupPadding = 40;
const defaultGroupBackgroundColor = 'transparent';

const transparentCheckerStyle: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)',
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
  const { getViewport, getNodesBounds, getNodes } = useReactFlow();
  const { setNodes, updateNode } = useCanvasActions();
  const selectedNodes = useStore(selectedNodesSelector);

  const selection = useMemo(() => {
    const n = selectedNodes.length;
    if (n >= 2 && selectedNodes.every((node) => node.type !== 'group'))
      return { show: true, canGroup: true, isGroup: false, collapsed: false };
    if (n === 1 && selectedNodes[0].type === 'group') {
      const collapsed = (selectedNodes[0].data as { collapsed?: boolean })?.collapsed === true;
      return { show: true, canGroup: false, isGroup: true, collapsed };
    }
    return { show: false, canGroup: false, isGroup: false, collapsed: false };
  }, [selectedNodes]);

  const position = useMemo(() => {
    if (!selection.show || selectedNodes.length === 0) return null;
    try {
      const bounds = getNodesBounds(selectedNodes);
      const viewport = getViewport();
      const left = (bounds.x + bounds.width / 2) * viewport.zoom + viewport.x;
      const top = bounds.y * viewport.zoom + viewport.y - toolbarGap - toolbarHeight;
      return { left, top };
    } catch {
      return null;
    }
  }, [selection.show, selectedNodes, getViewport, getNodesBounds]);

  const [bgOpen, setBgOpen] = useState(false);
  const [displayBgColor, setDisplayBgColor] = useState<string>(defaultGroupBackgroundColor);

  const selectedGroupBg =
    selection.isGroup && selectedNodes.length === 1
      ? (selectedNodes[0].data as { backgroundColor?: string })?.backgroundColor
      : undefined;
  useEffect(() => {
    if (selectedGroupBg) setDisplayBgColor(selectedGroupBg);
  }, [selectedGroupBg]);

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

    const childNodes = selectedNodes.map((n) => ({
      ...n,
      parentId: groupId,
      position: { x: n.position.x - containerLeft, y: n.position.y - containerTop },
      selected: false,
    }));

    const restNodes = allNodes.filter((n) => !selectedIds.has(n.id)).map((n) => ({ ...n, selected: false }));

    setNodes([groupNode, ...childNodes, ...restNodes]);
  };

  const handleUngroup = () => {
    if (!selection.isGroup || selectedNodes.length !== 1) return;
    const group = selectedNodes[0];
    if (group.type !== 'group') return;
    const allNodes = getNodes();
    const containerLeft = group.position.x;
    const containerTop = group.position.y;

    const newNodes = allNodes
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

    setNodes(newNodes);
  };

  const handleBackgroundColor = (color: string) => {
    setDisplayBgColor(color);
    setBgOpen(false);
    if (selection.isGroup && selectedNodes.length === 1) {
      const group = selectedNodes[0];
      updateNode(group.id, { data: { ...group.data, backgroundColor: color } });
    }
  };

  const isLocked =
    selection.isGroup && selectedNodes.length === 1 && (selectedNodes[0].data as { locked?: boolean })?.locked === true;

  const handleLock = () => {
    if (!selection.isGroup || selectedNodes.length !== 1) return;
    const group = selectedNodes[0];
    const nextLocked = !(group.data as { locked?: boolean })?.locked;
    const allNodes = getNodes();
    updateNode(group.id, { data: { ...group.data, locked: nextLocked }, draggable: !nextLocked });
    allNodes.forEach((node) => {
      if (node.parentId === group.id) {
        updateNode(node.id, { draggable: !nextLocked });
      }
    });
  };

  if (!selection.show || !position) return null;

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
                    onClick={() => handleBackgroundColor(value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleBackgroundColor(value)}
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

        {(selection.canGroup || selection.isGroup) && (
          <button
            type='button'
            disabled={selection.isGroup && isLocked}
            className='h-7 px-2 flex items-center gap-1.5 rounded-[4px] cursor-pointer enabled:hover:bg-background-default-base-hover disabled:opacity-50 disabled:cursor-not-allowed'
            title={selection.canGroup ? t('project.toolbar.group', 'Group') : t('project.toolbar.ungroup', 'Ungroup')}
            onClick={selection.canGroup ? handleGroup : isLocked ? undefined : handleUngroup}
          >
            <Icon
              name={selection.canGroup ? 'project-group-icon' : 'project-ungroup-icon'}
              width={16}
              height={16}
              color='var(--color-icon-secondary)'
            />
            <span className='text-[12px] font-medium text-text-default-base whitespace-nowrap'>
              {selection.canGroup ? t('project.toolbar.group', 'Group') : 'Ungroup'}
            </span>
          </button>
        )}

        {selection.isGroup && (
          <>
            <Divider type='vertical' className='h-[18px] mx-1 flex-shrink-0' />
            <button
              type='button'
              className='cursor-pointer h-7 px-2 flex items-center gap-1.5 rounded-[4px] hover:bg-background-default-base-hover'
              title={isLocked ? t('project.toolbar.unlock', 'Unlock') : t('project.toolbar.lock', 'Lock')}
              onClick={handleLock}
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
          </>
        )}
      </div>
    </Panel>
  );
};

export default memo(GroupToolbarPanel);
