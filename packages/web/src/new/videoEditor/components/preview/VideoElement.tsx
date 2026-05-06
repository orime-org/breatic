import React, { useState, useEffect, useMemo, memo } from 'react';
import { Icon } from '@/components/base/icon';
import { MediaItem, TimelineClip } from '../../types';

interface VideoElementProps {
  clip: TimelineClip;
  media: MediaItem;
  width: number;
  height: number;
  opacity: number;
  videoRefs: React.RefObject<{ [key: string]: HTMLVideoElement }>;
}

const VideoElement: React.FC<VideoElementProps> = ({
  clip,
  media,
  width,
  height,
  opacity,
  videoRefs,
}) => {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
  }, [media.url]);

  const handleVideoLoaded = () => {
    setIsLoading(false);
  };

  const handleVideoRef = (el: HTMLVideoElement | null) => {
    if (el) {
      videoRefs.current[clip.id] = el;
      const volume = clip.volume !== undefined ? clip.volume : 100;
      el.volume = Math.min(volume / 100, 1);
      el.muted = volume === 0;
    }
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

  const videoObjectFit = clip.cropArea ? 'fill' : 'contain';

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
        <video
          ref={handleVideoRef}
          src={media.url}
          crossOrigin='anonymous'
          className='w-full h-full block'
          style={{
            objectFit: videoObjectFit,
            imageRendering: 'auto',
            WebkitBackfaceVisibility: 'hidden',
            backfaceVisibility: 'hidden',
            transform: 'translateZ(0)',
          } as React.CSSProperties}
          playsInline
          preload='auto'
          onLoadedData={handleVideoLoaded}
        />
      </div>
    </>
  );
};

export default memo(VideoElement);

