import React, { memo, useRef, useState, useEffect } from 'react';
import { Button } from '@/ui/button';
import Dialog from '@/ui/dialog';
import Input from '@/ui/input';

interface TextInputModalProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  value?: string; // Input initial value
  placeholder?: string;
  maxLength?: number;
  width?: number;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (finalValue?: string) => void;
  onCancel: () => void;
}

const TextInputModal: React.FC<TextInputModalProps> = ({
  open,
  title,
  description,
  value,
  placeholder,
  maxLength = 30,
  width = 400,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  const [localValue, setLocalValue] = useState(value || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setLocalValue(value || ('' as string));
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const rafId = requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [open]);

  return (
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
            onClick={() => onConfirm(localValue)}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className='flex flex-col items-start justify-center w-full gap-3'>
        {description ? (
          <div className='text-base font-medium leading-6 text-[var(--color-text-default-base)] break-all whitespace-pre-wrap'>
            {description}
          </div>
        ) : null}

        <div className='w-full pr-4 pl-2 py-1.5 bg-[var(--color-background-default-secondary)] gap-[6px] rounded-full inline-flex items-center'>
          <Input
            ref={inputRef}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            type='borderless'
            size='small'
            className='flex-1 h-[24px] text-[var(--color-text-disabled-base)] text-base font-medium leading-6'
          />
          <div className='text-text-default-secondary text-base font-medium tracking-tight w-[42px] text-center'>
            {localValue?.length}/{maxLength}
          </div>
        </div>
      </div>
    </Dialog>
  );
};

export default memo(TextInputModal);
