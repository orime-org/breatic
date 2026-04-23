import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/base/button';
import Dialog from '@/components/base/dialog';

interface ModalProps {
  open: boolean;
  width?: number;
  title?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  footer?: boolean;
  closable?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open,
  width = 800,
  title = null,
  confirmText,
  cancelText,
  footer = true,
  closable: _closable = true,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}) => {
  const { t } = useTranslation();
  const defaultConfirmText = t('project.modal.confirm');
  const defaultCancelText = t('project.modal.cancel');
  return (
    <Dialog
      show={open}
      onClose={onCancel}
      closable={_closable}
      title={title || undefined}
      width={width}
      footer={
        footer ? (
          <>
            <Button
              type='default'
              shape='round'
              className='min-w-[100px]'
              onClick={onCancel}
            >
              {cancelText || defaultCancelText}
            </Button>
            <Button
              type='primary'
              shape='round'
              className='min-w-[100px]'
              onClick={onConfirm}
              disabled={confirmDisabled}
            >
              {confirmText || defaultConfirmText}
            </Button>
          </>
        ) : undefined
      }
      bodyClassName='flex flex-col items-center justify-center text-center'
    >
      <div className='flex flex-col items-center justify-center w-full'>
        {children}
      </div>
    </Dialog>
  );
};

