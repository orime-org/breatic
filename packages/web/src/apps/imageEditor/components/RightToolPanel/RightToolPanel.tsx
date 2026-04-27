import React from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';

export type ImageEditorToolMode =
  | 'inpaint'
  | 'mark'
  | 'graffiti'
  | 'adjust'
  | 'crop'
  | 'flip-rotate'
  | 'quick-edit'
  | 'erase'
  | 'cutout'
  | 'upscale'
  | 'expand'
  | 'grid-slice'
  | 'relight'
  | 'multi-angle';

type RightToolPanelProps = {
  activeTool: ImageEditorToolMode;
  onSelect: (tool: ImageEditorToolMode) => void;
};

const RightToolPanel: React.FC<RightToolPanelProps> = ({ activeTool, onSelect }) => {
  const coreTools = [
    { id: 'quick-edit', icon: 'project-excalidraw-top-quick-edit-icon', label: 'Quick Edit', width: 18, height: 18 },
    { id: 'inpaint', icon: 'project-excalidraw-top-inpaint-icon', label: 'Inpaint', width: 18, height: 18 },
    { id: 'erase', icon: 'project-excalidraw-top-erase-icon', label: 'Erase', width: 18, height: 18 },
    { id: 'cutout', icon: 'project-excalidraw-top-remove-bg-icon', label: 'Cutout', width: 17, height: 17 },
    { id: 'upscale', icon: 'project-excalidraw-top-enhance-icon', label: 'Upscale', width: 18, height: 15 },
  ] as const;

  const transformTools = [
    { id: 'crop', icon: 'project-image-editor-more-crop-icon', label: 'Crop', width: 16, height: 16 },
    { id: 'expand', icon: 'project-image-editor-more-expand-icon', label: 'Expand', width: 16, height: 16 },
    { id: 'flip-rotate', icon: 'imageEditor-more-flip-rotate-icon', label: 'Flip & Rotate', width: 16, height: 16 },
    { id: 'grid-slice', icon: 'project-image-editor-more-grid-slice-icon', label: 'Grid Slice', width: 16, height: 16 },
  ] as const;

  const creativeTools = [
    { id: 'mark', icon: 'imageEditor-mark-title-icon', label: 'Mark', width: 16, height: 16 },
    { id: 'graffiti', icon: 'imageEditor-more-graffiti-icon', label: 'Graffiti', width: 16, height: 16 },
    { id: 'adjust', icon: 'project-image-editor-more-adjust-icon', label: 'Adjust', width: 16, height: 16 },
    { id: 'relight', icon: 'project-image-editor-more-relight-icon', label: 'Relight', width: 20, height: 20 },
    { id: 'multi-angle', icon: 'project-excalidraw-top-multi-angle-icon', label: 'Multi-Angle', width: 20, height: 20 },
  ] as const;

  const renderToolButton = (tool: (typeof coreTools | typeof transformTools | typeof creativeTools)[number]) => {
    const isActive = activeTool === tool.id;
    return (
      <Tooltip key={tool.id} title={tool.label} placement='left' offset={6}>
        <button
          type='button'
          onClick={() => {
            onSelect(tool.id as ImageEditorToolMode);
          }}
          className={`my-1 flex h-10 w-10 items-center justify-center rounded-lg border transition-colors ${
            isActive
              ? 'border-[#a7dfb4] bg-[#eef9f0]'
              : 'border-transparent hover:border-[#e3e6ec] hover:bg-[#f1f3f7]'
          }`}
        >
          <Icon
            name={tool.icon}
            width={tool.width}
            height={tool.height}
            color='var(--color-icon-base)'
          />
        </button>
      </Tooltip>
    );
  };

  return (
    <div className='flex h-full flex-col items-center bg-background-default-secondary py-2'>
      {coreTools.map(renderToolButton)}
      <div className='my-1 h-px w-8 bg-[#e6e8ec]' />
      {transformTools.map(renderToolButton)}
      <div className='my-1 h-px w-8 bg-[#e6e8ec]' />
      {creativeTools.map(renderToolButton)}
    </div>
  );
};

export default RightToolPanel;
