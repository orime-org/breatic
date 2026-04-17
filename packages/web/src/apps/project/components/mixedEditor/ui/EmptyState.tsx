import React, { memo } from 'react';
import { Icon } from '@/components/base/icon';

const EmptyState: React.FC = () => (
  <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5'>
    <Icon name='project-image-editor-palette-icon' width={34} height={34} color='#B3B3B3' />
    <p className='text-3xl text-zinc-500 text-center'>
      Your creations will
      <br />
      appear here
    </p>
    <p className='text-base text-zinc-400'>
      Generate assets with AI or upload your own
    </p>
  </div>
);

export default memo(EmptyState);
