import React from 'react';
import { Icon } from '@/ui/icon';
import Tooltip from '@/ui/tooltip';
import type { VideoEditorToolKey } from '../../type';

interface RightToolPanelProps {
  activeTool: VideoEditorToolKey | null;
  onSelect: (tool: VideoEditorToolKey) => void;
}

const tools: Array<{ key: VideoEditorToolKey; label: string; icon: string; width: number; height: number }> = [
  { key: 'quick-edit', label: 'Quick Edit', icon: 'project-excalidraw-top-quick-edit-icon', width: 18, height: 18 },
  { key: 'cut', label: 'Cut', icon: 'videoNode-cut', width: 16, height: 16 },
  { key: 'speed', label: 'Speed', icon: 'videoNode-speed', width: 16, height: 16 },
  { key: 'upscale', label: 'Upscale', icon: 'videoNode-upscale-hd', width: 18, height: 15 },
  { key: 'interpolate', label: 'Interpolate', icon: 'videoNode-interpolate', width: 16, height: 16 },
  { key: 'erase', label: 'Erase', icon: 'videoNode-erase', width: 18, height: 18 },
  { key: 'extend', label: 'Extend', icon: 'videoNode-extend', width: 16, height: 16 },
  { key: 'animate', label: 'Animate', icon: 'videoNode-animate', width: 16, height: 16 },
  { key: 'adjust', label: 'Adjust', icon: 'videoNode-adjust', width: 16, height: 16 },
  { key: 'stabilization', label: 'Stabilization', icon: 'videoNode-stabilization', width: 16, height: 16 },
  { key: 'crop', label: 'Crop', icon: 'videoNode-crop', width: 16, height: 16 },
  { key: 'hdr-conversion', label: 'HDR Conversion', icon: 'videoNode-hdr-conversion', width: 16, height: 16 },
  { key: 'cutout', label: 'Cutout', icon: 'videoNode-cutout', width: 17, height: 17 },
  { key: 'scene-extension', label: 'Scene Extension', icon: 'videoNode-scene-extension', width: 16, height: 16 },
  { key: 'audio-denoise', label: 'Audio Denoise', icon: 'videoNode-audio-denoise', width: 16, height: 16 },
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
          <Icon name={tool.icon} width={tool.width} height={tool.height} color='var(--color-icon-base)' />
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
