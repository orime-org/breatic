// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The host side of the web-animation frame-ready bridge (inner#1711 design §7.2, §9 preview-instance table); the
 * page side is `WEB_ANIMATION_BRIDGE_SCRIPT` in `@breatic/shared/space-content`.
 *
 * Each instance is a `<hyperframes-player>` whose iframe runs the page. The host says `breatic-hello` when it
 * attaches, opens a new session on every `breatic-bridge-ready`, posts `breatic-seek {session, sequence, time}` and
 * counts the instance ready only on a `breatic-frame-ready` from that iframe for the current session and latest
 * sequence. A load of the iframe is a reload; an `error` from the player, or no bridge-ready within the load timeout,
 * fails the instance until a retry.
 *
 * An instance has a pool role (§7.4). Only visible instances count in `ready()`, get the frames of play and are
 * repositioned on a seek, a pause or a start of play. A premounted instance is positioned once per session at the
 * source time of its target frame; an idle one is sent nothing. A premounted instance turning visible whose last sent
 * time is the current frame's keeps its state without a new sequence.
 */

import type { TimelineRate, TimelineWebAnimationClip } from '@breatic/shared';
import type { WebInstanceRole } from '@web/spaces/timeline/web-instance-pool';

/** The player element the preview mounts: it exposes the iframe its page runs in. */
export type WebAnimationPlayerElement = HTMLElement & { readonly iframeElement: HTMLIFrameElement | null };

/** One web-animation instance: the copy it serves, its source frame rate, its player and its pool role. */
export interface TimelineWebLayer {
  key: string;
  clip: TimelineWebAnimationClip;
  fps: TimelineRate;
  player: WebAnimationPlayerElement;
  /** Its pool role (inner#1711 design §7.4). */
  role: WebInstanceRole;
  /** A premounted instance's target: the copy's first visible frame. */
  targetFrame?: number;
}

/** Loading its page, waiting for the latest frame, showing it, or failed until a retry. */
export type WebInstanceState = 'loading' | 'waiting' | 'ready' | 'failed';

/** What the host reads from the preview it serves. */
export interface WebAnimationHostOptions {
  /** The current Timeline frame. */
  frame: () => number;
  /** The Timeline's frame rate. */
  timelineFps: () => TimelineRate;
  /** How long a page may take to say its bridge is ready; none waits for ever. */
  loadTimeoutMs: () => number | undefined;
  /** An instance changed state on its own (a message, a load, an error or the timeout). */
  onChange: () => void;
}

/** The instances of one preview. */
export interface WebAnimationHost {
  /** Bring the instances to the layers: attach new ones, detach gone ones, send a changed mapping or role. */
  sync: (layers: readonly TimelineWebLayer[]) => void;
  /** A seek, a pause, a start of play: every visible instance gets the current frame under a new sequence. */
  reposition: () => void;
  /** A frame during play: the visible instances covering it get its time under their current sequence, without waiting. */
  sendFrame: () => void;
  /** Load a failed instance again. */
  retry: (key: string) => void;
  /** Take a message the window received. */
  receive: (event: MessageEvent) => void;
  /** Take the window's messages until the returned stop, which also detaches everything. */
  listen: () => () => void;
  /** Every instance's state. */
  states: () => ReadonlyMap<string, WebInstanceState>;
  /** Whether every visible instance that has not failed shows the latest frame. */
  ready: () => boolean;
  /** Detach everything. */
  dispose: () => void;
}

/** One attached instance. */
interface Instance {
  layer: TimelineWebLayer;
  state: WebInstanceState;
  session: number | null;
  sequence: number;
  /** The source time last sent in the current session; null when none was. */
  sentTime: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

// Sessions are unique across every preview of the page, so a reply can never match another preview's session.
let lastSession = 0;

/**
 * Whether a layer change moves what the copy shows at a frame.
 * @param before - The layer before.
 * @param after - The layer now.
 * @returns True when the start, in-point, speed, binding or source rate changed.
 * @throws {never} Never.
 */
function mappingChanged(before: TimelineWebLayer, after: TimelineWebLayer): boolean {
  const a = before.clip;
  const b = after.clip;
  return a.startFrame !== b.startFrame || a.sourceInFrame !== b.sourceInFrame || a.rate.num !== b.rate.num || a.rate.den !== b.rate.den
    || a.contentBinding.baseSourceResultId !== b.contentBinding.baseSourceResultId || a.contentBinding.operationId !== b.contentBinding.operationId
    || before.fps.num !== after.fps.num || before.fps.den !== after.fps.den;
}

/**
 * The source time a copy shows at a Timeline frame: `sourceIn / sourceFps + (frame - start) / timelineFps × rate`,
 * with the frame held inside the copy.
 * @param layer - The instance's layer.
 * @param frame - The Timeline frame.
 * @param fps - The Timeline frame rate.
 * @returns Seconds on the page's clock.
 * @throws {never} Never.
 */
export function webAnimationSourceSeconds(layer: Pick<TimelineWebLayer, 'clip' | 'fps'>, frame: number, fps: TimelineRate): number {
  const { clip } = layer;
  const at = Math.max(clip.startFrame, Math.min(clip.startFrame + clip.durationFrames - 1, frame));
  return clip.sourceInFrame * layer.fps.den / layer.fps.num + (at - clip.startFrame) * fps.den / fps.num * clip.rate.num / clip.rate.den;
}

/**
 * Create the host side of the bridge for one preview.
 * @param options - What it reads from the preview.
 * @returns The host.
 * @throws {never} Never.
 */
export function createWebAnimationHost(options: WebAnimationHostOptions): WebAnimationHost {
  const instances = new Map<string, Instance>();

  /**
   * Post to an instance's page.
   * @param instance - The instance.
   * @param message - The message.
   * @throws {never} Never.
   */
  const post = (instance: Instance, message: object): void => {
    // The sandboxed page's origin is null, so no narrower target origin can reach it.
    instance.layer.player.iframeElement?.contentWindow?.postMessage(message, '*');
  };
  /**
   * The source time an instance is to show: the current frame's for a visible one, its target frame's for a premount.
   * @param instance - The instance.
   * @returns Seconds on the page's clock.
   * @throws {never} Never.
   */
  const timeOf = (instance: Instance): number => {
    const { layer } = instance;
    const frame = layer.role === 'premount' ? layer.targetFrame ?? options.frame() : options.frame();
    return webAnimationSourceSeconds(layer, frame, options.timelineFps());
  };
  /**
   * Send the instance's time under its current sequence.
   * @param instance - The instance.
   * @throws {never} Never.
   */
  const sendSeek = (instance: Instance): void => {
    const time = timeOf(instance);
    instance.sentTime = time;
    post(instance, { type: 'breatic-seek', session: instance.session, sequence: instance.sequence, time });
  };
  /**
   * Stop waiting for a bridge-ready.
   * @param instance - The instance.
   * @throws {never} Never.
   */
  const stopTimer = (instance: Instance): void => {
    if (instance.timer !== null) clearTimeout(instance.timer);
    instance.timer = null;
  };
  /**
   * Fail an instance until a retry.
   * @param instance - The instance.
   * @throws {never} Never.
   */
  const fail = (instance: Instance): void => {
    if (instance.state === 'failed') return;
    stopTimer(instance);
    instance.state = 'failed';
    instance.session = null;
    options.onChange();
  };
  /**
   * Start loading: say hello and wait for the bridge within the load timeout.
   * @param instance - The instance.
   * @throws {never} Never.
   */
  const load = (instance: Instance): void => {
    instance.state = 'loading';
    instance.session = null;
    instance.sentTime = null;
    stopTimer(instance);
    const ms = options.loadTimeoutMs();
    if (ms !== undefined) instance.timer = setTimeout(() => fail(instance), ms);
    post(instance, { type: 'breatic-hello' });
  };
  /**
   * Move an instance to a new sequence and send it, unless it is failed or its page is not ready to receive.
   * @param instance - The instance.
   * @throws {never} Never.
   */
  const bump = (instance: Instance): void => {
    if (instance.state === 'failed') return;
    instance.sequence += 1;
    if (instance.session === null) return;
    instance.state = 'waiting';
    sendSeek(instance);
  };
  /**
   * Position a premounted instance at its target once per session: a new sequence unless the time last sent in this
   * session is already the target's, which it then waits for or already shows.
   * @param instance - The instance.
   * @throws {never} Never.
   */
  const positionPremount = (instance: Instance): void => {
    if (instance.state === 'failed' || instance.session === null || instance.sentTime === timeOf(instance)) return;
    bump(instance);
  };
  /**
   * Attach to a layer's player.
   * @param layer - The layer.
   * @throws {never} Never.
   */
  const attach = (layer: TimelineWebLayer): void => {
    const iframe = layer.player.iframeElement;
    const instance: Instance = { layer, state: 'loading', session: null, sequence: 0, sentTime: null, timer: null, detach: () => {} };
    /** The player reloaded its page. */
    const reloaded = (): void => {
      if (instance.state === 'failed') return;
      load(instance);
      options.onChange();
    };
    /** The player could not load its page. */
    const failed = (): void => { fail(instance); };
    iframe?.addEventListener('load', reloaded);
    layer.player.addEventListener('error', failed);
    instance.detach = () => {
      stopTimer(instance);
      iframe?.removeEventListener('load', reloaded);
      layer.player.removeEventListener('error', failed);
    };
    instances.set(layer.key, instance);
    load(instance);
  };

  const host: WebAnimationHost = {
    sync(layers) {
      const next = new Map(layers.map((layer) => [layer.key, layer]));
      for (const [key, instance] of instances) {
        if (next.get(key)?.player === instance.layer.player) continue;
        instance.detach();
        instances.delete(key);
      }
      for (const layer of layers) {
        const instance = instances.get(layer.key);
        if (instance === undefined) { attach(layer); continue; }
        const before = instance.layer;
        instance.layer = layer;
        const role = layer.role;
        if (role === 'premount') positionPremount(instance);
        else if (role === 'visible') {
          // An instance turning visible keeps what it was last sent when that is this frame's time.
          const moved = before.role === 'visible' ? mappingChanged(before, layer) : instance.session === null || instance.sentTime !== timeOf(instance);
          if (moved) bump(instance);
        }
      }
    },
    reposition() {
      for (const instance of instances.values()) if (instance.layer.role === 'visible') bump(instance);
    },
    sendFrame() {
      const frame = options.frame();
      for (const instance of instances.values()) {
        const { clip } = instance.layer;
        if (instance.layer.role === 'visible' && instance.session !== null && instance.state !== 'failed' && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames) sendSeek(instance);
      }
    },
    retry(key) {
      const instance = instances.get(key);
      if (instance?.state === 'failed') load(instance);
    },
    receive(event) {
      const data: unknown = event.data;
      if (event.source === null || typeof data !== 'object' || data === null) return;
      const { type, session, sequence } = data as { type?: unknown; session?: unknown; sequence?: unknown };
      for (const instance of instances.values()) {
        if (instance.layer.player.iframeElement?.contentWindow !== event.source) continue;
        if (instance.state === 'failed') return;
        if (type === 'breatic-bridge-ready') {
          stopTimer(instance);
          lastSession += 1;
          instance.session = lastSession;
          instance.sentTime = null;
          instance.state = 'waiting';
          // An idle instance is sent nothing until a copy takes it.
          if (instance.layer.role !== 'idle') sendSeek(instance);
          options.onChange();
        } else if (type === 'breatic-frame-ready' && instance.state === 'waiting' && session === instance.session && sequence === instance.sequence) {
          instance.state = 'ready';
          options.onChange();
        }
        return;
      }
    },
    states() {
      return new Map([...instances].map(([key, instance]) => [key, instance.state]));
    },
    ready() {
      return [...instances.values()].every((instance) => instance.layer.role !== 'visible' || instance.state === 'ready' || instance.state === 'failed');
    },
    listen() {
      /**
       * Hand a window message to the host.
       * @param event - The message.
       * @throws {never} Never.
       */
      const receive = (event: MessageEvent): void => { host.receive(event); };
      window.addEventListener('message', receive);
      return () => {
        window.removeEventListener('message', receive);
        host.dispose();
      };
    },
    dispose() {
      for (const instance of instances.values()) instance.detach();
      instances.clear();
    },
  };
  return host;
}
