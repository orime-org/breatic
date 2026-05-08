import React, { memo, useState } from 'react';
import CustomPopover from '@/ui/popover';
import { Button } from '@/ui/button';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import aspectRatioIconMap from '@/pages/project/constants/aspectRatioIconMap';
import ExportPanel from './ExportPanel';
import RatioMenu from './RatioMenu';

interface TopBarProps {
  canvasRatio: string;
  onRatioChange: (ratio: string) => void;
  currentTime?: number;
  nodeId?: string;
  projectId?: string;
  // Skip OSS / workflow persistence; export is local download only.
  exportStandalone?: boolean;
}

const TopBar: React.FC<TopBarProps> = ({
  canvasRatio,
  onRatioChange,
  currentTime = 0,
  nodeId,
  projectId,
  exportStandalone = false,
}) => {
  const { t } = useTranslation();
  const [ratioPopoverVisible, setRatioPopoverVisible] = useState(false);
  const [exportPopoverVisible, setExportPopoverVisible] = useState(false);

  const ratioIcon = aspectRatioIconMap[canvasRatio] || aspectRatioIconMap['16:9'];

  const handleRatioChange = (ratio: string) => {
    onRatioChange(ratio);
    setRatioPopoverVisible(false);
  };

  const renderRatioMenuContent = () => {
    return <RatioMenu onRatioChange={handleRatioChange} selectedRatio={canvasRatio} />;
  };

  return (
    <div className='relative p-3 bg-background-default-base border-b border-border-default-base inline-flex justify-between items-center'>
      <div className='text-text-default-tertiary absolute left-1/2 -translate-x-1/2 text-sm text-zinc-500'>
        {t('common.appTitle')}
      </div>

      {/* Right action area */}
      <div className='flex items-center gap-2.5 ml-auto'>
        {/* Canvas ratio selector */}
        <CustomPopover
          htmlContent={renderRatioMenuContent()}
          trigger='click'
          open={ratioPopoverVisible}
          onOpenChange={setRatioPopoverVisible}
          position='bottom-end'
          btnElement={
            <Button
              type='default'
              className='h-[24px] gap-1.5'
            >
              <Icon name={ratioIcon} width={16} height={16} color='var(--color-icon-primary)' />
              {canvasRatio}
            </Button>
          }
        />

        {/* Export */}
        <CustomPopover
          htmlContent={
            <ExportPanel
              canvasRatio={canvasRatio}
              currentTime={currentTime}
              nodeId={nodeId}
              projectId={projectId}
              standalone={exportStandalone}
            />
          }
          trigger='click'
          open={exportPopoverVisible}
          onOpenChange={setExportPopoverVisible}
          position='bottom-end'
          btnElement={
            <Button
              type='primary'
              icon={<Icon name='videoEditor-download-audio-icon' width={16} height={16} />}
              bordered={false}
              className='h-[24px]'
            >
              {t('common.export')}
            </Button>
          }
        />
      </div>
    </div>
  );
};

export default memo(TopBar);
