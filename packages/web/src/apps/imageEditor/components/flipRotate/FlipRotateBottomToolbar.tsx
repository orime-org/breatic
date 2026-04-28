import React, { useState } from 'react';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import { Button } from '@/components/base/button';

export type FlipRotateBitmapOp = 'rotateMinus90' | 'rotate90' | 'flipHorizontal' | 'flipVertical';

type FlipRotateBottomToolbarProps = {
  active: boolean;
  imageSrc?: string;
  onClose: () => void;
  onApply: (op: FlipRotateBitmapOp) => void | Promise<void>;
  onSave: () => void;
};

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover disabled:cursor-not-allowed disabled:opacity-40';

export const bitmapTransformToPngDataUrl = async (
  src: string,
  op: FlipRotateBitmapOp,
): Promise<{ dataUrl: string; outWidth: number; outHeight: number }> => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = src;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Image load failed'));
  });

  const naturalW = image.naturalWidth;
  const naturalH = image.naturalHeight;
  if (!naturalW || !naturalH) throw new Error('Invalid image size');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unsupported');

  if (op === 'rotateMinus90' || op === 'rotate90') {
    canvas.width = naturalH;
    canvas.height = naturalW;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(op === 'rotate90' ? Math.PI / 2 : -Math.PI / 2);
    ctx.drawImage(image, -naturalW / 2, -naturalH / 2);
  } else {
    canvas.width = naturalW;
    canvas.height = naturalH;
    if (op === 'flipHorizontal') {
      ctx.translate(naturalW, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, naturalH);
      ctx.scale(1, -1);
    }
    ctx.drawImage(image, 0, 0);
  }

  return {
    dataUrl: canvas.toDataURL('image/png'),
    outWidth: canvas.width,
    outHeight: canvas.height,
  };
};

export const swapsNodeDimensions = (op: FlipRotateBitmapOp) => op === 'rotateMinus90' || op === 'rotate90';

const FlipRotateBottomToolbar: React.FC<FlipRotateBottomToolbarProps> = ({ active, imageSrc, onClose, onApply, onSave }) => {
  const [busy, setBusy] = useState(false);

  if (!active) return null;

  const run = async (op: FlipRotateBitmapOp) => {
    if (!imageSrc || busy) return;
    setBusy(true);
    try {
      await onApply(op);
    } catch {
      void 0;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className='flex items-center gap-1'>
        <Icon name='imageEditor-more-flip-rotate-icon' width={20} height={20} color='var(--color-icon-base)' />
        <span className='whitespace-nowrap text-[13px] font-bold text-text-default-base'>Flip & Rotate</span>
      </div>

      <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

      <Tooltip title='-90°' placement='top' offset={4}>
        <button
          type='button'
          className={iconBtnClass}
          disabled={!imageSrc || busy}
          aria-label='Rotate 90 degrees counter-clockwise'
          onClick={() => void run('rotateMinus90')}
        >
          <span className='inline-flex rotate-180'>
            <Icon name='project-image-editor-more-rotate-90-icon' width={20} height={20} color='var(--color-icon-base)' />
          </span>
        </button>
      </Tooltip>

      <Tooltip title='90°' placement='top' offset={4}>
        <button
          type='button'
          className={iconBtnClass}
          disabled={!imageSrc || busy}
          aria-label='Rotate 90 degrees clockwise'
          onClick={() => void run('rotate90')}
        >
          <Icon name='project-image-editor-more-rotate-90-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </Tooltip>

      <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

      <Tooltip title='Flip Horizontal' placement='top' offset={4}>
        <button
          type='button'
          className={iconBtnClass}
          disabled={!imageSrc || busy}
          aria-label='Flip horizontal'
          onClick={() => void run('flipHorizontal')}
        >
          <Icon name='imageEditor-flip-horizontal-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </Tooltip>

      <Tooltip title='Flip Vertical' placement='top' offset={4}>
        <button
          type='button'
          className={iconBtnClass}
          disabled={!imageSrc || busy}
          aria-label='Flip vertical'
          onClick={() => void run('flipVertical')}
        >
          <Icon name='imageEditor-flip-vertical-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </Tooltip>

      <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

      <Button
        type='primary'
        shape='round'
        className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
        disabled={!imageSrc || busy}
        onClick={onSave}
      >
        <span className='inline-flex items-center'>
          <Icon name='imageEditor-mark-save-icon' width={18} height={18} />
          <span className='pl-2'>Save</span>
        </span>
      </Button>

      <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

      <Tooltip title='Exit' placement='top' offset={4}>
        <button
          type='button'
          className={iconBtnClass}
          disabled={busy}
          aria-label='Close flip and rotate toolbar'
          onClick={onClose}
        >
          <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='#383838' />
        </button>
      </Tooltip>
    </div>
  );
};

export default FlipRotateBottomToolbar;

