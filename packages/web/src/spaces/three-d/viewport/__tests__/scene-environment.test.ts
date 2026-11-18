// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scene environment (inner#1693 design 5.7): the caller keeps the render target, because only its dispose frees the
 * texture a PMREM pass draws into.
 */

import { WebGLRenderTarget, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

const generated = vi.hoisted(() => ({ target: null as WebGLRenderTarget | null, disposed: 0 }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, PMREMGenerator: class {
    fromScene(): WebGLRenderTarget { generated.target = new actual.WebGLRenderTarget(1, 1); return generated.target; }
    dispose(): void { generated.disposed += 1; }
  } };
});

const { createSceneEnvironment } = await import('@web/spaces/three-d/viewport/scene-environment');

describe('createSceneEnvironment', () => {
  it('hands back the render target the room was drawn into and releases its generator', () => {
    const target = createSceneEnvironment({} as WebGLRenderer);
    expect(target).toBeInstanceOf(WebGLRenderTarget);
    expect(target).toBe(generated.target);
    expect(generated.disposed).toBe(1);
  });
});
