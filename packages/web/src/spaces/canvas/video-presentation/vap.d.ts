// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

// The fixed package ships dist declarations but omits its package.json types
// entry. This declaration covers only the public API used by our adapter.
declare module 'video-animation-player' {
  export interface VapOptions {
    container: HTMLElement;
    src: string;
    config: Record<string, unknown>;
    width: number;
    height: number;
    loop: boolean;
    mute: boolean;
    accurate: boolean;
    precache: boolean;
    onLoadError: () => void;
  }
  export interface VapPlayer {
    video: HTMLVideoElement;
    play: (options: VapOptions) => unknown;
    initWebGL: () => WebGLRenderingContext;
    initTexture: () => void;
    initVideoTexture: () => void;
    drawFrame: (now: number, metadata: unknown) => void;
    cancelRequestAnimation: () => void;
    destroy: () => void;
  }
  /**
   * Constructs the approved fixed VAP browser renderer.
   * @returns Its public renderer instance.
   * @throws {Error} When WebGL is unavailable.
   */
  export type VapFactory = () => VapPlayer;
  const createVap: VapFactory | { default: VapFactory };
  export default createVap;
}
