import React, { useEffect, useState } from 'react';
import Loading from '@/components/loading/Loading';

export type VideoHistoryItem = {
  id: string;
  src: string;
  status: 'done' | 'loading' | 'failed';
  errorMessage?: string;
};

interface LeftHistoryPanelProps {
  historyList: VideoHistoryItem[];
  activeIndex: number;
  hostHistoryId: string | null;
  onSelect: (index: number, item: VideoHistoryItem) => void;
  onRetry?: (index: number, item: VideoHistoryItem) => void;
}

const LeftHistoryPanel: React.FC<LeftHistoryPanelProps> = ({
  historyList,
  activeIndex,
  hostHistoryId,
  onSelect,
  onRetry,
}) => {
  const [loadedMap, setLoadedMap] = useState<Record<string, boolean>>({});
  const [brokenThumbMap, setBrokenThumbMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLoadedMap((prev) => {
      const next: Record<string, boolean> = {};
      historyList.forEach(({ src }) => {
        next[src] = prev[src] ?? false;
      });
      return next;
    });
  }, [historyList]);

  useEffect(() => {
    setBrokenThumbMap((prev) => {
      const next: Record<string, boolean> = {};
      historyList.forEach(({ id }) => {
        next[id] = prev[id] ?? false;
      });
      return next;
    });
  }, [historyList]);

  const markLoaded = (src: string) => {
    setLoadedMap((prev) => {
      if (prev[src]) return prev;
      return { ...prev, [src]: true };
    });
  };

  return (
    <div className='flex h-full min-h-0 flex-col overflow-hidden bg-background-default-secondary p-3 pt-10'>
      <div className='h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden -mr-3 pr-3'>
        <div className='space-y-3'>
          {historyList.map((item, idx) => {
            const showFailedCard = item.status === 'failed' || brokenThumbMap[item.id] || !item.src;
            return (
              <button
                key={item.id}
                type='button'
                className={`relative box-border block w-full overflow-hidden rounded-lg border p-0 leading-none transition-all ${
                  activeIndex === idx
                    ? 'border-[#52c46b] ring-2 ring-[#c4ebcd]'
                    : 'border-[#e5e7eb] hover:border-[#cfd4dd]'
                }`}
                onClick={() => onSelect(idx, item)}
              >
                {item.status === 'loading' && (
                  <div className='absolute inset-0 z-10'>
                    <Loading
                      inline
                      width='100%'
                      height='100%'
                      scale={0.05}
                      backgroundColor='rgba(247, 248, 250, 0.9)'
                    />
                  </div>
                )}
                {showFailedCard ? (
                  <div className='flex h-[150px] w-full flex-col items-center justify-center gap-1 bg-[#fee2e2] text-[#b91c1c]'>
                    <span className='text-lg font-bold'>!</span>
                    <span className='px-2 text-center text-[11px] leading-4'>
                      {item.errorMessage ?? 'Generation failed'}
                    </span>
                  </div>
                ) : (
                  <video
                    src={item.src}
                    muted
                    playsInline
                    preload='metadata'
                    className={`block w-full align-top transition-opacity ${
                      loadedMap[item.src] ? 'h-auto opacity-100' : 'h-[150px] object-cover opacity-0'
                    }`}
                    onLoadedData={(event) => {
                      // Keep history thumbnail pinned to the first frame.
                      event.currentTarget.pause();
                      markLoaded(item.src);
                    }}
                    onError={() => {
                      markLoaded(item.src);
                      setBrokenThumbMap((prev) => ({ ...prev, [item.id]: true }));
                    }}
                  />
                )}
                {showFailedCard && onRetry && (
                  <button
                    type='button'
                    className='absolute bottom-1 left-1 z-20 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-[#b91c1c] hover:bg-white'
                    onClick={(event) => {
                      event.stopPropagation();
                      onRetry(idx, item);
                    }}
                  >
                    Retry
                  </button>
                )}
                {hostHistoryId != null && item.id === hostHistoryId && (
                  <span
                    className='absolute bottom-1 right-1 inline-flex h-3 w-3 items-center justify-center rounded-full border border-white bg-[#2563eb]'
                    title='Current node content'
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default LeftHistoryPanel;
