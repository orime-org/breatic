import React, { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import Video from './Video';
import { getVideoMetaFromUrl } from '@/utils/mediaUtils';

export interface PreviewVideoProps {
  /** Whether to show the modal */
  open: boolean;
  /** Video URL */
  src: string;
  /** Close modal callback */
  onClose: () => void;
  /** Initial playback time (seconds) */
  initialTime?: number;
  /** Whether to auto-play */
  autoPlay?: boolean;
}

const calculateDisplaySize = (videoWidth: number, videoHeight: number): { width: number; height: number } => {
  const maxWidth = 800;
  const maxHeight = 800;
  const ratio = videoWidth / videoHeight;
  let w: number;
  let h: number;
  if (videoWidth > videoHeight) {
    w = Math.min(videoWidth, maxWidth);
    h = w / ratio;
    if (h > maxHeight) {
      h = maxHeight;
      w = h * ratio;
    }
  } else {
    h = Math.min(videoHeight, maxHeight);
    w = h * ratio;
    if (w > maxWidth) {
      w = maxWidth;
      h = w / ratio;
    }
  }
  return { width: Math.round(w), height: Math.round(h) };
};

/**
 * Video preview modal: overlay + centered video frame, using Video internally
 */
const PreviewVideo: React.FC<PreviewVideoProps> = ({ open, src, onClose, initialTime, autoPlay = false }) => {
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  useEffect(() => {
    if (!open || !src) {
      setDisplaySize(null);
      return;
    }

    let cancelled = false;
    setDisplaySize(null);
    getVideoMetaFromUrl(src).then((meta) => {
      if (cancelled) return;
      if (meta.width && meta.height) {
        setDisplaySize(calculateDisplaySize(meta.width, meta.height));
      } else {
        setDisplaySize({ width: 800, height: 450 });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, src]);

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  const effectiveSize = open && src ? displaySize : null;

  if (!open) return null;

  return createPortal(
    <div className='fixed inset-0 z-[2500] flex items-center justify-center' onClick={handleClose}>
      <div className='absolute inset-0 bg-black/50' />
      <Button
        onClick={handleClose}
        type='dark'
        shape='circle'
        bordered={false}
        className='absolute right-4 top-4 z-20 !w-10 !h-10 !p-[2px] !bg-black/50 backdrop-blur-sm !hover:!bg-black/70'
        aria-label='Close'
        icon={<Icon name='base-close-icon' width={16} height={16} color='#ffffff' />}
      />
      {effectiveSize ? (
        <div
          className='relative flex flex-col rounded-[12px] overflow-hidden bg-black shadow-lg'
          style={{ width: effectiveSize.width, height: effectiveSize.height, maxWidth: '90vw' }}
          onClick={stopPropagation}
        >
          <div className='flex-1 min-h-0 relative w-full'>
            <Video
              key={src}
              src={src}
              initialTime={initialTime}
              autoPlay={autoPlay}
              showControlBar
              className='!rounded-none'
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            />
          </div>
        </div>
      ) : (
        <div
          className='rounded-[12px] bg-black/60 px-4 py-3 text-sm text-white/80 backdrop-blur-sm'
          onClick={stopPropagation}
        >
          Loading…
        </div>
      )}
    </div>,
    document.body,
  );
};

export default memo(PreviewVideo);
