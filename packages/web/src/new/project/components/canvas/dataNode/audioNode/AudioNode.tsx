/**
 * Local audio node (type `1004`) — layout aligned with main canvas `AudioNode.tsx` (no top `NodeToolbar`).
 */
import { memo, useCallback, useRef, useState } from 'react';
import { Position, useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import CanvasOutputPendingProgressOverlay from '../../common/CanvasOutputPendingProgressOverlay';
import type { LocalCanvasNodeData } from '@/new/project/types';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import LocalNodeSkeleton, { zoomLevelShowContentSelector } from '../../common/LocalNodeSkeleton';
import CanvasAudioWaveform from '../../common/CanvasAudioWaveform';

const targetHandleId = 'Audio_0_0';
const sourceHandleId = 'Audio_0_0';

const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

const AudioNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected }) => {
  const { t } = useTranslation();
  const { setNodes } = useReactFlow();
  const showContent = useStore(zoomLevelShowContentSelector);
  const title = data.name?.trim() ? data.name : 'Audio';
  const url = data.url?.trim() ?? '';
  const [nodeHovered, setNodeHovered] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePlaceholderClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
    },
    [id, setNodes],
  );

  const handlePlaceholderDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const resourceUrl = URL.createObjectURL(file);
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          return { ...n, data: { ...prev, url: resourceUrl } };
        }),
      );
    },
    [id, setNodes],
  );

  return (
    <div className='relative w-0 min-w-0' style={{ width: defaultNodeWidth, height: defaultNodeHeight }}>
      <input
        ref={fileInputRef}
        type='file'
        accept='.mp3,.ogg,.wav,.webm'
        className='hidden'
        aria-hidden
        onChange={handleFileChange}
      />
      <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
        <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
      </div>
      <div
        className={
          'relative flex flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
          (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
        }
        style={{ width: defaultNodeWidth, height: defaultNodeHeight }}
        onMouseEnter={() => setNodeHovered(true)}
        onMouseLeave={() => setNodeHovered(false)}
      >
        <LocalDataNodeHandle
          type='target'
          position={Position.Left}
          handleId={targetHandleId}
          nodeId={id}
          selected={selected}
          nodeHovered={nodeHovered}
          isInsideLockedGroup={false}
        />
        <LocalDataNodeHandle
          type='source'
          position={Position.Right}
          handleId={sourceHandleId}
          nodeId={id}
          selected={selected}
          nodeHovered={nodeHovered}
          isInsideLockedGroup={false}
        />
        <div className='flex h-full w-full flex-1 items-center justify-center overflow-hidden px-3 pb-2 pt-1'>
          {!url ? (
            <div className='flex h-full w-full min-h-0 items-center justify-center overflow-hidden rounded-[8px]'>
              <div
                className='flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2'
                onClick={handlePlaceholderClick}
                onDoubleClick={handlePlaceholderDoubleClick}
              >
                <Icon name='project-audio-node-placeholder' width={32} height={42} className='text-text-default-tertiary' />
                <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                  {t('project.toolbar.audioNodePlaceholder')
                    .split('\n')
                    .map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                </div>
              </div>
            </div>
          ) : !showContent ? (
            <LocalNodeSkeleton />
          ) : (
            <div className='w-full max-w-full'>
              <CanvasAudioWaveform key={url} src={url} showControls />
            </div>
          )}
        </div>
        {data.localOutputPending ? <CanvasOutputPendingProgressOverlay /> : null}
      </div>
    </div>
  );
};

export default memo(AudioNode);
