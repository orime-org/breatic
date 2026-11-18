// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { PMREMGenerator, type Texture, type WebGLRenderer } from 'three';
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
 * @returns The prefiltered environment; the caller disposes it with its view.
 */
export function createSceneEnvironment(renderer: WebGLRenderer): Texture {
  const generator = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const texture = generator.fromScene(room, 0.04).texture;
  room.dispose();
  generator.dispose();
  return texture;
}
