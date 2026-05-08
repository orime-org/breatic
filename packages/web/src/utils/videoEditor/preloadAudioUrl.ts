/**
 * Wait until the audio resource is fully fetched so the next node can show waveform immediately.
 * Works for blob URLs and same-origin / CORS-allowed remote URLs.
 *
 * @throws If the request fails or the body cannot be read.
 */
export async function preloadAudioUrl(src: string): Promise<void> {
  const trimmed = src?.trim();
  if (!trimmed) throw new Error('Missing audio URL');

  const res = await fetch(trimmed);
  if (!res.ok) throw new Error(`Audio preload failed: HTTP ${res.status}`);
  await res.blob();
}
