import React, { memo } from 'react';
import { Button } from '@/ui/button';
import Dialog from '@/ui/dialog';

interface ConfirmModalProps {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  width?: number;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  description,
  width = 400,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}) => (
  <Dialog
    show={open}
    onClose={onCancel}
    title={title}
    width={width}
    style={{ minWidth: 400 }}
    footer={
      <>
        <Button
          type='default'
          shape='round'
          className='min-w-[100px]'
          onClick={onCancel}
        >
          {cancelText}
        </Button>

        <Button
          type='primary'
          shape='round'
          className='min-w-[100px]'
          onClick={onConfirm}
        >
          {confirmText}
        </Button>
      </>
    }
  >
    {description ? (
      <div className='text-base font-medium leading-6 text-[var(--color-text-default-base)] break-all whitespace-pre-wrap'>
        {description}
      </div>
    ) : null}
  </Dialog>
);

export default memo(ConfirmModal);
