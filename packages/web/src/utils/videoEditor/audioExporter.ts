/**
 * Audio export utilities.
 *
 * Uses FFmpeg.wasm in the browser to:
 * - mix timeline audio tracks
 * - support MP3/WAV/AAC/FLAC/AIFF/OGG
 * - control bitrate and sample rate
 * - report export progress
 */

import {FFmpeg} from '@ffmpeg/ffmpeg';
import {fetchFile, toBlobURL} from '@ffmpeg/util';
import {MediaItem, TimelineClip} from '@/spaces/timeline/types';

/** Shared FFmpeg singleton instance. */
let ffmpegInstance: FFmpeg | null = null;

/** Returns initialized FFmpeg singleton. */
const getFFmpeg = async (): Promise<FFmpeg> => {
  if (ffmpegInstance) return ffmpegInstance;

  ffmpegInstance = new FFmpeg();
  ffmpegInstance.on('log', ({ message }) => console.warn('[FFmpeg Audio]:', message));

  // Load FFmpeg core from remote URLs.
  await ffmpegInstance.load({
    coreURL: await toBlobURL('https://breatic.visiony.cc/ffmpeg/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL('https://breatic.visiony.cc/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
  });
  return ffmpegInstance;
};

/** Audio export options. */
export interface AudioExportOptions {
  /** Output audio format. */
  format: string;
  /** Target bitrate in kbps. */
  bitrate: string;
  /** Target sample rate in Hz. */
  sampleRate: number;
}

/**
 * Exports timeline audio into a single file.
 *
 * @param clips timeline clips
 * @param mediaItems media list
 * @param onProgress progress callback
 * @param options export options
 * @param abortSignal optional abort signal
 * @returns exported audio blob
 */
export const exportAudio = async (
  clips: TimelineClip[],
  mediaItems: MediaItem[],
  onProgress: (progress: number) => void,
  options: AudioExportOptions,
  abortSignal?: AbortSignal
): Promise<Blob> => {

  // Abort early if already canceled.
  if (abortSignal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }

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
  await new Promise(resolve => setTimeout(resolve, 30));

  // Initialize FFmpeg.
  updateProgress(3);
  await new Promise(resolve => setTimeout(resolve, 20));

  const ffmpeg = await getFFmpeg();

  updateProgress(8);
  await new Promise(resolve => setTimeout(resolve, 20));

  // Compute total timeline duration.
  updateProgress(10);
  await new Promise(resolve => setTimeout(resolve, 20));

  const duration = clips.length > 0 ? Math.max(...clips.map(c => c.end)) : 0;

  if (duration === 0) {
    throw new Error('No audio content to export');
  }

  updateProgress(12);
  await new Promise(resolve => setTimeout(resolve, 20));

  // Collect audio sources from video/audio clips.
  updateProgress(14);
  await new Promise(resolve => setTimeout(resolve, 20));

  const audioSources: Array<{
    clip: TimelineClip;
    media: MediaItem;
    url: string;
  }> = [];

  for (const clip of clips) {
    const media = mediaItems.find(m => m.id === clip.mediaId);
    if (!media || !media.url) continue;

    // Both video and audio media can contribute tracks.
    if (media.type === 'video' || media.type === 'audio') {
      audioSources.push({
        clip,
        media,
        url: media.url,
      });
    }
  }


  if (audioSources.length === 0) {
    throw new Error('No audio tracks found');
  }

  updateProgress(18);
  await new Promise(resolve => setTimeout(resolve, 20));

  updateProgress(20);
  await new Promise(resolve => setTimeout(resolve, 30));

  try {
    for (let i = 0; i < audioSources.length; i++) {
      const source = audioSources[i];
      const inputFileName = `input_${i}.mp4`;
      const audioData = await fetchFile(source.url);
      await ffmpeg.writeFile(inputFileName, audioData);

      // Update progress after each source is loaded.
      const loadProgress = 20 + Math.floor(((i + 1) / audioSources.length) * 15);
      updateProgress(loadProgress);

      // Add a tiny delay for smoother progress updates.
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    updateProgress(35);
    await new Promise(resolve => setTimeout(resolve, 20));

    // Step 2: create silent base track for full duration.
    updateProgress(37);

    await ffmpeg.exec([
      '-f', 'lavfi',
      '-i', `anullsrc=r=${options.sampleRate}:cl=stereo`,
      '-t', duration.toString(),
      '-ar', options.sampleRate.toString(),
      'silence.wav'
    ]);

    updateProgress(42);

    // Step 3: build FFmpeg filter_complex chain (42% -> 48%).
    updateProgress(44);

    let filterComplex = '';
    const mixInputs: string[] = ['[0:a]']; // Silent base input.

    for (let i = 0; i < audioSources.length; i++) {
      const source = audioSources[i];
      const { clip } = source;

      // Compute trim range.
      const trimStart = clip.trimStart || 0;
      const trimEnd = clip.trimEnd || (source.media.duration || clip.end - clip.start);

      // Build chain: trim -> reset PTS -> delay.
      filterComplex += `[${i + 1}:a]atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS,adelay=${clip.start * 1000}|${clip.start * 1000}[a${i}];`;
      mixInputs.push(`[a${i}]`);

      // Update progress while building filters.
      const filterProgress = 44 + Math.floor(((i + 1) / audioSources.length) * 4);
      updateProgress(filterProgress);
    }

    // Mix all inputs.
    filterComplex += `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[aout]`;

    updateProgress(48);

    // Step 4: run audio mixing.
    const inputFiles = ['-i', 'silence.wav'];
    for (let i = 0; i < audioSources.length; i++) {
      inputFiles.push('-i', `input_${i}.mp4`);
    }

    // Build codec args by output format.
    let codecArgs: string[] = [];
    const formatLower = options.format.toLowerCase();

    switch (formatLower) {
      case 'mp3':
        codecArgs = [
          '-c:a', 'libmp3lame',
          '-b:a', `${options.bitrate}k`,
        ];
        break;
      case 'wav':
        codecArgs = [
          '-c:a', 'pcm_s16le',
        ];
        break;
      case 'aac':
        codecArgs = [
          '-c:a', 'aac',
          '-b:a', `${options.bitrate}k`,
        ];
        break;
      case 'flac':
        codecArgs = [
          '-c:a', 'flac',
        ];
        break;
      case 'aiff':
        codecArgs = [
          '-c:a', 'pcm_s16be',
          '-f', 'aiff',
        ];
        break;
      case 'ogg':
        codecArgs = [
          '-c:a', 'libvorbis',
          '-b:a', `${options.bitrate}k`,
        ];
        break;
      default:
        codecArgs = [
          '-c:a', 'libmp3lame',
          '-b:a', `${options.bitrate}k`,
        ];
    }

    // Check cancel before encoding.
    if (abortSignal?.aborted) {
      throw new DOMException('Export was cancelled', 'AbortError');
    }

    updateProgress(50);

    // Use FFmpeg progress events for encoding progress.
    // `progress` is 0..1 based on processed media time.
    const progressHandler = ({ progress: prog }: { progress: number }) => {
      // Map FFmpeg progress to encoding stage (50% -> 92%).
      const encodingProgress = 50 + Math.floor(prog * 42);
      updateProgress(Math.min(encodingProgress, 92));
    };

    ffmpeg.on('progress', progressHandler);

    try {
      await ffmpeg.exec([
        ...inputFiles,
        '-filter_complex', filterComplex,
        '-map', '[aout]',
        ...codecArgs,
        '-ar', options.sampleRate.toString(),
        '-t', duration.toString(),
        `output.${formatLower}`
      ]);
    } finally {
      // Remove progress listener.
      ffmpeg.off('progress', progressHandler);
    }

    // Encoding finished.
    updateProgress(92);

    // Read output file (92% -> 98%).
    const data = await ffmpeg.readFile(`output.${formatLower}`) as Uint8Array;
    updateProgress(95);

    // Select MIME type and create blob.
    let mimeType = 'audio/mpeg';
    switch (formatLower) {
      case 'mp3': mimeType = 'audio/mpeg'; break;
      case 'wav': mimeType = 'audio/wav'; break;
      case 'aac': mimeType = 'audio/aac'; break;
      case 'flac': mimeType = 'audio/flac'; break;
      case 'aiff': mimeType = 'audio/aiff'; break;
      case 'ogg': mimeType = 'audio/ogg'; break;
    }

    const blob = new Blob([new Uint8Array(data.buffer as ArrayBuffer)], { type: mimeType });
    updateProgress(98);

    // Cleanup temp files asynchronously.
    Promise.all([
      ffmpeg.deleteFile('silence.wav').catch(() => {}),
      ...audioSources.map((_, i) => ffmpeg.deleteFile(`input_${i}.mp4`).catch(() => {})),
      ffmpeg.deleteFile(`output.${formatLower}`).catch(() => {})
    ]).catch(() => {
      // Ignore cleanup failures.
    });

    // Finalize and return blob.
    updateProgress(100);
    return blob;
  } catch (error) {
    // Re-throw abort errors directly.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    console.error('❌ Audio export failed:', error);
    throw error;
  }
};