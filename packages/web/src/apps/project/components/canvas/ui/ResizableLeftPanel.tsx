import React, { memo } from 'react';

export type ResizableLeftPanelProps = Record<string, never>;

const ResizableLeftPanel: React.FC<ResizableLeftPanelProps> = () => {
  return <div className='h-full w-full min-h-0 overflow-auto bg-background-default-secondary'></div>;
};

export default memo(ResizableLeftPanel);
