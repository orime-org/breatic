// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Whether this browser decodes the texture formats GLTFLoader r173 probes before using EXT_texture_webp or EXT_texture_avif. */
export interface TextureFormatSupport {
  webp: boolean;
  avif: boolean;
}

/** The probe images of GLTFTextureWebPExtension and GLTFTextureAVIFExtension.detectSupport (GLTFLoader.js 1495, 1579). */
const PROBES = {
  webp: 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  avif: 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABcAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB9tZGF0EgAKCBgABogQEDQgMgkQAAAAB8dSLfI=',
} as const;

/**
 * Decode one probe image the way GLTFLoader does: supported when it loads as a 1-pixel image.
 * @param source - The probe image data URI.
 * @returns Whether the browser decodes it.
 * @throws {never} Never; a decode failure resolves false.
 */
function decodes(source: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.src = source;
    image.onload = image.onerror = (): void => { resolve(image.height === 1); };
  });
}

/**
 * Probe this browser for the texture formats GLTFLoader decides on at load time, so checks pick the image the loader will decode.
 * @returns The browser's WebP and AVIF support.
 * @throws {never} Never.
 */
export async function detectTextureFormatSupport(): Promise<TextureFormatSupport> {
  const [webp, avif] = await Promise.all([decodes(PROBES.webp), decodes(PROBES.avif)]);
  return { webp, avif };
}
