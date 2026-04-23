import React, { useState, useEffect, useMemo, memo } from 'react';
import { Icon } from '@/components/base/icon';
import { MediaItem, TimelineClip } from '../../types';

interface ImageElementProps {
  clip: TimelineClip;
  media: MediaItem;
  width: number;
  height: number;
  opacity: number;
}

const ImageElement: React.FC<ImageElementProps> = ({
  clip,
  media,
  width,
  height,
  opacity,
}) => {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
  }, [media.url]);

  const handleImageLoad = () => {
    setIsLoading(false);
  };

  const mediaStyle = clip.mediaStyle || {};
  const filterValue = useMemo(() => {
    const filters = [];
    if (mediaStyle.blur && mediaStyle.blur > 0) {
      filters.push(`blur(${mediaStyle.blur}px)`);
    }
    if (mediaStyle.brightness && mediaStyle.brightness !== 100) {
      filters.push(`brightness(${mediaStyle.brightness}%)`);
    }
    return filters.length > 0 ? filters.join(' ') : undefined;
  }, [mediaStyle.blur, mediaStyle.brightness]);

  const cropStyle = useMemo(() => {
    if (clip.cropArea && media.width && media.height) {
      const { x: cropX, y: cropY, width: cropWidth, height: cropHeight } = clip.cropArea;
      const scaleX = width / cropWidth;
      const scaleY = height / cropHeight;
      const displayWidth = media.width * scaleX;
      const displayHeight = media.height * scaleY;
      const offsetX = -cropX * scaleX;
      const offsetY = -cropY * scaleY;

      return {
        position: 'absolute' as const,
        left: `${offsetX}px`,
        top: `${offsetY}px`,
        width: `${displayWidth}px`,
        height: `${displayHeight}px`,
      };
    }
    return null;
  }, [clip.cropArea, media.width, media.height, width, height]);

  const containerStyle = useMemo(() => {
    const baseStyle: React.CSSProperties = {
      opacity: isLoading ? 0 : opacity / 100,
    };
    if (filterValue) {
      baseStyle.filter = filterValue;
    }
    return baseStyle;
  }, [isLoading, opacity, filterValue]);

  const imageObjectFit = clip.cropArea ? 'fill' : 'contain';

  return (
    <>
      {isLoading && (
        <div className='absolute inset-0 flex items-center justify-center bg-gray-200 z-[1]'>
          <Icon name='videoEditor-loading-spinner' width={32} height={32} className='animate-spin' />
        </div>
      )}
      <div
        className='absolute inset-0 overflow-hidden pointer-events-none'
        style={cropStyle ? { ...containerStyle, ...cropStyle } : containerStyle}
      >
        <img
          src={media.url}
          alt={media.name}
          crossOrigin='anonymous'
          className='w-full h-full block'
          style={{
            objectFit: imageObjectFit,
            imageRendering: 'auto',
            WebkitBackfaceVisibility: 'hidden',
            backfaceVisibility: 'hidden',
            transform: 'translateZ(0)',
          } as React.CSSProperties}
          onLoad={handleImageLoad}
        />
      </div>
    </>
  );
};

export default memo(ImageElement);

