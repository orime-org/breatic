// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import createTransition, { type GLTextureLike } from 'gl-transition';
import fade from 'gl-transitions/transitions/fade.glsl?raw';
import wipeLeft from 'gl-transitions/transitions/wipeLeft.glsl?raw';
import wipeRight from 'gl-transitions/transitions/wipeRight.glsl?raw';
import { RefreshCw } from 'lucide-react';
import { canonicalMiniToolValue, type VideoTimelinePlan, type VideoPlannedClip, type VideoToolInput } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { checkerboardStyle } from '@web/spaces/canvas/_shared/checkerboard';
import { NativeTimelineDecoder } from '@web/spaces/canvas/mini-tool/video/NativeTimelineDecoder';
import type { VideoTimelineDecoderBinding, VideoTimelineDecoderRenderer, VideoTimelinePresentedFrame } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';
import { VideoPresentationRecoveryError } from '@web/spaces/canvas/video-presentation/video-presentation-recovery';

/** The composition frame: the first clip's display size, transparent when either clip is (canvas design §4 transitions row). */
export interface VideoTimelineFormat { width: number; height: number; transparent: boolean }

export interface VideoTimelinePreviewProps {
  plan: VideoTimelinePlan;
  /** The composition frame; unknown until the first clip's size is read. */
  format?: VideoTimelineFormat | null;
  inputs: readonly VideoToolInput[];
  cursor: number;
  onCursorChange: (time: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  renderDecoder?: VideoTimelineDecoderRenderer;
}
// The frame drawn while the first clip's size is still unknown.
const FALLBACK_FORMAT: VideoTimelineFormat = { width: 960, height: 540, transparent: false };
interface VideoTexture extends GLTextureLike { upload: (canvas: HTMLCanvasElement) => void; dispose: () => void }
interface FrameSnapshot {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  frame: Omit<VideoTimelinePresentedFrame, 'surface'> | null;
  binding: VideoTimelineDecoderBinding | null;
}

/**
 * Resolves the current pair on the same composition clock as the execution plan.
 * @param plan - The complete source timeline.
 * @param cursor - The logical composition instant.
 * @returns The visible outgoing and incoming clips.
 * @throws {never} Never.
 */
function visibleClips(plan: VideoTimelinePlan, cursor: number): { from: VideoPlannedClip | undefined; to: VideoPlannedClip | undefined } {
  const index = plan.clips.findIndex((clip) => cursor < clip.end);
  const from = plan.clips[index < 0 ? plan.clips.length - 1 : index];
  const next = index < 0 ? undefined : plan.clips[index + 1];
  return { from, to: from !== undefined && next !== undefined && from.overlap > 0 && cursor >= next.start ? next : undefined };
}

/**
 * Gives each mounted source and clip its own callback lifetime.
 * @param clip - The composition clip.
 * @param input - Its copied registered media.
 * @returns The stable attachment identity.
 * @throws {never} Never.
 */
function decoderKey(clip: VideoPlannedClip, input: VideoToolInput): string { return JSON.stringify([clip.clipId, input.inputId, input.url]); }

/**
 * Draws a source frame into the composition frame, scaled to fit and centred, the borders black for an opaque output and
 * fully transparent for a transparent one, the rule export uses (canvas design §4 transitions row; demo timeline-preview.tsx).
 * @param context - The composition-sized drawing context.
 * @param frame - The source frame snapshot.
 * @param format - The composition frame.
 * @throws {never} Never.
 */
export function drawFitted(context: CanvasRenderingContext2D, frame: HTMLCanvasElement, format: VideoTimelineFormat): void {
  const scale = Math.min(format.width / frame.width, format.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  if (format.transparent) context.clearRect(0, 0, format.width, format.height);
  else { context.fillStyle = '#000'; context.fillRect(0, 0, format.width, format.height); }
  context.drawImage(frame, (format.width - width) / 2, (format.height - height) / 2, width, height);
}

/**
 * Owns one stable canvas texture using the approved renderer's texture contract, each upload fitted into the composition frame.
 * @param gl - This preview's active graphics context.
 * @param format - The composition frame.
 * @returns An uploadable owned texture.
 * @throws {Error} When a texture cannot be allocated.
 */
function videoTexture(gl: WebGLRenderingContext, format: VideoTimelineFormat): VideoTexture {
  const fitted = document.createElement('canvas');
  fitted.width = format.width; fitted.height = format.height;
  const context = fitted.getContext('2d');
  const texture = gl.createTexture();
  if (texture === null) throw new Error('Video texture allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const owned: VideoTexture = {
    /**
     * Binds the owned sampler.
     * @param unit - The requested texture unit.
     * @returns The bound texture unit.
     * @throws {never} Never.
     */
    bind(unit: number): number { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); return unit; },
    shape: [format.width, format.height],
    /**
     * Uploads stable canonical RGBA pixels, fitted into the composition frame.
     * @param canvas - The owned source snapshot.
     * @throws {DOMException} When cross-origin texture access is unavailable.
     * @throws {Error} When the composition surface is unavailable.
     */
    upload(canvas: HTMLCanvasElement): void { if (context === null) throw new Error('Composition frame surface unavailable'); drawFitted(context, canvas, format); gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fitted); },
    /**
     * Releases this texture and its composition surface.
     * @throws {never} Never.
     */
    dispose(): void { gl.deleteTexture(texture); fitted.width = 0; fitted.height = 0; },
  };
  return owned;
}

/**
 * Composites synchronized real source frames with the approved shaders and WebAudio.
 * @param props - The immutable composition and source presentation adapters.
 * @returns The actual composite preview, buffering state or explicit recovery action.
 * @throws {never} Source, graphics and audio failures are presented for retry.
 */
export function VideoTimelinePreview(props: VideoTimelinePreviewProps): React.JSX.Element {
  const t = useTranslation();
  const latest = React.useRef(props);
  latest.current = props;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const snapshots = React.useRef(new Map<string, FrameSnapshot>());
  const sourceError = React.useRef<unknown>(null);
  const [failure, setFailure] = React.useState(false);
  const [waiting, setWaiting] = React.useState(false);
  const [epoch, setEpoch] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
  const pendingRetry = React.useRef(false);
  const mounted = React.useRef(false);
  const format = props.format ?? FALLBACK_FORMAT;
  const formatKey = `${format.width}x${format.height}:${format.transparent}`;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pair = visibleClips(props.plan, props.cursor);
  const sources = [pair.from, pair.to].flatMap((clip) => {
    const input = props.inputs.find((candidate) => candidate.inputId === clip?.inputId);
    return clip === undefined || input === undefined ? [] : [{ clip, input, key: decoderKey(clip, input) }];
  });
  const activeKeys = React.useRef(new Set<string>());
  activeKeys.current = new Set(failure ? [] : sources.map((source) => source.key));
  /**
   * Receives a binding independently of paused-first-frame delivery.
   * @param key - The mounted clip and source identity.
   * @param binding - The actual native or alpha transport.
   * @param error - Its explicit presentation failure, if any.
   * @throws {never} Never.
   */
  function bind(key: string, binding: VideoTimelineDecoderBinding | null, error?: unknown): void {
    if (!activeKeys.current.has(key)) return;
    if (error !== undefined && error !== null) sourceError.current = error;
    const held = snapshots.current.get(key);
    if (held !== undefined) held.binding = binding;
    else if (binding !== null) {
      const pixels = document.createElement('canvas');
      snapshots.current.set(key, { canvas: pixels, context: pixels.getContext('2d'), frame: null, binding });
    }
  }
  /**
   * Copies the real frame synchronously before a VAP drawing buffer can clear.
   * @param key - The mounted clip and source identity captured by the renderer.
   * @param frame - The just-presented canonical RGBA surface and its actual clock.
   * @throws {never} Pixel failures enter the shared preview error state.
   */
  function presented(key: string, frame: VideoTimelinePresentedFrame): void {
    if (!activeKeys.current.has(key)) return;
    let held = snapshots.current.get(key);
    if (held === undefined) {
      const pixels = document.createElement('canvas');
      held = { canvas: pixels, context: pixels.getContext('2d'), frame: null, binding: null };
      snapshots.current.set(key, held);
    }
    try {
      if (held.context === null) throw new Error('Source snapshot canvas unavailable');
      const width = frame.surface instanceof HTMLVideoElement ? frame.surface.videoWidth : frame.surface.width;
      const height = frame.surface instanceof HTMLVideoElement ? frame.surface.videoHeight : frame.surface.height;
      if (held.canvas.width !== width) held.canvas.width = width;
      if (held.canvas.height !== height) held.canvas.height = height;
      held.context.clearRect(0, 0, width, height);
      held.context.drawImage(frame.surface, 0, 0, width, height);
      const { surface: _surface, ...identity } = frame;
      held.frame = identity;
    } catch (error) { sourceError.current = error; }
  }
  React.useEffect(() => {
    for (const [key, snapshot] of snapshots.current) if (!activeKeys.current.has(key)) { snapshot.canvas.width = 0; snapshot.canvas.height = 0; snapshots.current.delete(key); }
  });
  React.useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    const surface: HTMLCanvasElement = element;
    const ownedSnapshots = snapshots.current;
    const gl = surface.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    const renderers = new Map<string, ReturnType<typeof createTransition>>();
    const textures: VideoTexture[] = [];
    let audio: AudioContext | null = null;
    const gains: GainNode[] = [];
    const soundNodes = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();
    const connected = new Map<HTMLVideoElement, { node: MediaElementAudioSourceNode; gain: number }>();
    const pendingPlay = new WeakSet<HTMLVideoElement>();
    let stopped = false;
    let faulted = false;
    let raf = 0;
    let previous = performance.now();
    let clock = latest.current.cursor;
    let published = clock;
    let planKey = canonicalMiniToolValue(latest.current.plan);
    let buffer: WebGLBuffer | null = null;
    let resuming = false;
    let disposed = false;
    /**
     * Releases partially or fully allocated presentation resources once.
     * @throws {never} Never.
     */
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const renderer of renderers.values()) renderer.dispose();
      renderers.clear();
      for (const texture of textures) texture.dispose();
      textures.length = 0;
      if (gl !== null && buffer !== null) gl.deleteBuffer(buffer);
      buffer = null;
      for (const route of connected.values()) route.node.disconnect();
      connected.clear();
      for (const gain of gains) gain.disconnect();
      gains.length = 0;
      if (audio !== null && audio.state !== 'closed') void audio.close();
      audio = null;
      for (const snapshot of ownedSnapshots.values()) { snapshot.canvas.width = 0; snapshot.canvas.height = 0; }
      ownedSnapshots.clear();
    }
    /**
     * Pauses every actual source transport.
     * @throws {never} Never.
     */
    function pauseAll(): void { for (const snapshot of ownedSnapshots.values()) snapshot.binding?.pause(); }
    /**
     * Stops the same logical clock and presents an actionable failure.
     * @throws {never} Never.
     */
    function fail(): void {
      if (stopped || faulted) return;
      faulted = true; cancelAnimationFrame(raf); pauseAll(); dispose(); setFailure(true); latest.current.onPlayingChange(false);
    }
    /**
     * Rejects old GL handles immediately.
     * @param event - The context loss event.
     * @throws {never} Never.
     */
    function lost(event: Event): void { event.preventDefault(); fail(); }
    /**
     * Rebuilds resources under a fresh lifetime.
     * @throws {never} Never.
     */
    function restored(): void { if (!stopped) { sourceError.current = null; setFailure(false); setEpoch((value) => value + 1); } }
    surface.addEventListener('webglcontextlost', lost); surface.addEventListener('webglcontextrestored', restored);
    try {
      if (gl === null) throw new Error('WebGL unavailable');
      audio = new AudioContext();
      gains.push(audio.createGain());
      gains.push(audio.createGain());
      for (const gain of gains) gain.connect(audio.destination);
      buffer = gl.createBuffer();
      if (buffer === null) throw new Error('Preview buffer allocation failed');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 4, 4, -1]), gl.STATIC_DRAW);
      gl.viewport(0, 0, surface.width, surface.height); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const composition = latest.current.format ?? FALLBACK_FORMAT;
      textures.push(videoTexture(gl, composition));
      textures.push(videoTexture(gl, composition));
      for (const [name, glsl] of Object.entries({ fade, wipeLeft, wipeRight })) renderers.set(name, createTransition(gl, { glsl, paramsTypes: {}, defaultParams: {} }, { resizeMode: 'contain' }));
    } catch { fail(); }
    /**
     * Resolves and synchronizes the current decoder without inferring source frames.
     * @param clip - The current composition clip.
     * @param cursor - The common composition time.
     * @param playing - The current playback intent.
     * @returns Its actual current source pixels when ready.
     * @throws {never} Seek failures enter the shared error state.
     */
    function ready(clip: VideoPlannedClip | undefined, cursor: number, playing: boolean): FrameSnapshot | null {
      if (clip === undefined) return null;
      const input = latest.current.inputs.find((item) => item.inputId === clip.inputId);
      if (input === undefined) return null;
      const snapshot = ownedSnapshots.get(decoderKey(clip, input));
      const binding = snapshot?.binding;
      if (snapshot === undefined || binding == null || binding.element.readyState < 1) return null;
      const beforeEnd = clip.out - Math.max(1, Math.abs(clip.out)) * Number.EPSILON;
      const target = Math.max(clip.in, Math.min(beforeEnd, clip.in + cursor - clip.start));
      if (!binding.element.seeking && Math.abs(binding.element.currentTime - target) > (playing ? 0.12 : 0.008)) {
        snapshot.frame = null;
        try { binding.seek(target); } catch { fail(); }
        return null;
      }
      return !binding.element.seeking && binding.element.readyState >= (playing ? 3 : 2) && snapshot.frame?.sourceKey === binding.sourceKey && snapshot.frame.sourceEpoch === binding.sourceEpoch ? snapshot : null;
    }
    /**
     * Routes one actual source into its current composition gain once per element.
     * @param binding - The current source transport.
     * @param gain - Its current outgoing or incoming mix slot.
     * @throws {Error} When the browser cannot establish the actual audio route.
     */
    function connect(binding: VideoTimelineDecoderBinding, gain: number): void {
      if (audio === null) return;
      const held = connected.get(binding.element);
      if (held?.gain === gain) return;
      let node = soundNodes.get(binding.element);
      if (node === undefined) { node = audio.createMediaElementSource(binding.element); soundNodes.set(binding.element, node); }
      node.disconnect(); node.connect(gains[gain]);
      connected.set(binding.element, { node, gain });
      binding.element.muted = false; binding.element.volume = 1;
    }
    /**
     * Plays through the source owner so alpha rendering follows its native element.
     * @param binding - The actual source transport.
     * @throws {never} Play failures enter the shared error state.
     */
    function play(binding: VideoTimelineDecoderBinding): void {
      if (!binding.element.paused || pendingPlay.has(binding.element)) return;
      pendingPlay.add(binding.element);
      void binding.play().then(() => { pendingPlay.delete(binding.element); if (stopped || !latest.current.playing) binding.pause(); }, () => { pendingPlay.delete(binding.element); fail(); });
    }
    /**
     * Draws stable canonical RGBA and advances only a ready common media clock.
     * @param now - The animation-frame clock reading.
     * @throws {never} Rendering and audio failures enter the visible recovery state.
     */
    function draw(now: number): void {
      if (stopped || faulted || gl === null || audio === null) return;
      if (sourceError.current !== null) { fail(); return; }
      const state = latest.current;
      const currentPlanKey = canonicalMiniToolValue(state.plan);
      if (currentPlanKey !== planKey || Math.abs(state.cursor - published) > 0.002) { planKey = currentPlanKey; clock = Math.max(0, Math.min(state.plan.duration, state.cursor)); published = clock; }
      const elapsed = Math.max(0, (now - previous) / 1000); previous = now;
      const pair = visibleClips(state.plan, clock);
      const from = ready(pair.from, clock, state.playing);
      const to = pair.to === undefined ? null : ready(pair.to, clock, state.playing);
      const allReady = from?.binding != null && (pair.to === undefined || to?.binding != null);
      setWaiting(pair.from !== undefined && !allReady);
      if (pair.from === undefined) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      if (!allReady || from?.binding == null || pair.from === undefined) pauseAll();
      else try {
        const progress = pair.to === undefined ? 0 : Math.min(1, Math.max(0, (clock - pair.to.start) / pair.from.overlap));
        textures[0].upload(from.canvas); if (to !== null) textures[1].upload(to.canvas);
        renderers.get(pair.to === undefined || pair.from.transition.kind === 'cut' ? 'fade' : pair.from.transition.kind)?.draw(progress, textures[0], to === null ? textures[0] : textures[1], surface.width, surface.height, {});
        surface.dataset.compositionTime = String(clock); surface.dataset.fromPts = String(from.frame?.mediaTime); surface.dataset.toPts = to?.frame === null || to === null ? '' : String(to.frame.mediaTime);
        connect(from.binding, 0); gains[0].gain.value = to === null ? 1 : 1 - progress; gains[1].gain.value = to === null ? 0 : progress;
        if (to?.binding != null) connect(to.binding, 1);
        const active = new Set([from.binding.element, ...(to?.binding == null ? [] : [to.binding.element])]);
        for (const [element, route] of connected) if (!active.has(element)) { route.node.disconnect(); connected.delete(element); }
        if (state.playing && clock < state.plan.duration) {
          if (audio.state === 'closed') throw new Error('Audio context closed');
          if (audio.state !== 'running' && !resuming) { resuming = true; void audio.resume().then(() => { resuming = false; }, fail); }
          if (audio.state === 'running') {
            play(from.binding); if (to?.binding != null) play(to.binding);
            clock = Math.min(state.plan.duration, clock + elapsed); published = clock; state.onCursorChange(clock);
            if (clock >= state.plan.duration) { pauseAll(); state.onPlayingChange(false); }
          } else pauseAll();
        } else pauseAll();
      } catch { fail(); }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true; cancelAnimationFrame(raf); pauseAll();
      surface.removeEventListener('webglcontextlost', lost); surface.removeEventListener('webglcontextrestored', restored);
      dispose();
    };
  }, [epoch, formatKey]);
  /**
   * Recovers failed preparation before rebuilding the same preview resources.
   * @throws {never} The source displays repair errors; this caller resets its wait.
   */
  async function retry(): Promise<void> {
    if (pendingRetry.current) return;
    pendingRetry.current = true;
    setRetrying(true);
    const error = sourceError.current;
    try {
      if (error instanceof VideoPresentationRecoveryError && latest.current.inputs.some((input) => input.url === error.canonicalURL)) await error.recover();
      if (!mounted.current || sourceError.current !== error) return;
      sourceError.current = null; setFailure(false); setEpoch((value) => value + 1);
    } catch {
      // Keep Retry available after the source reports the failed repair.
    } finally {
      pendingRetry.current = false;
      if (mounted.current) setRetrying(false);
    }
  }
  return <div className='relative flex min-h-0 items-center justify-center overflow-hidden rounded-content-sm bg-canvas' data-testid='video-timeline-preview'>
    {/* The canvas keeps the composition aspect inside the box; only a transparent output shows the checkerboard through it. */}
    <div className='absolute inset-0 grid place-items-center' style={{ containerType: 'size' }}><canvas key={formatKey} ref={canvas} width={format.width} height={format.height} style={{ width: `min(100cqw, ${format.width / format.height * 100}cqh)`, height: `min(100cqh, ${format.height / format.width * 100}cqw)`, ...(format.transparent ? checkerboardStyle(1, { x: 0, y: 0 }) : {}) }} /></div>
    <div hidden>{(failure ? [] : sources).map(({ input, key }) => <React.Fragment key={`${epoch}:${key}`}>{props.renderDecoder === undefined ? <NativeTimelineDecoder input={input} onBinding={(binding, error) => bind(key, binding, error)} onPresentedFrame={(frame) => presented(key, frame)} /> : props.renderDecoder(input, (binding, error) => bind(key, binding, error), (frame) => presented(key, frame))}</React.Fragment>)}</div>
    {props.plan.clips.length === 0 ? <p className='absolute inset-0 grid place-content-center p-4 text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.timelineEmpty')}</p> : null}
    {waiting && !failure ? <span className='absolute bottom-2 rounded-chrome bg-popover px-2 py-1 text-xs'>{t('canvas.miniTool.videoUI.loadingFrames')}</span> : null}
    {failure ? <div className='absolute inset-0 grid place-content-center gap-2 bg-card p-4 text-center'><p className='text-xs'>{t('canvas.miniTool.videoUI.previewUnavailable')}</p><Button variant='outline' size='sm' loading={retrying} icon={<RefreshCw className='size-3.5' />} onClick={() => { void retry(); }}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}
  </div>;
}
