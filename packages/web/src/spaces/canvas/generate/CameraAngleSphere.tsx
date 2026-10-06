// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The camera-angle sphere (inner#830): the subject's card in the middle, the
 * camera on a sphere round it, drawn with three.js.
 *
 * Its own lazy chunk. It imports three.js, React and the geometry beside it,
 * and takes every word, colour and address as a prop (see
 * `camera-angle-sphere-props.ts` for why).
 */

import * as React from 'react';
import * as THREE from 'three';

import type { CameraAngle } from '@breatic/shared';

import {
  AZIMUTH_STEPS,
  ELEVATION_RANGE,
  angleFromOffset,
  cameraOffset,
  pickOnSphere,
  radiusFor,
} from '@web/spaces/canvas/generate/camera-angle-geometry';
import type { CameraAngleSphereProps, SphereColors } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

/** Where the card's centre sits. */
const CENTER = new THREE.Vector3(0, 0.15, 0);

/** Where the viewer looks from: in front of the subject and to its right, above. */
const EYE = new THREE.Vector3(-2.5, 2.0, 3.2);

/** How long a move to a new pose takes, in ms. */
const SETTLE_MS = 200;

/** The card's longer side, in scene units. */
const CARD_SIZE = 1.0;

/**
 * A CSS colour and its alpha, read the way three.js cannot: `THREE.Color`
 * drops the alpha of an `rgba()`, and `--color-border` is one.
 * @param css - The colour as the token resolves.
 * @param current - The colour the part has now.
 * @returns The colour and its opacity.
 */
function parseColor(css: string, current: THREE.Color): { color: THREE.Color; opacity: number } {
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(css);
  if (rgba) {
    const [, r, g, b, a] = rgba;
    const alpha = a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
    return { color: new THREE.Color(Number(r) / 255, Number(g) / 255, Number(b) / 255), opacity: alpha };
  }
  // A token that does not resolve leaves the part in the colour it had.
  const color = current.clone();
  if (css !== '') color.setStyle(css);
  return { color, opacity: 1 };
}

/**
 * A line material in one of the theme's colours.
 * @param material - The material to colour.
 * @param css - The colour.
 */
function paint(material: THREE.LineBasicMaterial | THREE.MeshBasicMaterial, css: string): void {
  const { color, opacity } = parseColor(css, material.color);
  material.color = color;
  material.opacity = opacity;
  material.transparent = opacity < 1;
  material.needsUpdate = true;
}

/** Everything the scene holds, built once per mount. */
interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  eye: THREE.PerspectiveCamera;
  card: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  arc: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** One tick on the ring for each azimuth the grid holds. */
  ticks: { azimuth: number; mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> }[];
  tickMaterial: THREE.MeshBasicMaterial;
  camera: THREE.Group;
  cameraMaterial: THREE.MeshBasicMaterial;
  ray: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
}

/**
 * The points of a circle arc in the plane x = 0, from one elevation to another.
 * @param from - Degrees.
 * @param to - Degrees.
 * @returns The points, on a unit circle.
 */
function arcPoints(from: number, to: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let a = from; a <= to; a += 3) {
    const r = (a * Math.PI) / 180;
    points.push(new THREE.Vector3(0, Math.sin(r), Math.cos(r)));
  }
  return points;
}

/**
 * Builds the scene into a canvas.
 * @param canvas - The canvas to draw into.
 * @returns The scene.
 * @throws {Error} When the browser cannot create a WebGL context.
 */
function buildScene(canvas: HTMLCanvasElement): Scene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const scene = new THREE.Scene();
  const eye = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 100);
  eye.position.copy(EYE);
  eye.lookAt(CENTER);

  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_SIZE * 0.75, CARD_SIZE),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  card.position.copy(CENTER);
  scene.add(card);

  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 120 }, (_, i) => {
        const t = (i / 120) * Math.PI * 2;
        return new THREE.Vector3(Math.sin(t), 0, Math.cos(t));
      }),
    ),
    new THREE.LineBasicMaterial(),
  );
  ring.position.copy(CENTER);
  scene.add(ring);

  const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPoints(...ELEVATION_RANGE)), new THREE.LineBasicMaterial());
  arc.position.copy(CENTER);
  scene.add(arc);

  const tickMaterial = new THREE.MeshBasicMaterial();
  const tickGeometry = new THREE.SphereGeometry(0.035, 12, 8);
  const ticks = AZIMUTH_STEPS.map((azimuth) => {
    const mesh = new THREE.Mesh(tickGeometry, tickMaterial);
    scene.add(mesh);
    return { azimuth, mesh };
  });

  const cameraMaterial = new THREE.MeshBasicMaterial();
  const camera = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.18), cameraMaterial);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 16), cameraMaterial);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.13;
  camera.add(body, lens);
  scene.add(camera);

  const ray = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ dashSize: 0.06, gapSize: 0.05 }));
  scene.add(ray);

  return { renderer, scene, eye, card, ring, arc, ticks, tickMaterial, camera, cameraMaterial, ray };
}

/**
 * Colours every part of the scene from the theme.
 * @param s - The scene.
 * @param colors - The theme's colours.
 */
function applyColors(s: Scene, colors: SphereColors): void {
  paint(s.ring.material, colors.line);
  paint(s.tickMaterial, colors.line);
  paint(s.arc.material, colors.accent);
  paint(s.cameraMaterial, colors.accent);
  paint(s.ray.material, colors.accent);
  if (s.card.material.map === null) paint(s.card.material, colors.card);
}

/**
 * Places the camera, the arc and the ticks for a pose.
 * @param s - The scene.
 * @param pose - The pose to draw.
 */
function place(s: Scene, pose: CameraAngle): void {
  const r = radiusFor(pose.distance);
  const offset = cameraOffset(pose.azimuth, pose.elevation, r);
  const at = new THREE.Vector3(offset.x, offset.y, offset.z).add(CENTER);
  s.camera.position.copy(at);
  s.camera.lookAt(CENTER);
  s.ring.scale.setScalar(r);
  s.arc.scale.setScalar(r);
  s.arc.rotation.y = (-pose.azimuth * Math.PI) / 180;
  s.ticks.forEach(({ azimuth, mesh }) => {
    const o = cameraOffset(azimuth, 0, r);
    mesh.position.set(o.x, o.y, o.z).add(CENTER);
  });
  s.ray.geometry.setFromPoints([at, CENTER]);
  s.ray.computeLineDistances();
}

/**
 * Frees everything the scene allocated on the GPU.
 * @param s - The scene.
 */
function dispose(s: Scene): void {
  s.scene.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  });
  s.renderer.dispose();
}

/**
 * The shortest signed turn from one azimuth to another.
 * @param from - Degrees.
 * @param to - Degrees.
 * @returns Degrees in (-180, 180].
 */
function turn(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/**
 * The sphere.
 * @param props - See {@link CameraAngleSphereProps}.
 * @returns The canvas.
 */
export default function CameraAngleSphere(props: CameraAngleSphereProps): React.JSX.Element {
  const { pose, subjectUrl, colors, animate, onDragStart, onDrag, onDragEnd, onUnavailable } = props;
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const sceneRef = React.useRef<Scene | null>(null);
  const viewRef = React.useRef<CameraAngle>(pose);
  const draggingRef = React.useRef(false);
  const frameRef = React.useRef(0);
  const latest = React.useRef({ pose, onDrag, colors });
  latest.current = { pose, onDrag, colors };

  /** Draws the current view. */
  const draw = React.useCallback((): void => {
    const s = sceneRef.current;
    if (!s) return;
    place(s, viewRef.current);
    s.renderer.render(s.scene, s.eye);
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let s: Scene;
    try {
      s = buildScene(canvas);
    } catch {
      onUnavailable();
      return;
    }
    sceneRef.current = s;
    const resize = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = canvas;
      if (w === 0 || h === 0) return;
      s.renderer.setSize(w, h, false);
      s.eye.aspect = w / h;
      s.eye.updateProjectionMatrix();
      draw();
    });
    resize.observe(canvas);
    return () => {
      cancelAnimationFrame(frameRef.current);
      resize.disconnect();
      dispose(s);
      sceneRef.current = null;
    };
  }, [draw, onUnavailable]);

  React.useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    applyColors(s, colors);
    draw();
  }, [colors, draw]);

  React.useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const material = s.card.material;
    /** The card without a picture: no image is sent, or the one sent cannot be read. */
    const plain = (): void => {
      material.map?.dispose();
      material.map = null;
      s.card.scale.set(1, 1, 1);
      applyColors(s, latest.current.colors);
      draw();
    };
    if (subjectUrl === undefined) {
      plain();
      return;
    }
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      subjectUrl,
      (texture) => {
        if (cancelled) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        material.map?.dispose();
        material.map = texture;
        // White leaves the picture's own colours untouched.
        material.color.setRGB(1, 1, 1);
        material.opacity = 1;
        material.transparent = false;
        material.needsUpdate = true;
        const image = texture.image as { width?: number; height?: number } | undefined;
        const aspect = image?.width && image.height ? image.width / image.height : 0.75;
        // The plane is 0.75 wide by 1 tall; fit the picture's own shape inside a 1 x 1 box.
        s.card.scale.set(Math.min(1, aspect) / 0.75, Math.min(1, 1 / aspect), 1);
        draw();
      },
      undefined,
      () => {
        if (!cancelled) plain();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [subjectUrl, draw]);

  React.useEffect(() => {
    cancelAnimationFrame(frameRef.current);
    if (draggingRef.current || !animate) {
      viewRef.current = pose;
      draw();
      return;
    }
    const from = viewRef.current;
    const da = turn(from.azimuth, pose.azimuth);
    const start = performance.now();
    /**
     * One frame of the move to the new pose.
     * @param now - The frame's time.
     */
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / SETTLE_MS);
      const e = 1 - (1 - k) ** 3;
      viewRef.current = {
        azimuth: from.azimuth + da * e,
        elevation: from.elevation + (pose.elevation - from.elevation) * e,
        distance: from.distance + (pose.distance - from.distance) * e,
      };
      draw();
      if (k < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [pose, animate, draw]);

  /**
   * Puts the camera under the pointer and reports the pose.
   * @param event - The pointer event.
   */
  const pick = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>): void => {
    const s = sceneRef.current;
    if (!s) return;
    const box = event.currentTarget.getBoundingClientRect();
    const caster = new THREE.Raycaster();
    caster.setFromCamera(
      new THREE.Vector2(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1),
      s.eye,
    );
    const r = radiusFor(latest.current.pose.distance);
    const point = pickOnSphere(caster.ray.origin, caster.ray.direction, CENTER, r, s.camera.position);
    const { azimuth, elevation } = angleFromOffset(
      { x: point.x - CENTER.x, y: point.y - CENTER.y, z: point.z - CENTER.z },
      r,
    );
    latest.current.onDrag({ azimuth, elevation, distance: latest.current.pose.distance });
  }, []);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      if (event.button !== 0 || !sceneRef.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      cancelAnimationFrame(frameRef.current);
      draggingRef.current = true;
      onDragStart();
      pick(event);
    },
    [onDragStart, pick],
  );
  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      if (draggingRef.current) pick(event);
    },
    [pick],
  );
  const end = React.useCallback((): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onDragEnd();
  }, [onDragEnd]);

  return (
    <canvas
      ref={canvasRef}
      data-testid='generate-camera-angle-sphere'
      className='block h-full w-full cursor-grab active:cursor-grabbing'
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onLostPointerCapture={end}
    />
  );
}
