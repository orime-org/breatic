// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { MODALITY_ICONS } from '@web/spaces/canvas/nodes/_shared/modality';
import type { Modality } from '@web/spaces/canvas/types/node-view';

interface NodePlaceholderProps {
  modality: Modality;
  /** Optional override (e.g. "Generating cover…" while AI runs). */
  hint?: string;
  /** Click handler for the call-to-action (typically opens generate popover). */
  onActivate?: () => void;
}

const DEFAULT_HINT: Record<Modality, string> = {
  text: 'Double-click to write or generate text',
  image: 'Double-click to upload or generate an image',
  audio: 'Double-click to upload or generate audio',
  video: 'Double-click to upload or generate a video',
  '3d': 'Double-click to upload a 3D model (glb / gltf)',
  web: 'Double-click to embed a web page URL',
};

/**
 * Empty-state body shown when a content node has no `content` / `url`
 * yet. Acts as the entry to the toolbar's left-zone generate/load
 * popover (double-click → `onActivate`).
 * @param root0 - Node placeholder props.
 * @param root0.modality - Node modality, selecting the icon and the default hint copy.
 * @param root0.hint - Optional hint text overriding the modality default.
 * @param root0.onActivate - Called on click / double-click to open the generate/load popover.
 * @returns The empty-state call-to-action button.
 */
export function NodePlaceholder({
  modality,
  hint,
  onActivate,
}: NodePlaceholderProps): React.JSX.Element {
  const Icon = MODALITY_ICONS[modality];
  return (
    <button
      type='button'
      onDoubleClick={onActivate}
      onClick={onActivate}
      data-testid='node-placeholder'
      data-modality={modality}
      className='flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground hover:bg-accent'
    >
      <Icon className='h-5 w-5 opacity-70' aria-hidden='true' />
      <span className='text-xs'>{hint ?? DEFAULT_HINT[modality]}</span>
    </button>
  );
}
