import React, { useEffect, useState } from 'react';
import Loading from '@/components/loading/Loading';

interface LeftHistoryPanelProps {
  historyList: string[];
  activeIndex: number;
  onSelect: (index: number, src: string) => void;
}

const LeftHistoryPanel: React.FC<LeftHistoryPanelProps> = ({
  historyList,
  activeIndex,
  onSelect,
}) => {
  const [loadedMap, setLoadedMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLoadedMap((prev) => {
      const next: Record<string, boolean> = {};
      historyList.forEach((src) => {
        next[src] = prev[src] ?? false;
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
    <div className='flex h-full min-h-0 flex-col overflow-hidden bg-background-default-secondary p-3 pt-[50px]'>
      <div className='h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden -mr-3 pr-3'>
        <div className='space-y-3'>
          {historyList.map((thumb, idx) => (
            <button
              key={`${thumb}-${idx}`}
              type='button'
              className={`relative box-border block w-full overflow-hidden rounded-lg border p-0 leading-none transition-all ${
                activeIndex === idx
                  ? 'border-[#52c46b] ring-2 ring-[#c4ebcd]'
                  : 'border-[#e5e7eb] hover:border-[#cfd4dd]'
              }`}
              onClick={() => onSelect(idx, thumb)}
            >
              {!loadedMap[thumb] && (
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
              <img
                src={thumb}
                alt={`history-${idx}`}
                className={`block w-full align-top transition-opacity ${
                  loadedMap[thumb] ? 'h-auto opacity-100' : 'h-[150px] object-cover opacity-0'
                }`}
                onLoad={() => markLoaded(thumb)}
                onError={() => markLoaded(thumb)}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default LeftHistoryPanel;
