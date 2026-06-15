// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Box,
  FileText,
  Globe,
  Image as ImageIcon,
  Music,
  Video,
  X,
} from 'lucide-react';
import type * as React from 'react';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import type { Modality } from '@web/spaces/canvas/types/node-view';

export interface ReferenceChipProps {
  modality: Modality;
  /** Short label used for display (e.g. truncated text snippet or filename). */
  label: string;
  /** Optional remove handler — clicking the ✕ unlinks the reference. */
  onRemove?: () => void;
}

const ICONS: Record<Modality, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: Music,
  video: Video,
  '3d': Box,
  web: Globe,
};

/**
 * Compact chip that represents one `@`-style reference attached to a
 * node's prompt context. Driven by the canvas's edge graph + the snapshot
 * payload — NOT a node type. The picker that produces these lives in
 * `ReferencePicker.tsx`.
 * @param root0 - Reference chip props.
 * @param root0.modality - Referenced node's modality, selecting the leading icon.
 * @param root0.label - Short display label (truncated text snippet or filename).
 * @param root0.onRemove - Optional handler; when present, renders a ✕ that unlinks the reference.
 * @returns The reference chip badge element.
 */
export function ReferenceChip({
  modality,
  label,
  onRemove,
}: ReferenceChipProps): React.JSX.Element {
  const Icon = ICONS[modality];
  return (
    <Badge
      variant='secondary'
      className='inline-flex max-w-[10rem] items-center gap-1 pl-1 pr-0.5'
      data-testid='reference-chip'
      data-modality={modality}
    >
      <Icon className='h-3 w-3 shrink-0 opacity-70' aria-hidden='true' />
      <span className='truncate'>{label}</span>
      {onRemove ? (
        <Button
          variant='ghost'
          size='icon'
          className='ml-0.5 h-4 w-4'
          aria-label='Remove reference'
          onClick={onRemove}
          data-testid='reference-chip-remove'
        >
          <X className='h-3 w-3' />
        </Button>
      ) : null}
    </Badge>
  );
}
