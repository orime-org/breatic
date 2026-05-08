/**
 * FFmpeg video exporter.
 *
 * Uses FFmpeg.wasm in the browser to:
 * - compose multi-track video/image/text clips
 * - mix audio tracks
 * - apply trim and transforms
 * - export MP4 with progress updates
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { MediaItem, TimelineClip } from '@/spaces/timeline/types';

/** Shared FFmpeg singleton instance. */
let ffmpegInstance: FFmpeg | null = null;

/**
 * Returns initialized FFmpeg singleton.
 *
 * Loads FFmpeg.wasm core on first call and reuses it after.
 *
 * @returns FFmpeg instance
 */
const getFFmpeg = async (): Promise<FFmpeg> => {
  if (ffmpegInstance) return ffmpegInstance;

  ffmpegInstance = new FFmpeg();
  ffmpegInstance.on('log', ({ message }) => console.warn('[FFmpeg]:', message));

  // Load FFmpeg core from remote URLs.
  await ffmpegInstance.load({
    coreURL: await toBlobURL('https://breatic.visiony.cc/ffmpeg/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL('https://breatic.visiony.cc/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
  });

  return ffmpegInstance;
};


/**
 * Loads an image element asynchronously.
 *
 * @param url image URL
 * @returns loaded image element
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
 * Loads a video element asynchronously.
 *
 * Only metadata is preloaded.
 *
 * @param url video URL
 * @returns loaded video element
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

const renderSingleClip = async (
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  media: MediaItem,
  currentTime: number,
  canvasSize: { width: number; height: number }
): Promise<void> => {
  ctx.save();

  const rotation = (clip.rotation ?? 0) * Math.PI / 180;
  const scale = clip.scale ?? 1;
  const opacity = (clip.opacity ?? 100) / 100;

  try {
    if (media.type === 'image' && media.url) {
      const img = await loadImage(media.url);
      const width = clip.width ?? img.width;
      const height = clip.height ?? img.height;

      // Compute top-left and center coordinates.
      const x = clip.x ?? (canvasSize.width - width) / 2;
      const y = clip.y ?? (canvasSize.height - height) / 2;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      // Apply translate/rotate/scale (matches outer transform).
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      const mediaStyle = clip.mediaStyle || {};

      // Step 1: draw shadow by painting a shape.
      if (mediaStyle.shadowColor && mediaStyle.shadowBlur) {
        ctx.shadowColor = mediaStyle.shadowColor;
        ctx.shadowBlur = mediaStyle.shadowBlur || 0;
        ctx.shadowOffsetX = mediaStyle.shadowOffsetX || 0;
        ctx.shadowOffsetY = mediaStyle.shadowOffsetY || 0;

        // Draw a shape to emit shadow.
        if (mediaStyle.borderRadius) {
          // Rounded rectangle shadow shape.
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
          ctx.fillStyle = 'black'; // Temporary fill for shadow pass.
          ctx.fill();
        } else {
          // Rectangle shadow shape.
          ctx.fillStyle = 'black'; // Temporary fill for shadow pass.
          ctx.fillRect(-width / 2, -height / 2, width, height);
        }

        // Reset shadow styles.
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      // Step 2: apply rounded clipping path.
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

      // Step 3: apply opacity and filters.
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

      // Step 4: draw image content.
      if (clip.cropArea && media.width && media.height) {
        // Draw cropped image.
        const { x: cropX, y: cropY, width: cropWidth, height: cropHeight } = clip.cropArea;

        // Align crop area to actual image size.
        const actualImageWidth = img.naturalWidth || media.width;
        const actualImageHeight = img.naturalHeight || media.height;


        // Adjust crop coordinates when dimensions differ.
        const scaleX = actualImageWidth / media.width;
        const scaleY = actualImageHeight / media.height;

        const adjustedCropX = cropX * scaleX;
        const adjustedCropY = cropY * scaleY;
        const adjustedCropWidth = cropWidth * scaleX;
        const adjustedCropHeight = cropHeight * scaleY;

        ctx.drawImage(
          img,
          adjustedCropX, adjustedCropY, adjustedCropWidth, adjustedCropHeight, // Source crop.
          -width / 2, -height / 2, width, height // Destination area.
        );
      } else {
        ctx.drawImage(img, -width / 2, -height / 2, width, height);
      }

      // Reset shadow/filter before outline pass.
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.filter = 'none';
      ctx.globalAlpha = 1;

      // Draw outline outside filtered pass.
      if (mediaStyle.outlineColor && mediaStyle.outlineWidth) {
        ctx.strokeStyle = mediaStyle.outlineColor;
        ctx.lineWidth = mediaStyle.outlineWidth;
        if (mediaStyle.borderRadius) {
          // Use rounded path for rounded outline.
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

      // Compute top-left and center coordinates.
      const x = clip.x ?? (canvasSize.width - width) / 2;
      const y = clip.y ?? (canvasSize.height - height) / 2;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      // Apply translate/rotate/scale (matches outer transform).
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      const trimStart = clip.trimStart || 0;
      const videoTime = trimStart + (currentTime - clip.start);
      video.currentTime = Math.max(0, Math.min(videoTime, video.duration));

      await new Promise<void>(resolve => {
        const checkReady = () => {
          if (video.readyState >= 2) resolve();
          else setTimeout(checkReady, 50);
        };
        checkReady();
      });

      const mediaStyle = clip.mediaStyle || {};

      // Step 1: draw shadow by painting a shape.
      if (mediaStyle.shadowColor && mediaStyle.shadowBlur) {
        ctx.shadowColor = mediaStyle.shadowColor;
        ctx.shadowBlur = mediaStyle.shadowBlur || 0;
        ctx.shadowOffsetX = mediaStyle.shadowOffsetX || 0;
        ctx.shadowOffsetY = mediaStyle.shadowOffsetY || 0;

        // Draw a shape to emit shadow.
        if (mediaStyle.borderRadius) {
          // Rounded rectangle shadow shape.
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
          ctx.fillStyle = 'black'; // Temporary fill for shadow pass.
          ctx.fill();
        } else {
          // Rectangle shadow shape.
          ctx.fillStyle = 'black'; // Temporary fill for shadow pass.
          ctx.fillRect(-width / 2, -height / 2, width, height);
        }

        // Reset shadow styles.
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      // Step 2: apply rounded clipping path.
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

      // Step 3: apply opacity and filters.
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

      // Step 4: draw video content.
      if (clip.cropArea && media.width && media.height) {
        // Draw cropped video.
        const { x: cropX, y: cropY, width: cropWidth, height: cropHeight } = clip.cropArea;

        // Align crop area to actual video size.
        const actualVideoWidth = video.videoWidth || media.width;
        const actualVideoHeight = video.videoHeight || media.height;

        // Adjust crop coordinates when dimensions differ.
        const scaleX = actualVideoWidth / media.width;
        const scaleY = actualVideoHeight / media.height;

        const adjustedCropX = cropX * scaleX;
        const adjustedCropY = cropY * scaleY;
        const adjustedCropWidth = cropWidth * scaleX;
        const adjustedCropHeight = cropHeight * scaleY;

        ctx.drawImage(
          video,
          adjustedCropX, adjustedCropY, adjustedCropWidth, adjustedCropHeight, // Source crop.
          -width / 2, -height / 2, width, height // Destination area.
        );
      } else {
        ctx.drawImage(video, -width / 2, -height / 2, width, height);
      }

      // Reset shadow/filter before outline pass.
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.filter = 'none';
      ctx.globalAlpha = 1;

      // Draw outline outside filtered pass.
      if (mediaStyle.outlineColor && mediaStyle.outlineWidth) {
        ctx.strokeStyle = mediaStyle.outlineColor;
        ctx.lineWidth = mediaStyle.outlineWidth;
        if (mediaStyle.borderRadius) {
          // Use rounded path for rounded outline.
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

      // Compute center coordinates from top-left position.
      const x = clip.x ?? (canvasSize.width - width) / 2;
      const y = clip.y ?? (canvasSize.height - height) / 2;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      // Apply translate/rotate/scale.
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      // Apply opacity.
      ctx.globalAlpha = opacity;

      // Set text style.
      const fontSize = textStyle.fontSize ?? 48; // Default font size.
      const fontFamily = textStyle.fontFamily || 'Arial';
      const fontStyle = textStyle.fontStyle || 'normal';

      // Ensure target font is available before drawing.
      try {
        await document.fonts.load(`${fontStyle} ${fontSize}px "${fontFamily}"`);
      } catch (e) {
        console.warn('Font load failed, fallback to default font:', e);
      }

      ctx.font = `${fontStyle} ${fontSize}px "${fontFamily}"`;
      ctx.fillStyle = textStyle.color || '#ffffff';
      ctx.textBaseline = 'top'; // Better control for multiline rendering.

      // Resolve text anchor by alignment.
      const textAlign = textStyle.textAlign || 'center';
      let textX = 0;

      if (textAlign === 'left') {
        ctx.textAlign = 'left';
        textX = -width / 2; // Left edge of text box.
      } else if (textAlign === 'right') {
        ctx.textAlign = 'right';
        textX = width / 2; // Right edge of text box.
      } else {
        ctx.textAlign = 'center';
        textX = 0; // Center of text box.
      }

      // Apply text shadow.
      if (textStyle.shadowColor) {
        ctx.shadowColor = textStyle.shadowColor;
        ctx.shadowOffsetX = textStyle.shadowOffsetX || 0;
        ctx.shadowOffsetY = textStyle.shadowOffsetY || 0;
        ctx.shadowBlur = textStyle.shadowBlur || 0;
      }

      // Split into lines and wrap by width.
      const rawLines = text.split('\n');
      const lines: string[] = [];

      // Wrap each raw line.
      rawLines.forEach((rawLine) => {
        if (rawLine === '') {
          // Keep empty lines.
          lines.push('');
          return;
        }

        // Wrap when measured width exceeds text box width.
        const words = rawLine.split('');
        let currentLine = '';

        for (let i = 0; i < words.length; i++) {
          const testLine = currentLine + words[i];
          const metrics = ctx.measureText(testLine);

          if (metrics.width > width && currentLine !== '') {
            // Push current line and continue.
            lines.push(currentLine);
            currentLine = words[i];
          } else {
            currentLine = testLine;
          }
        }

        // Append last wrapped line.
        if (currentLine !== '') {
          lines.push(currentLine);
        }
      });

      const lineHeight = fontSize * 1.6; // Relative line height.
      const totalTextHeight = lines.length * lineHeight;
      const startY = -totalTextHeight / 2; // Vertical center alignment.

      // Draw each line.
      lines.forEach((line, index) => {
        const currentY = startY + index * lineHeight;

        // Draw stroke before fill for better edge quality.
        if (textStyle.strokeColor && textStyle.strokeWidth) {
          ctx.strokeStyle = textStyle.strokeColor;
          ctx.lineWidth = textStyle.strokeWidth * 2; // Canvas strokes are centered.
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.strokeText(line, textX, currentY);
        }

        // Draw fill text.
        ctx.fillText(line, textX, currentY);

        // Draw decoration lines.
        if (textStyle.textDecoration && textStyle.textDecoration !== 'none') {
          ctx.save();
          ctx.shadowColor = 'transparent'; // Remove shadow for decoration pass.
          ctx.shadowBlur = 0;

          const metrics = ctx.measureText(line);
          const textWidth = metrics.width;

          // Resolve text start X by alignment.
          let textStartX = textX;
          if (ctx.textAlign === 'center') {
            textStartX = textX - textWidth / 2;
          } else if (ctx.textAlign === 'right') {
            textStartX = textX - textWidth;
          }
          // For left align, textStartX equals textX.

          const decorationLineWidth = Math.max(1.5, fontSize * 0.06);

          // Parse decorations (supports multiple values).
          const decorations = textStyle.textDecoration.split(' ').filter((d: string) => d.trim());

          // Helper to draw one decoration line.
          const drawDecorationLine = (y: number) => {
            ctx.beginPath();
            ctx.moveTo(textStartX, y);
            ctx.lineTo(textStartX + textWidth, y);
            ctx.lineWidth = decorationLineWidth;
            // Prefer stroke color when stroke is enabled.
            ctx.strokeStyle = (textStyle.strokeColor && textStyle.strokeWidth)
              ? textStyle.strokeColor
              : (textStyle.color || '#ffffff');
            ctx.stroke();
          };

          decorations.forEach((decoration: string) => {
            if (decoration === 'underline') {
              // Underline position near CSS baseline equivalent.
              const underlineY = currentY + fontSize * 0.85;
              drawDecorationLine(underlineY);
            } else if (decoration === 'line-through') {
              // Line-through near vertical middle.
              const middleY = currentY + fontSize * 0.5;
              drawDecorationLine(middleY);
            } else if (decoration === 'overline') {
              // Overline slightly above glyph box.
              const topY = currentY - fontSize * 0.15;
              drawDecorationLine(topY);
            }
          });
          ctx.restore();
        }
      });
    }
  } catch (error) {
    console.error('Failed to render clip:', error);
  }

  ctx.restore();
};

const getBaseCanvasSize = (canvasRatio: string): { width: number; height: number } => {
  switch (canvasRatio) {
    case '16:9':
      return { width: 1920, height: 1080 };
    case '9:16':
      return { width: 1080, height: 1920 };
    case '1:1':
      return { width: 1080, height: 1080 };
    default:
      // Default to 16:9.
      return { width: 1920, height: 1080 };
  }
};

const renderFrame = async (
  ctx: CanvasRenderingContext2D,
  clips: TimelineClip[],
  mediaItems: MediaItem[],
  currentTime: number,
  canvasSize: { width: number; height: number },
  canvasRatio: string
): Promise<void> => {
  // Get virtual base size from canvas ratio.
  // All clip coordinates are stored in this virtual space.
  const baseSize = getBaseCanvasSize(canvasRatio);
  const baseWidth = baseSize.width;
  const baseHeight = baseSize.height;

  // Clear canvas background.
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

  ctx.save();

  // Scale uniformly to avoid distortion (same as PreviewCanvas).
  // Use width as the scale reference.
  const scale = canvasSize.width / baseWidth;
  ctx.scale(scale, scale);

  // Get visible clips at current time.
  const visibleClips = clips
    .filter(clip => currentTime >= clip.start && currentTime < clip.end)
    .sort((a, b) => b.trackIndex - a.trackIndex);

  // Render clips in virtual coordinate space.
  for (const clip of visibleClips) {
    const media = mediaItems.find(item => item.id === clip.mediaId);
    if (!media || media.type === 'audio') continue;

    await renderSingleClip(ctx, clip, media, currentTime, { width: baseWidth, height: baseHeight });
  }

  ctx.restore();
};

/** Video export options. */
export interface ExportOptions {
  /** Output resolution, e.g. "1920x1080". */
  resolution?: string;
  /** Output frame rate in fps. */
  frameRate?: number;
  /** Video bitrate, e.g. "2M" or "5M". */
  bitrate?: string;
  /** Bitrate mode, e.g. "cbr" or "vbr". */
  bitrateMode?: string;
  /** Video codec, e.g. "libx264". */
  codec?: string;
  /** Audio sample rate in Hz. */
  audioSampleRate?: number;
  /** Audio quality/bitrate preset. */
  audioQuality?: string;
  /** Output container format. */
  format?: string;
}

/**
 * Exports timeline media as MP4/MOV using FFmpeg.wasm.
 *
 * @param clips timeline clips
 * @param mediaItems media list
 * @param canvasRatio canvas ratio
 * @param onProgress progress callback (0..100)
 * @param options optional export settings
 * @returns exported video blob
 */
export const exportAsMP4 = async (
  clips: TimelineClip[],
  mediaItems: MediaItem[],
  canvasRatio: string,
  onProgress: (progress: number) => void,
  options?: ExportOptions,
  abortSignal?: AbortSignal
): Promise<Blob> => {

  // Abort early if already canceled.
  if (abortSignal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }
  // Use user-selected resolution directly.
  const resolution = options?.resolution ?? '1920x1080';
  const [width, height] = resolution.split('x').map(Number);

  if (!width || !height) {
    throw new Error(`Invalid resolution format: ${resolution}`);
  }

  const canvasSize = { width, height };

  const fps = options?.frameRate ?? 30;
  const audioSampleRate = options?.audioSampleRate ?? 44100;

  // Compute bitrate using Bits Per Pixel (BPP).
  // Formula: bitrate = pixels * fps * bpp factor.
  const totalPixels = width * height;
  let bitrate = '5M';
  const bitrateOption = options?.bitrate ?? 'recommended';

  /**
   * Helper for dynamic bitrate calculation.
   * @param bpp bits per pixel
   * @param codecEfficiency codec efficiency factor
   * @returns bitrate string, e.g. "5M"
   */
  const calculateBitrate = (bpp: number, codecEfficiency: number = 1.0): string => {
    // Base bitrate = pixels * fps * bpp.
    let bitrateKbps = (totalPixels * fps * bpp) / 1000; // Convert to kbps.

    // Adjust for codec efficiency.
    bitrateKbps = bitrateKbps * codecEfficiency;

    // Clamp bitrate range.
    const minBitrate = 500; // Minimum 500 kbps.
    const maxBitrate = 100000; // Maximum 100 Mbps.
    bitrateKbps = Math.max(minBitrate, Math.min(maxBitrate, bitrateKbps));

    // Convert to Mbps with one decimal.
    const bitrateMbps = Math.round(bitrateKbps / 100) / 10;

    return `${bitrateMbps}M`;
  };

  // Resolve codec efficiency factor.
  const getCodecEfficiency = (): number => {
    const codecType = options?.codec ?? 'libx264';
    if (codecType === 'libx265' || codecType === 'libx265_alpha' || codecType === 'libx265_422') {
      return 0.6; // H.265 is more efficient than H.264.
    } else if (codecType === 'libaom-av1') {
      return 0.5; // AV1 is more efficient than H.264.
    }
    return 1.0; // H.264 baseline.
  };

  const codecEfficiency = getCodecEfficiency();

  if (bitrateOption === 'lower') {
    // Lower quality preset.
    bitrate = calculateBitrate(0.07, codecEfficiency);
  } else if (bitrateOption === 'recommended') {
    // Recommended quality preset.
    bitrate = calculateBitrate(0.12, codecEfficiency);
  } else if (bitrateOption === 'higher') {
    // Higher quality preset.
    bitrate = calculateBitrate(0.20, codecEfficiency);
  } else {
    // Use custom bitrate value.
    bitrate = bitrateOption;
  }

  // Normalize codec variant.
  let codec = options?.codec ?? 'libx264';
  let pixelFormat = 'yuv420p';

  if (codec === 'libx265_alpha') {
    codec = 'libx265';
    pixelFormat = 'yuva420p';
  } else if (codec === 'libx265_422') {
    codec = 'libx265';
    pixelFormat = 'yuv422p';
  }

  // Resolve audio codec settings.
  const audioQuality = options?.audioQuality ?? 'aac_192';
  let audioCodec = 'aac';
  let audioBitrate = '192k';

  if (audioQuality === 'aac_192') {
    audioCodec = 'aac';
    audioBitrate = '192k';
  } else if (audioQuality === 'aac_256') {
    audioCodec = 'aac';
    audioBitrate = '256k';
  } else if (audioQuality === 'aac_320') {
    audioCodec = 'aac';
    audioBitrate = '320k';
  } else if (audioQuality === 'pcm') {
    audioCodec = 'pcm_s16le';
    audioBitrate = ''; // PCM does not use bitrate arg.
  }

  const duration = clips.length > 0 ? Math.max(...clips.map(c => c.end)) : 10;
  const outputFormat = options?.format ?? 'MP4';
  const outputFile = outputFormat === 'MOV' ? 'output.mov' : 'output.mp4';

  // Keep progress monotonic.
  let currentProgress = 0;
  const updateProgress = (progress: number) => {
    if (progress > currentProgress) {
      currentProgress = progress;
      onProgress(progress);
    }
  };

  // Start from 0%.
  updateProgress(0);

  try {
    // Initialize FFmpeg and canvas.
    const ffmpeg = await getFFmpeg();

    const canvas = document.createElement('canvas');
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    const ctx = canvas.getContext('2d', {
      willReadFrequently: false,
      alpha: true,
    });

    if (!ctx) throw new Error('Failed to create canvas context');

    // Enable high-quality image smoothing.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const totalFrames = Math.ceil(duration * fps);

    // Render frames: 0% -> 55%.
    for (let i = 0; i < totalFrames; i++) {
      // Check abort signal during frame rendering.
      if (abortSignal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }

      const time = i / fps;
      await renderFrame(ctx, clips, mediaItems, time, canvasSize, canvasRatio);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Failed to export frame')), 'image/png', 0.9);
      });

      await ffmpeg.writeFile(`frame${i.toString().padStart(5, '0')}.png`, await fetchFile(blob));
      // Update progress based on rendered frame count.
      const frameProgress = Math.floor(((i + 1) / totalFrames) * 55);
      updateProgress(Math.min(frameProgress, 55));
    }

    updateProgress(55);

    // Check abort signal before audio stage.
    if (abortSignal?.aborted) {
      throw new DOMException('Export was cancelled', 'AbortError');
    }

    // Process audio: 55% -> 60%.
    const audioClips = clips.filter(clip => {
      const m = mediaItems.find(item => item.id === clip.mediaId);
      return m && (m.type === 'audio' || m.type === 'video');
    });

    let hasAudio = false;
    const audioFilterComplexParts: string[] = [];

    if (audioClips.length > 0) {
      // Process each audio clip.
      for (let i = 0; i < audioClips.length; i++) {
        const clip = audioClips[i];
        const audioMedia = mediaItems.find(item => item.id === clip.mediaId);

        if (!audioMedia) continue;

        try {
          const audioData = await fetchFile(audioMedia.url);
          const ext = audioMedia.type === 'audio' ? 'mp3' : 'mp4';
          const fileName = `audio_${i}.${ext}`;
          await ffmpeg.writeFile(fileName, audioData);

          // Build audio filter chain.
          const trimStart = clip.trimStart || 0;
          const trimEnd = clip.trimEnd || (audioMedia.duration || duration);
          const volume = (clip.volume ?? 100) / 100;
          const speed = clip.speed ?? 1;

          // Audio chain: trim, speed, volume, delay.
          let audioFilter = `[${i + 1}:a]`;

          // 1) Trim audio.
          audioFilter += `atrim=${trimStart}:${trimEnd},asetpts=PTS-STARTPTS`;

          // 2) Apply playback speed.
          if (speed !== 1) {
            audioFilter += `,atempo=${speed}`;
          }

          // 3) Apply volume.
          if (volume !== 1) {
            audioFilter += `,volume=${volume}`;
          }

          // 4) Delay to clip start time.
          if (clip.start > 0) {
            audioFilter += `,adelay=${clip.start * 1000}|${clip.start * 1000}`;
          }

          audioFilter += `[a${i}]`;
          audioFilterComplexParts.push(audioFilter);

          hasAudio = true;

          // Update progress based on loaded audio count.
          const audioProgress = 55 + Math.floor(((i + 1) / audioClips.length) * 5);
          updateProgress(Math.min(audioProgress, 60));
        } catch (error) {
          console.warn(`Failed to load audio ${i}:`, error);
        }
      }
    }

    updateProgress(60);

    // Check abort signal before encoding.
    if (abortSignal?.aborted) {
      throw new DOMException('Export was cancelled', 'AbortError');
    }

    // Encode video: 60% -> 92%.
    // Use FFmpeg progress events based on media time.
    const progressHandler = ({ progress: prog }: { progress: number }) => {
      // Map FFmpeg progress to encoding stage (60% -> 92%).
      const encodingProgress = 60 + Math.floor(prog * 32);
      updateProgress(Math.min(encodingProgress, 92));
    };

    ffmpeg.on('progress', progressHandler);

    try {
      if (hasAudio && audioFilterComplexParts.length > 0) {
        // Build FFmpeg args.
        const ffmpegArgs = [
          '-framerate', fps.toString(),
          '-i', 'frame%05d.png',
        ];

        // Add all audio input files.
        for (let i = 0; i < audioFilterComplexParts.length; i++) {
          const clip = audioClips[i];
          const audioMedia = mediaItems.find(item => item.id === clip.mediaId);
          if (audioMedia) {
            const ext = audioMedia.type === 'audio' ? 'mp3' : 'mp4';
            ffmpegArgs.push('-i', `audio_${i}.${ext}`);
          }
        }

        // Mix tracks when multiple audio inputs exist.
        if (audioFilterComplexParts.length > 1) {
          // Mix all audio tracks.
          const mixInputs = audioFilterComplexParts.map((_, i) => `[a${i}]`).join('');
          const filterComplex = audioFilterComplexParts.join(';') + `;${mixInputs}amix=inputs=${audioFilterComplexParts.length}:duration=longest[aout]`;

          ffmpegArgs.push(
            '-filter_complex', filterComplex,
            '-map', '0:v', '-map', '[aout]',
            '-c:v', codec, '-preset', 'fast', '-b:v', bitrate, '-pix_fmt', pixelFormat,
            '-c:a', audioCodec
          );
        } else {
          // Single audio track path.
          const filterComplex = audioFilterComplexParts[0];
          ffmpegArgs.push(
            '-filter_complex', filterComplex,
            '-map', '0:v', '-map', '[a0]',
            '-c:v', codec, '-preset', 'fast', '-b:v', bitrate, '-pix_fmt', pixelFormat,
            '-c:a', audioCodec
          );
        }

        // Add output audio sample rate.
        ffmpegArgs.push('-ar', audioSampleRate.toString());

        // Add audio bitrate when codec uses it.
        if (audioBitrate) {
          ffmpegArgs.push('-b:a', audioBitrate);
        }

        ffmpegArgs.push('-t', duration.toString(), outputFile);

        await ffmpeg.exec(ffmpegArgs);
      } else {
        // Export video-only output.
        await ffmpeg.exec([
          '-framerate', fps.toString(),
          '-i', 'frame%05d.png',
          '-c:v', codec, '-preset', 'fast', '-b:v', bitrate, '-pix_fmt', pixelFormat,
          '-t', duration.toString(),
          outputFile
        ]);
      }
    } finally {
      // Remove progress listener.
      ffmpeg.off('progress', progressHandler);
    }

    // Encoding finished.
    updateProgress(92);

    // Read output file (92% -> 98%).
    const data = await ffmpeg.readFile(outputFile) as Uint8Array;
    updateProgress(95);

    const arrayBuffer = new ArrayBuffer(data.length);
    new Uint8Array(arrayBuffer).set(data);
    const mimeType = outputFormat === 'MOV' ? 'video/quicktime' : 'video/mp4';
    const videoBlob = new Blob([arrayBuffer], { type: mimeType });

    updateProgress(98);

    // Cleanup temporary files asynchronously.
    Promise.all([
      // Delete frame files.
      ...Array.from({ length: totalFrames }, (_, i) =>
        ffmpeg.deleteFile(`frame${i.toString().padStart(5, '0')}.png`).catch(() => {})
      ),
      // Delete audio files.
      ...(hasAudio ? audioClips.map((clip, i) => {
        const audioMedia = mediaItems.find(item => item.id === clip.mediaId);
        if (audioMedia) {
          const ext = audioMedia.type === 'audio' ? 'mp3' : 'mp4';
          return ffmpeg.deleteFile(`audio_${i}.${ext}`).catch(() => {});
        }
        return Promise.resolve();
      }) : []),
      // Delete output file.
      ffmpeg.deleteFile(outputFile).catch(() => {})
    ]).catch(() => {
      // Ignore cleanup failures.
    });

    // Finalize and return blob.
    updateProgress(100);
    return videoBlob;

  } catch (error) {
    // Re-throw abort errors directly.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    console.error('❌ Video export failed:', error);
    throw new Error(`Video export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};