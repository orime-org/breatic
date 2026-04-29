import React from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import type { VideoEditorToolKey } from '../../type';

interface RightToolPanelProps {
  activeTool: VideoEditorToolKey | null;
  onSelect: (tool: VideoEditorToolKey) => void;
}

const tools: Array<{ key: VideoEditorToolKey; label: string; icon: string }> = [
  { key: 'quick-edit', label: 'Quick Edit', icon: 'project-excalidraw-top-quick-edit-icon' },
  { key: 'cut', label: 'Cut', icon: 'videoNode-cut' },
  { key: 'speed', label: 'Speed', icon: 'videoNode-speed' },
  { key: 'upscale', label: 'Upscale', icon: 'videoNode-upscale-hd' },
  { key: 'interpolate', label: 'Interpolate', icon: 'videoNode-interpolate' },
  { key: 'erase', label: 'Erase', icon: 'videoNode-erase' },
  { key: 'extend', label: 'Extend', icon: 'videoNode-extend' },
  { key: 'animate', label: 'Animate', icon: 'videoNode-animate' },
  { key: 'adjust', label: 'Adjust', icon: 'videoNode-adjust' },
  { key: 'stabilization', label: 'Stabilization', icon: 'videoNode-stabilization' },
  { key: 'crop', label: 'Crop', icon: 'videoNode-crop' },
  { key: 'hdr-conversion', label: 'HDR Conversion', icon: 'videoNode-hdr-conversion' },
  { key: 'cutout', label: 'Cutout', icon: 'videoNode-cutout' },
  { key: 'scene-extension', label: 'Scene Extension', icon: 'videoNode-scene-extension' },
  { key: 'audio-denoise', label: 'Audio Denoise', icon: 'videoNode-audio-denoise' },
];

const RightToolPanel: React.FC<RightToolPanelProps> = ({ activeTool, onSelect }) => {
  const mainTools: VideoEditorToolKey[] = ['quick-edit', 'cut', 'speed', 'upscale', 'interpolate', 'erase', 'extend'];
  const advancedTools: VideoEditorToolKey[] = [
    'animate',
    'adjust',
    'stabilization',
    'crop',
    'hdr-conversion',
    'cutout',
    'scene-extension',
    'audio-denoise',
  ];

  const renderToolButton = (tool: (typeof tools)[number]) => {
    const active = activeTool === tool.key;
    return (
      <Tooltip key={tool.key} title={tool.label} placement='left' offset={6}>
        <button
          type='button'
          onClick={() => onSelect(tool.key)}
          className={`my-1 flex h-10 w-10 items-center justify-center rounded-lg border transition-colors ${
            active
              ? 'border-[#a7dfb4] bg-[#eef9f0]'
              : 'border-transparent hover:border-[#e3e6ec] hover:bg-[#f1f3f7]'
          }`}
        >
          <span className='flex h-5 w-5 items-center justify-center'>
            <Icon name={tool.icon} width={16} height={16} color='var(--color-icon-base)' />
          </span>
        </button>
      </Tooltip>
    );
  };

  return (
    <div className='flex h-full flex-col items-center bg-background-default-secondary py-2'>
      {tools.filter((tool) => mainTools.includes(tool.key)).map(renderToolButton)}
      <div className='my-1 h-px w-8 bg-[#e6e8ec]' />
      {tools.filter((tool) => advancedTools.includes(tool.key)).map(renderToolButton)}
    </div>
  );
};

export default RightToolPanel;
