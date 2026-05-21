import {
  Box,
  FileText,
  Globe,
  Image as ImageIcon,
  Music,
  Video,
} from 'lucide-react';

import type { Modality } from '@/spaces/canvas/types/node';

interface NodePlaceholderProps {
  modality: Modality;
  /** Optional override (e.g. "Generating cover…" while AI runs). */
  hint?: string;
  /** Click handler for the call-to-action (typically opens generate popover). */
  onActivate?: () => void;
}

const ICONS: Record<Modality, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: Music,
  video: Video,
  '3d': Box,
  web: Globe,
};

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
 */
export function NodePlaceholder({
  modality,
  hint,
  onActivate,
}: NodePlaceholderProps) {
  const Icon = ICONS[modality];
  return (
    <button
      type='button'
      onDoubleClick={onActivate}
      onClick={onActivate}
      data-testid='node-placeholder'
      data-modality={modality}
      className='flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground hover:bg-muted'
    >
      <Icon className='h-5 w-5 opacity-70' aria-hidden='true' />
      <span className='text-xs'>{hint ?? DEFAULT_HINT[modality]}</span>
    </button>
  );
}
