// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The pixel size of a picture or a video, read off the file being added
 * (inner#1127 A23). The block stores it so the media keeps its place at its
 * final size while it loads; the upload's answer carries no size, so the
 * file the browser already holds is where it is read.
 */

/** A pixel size. */
export interface MediaSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A size worth keeping: both sides whole and above zero.
 * @param width - The width read.
 * @param height - The height read.
 * @returns The size, or undefined.
 */
function sizeOf(width: number, height: number): MediaSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Reads a picture's size the way the page shows it: an image element that is
 * never drawn reads the size from the file without decoding its pixels, and
 * turns it by the file's orientation as the body's own picture does.
 * @param file - The picture.
 * @returns Its size, or undefined when the browser cannot read it.
 */
function pictureSize(file: File): Promise<MediaSize | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    const address = URL.createObjectURL(file);
    /**
     * Lets the file go and answers.
     * @param size - The answer.
     */
    const done = (size: MediaSize | undefined): void => {
      URL.revokeObjectURL(address);
      resolve(size);
    };
    image.onload = (): void => {
      done(sizeOf(image.naturalWidth, image.naturalHeight));
    };
    image.onerror = (): void => {
      done(undefined);
    };
    image.src = address;
  });
}

/**
 * Reads a video's size off its metadata.
 * @param file - The video.
 * @returns Its size, or undefined when the browser cannot read it.
 */
function videoSize(file: File): Promise<MediaSize | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const address = URL.createObjectURL(file);
    /**
     * Lets the file go and answers.
     * @param size - The answer.
     */
    const done = (size: MediaSize | undefined): void => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(address);
      resolve(size);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = (): void => {
      done(sizeOf(video.videoWidth, video.videoHeight));
    };
    video.onerror = (): void => {
      done(undefined);
    };
    video.src = address;
  });
}

/**
 * The pixel size of a file being added, for a picture or a video.
 * @param file - The file.
 * @returns Its size, or undefined for audio and anything the browser cannot read.
 */
export function measureMediaFile(file: File): Promise<MediaSize | undefined> {
  if (file.type.startsWith('image/')) return pictureSize(file);
  if (file.type.startsWith('video/')) return videoSize(file);
  return Promise.resolve(undefined);
}
