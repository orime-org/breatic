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

afterEach(() => { cleanup(); scenes.length = 0; canvases.length = 0; });

describe('model import preview (inner#1693 design 5.7)', () => {
  it('lights the preview without a generated environment, since the 3D Space is a schematic view', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ metalness: 1 })));
    const view = render(<ModelImportPreview root={root} />);
    const scene = scenes.at(-1);
    if (!scene) throw new Error('no preview render');
    expect(scene.environment).toBeNull();
    view.unmount();
  });

  it('draws again once the GPU context comes back, and not after it closed', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ metalness: 1 })));
    const view = render(<ModelImportPreview root={root} />);
    const canvas = canvases.at(-1)!;
    const draws = scenes.length;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(scenes.length).toBeGreaterThan(draws);
    view.unmount();
    const closed = scenes.length;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(scenes).toHaveLength(closed);
  });
});
