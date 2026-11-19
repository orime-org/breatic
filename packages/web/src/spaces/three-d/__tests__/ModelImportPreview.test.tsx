// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Scene } from 'three';
import { ModelImportPreview } from '@web/spaces/three-d/ModelImportPreview';

const scenes: Scene[] = [];
const canvases = vi.hoisted(() => [] as HTMLCanvasElement[]);
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = (() => { const canvas = document.createElement('canvas'); canvases.push(canvas); return canvas; })();
    setPixelRatio(): void {} setSize(): void {} setClearAlpha(): void {} dispose(): void {} forceContextLoss(): void {}
    render(scene: Scene): void { scenes.push(scene); }
  } };
});
const environments = vi.hoisted(() => [] as Array<{ dispose: () => void; texture: unknown }>);
vi.mock('@web/spaces/three-d/viewport/scene-environment', async () => {
  const { WebGLRenderTarget } = await import('three');
  return { SCENE_ENVIRONMENT_INTENSITY: 0.4, createSceneEnvironment: vi.fn(() => { const target = new WebGLRenderTarget(1, 1); environments.push(target); return target; }) };
});

afterEach(() => { cleanup(); scenes.length = 0; environments.length = 0; canvases.length = 0; });

describe('model import preview (inner#1693 design 5.7)', () => {
  it('lights the preview with a neutral environment at the default strength and releases it on unmount', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ metalness: 1 })));
    const view = render(<ModelImportPreview root={root} />);
    const scene = scenes.at(-1);
    const environment = environments.at(-1);
    if (!scene || !environment) throw new Error('no preview render');
    expect(scene.environment).toBe(environment.texture);
    expect(scene.environmentIntensity).toBe(0.4);
    const dispose = vi.spyOn(environment, 'dispose');
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('builds its environment again after the GPU context comes back, freeing the emptied one, and draws again', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ metalness: 1 })));
    const view = render(<ModelImportPreview root={root} />);
    const first = environments.at(-1)!;
    const dispose = vi.spyOn(first, 'dispose');
    const draws = scenes.length;
    canvases.at(-1)!.dispatchEvent(new Event('webglcontextrestored'));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(environments).toHaveLength(2);
    expect(scenes.length).toBeGreaterThan(draws);
    expect(scenes.at(-1)!.environment).toBe(environments[1]!.texture);
    const second = vi.spyOn(environments[1]!, 'dispose');
    view.unmount();
    expect(second).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    // A restore after unmount builds nothing.
    canvases.at(-1)!.dispatchEvent(new Event('webglcontextrestored'));
    expect(environments).toHaveLength(2);
  });
});
