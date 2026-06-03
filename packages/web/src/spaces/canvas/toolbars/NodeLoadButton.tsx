// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Upload } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import type { Modality } from '@web/spaces/canvas/types/node';

interface NodeLoadButtonProps {
  modality: Modality;
  onLoad?: (file: File) => void;
}

const ACCEPT: Record<Modality, string> = {
  text: '.txt,.md',
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
  '3d': '.glb,.gltf,.usdz',
  web: '',
};

/**
 * Left-zone "Load" entry on the node toolbar. Opens a hidden file picker
 * filtered by the node's modality and hands the chosen file to the
 * caller, which replaces the CURRENT node's content payload.
 * @param root0 - Load button props.
 * @param root0.modality - Active node's modality, selecting the file picker `accept` filter.
 * @param root0.onLoad - Called with the chosen file to replace the current node's content.
 * @returns The load trigger button plus its hidden file input.
 */
export function NodeLoadButton({
  modality,
  onLoad,
}: NodeLoadButtonProps): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement>(null);

  /**
   * Forwards the first selected file to `onLoad` and resets the input so
   * re-selecting the same file fires `change` again.
   * @param e - The file input change event.
   */
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
