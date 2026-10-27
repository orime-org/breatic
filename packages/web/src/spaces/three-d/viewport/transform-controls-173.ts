// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Camera, Vector3 } from 'three';
import { TransformControls, TransformControlsGizmo } from 'three/addons/controls/TransformControls.js';
import { uniformScaleRatio } from '@web/spaces/three-d/viewport/scene-transform';

interface UniformScaleStart {
  x: number;
  y: number;
  scale: Vector3;
}

/**
 * Isolate the approved r173 centre-scale and gizmo adaptation (inner#1689).
 * @throws {Error} When the installed helper no longer exposes the r173 gizmo.
 */
export class SceneTransformControls173 extends TransformControls {
  private scaleStart: UniformScaleStart | null = null;
  private sensitivity: number;
  private readonly onCancel: () => void;

  /**
   * Connect the official controls to one viewport.
   * @param camera - The personal view camera used for native gizmo projection and picking.
   * @param element - The viewport canvas receiving the official pointer listeners.
   * @param sensitivity - The configured uniform-scale exponent per CSS pixel of pointer displacement.
   * @param onCancel - Withdraws the owning session's draft when uniform scaling cannot produce a finite positive ratio.
   * @throws {never} Never directly; Three may reject an unavailable DOM target.
   */
  constructor(camera: Camera, element: HTMLElement, sensitivity: number, onCancel: () => void) {
    super(camera, element);
    this.sensitivity = sensitivity;
    this.onCancel = onCancel;
  }

  /**
   * Apply the current runtime calibration without rebuilding the controls.
   * @param sensitivity - The updated uniform-scale exponent per CSS pixel of pointer displacement.
   * @throws {never} Never.
   */
  setSensitivity(sensitivity: number): void {
    this.sensitivity = sensitivity;
  }

  /**
   * Capture screen coordinates after native picking has started a scale.
   * @param pointer - The starting native pointer sample in normalized viewport coordinates, or null.
   * @throws {never} Never directly.
   */
  override pointerDown(pointer: PointerEvent | null): void {
    super.pointerDown(pointer);
    this.scaleStart = this.dragging && this.mode === 'scale' && this.axis === 'XYZ' && pointer && this.object
      ? { x: pointer.x, y: pointer.y, scale: this.object.scale.clone() }
      : null;
  }

  /**
   * Retain native translation/rotation while using a positive uniform scale.
   * @param pointer - The current native pointer sample, including normalized coordinates and its movement button state.
   * @throws {never} Never directly.
   */
  override pointerMove(pointer: PointerEvent | null): void {
    const start = this.scaleStart;
    if (!start || !this.dragging || this.mode !== 'scale' || this.axis !== 'XYZ') {
      super.pointerMove(pointer);
      return;
    }
    if (!pointer || pointer.button !== -1 || !this.object || !this.domElement) return;
    const horizontal = (pointer.x - start.x) * this.domElement.clientWidth / 2;
    const vertical = (pointer.y - start.y) * this.domElement.clientHeight / 2;
    const ratio = uniformScaleRatio(horizontal, vertical, this.sensitivity);
    if (ratio === null) {
      this.cancelInteraction();
      this.onCancel();
      return;
    }
    this.object.scale.copy(start.scale).multiplyScalar(ratio);
    this.dispatchEvent({ type: 'change' });
    this.dispatchEvent({ type: 'objectChange' });
  }

  /**
   * Clear scale capture after the official end event.
   * @param pointer - The released native pointer sample, or null when the caller ends without a sample.
   * @throws {never} Never directly.
   */
  override pointerUp(pointer: PointerEvent | null): void {
    super.pointerUp(pointer);
    if (!this.dragging) this.scaleStart = null;
  }

  /**
   * Cancel without calling pointerUp, whose mouseUp event would commit.
   * @param reconnect - Whether to reconnect DOM listeners to clear drag handlers; false preserves listener order during normal pointer-up dispatch.
   * @throws {never} Never.
   */
  cancelInteraction(reconnect = true): void {
    if (reconnect) {
      this.disconnect();
      this.connect();
    }
    this.scaleStart = null;
    this.dragging = false;
    this.axis = null;
  }

  /**
   * Hide nonuniform multiselect handles from both drawing and picking.
   * @param multiple - Whether more than one scene object shares the temporary transform pivot.
   * @throws {Error} When the installed helper differs from r173.
   */
  setMultipleSelection(multiple: boolean): void {
    const gizmo = this.getHelper().children.find((child) => child instanceof TransformControlsGizmo);
    if (!(gizmo instanceof TransformControlsGizmo)) throw new Error('Unexpected TransformControls r173 helper');
    for (const group of [gizmo.gizmo.scale, gizmo.picker.scale]) {
      for (const handle of group.children) handle.layers.set(multiple && handle.name !== 'XYZ' ? 1 : 0);
    }
  }
}
