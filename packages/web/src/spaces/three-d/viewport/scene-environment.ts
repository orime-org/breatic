// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { PMREMGenerator, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * The environment's strength under the default ambient light: metal reads as metal while matte surfaces, already lit
 * by the ambient and key lights, brighten by about a fifth instead of washing out.
 */
export const SCENE_ENVIRONMENT_INTENSITY = 0.4;

/**
 * A neutral room for metal and glass to reflect (inner#1693 design 5.7): without an environment a fully metallic
 * surface has no diffuse light to show and renders almost black.
 * @param renderer - The renderer the texture is made for and later drawn with.
 * @returns The render target holding the prefiltered environment in its `texture`; the caller disposes the target with
 * its view, since disposing only its texture frees nothing in three's renderer.
 */
export function createSceneEnvironment(renderer: WebGLRenderer): WebGLRenderTarget {
  const generator = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = generator.fromScene(room, 0.04);
  room.dispose();
  generator.dispose();
  return target;
}
