// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import {
  BoxGeometry, BufferGeometry, CanvasTexture, ConeGeometry, DirectionalLight, Float32BufferAttribute, Group, LineBasicMaterial,
  LineSegments, MathUtils, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, PointLight, SphereGeometry, SpotLight, Sprite,
  SpriteMaterial,
} from 'three';
import { SCENE_SPOT_ANGLE_DEFAULT, isSceneCamera, isSceneLight, type SceneCameraObject, type SceneDirectorConfig, type SceneLightObject, type SceneObject } from '@breatic/shared';

import type { LightPlan } from '@web/spaces/three-d/viewport/director-lights';

/** Layer of the camera and light icons: drawn in the main view and picked by a click. */
export const DISPLAY_PICK_LAYER = 1;
/** Layer of frustum and direction lines and number labels: drawn in the main view, never picked. */
export const DISPLAY_LINE_LAYER = 2;
/** The film gauge a camera's focal length is measured on, in millimetres. */
export const CAMERA_FILM_GAUGE = 36;
/** Length of a camera's frustum lines and a light's direction line, in scene units. */
const GUIDE_LENGTH = 1.5;

/**
 * A camera record's frame ratio, width over height.
 * @param camera - The record.
 * @returns The ratio.
 */
export function cameraAspect(camera: SceneCameraObject): number {
  if (camera.frame === 'Free') return camera.freeRatio;
  const [width, height] = camera.frame.split(':').map(Number);
  return (width ?? 1) / (height ?? 1);
}

/**
 * Set a perspective camera to a camera record's lens and pose.
 * @param target - The camera to set.
 * @param camera - The record.
 * @param aspect - The frame ratio to project with.
 */
export function applyCameraRecord(target: PerspectiveCamera, camera: SceneCameraObject, aspect: number): void {
  target.position.fromArray(camera.position);
  target.quaternion.fromArray(camera.rotation);
  target.filmGauge = CAMERA_FILM_GAUGE;
  target.aspect = aspect;
  target.setFocalLength(camera.focalLength);
  target.updateMatrixWorld(true);
}

/**
 * Put an object and its descendants on one layer only.
 * @param object - The object.
 * @param layer - The layer.
 */
function onLayer(object: Object3D, layer: number): void {
  object.traverse((child) => { child.layers.set(layer); });
}

/**
 * A sprite showing a record's number, or null where no 2D canvas is available.
 * @returns The sprite and its painter.
 */
function numberLabel(): { sprite: Sprite; paint: (text: string, color: string) => void } | null {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.setScalar(0.3);
  sprite.position.set(0.25, 0.25, 0.3);
  sprite.renderOrder = 900;
  /**
   * Draw the number.
   * @param text - The number as text.
   * @param color - The text colour.
   */
  const paint = (text: string, color: string): void => {
    context.clearRect(0, 0, 64, 64);
    context.fillStyle = color;
    context.font = '600 40px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 32, 34);
    texture.needsUpdate = true;
  };
  return { sprite, paint };
}

/** Display settings shared by every figure. */
export interface FigureStyle {
  /** Colour of camera icons and number labels. */
  ink: string;
  director: SceneDirectorConfig | undefined;
}

/**
 * The visible figure of one camera or light record and, for a light, its light; its root carries the record's id.
 * @throws {never} Never.
 */
export class DirectorFigure {
  readonly root = new Group();
  readonly light: DirectionalLight | PointLight | SpotLight | null = null;
  private readonly materials: Array<MeshBasicMaterial | LineBasicMaterial> = [];
  private readonly guide: LineSegments | null = null;
  private readonly label: ReturnType<typeof numberLabel>;
  private paintedLabel = '';

  /**
   * Build the figure for a record.
   * @param object - A camera or light record.
   */
  constructor(object: SceneObject) {
    this.root.userData.sceneObjectId = object.id;
    const icon = new Group();
    if (isSceneCamera(object)) {
      const ink = new MeshBasicMaterial();
      this.materials.push(ink);
      // The whole icon sits behind the camera's origin, so a view standing on the camera never has it in front.
      const body = new Mesh(new BoxGeometry(0.24, 0.18, 0.3), ink);
      body.position.z = 0.29;
      const lens = new Mesh(new ConeGeometry(0.09, 0.14, 16), ink);
      lens.rotation.x = Math.PI / 2;
      lens.position.z = 0.07;
      icon.add(body, lens);
      this.guide = new LineSegments(new BufferGeometry(), this.line());
    } else if (isSceneLight(object)) {
      const glow = new MeshBasicMaterial();
      this.materials.push(glow);
      if (object.model.type === 'point') {
        icon.add(new Mesh(new SphereGeometry(0.12, 16, 12), glow));
        const point = new PointLight();
        point.decay = 2;
        point.distance = 0;
        this.light = point;
      } else {
        const shape = object.model.type === 'spot' ? new ConeGeometry(0.12, 0.22, 16) : new SphereGeometry(0.14, 16, 12);
        const mesh = new Mesh(shape, glow);
        if (object.model.type === 'spot') mesh.rotation.x = -Math.PI / 2;
        icon.add(mesh);
        if (object.model.type === 'spot') {
          const spot = new SpotLight();
          spot.decay = 2;
          spot.distance = 0;
          this.light = spot;
        } else this.light = new DirectionalLight();
        const target = new Object3D();
        target.position.set(0, 0, -1);
        this.light.add(target);
        this.light.target = target;
        const guide = new BufferGeometry();
        guide.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -GUIDE_LENGTH], 3));
        this.guide = new LineSegments(guide, this.line());
      }
      this.root.add(this.light);
    }
    onLayer(icon, DISPLAY_PICK_LAYER);
    this.root.add(icon);
    if (this.guide) { onLayer(this.guide, DISPLAY_LINE_LAYER); this.root.add(this.guide); }
    this.label = numberLabel();
    if (this.label) { onLayer(this.label.sprite, DISPLAY_LINE_LAYER); this.root.add(this.label.sprite); }
  }

  /**
   * A line material owned by this figure.
   * @returns The material.
   */
  private line(): LineBasicMaterial {
    const material = new LineBasicMaterial();
    this.materials.push(material);
    return material;
  }

  /**
   * Show a record's current values.
   * @param object - The record, of the kind this figure was built for.
   * @param style - Colours and the director configuration.
   * @param plan - Whether this light shines and casts, for a light.
   */
  update(object: SceneObject, style: FigureStyle, plan: LightPlan | undefined): void {
    this.root.position.fromArray(object.position);
    this.root.quaternion.fromArray(object.rotation);
    this.root.updateMatrixWorld(true);
    const number = String(object.number ?? '');
    if (this.label && number !== this.paintedLabel) { this.label.paint(number, style.ink); this.paintedLabel = number; }
    if (isSceneCamera(object)) {
      for (const material of this.materials) material.color.setStyle(style.ink);
      this.shapeFrustum(object);
      return;
    }
    if (!isSceneLight(object) || !this.light) return;
    for (const material of this.materials) material.color.setStyle(object.color);
    this.applyLight(object, style.director, plan);
  }

  /**
   * Redraw the frustum lines for the lens and frame.
   * @param camera - The camera record.
   */
  private shapeFrustum(camera: SceneCameraObject): void {
    if (!this.guide) return;
    const lens = new PerspectiveCamera();
    lens.filmGauge = CAMERA_FILM_GAUGE;
    lens.aspect = cameraAspect(camera);
    lens.setFocalLength(camera.focalLength);
    const halfHeight = Math.tan(MathUtils.degToRad(lens.fov) / 2) * GUIDE_LENGTH;
    const halfWidth = halfHeight * lens.aspect;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [(x ?? 0) * halfWidth, (y ?? 0) * halfHeight, -GUIDE_LENGTH]);
    const points: number[] = [];
    corners.forEach((corner, index) => {
      const next = corners[(index + 1) % corners.length] ?? corner;
      points.push(0, 0, 0, ...corner, ...corner, ...next);
    });
    this.guide.geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    this.guide.geometry.computeBoundingSphere();
  }

  /**
   * Set the light from the record and the plan.
   * @param light - The light record.
   * @param director - The director configuration, or undefined before it loads.
   * @param plan - The light's plan.
   */
  private applyLight(light: SceneLightObject, director: SceneDirectorConfig | undefined, plan: LightPlan | undefined): void {
    const target = this.light;
    if (!target) return;
    target.color.setStyle(light.color);
    target.intensity = light.intensity;
    target.visible = plan?.enabled ?? false;
    target.castShadow = plan?.castsShadow ?? false;
    if (target instanceof SpotLight) target.angle = MathUtils.degToRad(light.angle ?? SCENE_SPOT_ANGLE_DEFAULT);
    const point = target instanceof PointLight;
    if (director) {
      target.shadow.bias = point ? director.pointShadowBias : director.shadowBias;
      target.shadow.normalBias = point ? director.pointShadowNormalBias : director.shadowNormalBias;
    }
    const edge = point ? director?.pointShadowMapPx : director?.shadowMapPx;
    if (edge !== undefined && target.shadow.mapSize.x !== edge) {
      target.shadow.mapSize.set(edge, edge);
      target.shadow.map?.dispose();
      target.shadow.map = null;
    }
  }

  /**
   * Release geometries, materials and textures this figure owns.
   */
  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((child) => {
      if (child instanceof Mesh || child instanceof LineSegments) child.geometry.dispose();
      if (child instanceof Sprite) { child.material.map?.dispose(); child.material.dispose(); }
    });
    for (const material of this.materials) material.dispose();
    this.light?.shadow.dispose();
  }
}
