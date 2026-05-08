import React, { useState } from 'react';
import Dialog from '@/ui/dialog';
import ConfirmModal from '@/app/shell/modals/ConfirmModal';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import { useTranslation } from 'react-i18next';
import { LoadingDots } from './LoadingDots';

interface ExportSettingsModalProps {
  // comment
  isExporting: boolean;
  exportProgress: number;
  exportComplete: boolean;
  exportedFormat: string;
  isUploading?: boolean; // up

  // set
  setIsExporting: (value: boolean) => void;
  setExportProgress: (value: number) => void;
  setExportComplete: (value: boolean) => void;
  setExportedBlob: (value: Blob | null) => void;

  // comment
  handleDownload: () => void;
  handleCancelExport?: () => void; // comment
}

/* * * Modal component * * display ， ： * * ： * - （ display） * - " " text + * - text * * ： * - * - text * - （image/audio/video） * - down button * * ： * - （display ） * - close * - down button down */
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

  /* * * handle Modal close * - ： close reset * - ：display */
  const handleCancel = () => {
    if (exportComplete) {
      // down ： close
      setIsExporting(false);
      setExportProgress(0);
      setExportComplete(false);
      setExportedBlob(null);
    } else {
      // ：display
      setCancelConfirmOpen(true);
    }
  };

  /* * * */
  const handleConfirmCancel = () => {
    setCancelConfirmOpen(false);
    // ，
    if (handleCancelExport) {
      handleCancelExport();
    } else {
      // ：reset
      setIsExporting(false);
      setExportProgress(0);
      setExportComplete(false);
      setExportedBlob(null);
    }
  };

  /* * * get text */
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
            // up
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
            // up
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
            // comment
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

