import React, { useState, useRef, memo, useEffect, useCallback } from 'react';
import Dialog from '@/components/base/dialog';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import { useTranslation } from 'react-i18next';
import './CropModal.css';

interface CropModalProps {
  visible: boolean;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  mediaThumbnail?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  existingCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    unit: 'px';
  };
  onClose: () => void;
  onApply: (
    croppedUrl: string | null,
    cropData: {
      x: number;
      y: number;
      width: number;
      height: number;
      unit: 'px';
    }
  ) => void;
}

type CropRect = { x: number; y: number; w: number; h: number };
type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type DragState =
  | { type: 'move'; startX: number; startY: number; origRect: CropRect }
  | { type: 'resize'; handle: HandlePos; startX: number; startY: number; origRect: CropRect };

const MIN_CROP_SIZE = 50;

const calcMove = (origRect: CropRect, dx: number, dy: number, cw: number, ch: number): CropRect => {
  const newX = Math.max(0, Math.min(origRect.x + dx, cw - origRect.w));
  const newY = Math.max(0, Math.min(origRect.y + dy, ch - origRect.h));
  return { ...origRect, x: newX, y: newY };
};

const calcEdgeResize = (
  origRect: CropRect,
  handle: 'n' | 's' | 'w' | 'e',
  dx: number,
  dy: number,
  cw: number,
  ch: number
): CropRect => {
  const right = origRect.x + origRect.w;
  const bottom = origRect.y + origRect.h;

  if (handle === 'n') {
    const newY = Math.max(0, Math.min(origRect.y + dy, bottom - MIN_CROP_SIZE));
    return { ...origRect, y: newY, h: bottom - newY };
  }
  if (handle === 's') {
    const newBottom = Math.max(origRect.y + MIN_CROP_SIZE, Math.min(bottom + dy, ch));
    return { ...origRect, h: newBottom - origRect.y };
  }
  if (handle === 'w') {
    const newX = Math.max(0, Math.min(origRect.x + dx, right - MIN_CROP_SIZE));
    return { ...origRect, x: newX, w: right - newX };
  }
  const newRight = Math.max(origRect.x + MIN_CROP_SIZE, Math.min(right + dx, cw));
  return { ...origRect, w: newRight - origRect.x };
};

const calcCornerResize = (
  origRect: CropRect,
  handle: 'nw' | 'ne' | 'sw' | 'se',
  dx: number,
  dy: number,
  cw: number,
  ch: number
): CropRect => {
  const right = origRect.x + origRect.w;
  const bottom = origRect.y + origRect.h;
  const minScale = MIN_CROP_SIZE / Math.min(origRect.w, origRect.h);

  if (handle === 'se') {
    const maxScale = Math.min((cw - origRect.x) / origRect.w, (ch - origRect.y) / origRect.h);
    const rawScale = Math.min((origRect.w + dx) / origRect.w, (origRect.h + dy) / origRect.h);
    const scale = Math.max(minScale, Math.min(rawScale, maxScale));
    return { x: origRect.x, y: origRect.y, w: origRect.w * scale, h: origRect.h * scale };
  }
  if (handle === 'sw') {
    const maxScale = Math.min(right / origRect.w, (ch - origRect.y) / origRect.h);
    const rawScale = Math.min((origRect.w - dx) / origRect.w, (origRect.h + dy) / origRect.h);
    const scale = Math.max(minScale, Math.min(rawScale, maxScale));
    const newW = origRect.w * scale;
    return { x: right - newW, y: origRect.y, w: newW, h: origRect.h * scale };
  }
  if (handle === 'ne') {
    const maxScale = Math.min((cw - origRect.x) / origRect.w, bottom / origRect.h);
    const rawScale = Math.min((origRect.w + dx) / origRect.w, (origRect.h - dy) / origRect.h);
    const scale = Math.max(minScale, Math.min(rawScale, maxScale));
    const newH = origRect.h * scale;
    return { x: origRect.x, y: bottom - newH, w: origRect.w * scale, h: newH };
  }

  const maxScale = Math.min(right / origRect.w, bottom / origRect.h);
  const rawScale = Math.min((origRect.w - dx) / origRect.w, (origRect.h - dy) / origRect.h);
  const scale = Math.max(minScale, Math.min(rawScale, maxScale));
  const newW = origRect.w * scale;
  const newH = origRect.h * scale;
  return { x: right - newW, y: bottom - newH, w: newW, h: newH };
};

const handles: { id: HandlePos; cursor: string; style: React.CSSProperties }[] = [
  { id: 'nw', cursor: 'nw-resize', style: { top: -6, left: -6 } },
  { id: 'n', cursor: 'n-resize', style: { top: -6, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'ne', cursor: 'ne-resize', style: { top: -6, right: -6 } },
  { id: 'e', cursor: 'e-resize', style: { top: '50%', right: -6, transform: 'translateY(-50%)' } },
  { id: 'se', cursor: 'se-resize', style: { bottom: -6, right: -6 } },
  { id: 's', cursor: 's-resize', style: { bottom: -6, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'sw', cursor: 'sw-resize', style: { bottom: -6, left: -6 } },
  { id: 'w', cursor: 'w-resize', style: { top: '50%', left: -6, transform: 'translateY(-50%)' } },
];

const CropModal: React.FC<CropModalProps> = ({
  visible,
  mediaUrl,
  mediaType,
  mediaThumbnail,
  mediaWidth,
  mediaHeight,
  existingCrop,
  onClose,
  onApply,
}) => {
  const { t } = useTranslation();
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleAfterClose = useCallback(() => {
    setImageLoaded(false);
    setCropRect(null);
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const initializeCrop = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
      return;
    }

    const imgWidth = img.width;
    const imgHeight = img.height;

    if (existingCrop) {
      // 对于视频，existingCrop 是基于视频实际尺寸的
      // 需要转换到显示尺寸（缩略图尺寸）
      const sourceWidth = mediaType === 'video' && mediaWidth ? mediaWidth : img.naturalWidth;
      const sourceHeight = mediaType === 'video' && mediaHeight ? mediaHeight : img.naturalHeight;

      const scaleX = imgWidth / sourceWidth;
      const scaleY = imgHeight / sourceHeight;

      let cropX = existingCrop.x * scaleX;
      let cropY = existingCrop.y * scaleY;
      let cropWidth = existingCrop.width * scaleX;
      let cropHeight = existingCrop.height * scaleY;

      if (cropX < 0) {
        cropWidth += cropX;
        cropX = 0;
      }
      if (cropY < 0) {
        cropHeight += cropY;
        cropY = 0;
      }
      if (cropX + cropWidth > imgWidth) {
        cropWidth = imgWidth - cropX;
      }
      if (cropY + cropHeight > imgHeight) {
        cropHeight = imgHeight - cropY;
      }

      if (cropWidth < MIN_CROP_SIZE) {
        cropWidth = Math.min(MIN_CROP_SIZE, imgWidth - cropX);
      }
      if (cropHeight < MIN_CROP_SIZE) {
        cropHeight = Math.min(MIN_CROP_SIZE, imgHeight - cropY);
      }

      if (cropWidth <= 0 || cropHeight <= 0 || cropX < 0 || cropY < 0) {
        setCropRect({ x: 0, y: 0, w: imgWidth, h: imgHeight });
      } else {
        setCropRect({
          x: cropX,
          y: cropY,
          w: cropWidth,
          h: cropHeight,
        });
      }
    } else {
      setCropRect({ x: 0, y: 0, w: imgWidth, h: imgHeight });
    }
    setImageLoaded(true);
  }, [existingCrop, mediaType, mediaWidth, mediaHeight]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const img = imgRef.current;
      if (!drag || !img) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const { origRect } = drag;
      const cw = img.width;
      const ch = img.height;

      if (drag.type === 'move') {
        setCropRect(calcMove(origRect, dx, dy, cw, ch));
        return;
      }

      const { handle } = drag;
      const isEdge = handle === 'n' || handle === 's' || handle === 'w' || handle === 'e';
      const nextRect = isEdge
        ? calcEdgeResize(origRect, handle, dx, dy, cw, ch)
        : calcCornerResize(origRect, handle as 'nw' | 'ne' | 'sw' | 'se', dx, dy, cw, ch);

      setCropRect(nextRect);
    };

    const onUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleReset = () => {
    const img = imgRef.current;
    if (img) {
      setCropRect({ x: 0, y: 0, w: img.width, h: img.height });
    }
  };

  const handleApply = () => {
    if (!cropRect || !imgRef.current) return;

    const img = imgRef.current;

    // 对于视频，使用传入的 mediaWidth/mediaHeight（视频实际尺寸）
    // 对于图片，使用图片的 naturalWidth/naturalHeight
    const targetWidth = mediaType === 'video' && mediaWidth ? mediaWidth : img.naturalWidth;
    const targetHeight = mediaType === 'video' && mediaHeight ? mediaHeight : img.naturalHeight;

    const scaleX = targetWidth / img.width;
    const scaleY = targetHeight / img.height;

    // 转换到原始尺寸坐标（基于视频实际尺寸或图片原始尺寸）
    const originalCrop = {
      x: cropRect.x * scaleX,
      y: cropRect.y * scaleY,
      width: cropRect.w * scaleX,
      height: cropRect.h * scaleY,
      unit: 'px' as const,
    };

    onApply(null, originalCrop);
    onClose();
  };

  const displayUrl = mediaType === 'video' ? mediaThumbnail || mediaUrl : mediaUrl;

  useEffect(() => {
    if (visible && imageLoaded) {
      initializeCrop();
    }
  }, [visible, existingCrop, imageLoaded, initializeCrop]);

  useEffect(() => {
    if (!visible) {
      handleAfterClose();
    }
  }, [visible, handleAfterClose]);

  useEffect(() => {
    if (!visible || !imageLoaded) return;

    const img = imgRef.current;
    if (!img) return;

    const resizeObserver = new ResizeObserver(() => {
      initializeCrop();
    });

    resizeObserver.observe(img);

    return () => {
      resizeObserver.disconnect();
    };
  }, [visible, imageLoaded, initializeCrop]);

  const startMove = (e: React.MouseEvent) => {
    if (!cropRect) return;
    dragRef.current = {
      type: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origRect: cropRect,
    };
    setIsDragging(true);
    e.stopPropagation();
    e.preventDefault();
  };

  const startResize = (handle: HandlePos) => (e: React.MouseEvent) => {
    if (!cropRect) return;
    dragRef.current = {
      type: 'resize',
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origRect: cropRect,
    };
    setIsDragging(true);
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <Dialog
      show={visible}
      onClose={onClose}
      width={900}
      bodyClassName='p-0'
      style={{ zIndex: 10000 }}
    >
      <div className='relative h-[600px]'>
        <div className='flex flex-col h-full mt-[30px]'>
          {/* 裁剪区域 */}
          <div className='relative flex items-center justify-center flex-1 p-8 overflow-auto '>
            {/* Loading 动画 */}
            {displayUrl && !imageLoaded && (
              <div className='absolute inset-0 flex items-center justify-center bg-[#1a1a1a] z-10'>
                <Icon name='videoEditor-loading-spinner' width={32} height={32} className='animate-spin' />
              </div>
            )}
            {displayUrl && (
              <div className={`transition-opacity duration-150 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}>
                <div ref={containerRef} className='crop-modal-container'>
                  <img
                    ref={(el) => {
                      imgRef.current = el;
                      if (el && el.complete && el.naturalWidth > 0 && !imageLoaded) {
                        initializeCrop();
                      }
                    }}
                    src={displayUrl}
                    alt='Crop'
                    onLoad={() => {
                      initializeCrop();
                    }}
                    onError={() => {
                      setImageLoaded(true); // 失败也要隐藏加载动画
                    }}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '450px',
                      width: 'auto',
                      height: 'auto',
                      objectFit: 'contain',
                      display: 'block',
                    }}
                  />
                  {imageLoaded && cropRect && (
                    <div className='crop-modal-overlay'>
                      <div className='crop-modal-mask'>
                        <div
                          className='crop-modal-cutout'
                          style={{
                            left: cropRect.x,
                            top: cropRect.y,
                            width: cropRect.w,
                            height: cropRect.h,
                          }}
                        />
                      </div>

                      <div
                        className='crop-modal-box'
                        style={{
                          left: cropRect.x,
                          top: cropRect.y,
                          width: cropRect.w,
                          height: cropRect.h,
                        }}
                        onMouseDown={startMove}
                      >
                        {isDragging && (
                          <div className='pointer-events-none absolute inset-0'>
                            <div className='absolute bg-white/30' style={{ top: '33.33%', left: 0, right: 0, height: 1 }} />
                            <div className='absolute bg-white/30' style={{ top: '66.66%', left: 0, right: 0, height: 1 }} />
                            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '33.33%', width: 1 }} />
                            <div className='absolute bg-white/30' style={{ top: 0, bottom: 0, left: '66.66%', width: 1 }} />
                          </div>
                        )}

                        {handles.map(({ id, cursor, style }) => {
                          return (
                            <div
                              key={id}
                              className='crop-modal-handle h-3 w-3 rounded-full'
                              style={{ ...style, cursor }}
                              onMouseDown={startResize(id)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* 底部按钮 */}
          <div className='flex justify-end gap-3 p-4 '>
            <Button type='default' onClick={handleReset}>{t('cropModal.reset')}</Button>
            <Button
              type='primary'
              onClick={handleApply}
              className='min-w-[100px]'
            >
              {t('cropModal.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
};

export default memo(CropModal);

