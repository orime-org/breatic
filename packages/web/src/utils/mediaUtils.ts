/**
 * Helpers to read dimensions/duration from media `File`s and URLs, and to build thumbnails.
 */

/**
 * Reads natural width/height from a local image file.
 *
 * @param file - Image file
 * @returns Width and height when decode succeeds
 */
export const getImageMeta = async (
  file: File
): Promise<{ width?: number; height?: number }> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: undefined, height: undefined });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

/**
 * Reads natural width/height from an image URL.
 *
 * @param imageUrl - Image URL
 * @returns Width and height when decode succeeds
 */
export const getImageMetaFromUrl = async (
  imageUrl: string
): Promise<{ width?: number; height?: number }> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      resolve({ width: undefined, height: undefined });
    };
    img.src = imageUrl;
  });

/**
 * Reads duration and frame size from a local video file.
 *
 * @param file - Video file
 * @returns Duration and dimensions when metadata loads
 */
export const getVideoMeta = async (
  file: File
): Promise<{ duration?: number; width?: number; height?: number }> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve({
        duration: undefined,
        width: undefined,
        height: undefined,
      });
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });

/**
 * Reads frame size from a video URL (for aspect-ratio layout).
 *
 * @param videoUrl - Video URL
 * @returns Width and height when metadata loads
 */
export const getVideoMetaFromUrl = async (
  videoUrl: string
): Promise<{ width?: number; height?: number }> =>
  new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    video.onerror = () => {
      resolve({ width: undefined, height: undefined });
    };
    video.src = videoUrl;
  });

/**
 * Reads duration from a local audio file.
 *
 * @param file - Audio file
 * @returns Duration when metadata loads
 */
export const getAudioMeta = async (
  file: File
): Promise<{ duration?: number }> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      resolve({ duration: audio.duration });
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => {
      resolve({ duration: undefined });
      URL.revokeObjectURL(url);
    };
    audio.src = url;
  });

/**
 * Reads duration from an audio URL.
 *
 * @param audioUrl - Audio URL
 * @returns Duration when metadata loads
 */
export const getAudioMetaFromUrl = async (
  audioUrl: string
): Promise<{ duration?: number }> =>
  new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous';
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      if (duration && isFinite(duration) && duration > 0) {
        resolve({ duration });
      } else {
        resolve({ duration: undefined });
      }
    };
    audio.onerror = () => {
      resolve({ duration: undefined });
    };
    audio.src = audioUrl;
    audio.load();
  });

/**
 * Samples one video frame from a local file and returns a JPEG data URL.
 *
 * @param file - Video file
 * @returns Base64 data URL of the thumbnail frame
 */
export const extractThumbWithVideoElement = async (
  file: File
): Promise<string> => {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = objectUrl;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    holder.style.top = '-9999px';
    holder.style.width = '1px';
    holder.style.height = '1px';
    holder.style.opacity = '0';
    holder.style.pointerEvents = 'none';
    holder.appendChild(video);
    document.body.appendChild(holder);

    await new Promise<void>((resolve, reject) => {
      const onLoadedMeta = () => resolve();
      const onError = () => reject(new Error('Failed to load video metadata'));
      video.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.load();
    });

    const targetWidth = 360;
    const ratio = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 1;

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = Math.round(targetWidth * ratio);

    const seekTime = video.duration
      ? Math.max(0.2, video.duration * 0.02)
      : 0.2;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Failed to seek video'));
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      try {
        video.currentTime = seekTime;
      } catch {
        video.currentTime = 0;
      }
    });

    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    video.pause();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timeout = setTimeout(finish, 120);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (video as any).requestVideoFrameCallback === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (video as any).requestVideoFrameCallback(() => {
          clearTimeout(timeout);
          finish();
        });
      } else if (video.readyState < 2) {
        video.addEventListener(
          'canplay',
          () => {
            clearTimeout(timeout);
            finish();
          },
          { once: true }
        );
      } else finish();
    });

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode thumbnail'))),
        'image/jpeg',
        0.85
      );
    });

    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });

    document.body.removeChild(holder);

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

/**
 * Draws one frame from a remote or blob video URL into a canvas and returns metadata.
 *
 * Steps: load `video`, seek to `seekTime`, draw to canvas, export JPEG at 90% quality.
 *
 * @param videoUrl - Video URL (remote or object URL)
 * @param seekTime - Timestamp in seconds (default 0.1)
 * @returns Thumbnail data URL plus duration and dimensions
 * @throws When the video fails to load or the canvas context is missing
 *
 * @example
 * ```ts
 * const { thumbnail, duration, width, height } =
 *   await generateVideoThumbnail(videoUrl);
 * console.log(`duration: ${duration}s, size: ${width}x${height}`);
 * ```
 */
export const generateVideoThumbnail = (
  videoUrl: string,
  seekTime: number = 0.1
): Promise<{
  thumbnail: string;
  duration: number;
  width: number;
  height: number;
}> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.crossOrigin = 'anonymous';
    video.currentTime = seekTime;

    video.addEventListener('loadeddata', () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frameUrl = canvas.toDataURL('image/jpeg', 0.9);

      if (!frameUrl || frameUrl.length < 100) {
        reject(new Error('Thumbnail encode failed: empty or too small'));
        return;
      }

      resolve({
        thumbnail: frameUrl,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    });

    video.addEventListener('error', () => {
      reject(new Error(`Failed to load video: ${videoUrl}`));
    });
  });
};

/**
 * Converts a data URL to a `Blob`.
 *
 * @param dataUrl - e.g. `data:image/jpeg;base64,...`
 * @returns Binary blob with inferred MIME type
 */
export const dataURLtoBlob = (dataUrl: string): Blob => {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
};
