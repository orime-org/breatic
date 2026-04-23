import React, { memo, useState } from 'react';
import CustomPopover from '@/components/base/popover';
import { Button } from '@/components/base/button';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import aspectRatioIconMap from '@/apps/project/constants/aspectRatioIconMap';
import ExportPanel from './ExportPanel';
import RatioMenu from './RatioMenu';

/**
 * TopBar 组件 - 顶部工具栏
 */
interface TopBarProps {
  canvasRatio: string;
  onRatioChange: (ratio: string) => void;
  currentTime?: number;
  nodeId?: string;
  projectId?: string;
  /** Skip OSS / workflow persistence; export ends as local download only. */
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

  // 根据选中的比例获取对应的图标
  const ratioIcon = aspectRatioIconMap[canvasRatio] || aspectRatioIconMap['16:9'];

  // 处理比例变更
  const handleRatioChange = (ratio: string) => {
    onRatioChange(ratio);
    setRatioPopoverVisible(false);
  };

  // 渲染比例菜单内容
  const renderRatioMenuContent = () => {
    return <RatioMenu onRatioChange={handleRatioChange} selectedRatio={canvasRatio} />;
  };

  return (
    <div className='relative p-3 bg-background-default-base border-b border-border-default-base inline-flex justify-between items-center'>
      {/* 应用标题 - 居中显示 */}
      <div className='text-text-default-tertiary absolute left-1/2 -translate-x-1/2 text-sm text-zinc-500'>
        {t('common.appTitle')}
      </div>

      {/* 右侧功能按钮区域 */}
      <div className='flex items-center gap-2.5 ml-auto'>
        {/* 画布尺寸调整 */}
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

        {/* 导出功能 */}
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
