import { Upload } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import type { Modality } from '@/spaces/canvas/types/node';

interface NodeLoadButtonProps {
  modality: Modality;
  onLoad?: (file: File) => void;
}

const ACCEPT: Record<Modality, string> = {
  text: '.txt,.md',
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
};

/**
 * Left-zone "Load" entry on the node toolbar. Opens a hidden file picker
 * filtered by the node's modality and hands the chosen file to the
 * caller, which replaces the CURRENT node's content payload.
 */
export function NodeLoadButton({ modality, onLoad }: NodeLoadButtonProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const onChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    if (file) onLoad?.(file);
    e.target.value = '';
  };

  return (
    <>
      <Button
        variant='ghost'
        size='sm'
        className='h-7 gap-1 px-2'
        onClick={() => inputRef.current?.click()}
        data-testid='node-load-trigger'
      >
        <Upload className='h-3.5 w-3.5' />
        <span className='text-xs'>Load</span>
      </Button>
      <input
        ref={inputRef}
        type='file'
        accept={ACCEPT[modality]}
        onChange={onChange}
        data-testid='node-load-input'
        className='hidden'
      />
    </>
  );
}
