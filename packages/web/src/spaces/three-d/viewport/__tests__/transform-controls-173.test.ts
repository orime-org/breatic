// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera } from 'three';
import { TransformControlsGizmo } from 'three/addons/controls/TransformControls.js';
import { SceneTransformControls173 } from '@web/spaces/three-d/viewport/transform-controls-173';

describe('the installed r173 controls adapter (inner#1689)', () => {
  it('cancels native interaction without publishing a mouseUp commit', () => {
    const canvas = document.createElement('canvas');
    const controls = new SceneTransformControls173(new PerspectiveCamera(), canvas, 0.006, vi.fn());
    const mouseUp = vi.fn();
    controls.addEventListener('mouseUp', mouseUp);
    controls.attach(new Object3D());
    controls.dragging = true;
    controls.axis = 'XYZ';
    controls.cancelInteraction();
    controls.cancelInteraction();
    expect(controls.dragging).toBe(false);
    expect(controls.axis).toBeNull();
    expect(mouseUp).toHaveBeenCalledTimes(0);
    controls.dispose();
  });

  it('removes both drawing and picking of nonuniform multiselect scale handles', () => {
    const controls = new SceneTransformControls173(new PerspectiveCamera(), document.createElement('canvas'), 0.006, vi.fn());
    const gizmo = controls.getHelper().children.find((child) => child instanceof TransformControlsGizmo);
    if (!(gizmo instanceof TransformControlsGizmo)) throw new Error('Installed r173 helper has no gizmo');
    controls.setMultipleSelection(true);
    for (const group of [gizmo.gizmo.scale, gizmo.picker.scale]) {
      expect(group.children.filter((handle) => handle.layers.isEnabled(0)).map((handle) => handle.name)).toEqual(['XYZ']);
    }
    controls.setMultipleSelection(false);
    expect(gizmo.picker.scale.children.every((handle) => handle.layers.isEnabled(0))).toBe(true);
    controls.dispose();
  });
});
