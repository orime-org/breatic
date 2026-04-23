import React, { useState } from 'react';
import Dialog from '@/components/base/dialog';
import ConfirmModal from '@/components/modals/ConfirmModal';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import { useTranslation } from 'react-i18next';
import { LoadingDots } from './LoadingDots';

interface ExportSettingsModalProps {
  // 导出状态
  isExporting: boolean;
  exportProgress: number;
  exportComplete: boolean;
  exportedFormat: string;
  isUploading?: boolean; // 上传状态

  // 状态设置函数
  setIsExporting: (value: boolean) => void;
  setExportProgress: (value: number) => void;
  setExportComplete: (value: boolean) => void;
  setExportedBlob: (value: Blob | null) => void;

  // 回调函数
  handleDownload: () => void;
  handleCancelExport?: () => void; // 取消导出的回调
}

/**
 * 导出进度 Modal 组件
 *
 * 显示导出进度或导出完成状态，包括：
 *
 * 导出中状态：
 * - 进度百分比（大号显示）
 * - "导出中" 文字 + 动画点
 * - 进度提示文字
 *
 * 导出完成状态：
 * - 完成图标
 * - 成功提示文字
 * - 格式提示（图片/音频/视频）
 * - 下载按钮
 *
 * 功能：
 * - 导出中可以取消（显示确认对话框）
 * - 导出完成可以直接关闭
 * - 点击下载按钮触发文件下载
 */
export const ExportSettingsModal: React.FC<ExportSettingsModalProps> = ({
  isExporting,
  exportProgress,
  exportComplete,
  exportedFormat,
  isUploading = false,
  setIsExporting,
  setExportProgress,
  setExportComplete,
  setExportedBlob,
  handleDownload,
  handleCancelExport,
}) => {
  const { t } = useTranslation();
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  /**
   * 处理 Modal 关闭事件
   * - 导出完成：直接关闭并重置状态
   * - 导出中：显示确认对话框
   */
  const handleCancel = () => {
    if (exportComplete) {
      // 下载页面：直接关闭
      setIsExporting(false);
      setExportProgress(0);
      setExportComplete(false);
      setExportedBlob(null);
    } else {
      // 导出中：显示确认对话框
      setCancelConfirmOpen(true);
    }
  };

  /**
   * 确认取消导出
   */
  const handleConfirmCancel = () => {
    setCancelConfirmOpen(false);
    // 调用取消导出回调，真正中止导出进程
    if (handleCancelExport) {
      handleCancelExport();
    } else {
      // 兜底：重置导出状态
      setIsExporting(false);
      setExportProgress(0);
      setExportComplete(false);
      setExportedBlob(null);
    }
  };

  /**
   * 获取导出格式提示文字
   */
  const getFormatMessage = () => {
    if (exportedFormat === 'PNG' || exportedFormat === 'JPG') {
      return t('export.exportingImage');
    } else if (exportedFormat === 'AUDIO') {
      return t('export.exportingAudio');
    }
    return t('export.exportingVideo');

  };

  return (
    <>
      <Dialog
        title={t('export.download')}
        show={isExporting}
        onClose={handleCancel}
        width={700}
      >
        <div
          className='flex flex-col items-center justify-center'
          style={{ height: '400px' }}
        >
          {exportComplete && !isUploading ? (
            // 导出和上传都完成状态
            <>
              <Icon name='videoEditor-check-success-icon' width={24} height={24} className='mb-2' />
              <div className='mb-2 text-lg text-gray-900'>
                {t('export.success')}
              </div>
              <div className='mb-8 text-sm text-gray-500'>
                {getFormatMessage()}
              </div>
              <Button
                type='primary'
                size='large'
                bordered={false}
                onClick={handleDownload}
              >
                {t('export.download')}
              </Button>
            </>
          ) : isUploading ? (
            // 上传中状态
            <>
              <div className='mb-6 text-6xl font-bold text-gray-900'>
                100%
              </div>
              <div className='mb-2 text-lg text-gray-900'>
                上传中
                <LoadingDots />
              </div>
              <div className='text-sm text-gray-500'>正在上传到服务器...</div>
            </>
          ) : (
            // 导出中状态
            <>
              <div className='mb-6 text-6xl font-bold text-gray-900'>
                {exportProgress}%
              </div>
              <div className='mb-2 text-lg text-gray-900'>
                {t('export.exporting')}
                <LoadingDots />
              </div>
              <div className='text-sm text-gray-500'>{t('export.progress')}</div>
            </>
          )}
        </div>
      </Dialog>

      <ConfirmModal
        open={cancelConfirmOpen}
        title={t('export.cancelTitle')}
        description={t('export.cancelMessage')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmCancel}
        onCancel={() => setCancelConfirmOpen(false)}
      />
    </>
  );
};

