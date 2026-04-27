/**
 * 图片导出工具函数
 *
 * 提供将当前帧导出为PNG/JPG图片的功能
 */

import type { MediaItem, TimelineClip } from '@/apps/videoEditor/types';

/**
 * 异步加载图片
 */
const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
};

/**
 * 加载视频
 */
const loadVideo = (url: string): Promise<HTMLVideoElement> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = reject;
  });
};

/**
 * 创建一个可取消的延迟 Promise
 */
const cancellableDelay = (ms: number, abortSignal?: AbortSignal): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new DOMException('Export was cancelled', 'AbortError'));
      return;
    }
    const timeoutId = setTimeout(resolve, ms);
    abortSignal?.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      reject(new DOMException('Export was cancelled', 'AbortError'));
    });
  });
};

/**
 * 渲染单个片段到 canvas
 */
const renderClipToCanvas = async (
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  media: MediaItem,
  currentTime: number,
  canvasSize: { width: number; height: number }
): Promise<void> => {
  ctx.save();

  const rotation = ((clip.rotation ?? 0) * Math.PI) / 180;
  const scale = clip.scale ?? 1;
  const opacity = (clip.opacity ?? 100) / 100;

  try {
    if (media.type === 'image' && media.url) {
      const img = await loadImage(media.url);
      const width = clip.width ?? img.width;
      const height = clip.height ?? img.height;

      const x = clip.x ?? (canvasSize.width - width) / 2;
      const y = clip.y ?? (canvasSize.height - height) / 2;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      const mediaStyle = clip.mediaStyle || {};

      if (mediaStyle.shadowColor && mediaStyle.shadowBlur) {
        ctx.shadowColor = mediaStyle.shadowColor;
        ctx.shadowBlur = mediaStyle.shadowBlur || 0;
        ctx.shadowOffsetX = mediaStyle.shadowOffsetX || 0;
        ctx.shadowOffsetY = mediaStyle.shadowOffsetY || 0;

        if (mediaStyle.borderRadius) {
          const radius = Math.min(mediaStyle.borderRadius, width / 2, height / 2);
          ctx.beginPath();
          ctx.moveTo(-width / 2 + radius, -height / 2);
          ctx.lineTo(width / 2 - radius, -height / 2);
          ctx.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
          ctx.lineTo(width / 2, height / 2 - radius);
          ctx.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
          ctx.lineTo(-width / 2 + radius, height / 2);
          ctx.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
          ctx.lineTo(-width / 2, -height / 2 + radius);
          ctx.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
          ctx.closePath();
          ctx.fillStyle = 'black';
          ctx.fill();
        } else {
          ctx.fillStyle = 'black';
          ctx.fillRect(-width / 2, -height / 2, width, height);
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      if (mediaStyle.borderRadius) {
        const radius = Math.min(mediaStyle.borderRadius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(-width / 2 + radius, -height / 2);
        ctx.lineTo(width / 2 - radius, -height / 2);
        ctx.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
        ctx.lineTo(width / 2, height / 2 - radius);
        ctx.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
        ctx.lineTo(-width / 2 + radius, height / 2);
        ctx.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
        ctx.lineTo(-width / 2, -height / 2 + radius);
        ctx.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
        ctx.closePath();
        ctx.clip();
      }

      ctx.globalAlpha = opacity;

      const filters = [];
      if (mediaStyle.blur && mediaStyle.blur > 0) {
        filters.push(`blur(${mediaStyle.blur}px)`);
      }
      if (mediaStyle.brightness && mediaStyle.brightness !== 100) {
        filters.push(`brightness(${mediaStyle.brightness}%)`);
      }
      if (filters.length > 0) {
        ctx.filter = filters.join(' ');
      }

      if (clip.cropArea && media.width && media.height) {
        const { x: cropX, y: cropY, width: cropWidth, height: cropHeight } = clip.cropArea;
        const actualImageWidth = img.naturalWidth || media.width;
        const actualImageHeight = img.naturalHeight || media.height;
        const scaleX = actualImageWidth / media.width;
        const scaleY = actualImageHeight / media.height;
        const adjustedCropX = cropX * scaleX;
        const adjustedCropY = cropY * scaleY;
        const adjustedCropWidth = cropWidth * scaleX;
        const adjustedCropHeight = cropHeight * scaleY;

        ctx.drawImage(
          img,
          adjustedCropX,
          adjustedCropY,
          adjustedCropWidth,
          adjustedCropHeight,
          -width / 2,
          -height / 2,
          width,
          height
        );
      } else {
        ctx.drawImage(img, -width / 2, -height / 2, width, height);
      }

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.filter = 'none';
      ctx.globalAlpha = 1;

      if (mediaStyle.outlineColor && mediaStyle.outlineWidth) {
        ctx.strokeStyle = mediaStyle.outlineColor;
        ctx.lineWidth = mediaStyle.outlineWidth;
        if (mediaStyle.borderRadius) {
          const radius = Math.min(mediaStyle.borderRadius, width / 2, height / 2);
          ctx.beginPath();
          ctx.moveTo(-width / 2 + radius, -height / 2);
          ctx.lineTo(width / 2 - radius, -height / 2);
          ctx.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
          ctx.lineTo(width / 2, height / 2 - radius);
          ctx.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
          ctx.lineTo(-width / 2 + radius, height / 2);
          ctx.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
          ctx.lineTo(-width / 2, -height / 2 + radius);
          ctx.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(-width / 2, -height / 2, width, height);
        }
      }
    } else if (media.type === 'video' && media.url) {
      const video = await loadVideo(media.url);
      const width = clip.width ?? (media.width || video.videoWidth);
      const height = clip.height ?? (media.height || video.videoHeight);

      const x = clip.x ?? (canvasSize.width - width) / 2;
      const y = clip.y ?? (canvasSize.height - height) / 2;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      const trimStart = clip.trimStart || 0;
      const videoTime = trimStart + (currentTime - clip.start);
      video.currentTime = Math.max(0, Math.min(videoTime, video.duration));

      await new Promise<void>((resolve) => {
        const checkReady = () => {
          if (video.readyState >= 2) {
            resolve();
          } else {
            setTimeout(checkReady, 50);
          }
        };
        checkReady();
      });

      const mediaStyle = clip.mediaStyle || {};

      if (mediaStyle.shadowColor && mediaStyle.shadowBlur) {
        ctx.shadowColor = mediaStyle.shadowColor;
        ctx.shadowBlur = mediaStyle.shadowBlur || 0;
        ctx.shadowOffsetX = mediaStyle.shadowOffsetX || 0;
        ctx.shadowOffsetY = mediaStyle.shadowOffsetY || 0;

        if (mediaStyle.borderRadius) {
          const radius = Math.min(mediaStyle.borderRadius, width / 2, height / 2);
          ctx.beginPath();
          ctx.moveTo(-width / 2 + radius, -height / 2);
          ctx.lineTo(width / 2 - radius, -height / 2);
          ctx.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
          ctx.lineTo(width / 2, height / 2 - radius);
          ctx.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
          ctx.lineTo(-width / 2 + radius, height / 2);
          ctx.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
          ctx.lineTo(-width / 2, -height / 2 + radius);
          ctx.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
          ctx.closePath();
          ctx.fillStyle = 'black';
          ctx.fill();
        } else {
          ctx.fillStyle = 'black';
          ctx.fillRect(-width / 2, -height / 2, width, height);
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      if (mediaStyle.borderRadius) {
        const radius = Math.min(mediaStyle.borderRadius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(-width / 2 + radius, -height / 2);
        ctx.lineTo(width / 2 - radius, -height / 2);
        ctx.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
        ctx.lineTo(width / 2, height / 2 - radius);
        ctx.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
        ctx.lineTo(-width / 2 + radius, height / 2);
        ctx.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
        ctx.lineTo(-width / 2, -height / 2 + radius);
        ctx.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
        ctx.closePath();
        ctx.clip();
      }

      ctx.globalAlpha = opacity;

      const filters = [];
      if (mediaStyle.blur && mediaStyle.blur > 0) {
        filters.push(`blur(${mediaStyle.blur}px)`);
      }
      if (mediaStyle.brightness && mediaStyle.brightness !== 100) {
        filters.push(`brightness(${mediaStyle.brightness}%)`);
      }
      if (filters.length > 0) {
        ctx.filter = filters.join(' ');
      }

      if (clip.cropArea && media.width && media.height) {
        const { x: cropX, y: cropY, width: cropWidth, height: cropHeight } = clip.cropArea;
        const actualVideoWidth = video.videoWidth || media.width;
        const actualVideoHeight = video.videoHeight || media.height;
        const scaleX = actualVideoWidth / media.width;
        const scaleY = actualVideoHeight / media.height;
        const adjustedCropX = cropX * scaleX;
        const adjustedCropY = cropY * scaleY;
        const adjustedCropWidth = cropWidth * scaleX;
        const adjustedCropHeight = cropHeight * scaleY;

        ctx.drawImage(
          video,
          adjustedCropX,
          adjustedCropY,
          adjustedCropWidth,
          adjustedCropHeight,
          -width / 2,
          -height / 2,
          width,
          height
        );
      } else {
        ctx.drawImage(video, -width / 2, -height / 2, width, height);
      }

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.filter = 'none';
      ctx.globalAlpha = 1;

      if (mediaStyle.outlineColor && mediaStyle.outlineWidth) {
        ctx.strokeStyle = mediaStyle.outlineColor;
        ctx.lineWidth = mediaStyle.outlineWidth;
        if (mediaStyle.borderRadius) {
          const radius = Math.min(mediaStyle.borderRadius, width / 2, height / 2);
          ctx.beginPath();
          ctx.moveTo(-width / 2 + radius, -height / 2);
          ctx.lineTo(width / 2 - radius, -height / 2);
          ctx.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
          ctx.lineTo(width / 2, height / 2 - radius);
          ctx.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
          ctx.lineTo(-width / 2 + radius, height / 2);
          ctx.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
          ctx.lineTo(-width / 2, -height / 2 + radius);
          ctx.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(-width / 2, -height / 2, width, height);
        }
      }
    } else if (media.type === 'text') {
      const textStyle = clip.textStyle || {};
      let text = clip.text || 'Text';

      if (textStyle.textTransform === 'uppercase') text = text.toUpperCase();
      else if (textStyle.textTransform === 'lowercase') text = text.toLowerCase();
      else if (textStyle.textTransform === 'capitalize') {
        text = text.replace(/\b\w/g, (l: string) => l.toUpperCase());
      }

      const width = clip.width ?? 120;
      const height = clip.height ?? 40;

      const x = clip.x ?? (canvasSize.width - width) / 2;
      const y = clip.y ?? (canvasSize.height - height) / 2;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      ctx.globalAlpha = opacity;

      const fontSize = textStyle.fontSize ?? 48;
      const fontFamily = textStyle.fontFamily || 'Arial';
      const fontStyle = textStyle.fontStyle || 'normal';

      try {
        await document.fonts.load(`${fontStyle} ${fontSize}px "${fontFamily}"`);
      } catch (e) {
        console.warn('字体加载失败，使用默认字体:', e);
      }

      ctx.font = `${fontStyle} ${fontSize}px "${fontFamily}"`;
      ctx.fillStyle = textStyle.color || '#ffffff';
      ctx.textBaseline = 'top';

      const textAlign = textStyle.textAlign || 'center';
      let textX = 0;

      if (textAlign === 'left') {
        ctx.textAlign = 'left';
        textX = -width / 2;
      } else if (textAlign === 'right') {
        ctx.textAlign = 'right';
        textX = width / 2;
      } else {
        ctx.textAlign = 'center';
        textX = 0;
      }

      if (textStyle.shadowColor) {
        ctx.shadowColor = textStyle.shadowColor;
        ctx.shadowOffsetX = textStyle.shadowOffsetX || 0;
        ctx.shadowOffsetY = textStyle.shadowOffsetY || 0;
        ctx.shadowBlur = textStyle.shadowBlur || 0;
      }

      const rawLines = text.split('\n');
      const lines: string[] = [];

      rawLines.forEach((rawLine) => {
        if (rawLine === '') {
          lines.push('');
          return;
        }

        const words = rawLine.split('');
        let currentLine = '';

        for (let i = 0; i < words.length; i++) {
          const testLine = currentLine + words[i];
          const metrics = ctx.measureText(testLine);

          if (metrics.width > width && currentLine !== '') {
            lines.push(currentLine);
            currentLine = words[i];
          } else {
            currentLine = testLine;
          }
        }

        if (currentLine !== '') {
          lines.push(currentLine);
        }
      });

      const lineHeight = fontSize * 1.6;
      const totalTextHeight = lines.length * lineHeight;
      const startY = -totalTextHeight / 2;

      lines.forEach((line, index) => {
        const currentY = startY + index * lineHeight;

        if (textStyle.strokeColor && textStyle.strokeWidth) {
          ctx.strokeStyle = textStyle.strokeColor;
          ctx.lineWidth = textStyle.strokeWidth * 2;
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.strokeText(line, textX, currentY);
        }

        ctx.fillText(line, textX, currentY);

        if (textStyle.textDecoration && textStyle.textDecoration !== 'none') {
          ctx.save();
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

          const metrics = ctx.measureText(line);
          const textWidth = metrics.width;

          let textStartX = textX;
          if (ctx.textAlign === 'center') {
            textStartX = textX - textWidth / 2;
          } else if (ctx.textAlign === 'right') {
            textStartX = textX - textWidth;
          }

          const decorationLineWidth = Math.max(1.5, fontSize * 0.06);
          const decorations = textStyle.textDecoration.split(' ').filter((d: string) => d.trim());

          const drawDecorationLine = (y: number) => {
            ctx.beginPath();
            ctx.moveTo(textStartX, y);
            ctx.lineTo(textStartX + textWidth, y);
            ctx.lineWidth = decorationLineWidth;
            ctx.strokeStyle =
              textStyle.strokeColor && textStyle.strokeWidth
                ? textStyle.strokeColor
                : textStyle.color || '#ffffff';
            ctx.stroke();
          };

          decorations.forEach((decoration: string) => {
            if (decoration === 'underline') {
              const underlineY = currentY + fontSize * 0.85;
              drawDecorationLine(underlineY);
            } else if (decoration === 'line-through') {
              const middleY = currentY + fontSize * 0.5;
              drawDecorationLine(middleY);
            } else if (decoration === 'overline') {
              const topY = currentY - fontSize * 0.15;
              drawDecorationLine(topY);
            }
          });
          ctx.restore();
        }
      });
    }
  } catch (error) {
    console.error('渲染片段失败:', error);
  }

  ctx.restore();
};

/**
 * 导出当前帧为PNG/JPG图片
 *
 * @param clips - 时间轴片段列表
 * @param mediaItems - 媒体素材列表
 * @param currentTime - 要导出的时间点（秒）
 * @param resolution - 导出分辨率（如 "1920x1080"）
 * @param onProgress - 进度回调函数（接收0-100的数值）
 * @param format - 图片格式（PNG 或 JPG）
 * @param canvasRatio - 画布比例
 * @param abortSignal - 取消信号，用于取消导出任务
 * @returns Promise，resolve时返回PNG图片的Blob对象
 */
export const exportFrameAsPNG = async (
  clips: TimelineClip[],
  mediaItems: MediaItem[],
  currentTime: number,
  resolution: string,
  onProgress: (progress: number) => void,
  getBaseCanvasSize: (canvasRatio: string) => { width: number; height: number },
  format: string = 'PNG',
  canvasRatio: string = '16:9',
  abortSignal?: AbortSignal
): Promise<Blob> => {
  const [width, height] = resolution.split('x').map(Number);

  if (!width || !height) {
    throw new Error(`Invalid resolution format: ${resolution}`);
  }

  const canvasSize = { width, height };

  // 检查是否已取消
  if (abortSignal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }

  let currentProgress = 0;
  const updateProgress = (progress: number) => {
    if (progress > currentProgress) {
      currentProgress = progress;
      onProgress(progress);
    }
  };

  updateProgress(0);
  await cancellableDelay(50, abortSignal);

  const canvas = document.createElement('canvas');
  canvas.width = canvasSize.width;
  canvas.height = canvasSize.height;

  updateProgress(5);
  await cancellableDelay(50, abortSignal);

  const ctx = canvas.getContext('2d', {
    willReadFrequently: false,
    alpha: true,
  });

  if (!ctx) {
    throw new Error('无法创建 canvas 上下文');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  updateProgress(10);
  await cancellableDelay(50, abortSignal);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  updateProgress(15);
  await cancellableDelay(50, abortSignal);

  const baseSize = getBaseCanvasSize(canvasRatio);
  const baseWidth = baseSize.width;
  const baseHeight = baseSize.height;

  ctx.save();
  const scale = canvasSize.width / baseWidth;
  ctx.scale(scale, scale);

  const visibleClips = clips
    .filter((clip) => currentTime >= clip.start && currentTime < clip.end)
    .sort((a, b) => b.trackIndex - a.trackIndex);

  updateProgress(20);
  await cancellableDelay(50, abortSignal);

  const totalClips = visibleClips.length;
  if (totalClips === 0) {
    updateProgress(85);
  }

  for (let i = 0; i < visibleClips.length; i++) {
    // 检查是否已取消
    if (abortSignal?.aborted) {
      throw new DOMException('Export was cancelled', 'AbortError');
    }

    const clip = visibleClips[i];
    let media = mediaItems.find((item) => item.id === clip.mediaId);
    if (!media || !media.type) {
      media = {
        id: clip.mediaId,
        name: clip.mediaId,
        text: clip.text || 'Text',
        type: 'text',
        url: '',
      };
    }

    try {
      await renderClipToCanvas(ctx, clip, media, currentTime, {
        width: baseWidth,
        height: baseHeight,
      });
      const progress = 20 + Math.floor(((i + 1) / totalClips) * 65);
      updateProgress(Math.min(progress, 85));
      if (i % Math.max(1, Math.floor(totalClips / 5)) === 0) {
        await cancellableDelay(30, abortSignal);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      console.error('渲染片段失败:', clip, error);
    }
  }

  // 检查是否已取消
  if (abortSignal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }

  ctx.restore();

  updateProgress(85);
  await cancellableDelay(50, abortSignal);

  // 检查是否已取消
  if (abortSignal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }

  return new Promise<Blob>((resolve, reject) => {
    // 如果已取消，直接拒绝
    if (abortSignal?.aborted) {
      reject(new DOMException('Export was cancelled', 'AbortError'));
      return;
    }

    // 设置取消监听
    const abortHandler = () => {
      reject(new DOMException('Export was cancelled', 'AbortError'));
    };
    abortSignal?.addEventListener('abort', abortHandler);

    updateProgress(90);
    const mimeType = format === 'JPG' ? 'image/jpeg' : 'image/png';
    const quality = format === 'JPG' ? 0.95 : undefined;

    canvas.toBlob(
      async (blob) => {
        // 移除取消监听
        abortSignal?.removeEventListener('abort', abortHandler);

        // 检查是否已取消
        if (abortSignal?.aborted) {
          reject(new DOMException('Export was cancelled', 'AbortError'));
          return;
        }

        if (!blob) {
          reject(new Error(`${format} 生成失败`));
          return;
        }

        updateProgress(95);
        await cancellableDelay(100, abortSignal).catch(reject);

        // 再次检查是否已取消
        if (abortSignal?.aborted) {
          reject(new DOMException('Export was cancelled', 'AbortError'));
          return;
        }

        updateProgress(100);
        await cancellableDelay(500, abortSignal).catch(reject);

        // 最后检查是否已取消
        if (abortSignal?.aborted) {
          reject(new DOMException('Export was cancelled', 'AbortError'));
          return;
        }

        resolve(blob);
      },
      mimeType,
      quality
    );
  });
};