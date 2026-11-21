// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { alphaPackedManifestMatchesVersion, alphaPackedManifestSchema, videoPresentationVersionSchema } from '@breatic/shared';
import type { AlphaPackedManifest } from '@breatic/shared';
import type { VapPlayer } from 'video-animation-player';
import { presentedSizeOf, type PresentedSize, type VideoPresentationSource, type VideoRendererCallbacks, type VideoRendererResource } from '@web/spaces/canvas/video-presentation/types';

/** One pending platform callback, whose logical handle survives a seek rearm. */
interface PendingFrame { logical: number; actual: number; callback: VideoFrameRequestCallback }
/** Frame API ownership and event ordering for the active clock. */
interface FrameCallbackGuard { dispose: () => void; afterReady: () => void }

/**
 * Cancels and rearms pending callbacks at each seek, rejecting queued old draws.
 * @param video - The actual native video used by either renderer.
 * @param callbacks - The current source's frame clock access.
 * @returns Cleanup restoring the element's original API.
 * @throws {never} Platforms without rVFC keep precise Current unavailable.
 */
function guardFrameCallbacks(video: HTMLVideoElement, callbacks: VideoRendererCallbacks): FrameCallbackGuard {
  if (typeof video.requestVideoFrameCallback !== 'function') return { dispose: () => {}, afterReady: () => {} };
  const requestDescriptor = Object.getOwnPropertyDescriptor(video, 'requestVideoFrameCallback');
  const cancelDescriptor = Object.getOwnPropertyDescriptor(video, 'cancelVideoFrameCallback');
  const request = video.requestVideoFrameCallback.bind(video);
  const cancel = video.cancelVideoFrameCallback.bind(video);
  const pending = new Map<number, PendingFrame>();
  let live = true;
  let rearmGeneration = 0;
  /**
   * Arms one callback with the currently accepted seek identity.
   * @param entry - Logical callback owned by the renderer.
   * @throws {never} Never.
   */
  function arm(entry: PendingFrame): void {
    const seekEpoch = callbacks.getSeekEpoch();
    entry.actual = request((now, info) => {
      if (!live || seekEpoch !== callbacks.getSeekEpoch()) return;
      pending.delete(entry.logical);
      entry.callback(now, info);
    });
  }
  video.requestVideoFrameCallback = (callback) => {
    const entry = { logical: 0, actual: 0, callback };
    arm(entry);
    entry.logical = entry.actual;
    pending.set(entry.logical, entry);
    return entry.logical;
  };
  video.cancelVideoFrameCallback = (handle) => {
    const entry = pending.get(handle);
    if (entry) { cancel(entry.actual); pending.delete(handle); }
  };
  /**
   * Waits for every seeking listener to invalidate its clock before rearming.
   * @throws {never} Never.
   */
  function rearm(): void {
    const generation = ++rearmGeneration;
    for (const entry of pending.values()) cancel(entry.actual);
    queueMicrotask(() => {
      if (!live || generation !== rearmGeneration) return;
      for (const entry of pending.values()) arm(entry);
    });
  }
  video.addEventListener('seeking', rearm);
  return {
    afterReady: () => {
      // Native event dispatch may perform a microtask checkpoint between
      // listeners. The clock must invalidate before this listener rearms.
      video.removeEventListener('seeking', rearm);
      video.addEventListener('seeking', rearm);
    },
    dispose: () => {
      live = false;
      video.removeEventListener('seeking', rearm);
      for (const entry of pending.values()) cancel(entry.actual);
      pending.clear();
      if (requestDescriptor) Object.defineProperty(video, 'requestVideoFrameCallback', requestDescriptor);
      else Reflect.deleteProperty(video, 'requestVideoFrameCallback');
      if (cancelDescriptor) Object.defineProperty(video, 'cancelVideoFrameCallback', cancelDescriptor);
      else Reflect.deleteProperty(video, 'cancelVideoFrameCallback');
    },
  };
}

/**
 * Creates a paused native renderer of the selected version's carrier.
 * @param host - Effect-owned host.
 * @param carrierURL - The selected native version's carrier.
 * @param callbacks - Current instance notifications.
 * @param given - The element to play through, when the host owns its transport; a new one otherwise.
 * @returns Resource cleanup.
 * @throws {never} Native decode failures are reported through callbacks.
 */
function createNativeRenderer(host: HTMLElement, carrierURL: string, callbacks: VideoRendererCallbacks, given?: HTMLVideoElement): VideoRendererResource {
  const video = given ?? document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.preload = 'metadata';
  video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
  const restoreFrameCallbacks = guardFrameCallbacks(video, callbacks);
  let live = true;
  let frameHandle: number | undefined;
  /**
   * Publishes native transport at metadata; presented-frame readiness stays separate.
   * @throws {never} Never.
   */
  function ready(): void { if (live) { callbacks.ready(video, video); restoreFrameCallbacks.afterReady(); } }
  /**
   * Records only the mediaTime delivered by a real frame callback.
   * @param _now - Platform callback time.
   * @param info - Browser's actual presented frame metadata.
   * @throws {never} Never.
   */
  function frame(_now: DOMHighResTimeStamp, info: VideoFrameCallbackMetadata): void {
    if (!live) return;
    ready();
    callbacks.frame(info.mediaTime, callbacks.getSeekEpoch());
    frameHandle = video.requestVideoFrameCallback(frame);
  }
  /**
   * Reports native loading, CORS or decode failure.
   * @throws {never} Never.
   */
  function error(): void { if (live) callbacks.error('media-load-failed'); }
  video.addEventListener('loadedmetadata', ready);
  video.addEventListener('loadeddata', ready);
  video.addEventListener('error', error);
  host.append(video);
  if (typeof video.requestVideoFrameCallback === 'function') frameHandle = video.requestVideoFrameCallback(frame);
  video.src = carrierURL;
  video.pause();
  video.load();
  return { dispose: () => {
    if (!live) return;
    live = false;
    video.pause();
    if (frameHandle !== undefined) video.cancelVideoFrameCallback(frameHandle);
    restoreFrameCallbacks.dispose();
    video.removeEventListener('loadedmetadata', ready);
    video.removeEventListener('loadeddata', ready);
    video.removeEventListener('error', error);
    video.removeAttribute('src');
    video.load();
    video.remove();
  } };
}

/**
 * Adapts the manifest's own fields into the fixed library's ephemeral configuration (§3.5 alpha manifest row).
 * @param manifest - The verified manifest: packed size and the logical colour and alpha rectangles.
 * @param size - The version's display size.
 * @returns VAP-only data, never persisted or written to canvas fields.
 * @throws {never} Never.
 */
function vapConfig(manifest: AlphaPackedManifest, size: PresentedSize): Record<string, unknown> {
  return { info: {
    v: 2, f: 0, w: size.width, h: size.height,
    videoW: manifest.packedWidth, videoH: manifest.packedHeight, orien: 0,
    // VAP uses this only for optional per-frame effects, which this adapter has
    // none of. Its draw clock always comes from the browser, never this rate.
    fps: 30, isVapx: 0,
    rgbFrame: [manifest.colorRect.x, manifest.colorRect.y, manifest.colorRect.width, manifest.colorRect.height],
    aFrame: [manifest.alphaRect.x, manifest.alphaRect.y, manifest.alphaRect.width, manifest.alphaRect.height],
  }, src: [], frame: [] };
}

/**
 * Chromium keeps at most 16 live WebGL contexts per page and drops the oldest; the page's other WebGL users (3D viewport, its
 * mini map, model import preview and preparation, camera angle sphere) hold up to 5, and a released three.js context counts
 * until garbage collection.
 */
export const MAX_LIVE_ALPHA_RENDERERS = 8;
/** One live alpha renderer in the page pool. */
interface AlphaPoolEntry { idle: () => boolean; release: () => void }
/** The page's live alpha renderers, least recently used first. */
const liveAlphaRenderers: AlphaPoolEntry[] = [];

/**
 * Takes a renderer out of the page pool.
 * @param entry - The renderer.
 * @throws {never} Never.
 */
function leaveAlphaPool(entry: AlphaPoolEntry): void {
  const at = liveAlphaRenderers.indexOf(entry);
  if (at >= 0) liveAlphaRenderers.splice(at, 1);
}

/**
 * Marks a renderer as the most recently used.
 * @param entry - The renderer.
 * @throws {never} Never.
 */
function touchAlphaPoolEntry(entry: AlphaPoolEntry): void {
  leaveAlphaPool(entry);
  liveAlphaRenderers.push(entry);
}

/**
 * Admits a renderer, first releasing the least recently used ones (paused before playing) past the pool size.
 * @param entry - The new renderer.
 * @throws {never} Owners handle their own release.
 */
function joinAlphaPool(entry: AlphaPoolEntry): void {
  while (liveAlphaRenderers.length >= MAX_LIVE_ALPHA_RENDERERS) {
    const victim = liveAlphaRenderers.find((held) => held.idle()) ?? liveAlphaRenderers[0]!;
    leaveAlphaPool(victim);
    victim.release();
  }
  liveAlphaRenderers.push(entry);
}

/**
 * Creates the approved packed-alpha renderer while retaining canonical identity.
 * @param host - Effect-owned host.
 * @param source - Current canonical asset and verified owned manifest.
 * @param callbacks - Current instance notifications.
 * @param given - The element to play through, when the host owns its transport; a new one otherwise.
 * @returns Cleanup that also covers the library's asynchronous initialization.
 * @throws {never} Initialization failures are reported through callbacks.
 */
function createAlphaRenderer(host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks, given?: HTMLVideoElement): VideoRendererResource {
  const manifest = alphaPackedManifestSchema.safeParse(source.manifest);
  if (!manifest.success || !alphaPackedManifestMatchesVersion(manifest.data, source.presentation)) {
    callbacks.error('invalid-alpha-manifest');
    return { dispose: () => {} };
  }
  const size = presentedSizeOf(source.presentation);
  const root = document.createElement('div');
  root.style.cssText = 'width:100%;height:100%';
  host.append(root);
  const video = given ?? document.createElement('video');
  let live = true;
  let suspended = false;
  let settled = false;
  let destroyed = false;
  let destroyRequested = false;
  let player: VapPlayer | undefined;
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | null = null;
  let bound = false;
  const restoreFrameCallbacks = guardFrameCallbacks(video, callbacks);
  const playDescriptor = Object.getOwnPropertyDescriptor(video, 'play');

  /**
   * Restores the real native command after VAP's initialization-only play call.
   * @throws {never} Never.
   */
  function restorePlay(): void {
    if (playDescriptor) Object.defineProperty(video, 'play', playDescriptor);
    else Reflect.deleteProperty(video, 'play');
  }
  /**
   * Keeps context restoration possible while suspending every active draw.
   * @param event - Browser's context loss event.
   * @throws {never} Never.
   */
  function contextLost(event: Event): void {
    event.preventDefault();
    if (!live || suspended) return;
    suspended = true;
    video.pause();
    player?.cancelRequestAnimation();
    // Delete while the context is lost. After restoration these handles are
    // invalid, and WebKit reports errors if VAP tries to delete them then.
    if (player && settled && !destroyed) { destroyed = true; player.destroy(); }
    video.removeAttribute('src');
    video.load();
    callbacks.contextLost();
  }
  /**
   * Requests a new effect-owned instance after the old context is restored.
   * @throws {never} Never.
   */
  function contextRestored(): void { if (live && suspended) callbacks.contextRestored(); }
  /**
   * Reports a current media failure without substituting an opaque picture.
   * @throws {never} Never.
   */
  function mediaError(): void { if (live) callbacks.error('media-load-failed'); }
  /**
   * Paints paused fallback pictures without claiming an exact presented time.
   * @throws {never} Draw failures are handled by the renderer boundary.
   */
  function fallbackDraw(): void {
    if (!live || suspended || !settled || !player || typeof video.requestVideoFrameCallback === 'function' || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    player.cancelRequestAnimation();
    player.drawFrame(0, null);
    if (video.paused) player.cancelRequestAnimation();
  }
  /**
   * Starts one fallback loop after VAP's own playing listener has run.
   * @throws {never} Never.
   */
  function fallbackPlay(): void { queueMicrotask(fallbackDraw); }
  /**
   * Stops animation work while a fallback video is paused.
   * @throws {never} Never.
   */
  function fallbackPause(): void {
    if (typeof video.requestVideoFrameCallback !== 'function') player?.cancelRequestAnimation();
  }
  video.addEventListener('error', mediaError);
  video.addEventListener('loadeddata', fallbackDraw);
  video.addEventListener('seeked', fallbackDraw);
  video.addEventListener('playing', fallbackPlay);
  video.addEventListener('pause', fallbackPause);

  /**
   * Releases the library once its uncancellable parser has completed.
   * @throws {never} Never.
   */
  function destroy(): void {
    destroyRequested = true;
    if (!settled || !player) return;
    canvas?.removeEventListener('webglcontextlost', contextLost);
    canvas?.removeEventListener('webglcontextrestored', contextRestored);
    if (!destroyed) {
      destroyed = true;
      player.destroy();
      // Removing the canvas keeps its context counted until garbage collection; losing it frees the page slot now.
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
    gl = null;
    canvas = null;
    player = undefined;
  }

  void import('video-animation-player').then(({ default: Vap }) => {
    if (!live) return;
    // The 1.0.5 UMD artifact exports {default: factory}; bundlers differ in
    // whether they unwrap that object for a dynamic CommonJS import.
    const factory = typeof Vap === 'function' ? Vap : Vap.default;
    const instance = factory();
    player = instance;
    instance.video = video;
    const draw = instance.drawFrame.bind(instance);
    const initialize = instance.initWebGL.bind(instance);
    const initializeTextures = instance.initTexture.bind(instance);
    const initializeVideoTexture = instance.initVideoTexture.bind(instance);
    /**
     * Reports errors that fixed VAP otherwise catches inside its parser promise.
     * @param operation - One public library initialization operation.
     * @returns Its successful result.
     * @throws {Error} The original platform or WebGL initialization failure.
     */
    function initializing<T>(operation: () => T): T {
      try { return operation(); }
      catch (error) { settled = true; if (live) callbacks.error('webgl-initialization-failed'); destroy(); throw error; }
    }
    instance.initWebGL = (): WebGLRenderingContext => { gl = initializing(initialize); return gl; };
    instance.initTexture = (): void => initializing(initializeTextures);
    instance.initVideoTexture = (): void => initializing(initializeVideoTexture);
    instance.drawFrame = (now: number, info: unknown): void => {
      if (!live || suspended || !settled) return;
      const seekEpoch = callbacks.getSeekEpoch();
      try { draw(now, info); }
      catch { if (live) callbacks.error('media-render-failed'); return; }
      if (!live || suspended || seekEpoch !== callbacks.getSeekEpoch()) return;
      if (!canvas) return;
      if (!bound) { bound = true; callbacks.ready(video, canvas); restoreFrameCallbacks.afterReady(); }
      if (typeof info === 'object' && info !== null && 'mediaTime' in info && typeof info.mediaTime === 'number') callbacks.frame(info.mediaTime, seekEpoch);
    };
    // VAP 1.0.5 initVideo reuses public video, then its parser continuation
    // unconditionally calls video.play (src/video.ts:155). Suppress only this
    // initialization command; all subsequent transport commands remain native.
    video.play = (): Promise<void> => {
      settled = true;
      restorePlay();
      // Keep the fallback playing listener after VAP's own listener as well.
      video.removeEventListener('playing', fallbackPlay);
      video.addEventListener('playing', fallbackPlay);
      canvas = root.querySelector('canvas');
      if (!live || destroyRequested) { destroy(); return Promise.resolve(); }
      if (canvas) {
        canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
        canvas.addEventListener('webglcontextlost', contextLost);
        canvas.addEventListener('webglcontextrestored', contextRestored);
      }
      queueMicrotask(fallbackDraw);
      return Promise.resolve();
    };
    instance.play({ container: root, src: manifest.data.packed.url, config: vapConfig(manifest.data, size), width: size.width, height: size.height, loop: false, mute: false, accurate: true, precache: false, onLoadError: mediaError });
  }).catch(() => { if (live) callbacks.error('renderer-initialization-failed'); });

  /**
   * Releases every resource of this renderer once.
   * @throws {never} Never.
   */
  function dispose(): void {
    if (!live) return;
    live = false;
    leaveAlphaPool(entry);
    video.removeEventListener('play', used);
    video.removeEventListener('seeking', used);
    video.pause();
    player?.cancelRequestAnimation();
    restoreFrameCallbacks.dispose();
    video.removeEventListener('error', mediaError);
    video.removeEventListener('loadeddata', fallbackDraw);
    video.removeEventListener('seeked', fallbackDraw);
    video.removeEventListener('playing', fallbackPlay);
    video.removeEventListener('pause', fallbackPause);
    canvas?.removeEventListener('webglcontextlost', contextLost);
    canvas?.removeEventListener('webglcontextrestored', contextRestored);
    destroy();
    video.removeAttribute('src');
    video.load();
    video.remove();
    root.remove();
  }
  const entry: AlphaPoolEntry = { idle: () => video.paused, release: () => { dispose(); (callbacks.evicted ?? callbacks.contextLost)(); } };
  /**
   * Marks this renderer as just used, so the pool releases others first.
   * @throws {never} Never.
   */
  function used(): void { touchAlphaPoolEntry(entry); }
  video.addEventListener('play', used);
  video.addEventListener('seeking', used);
  joinAlphaPool(entry);
  return { dispose };
}

/**
 * Creates the approved native or packed-alpha renderer for a ready source.
 * @param host - Effect-owned presentation host.
 * @param source - The selected version and, when alpha-packed, its verified manifest.
 * @param callbacks - Identity-checked resource notifications.
 * @param video - The element to play through, for a host that drives the transport itself (a Timeline layer); a new one
 *   otherwise.
 * @returns Cleanup for every resource, including partially initialized ones.
 * @throws {never} Resource errors are reported through callbacks.
 */
export function createVideoRenderer(host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks, video?: HTMLVideoElement): VideoRendererResource {
  const version = videoPresentationVersionSchema.safeParse(source.presentation);
  if (!version.success || version.data.sourceFingerprint !== source.sourceFingerprint) {
    callbacks.error('invalid-presentation');
    return { dispose: () => {} };
  }
  const { playback } = version.data;
  return playback.kind === 'native' ? createNativeRenderer(host, playback.carrier.url, callbacks, video) : createAlphaRenderer(host, source, callbacks, video);
}
