// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Box3, BoxHelper, Color, DirectionalLight, GridHelper, Group, HemisphereLight, Mesh, MeshBasicMaterial, OrthographicCamera, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Quaternion, Raycaster, Scene, ShadowMaterial, SkinnedMesh, SphereGeometry, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControlsGizmo } from 'three/addons/controls/TransformControls.js';
import type { Bone, Intersection, Object3D } from 'three';
import {
  SCENE_AMBIENT_COLOR_DEFAULT, SCENE_AMBIENT_INTENSITY_DEFAULT, isSceneCamera, isSceneLight, isSceneModelFile,
  type SceneCameraObject, type SceneModelFile, type SceneObject, type ScenePose,
} from '@breatic/shared';
import { DirectorFigure, applyCameraRecord } from '@web/spaces/three-d/viewport/director-objects';
import { DISPLAY_LINE_LAYER, DISPLAY_PICK_LAYER } from '@web/spaces/three-d/viewport/scene-layers';
import { cameraFrameRatio } from '@web/spaces/three-d/viewfinder/viewfinder-ratio';
import { directionalShadowRange, localShadowFar, planLights, programSamplers, shadowSlots, type LightsPlan } from '@web/spaces/three-d/viewport/director-lights';
import { monitorReducer, monitorsDue, type MonitorCards, type MonitorEvent } from '@web/spaces/three-d/viewport/monitor-schedule';
import { ScenePilot, pilotPivotDistance } from '@web/spaces/three-d/viewport/scene-pilot';
import { displayedObjects, previewedObjectIds } from '@web/spaces/three-d/viewport/scene-display';
import { applyPose, poseRigOf, type PoseRig } from '@web/spaces/three-d/viewport/pose-rig';
import { SceneMiniMapRuntime } from '@web/spaces/three-d/viewport/scene-mini-map';
import { SCENE_ENVIRONMENT_INTENSITY, createSceneEnvironment } from '@web/spaces/three-d/viewport/scene-environment';
import { SceneLookRuntime, lookReportOf } from '@web/spaces/three-d/viewport/scene-look-runtime';
import { decideScenePick, partAtHit } from '@web/spaces/three-d/viewport/look-highlight';
import { applySceneGridTheme } from '@web/spaces/three-d/viewport/scene-grid-theme';
import { ModelResourceCache, acquireMeasured, loadSceneModel, type MeasuredSceneModelLease } from '@web/spaces/three-d/viewport/model-resources';
import type { SceneModelLease } from '@web/spaces/three-d/viewport/model-resources';
import { createTransformGesture, transformPatches } from '@web/spaces/three-d/viewport/scene-transform';
import type { SceneTransformGesture } from '@web/spaces/three-d/viewport/scene-transform';
import { SceneTransformControls173 } from '@web/spaces/three-d/viewport/transform-controls-173';
import { SCENE_VIEW_FAR, SCENE_VIEW_FOV, SCENE_VIEW_NEAR, captureViewOffset, focusSceneBounds, updateSceneCameraRange } from '@web/spaces/three-d/viewport/scene-camera';
import { createOrbitUserMoveWatch } from '@web/spaces/three-d/viewport/orbit-user-move';
import type { CapturedPixels, SceneCameraView, SceneFrameCapture, SceneTransformPatch, SceneViewportProps, SceneView } from '@web/spaces/three-d/viewport/scene-viewport-props';

/** Width and depth of the ground that shows shadows, matching the grid. */
const GROUND_SIZE = 200;
/** How dark a shadow on the ground is. */
const GROUND_SHADOW_OPACITY = 0.3;

/**
 * A lease for a figure the viewport builds itself: releasing it disposes the figure.
 * @param figure - The figure.
 * @returns Its lease.
 */
function figureLease(figure: DirectorFigure): SceneModelLease {
  return { ready: Promise.resolve(figure.root), release: () => figure.dispose() };
}

interface NativeHandleObservation {
  name: string;
  visible: boolean;
  layer: number;
  cameraLayer: boolean;
  rayLayer: boolean;
  center: [number, number, number];
}

/**
 * Each part's first material as drawn, for the page's own inspection: its class, colour and whether it shows a picture.
 * @param root - A loaded instance.
 * @returns The drawn state by part.
 */
function renderedParts(root: Group): Record<string, { type: string; color: string | null; map: boolean }> {
  const parts: Record<string, { type: string; color: string | null; map: boolean }> = {};
  root.traverse((child) => {
    if (child.userData.lookHighlight || !(child instanceof Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      const part = material.userData.lookPart as string | undefined;
      if (part === undefined || parts[part]) continue;
      const drawn = material as MeshBasicMaterial;
      parts[part] = { type: material.type, color: drawn.color ? `#${drawn.color.getHexString()}` : null, map: Boolean(drawn.map) };
    }
  });
  return parts;
}

interface RenderedObject {
  source: string;
  lease: SceneModelLease;
  root: Group | null;
  state: 'loading' | 'ready' | 'failed';
  /** Its parts as last drawn, read again only when a look applies. */
  parts?: Record<string, { type: string; color: string | null; map: boolean }>;
}
/** One joint drag: its rig, the dragged bone's key and the committed pose it started from. */
interface JointGesture {
  id: string;
  key: string;
  root: Group;
  rig: PoseRig;
  start: ScenePose;
}
/** The single selected character whose joints joint mode shows. */
interface JointTarget {
  object: SceneObject;
  root: Group;
  rig: PoseRig;
}
interface JointMarker {
  key: string;
  bone: Bone;
  mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** A slightly larger sphere drawn just under the dot in the background colour, so the dot keeps an edge on any surface. */
  rim: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** The dot's radius in the character's own space at rest, scaled by its world scale when drawn. */
  unit: number;
}
/**
 * The largest axis of an object's world scale.
 * @param object - The object, its world matrix current.
 * @returns The largest scale factor.
 */
function largestScale(object: Object3D): number {
  object.updateWorldMatrix(true, false);
  const scale = object.getWorldScale(new Vector3());
  return Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
}
interface PointerOrigin {
  x: number;
  y: number;
  id: number;
}

/**
 * Compare membership independently from awareness arrival or list ordering.
 * @param left - The first selection's stable object IDs.
 * @param right - The object IDs to compare with the first selection.
 * @returns Whether the selections have the same size and contain the same object IDs, regardless of order.
 * @throws {never} Never.
 */
function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/**
 * Apply a complete object tuple snapshot to one independent model instance.
 * @param root - The loaded instance whose local transform and world matrix will be updated.
 * @param object - The scene snapshot supplying complete position, quaternion and scale tuples.
 * @throws {never} Never.
 */
function applyObject(root: Group, object: SceneObject): void {
  root.position.fromArray(object.position);
  root.quaternion.fromArray(object.rotation);
  root.scale.fromArray(object.scale);
  root.updateMatrixWorld(true);
}

/**
 * The joint a click on a skinned mesh means: the bone weighing most on the hit
 * triangle, or its nearest ancestor that shows a joint.
 * @param hit - The model hit.
 * @param keys - The shown joints by bone.
 * @returns The joint's pose key, or null when the hit is on no shown joint's skin.
 * @throws {never} Never.
 */
function jointAt(hit: Intersection, keys: ReadonlyMap<Object3D, string>): string | null {
  const mesh = hit.object;
  if (!(mesh instanceof SkinnedMesh) || !hit.face) return null;
  const index = mesh.geometry.getAttribute('skinIndex');
  const weight = mesh.geometry.getAttribute('skinWeight');
  if (!index || !weight) return null;
  const totals = new Map<number, number>();
  for (const vertex of [hit.face.a, hit.face.b, hit.face.c]) {
    for (let slot = 0; slot < index.itemSize; slot += 1) {
      const bone = index.getComponent(vertex, slot);
      totals.set(bone, (totals.get(bone) ?? 0) + weight.getComponent(vertex, slot));
    }
  }
  let heaviest = -1;
  let most = 0;
  for (const [bone, total] of totals) if (total > most) { heaviest = bone; most = total; }
  let node: Object3D | null = mesh.skeleton.bones[heaviest] ?? null;
  while (node && !keys.has(node)) node = node.parent;
  return node ? keys.get(node) ?? null : null;
}

/**
 * Convert thrown loader values into the application's ordinary error contract.
 * @param error - The value thrown while resolving, loading or instantiating a model.
 * @returns The existing Error, or an Error containing the string form of the thrown value.
 * @throws {never} Never.
 */
function sceneError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Own one visible Three view; the session and Y.Doc live outside this class.
 * @throws {Error} When WebGL or the installed controls cannot be constructed.
 */
export class SceneViewportRuntime {
  private props: SceneViewportProps;
  private readonly host: HTMLDivElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(SCENE_VIEW_FOV, 1, SCENE_VIEW_NEAR, SCENE_VIEW_FAR);
  private readonly renderer: WebGLRenderer;
  private readonly orbit: OrbitControls;
  /** Tells the user's own Orbit navigation from camera changes this code applies (#920). */
  private readonly userMove = createOrbitUserMoveWatch(() => this.props.onUserCameraMove?.());
  private readonly controls: SceneTransformControls173;
  private readonly pivot = new Group();
  private readonly grid = new GridHelper(GROUND_SIZE, GROUND_SIZE);
  private readonly resources: ModelResourceCache;
  /**
   * Hold one model through this view's cache, measured for placing it; the
   * view's own hold on the placed object then reuses the same template.
   * @param source - The model to place.
   * @returns The bounds and this holder's release.
   * @throws {Error} The bounds reject when the model cannot load.
   */
  readonly acquireModel = (source: SceneModelFile): MeasuredSceneModelLease => acquireMeasured(this.resources, source);
  private readonly items = new Map<string, RenderedObject>();
  private overview: SceneMiniMapRuntime | null = null;
  private overviewHost: HTMLDivElement | null = null;
  private outlines: BoxHelper[] = [];
  /** True while an update or a model load runs, which ends with one 'changed' of its own. */
  private syncing = false;
  /** Each loaded object's look, its pictures and the highlighted part (inner#1693). */
  private readonly looks = new SceneLookRuntime({
    textures: () => this.props.lookTextures ?? null,
    limits: () => ({ maxTextureEdge: Math.min(this.props.importLimits.maxTextureEdge, this.renderer.capabilities.maxTextureSize),
      maxTextureBytes: this.props.importLimits.maxTextureBytes }),
    themeColor: () => this.token('--color-muted-foreground'),
    highlightColor: () => this.token('--color-status-selected'),
    onProgramChanged: (root) => {
      // A loading object is not in the scene yet; its load compiles it once its look is on.
      if (root.parent === null) return;
      // As a model load does: its programs compile first, so the shadow budget counts their samplers (design 5.2).
      this.renderer.compile(root, this.camera, this.scene);
      this.syncLights();
      this.markShadows(true);
    },
    // Inside an update or a model load, their own one 'changed' covers it.
    onChanged: (id) => {
      const item = id === undefined ? undefined : this.items.get(id);
      if (item) item.parts = undefined;
      if (this.syncing) return;
      this.monitorEvent({ type: 'changed' });
      this.inspect();
    },
    onPictures: (id, pictures) => this.props.onLookPictures?.(id, pictures),
  });
  private gesture: SceneTransformGesture | null = null;
  private joint: JointGesture | null = null;
  /** What each object is drawn with: the document, or a collaborator's drag (design 5.4). */
  private displayed: readonly SceneObject[] = [];
  /** Objects drawn from a drag still in progress, this page's or a collaborator's. */
  private previewed: ReadonlySet<string> = new Set();
  private readonly markers = new Group();
  private readonly markerGeometry = new SphereGeometry(1, 16, 12);
  private markerOwner: Group | null = null;
  private markerItems: JointMarker[] = [];
  private changed = false;
  private down: PointerOrigin | null = null;
  private suppressClick = false;
  private releasingPointer: number | null = null;
  private pendingFocus = false;
  private frame = 0;
  private disposed = false;
  private readonly resize: ResizeObserver;
  private readonly theme: MutationObserver;
  private readonly keyLight = new DirectionalLight(0xffffff, 3);
  private readonly ambient = new HemisphereLight(0xffffff, 0x666666, SCENE_AMBIENT_INTENSITY_DEFAULT);
  /** What metal and glass reflect; main view, monitors and stills all draw this scene (inner#1693 design 5.7). */
  private environment: WebGLRenderTarget;
  private readonly ground = new Mesh(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new ShadowMaterial({ opacity: GROUND_SHADOW_OPACITY }));
  /** Camera and light figures by record id; their roots are also in `items`. */
  private readonly figures = new Map<string, DirectorFigure>();
  private readonly pilot: ScenePilot;
  /** What the main view shows (inner#1694 design 3.4.3). */
  private view: SceneCameraView | null = null;
  private lightPlan: LightsPlan = { defaultKey: true, lights: {} };
  private reportedPlan = '';
  private shadowKey = '';
  private shadowsDirty = true;
  private cards: MonitorCards = {};
  private readonly monitorCanvases = new Map<string, HTMLCanvasElement>();
  private readonly monitorCamera = new PerspectiveCamera(SCENE_VIEW_FOV, 1, SCENE_VIEW_NEAR, SCENE_VIEW_FAR);
  private readonly cardVisibility: IntersectionObserver | null;
  private readonly cardSize: ResizeObserver;
  private monitorDrawnAt = 0;
  /** The theme colour the part reports last carried. */
  private reportedTheme = '';

  /**
   * Construct resources only within the React view's effect lifetime.
   * @param host - The visible viewport container that owns the canvas and supplies its measured dimensions.
   * @param props - The initial scene snapshots, personal camera state and callbacks to the owning session.
   * @throws {Error} When Three cannot construct a WebGL renderer or controls.
   */
  constructor(host: HTMLDivElement, props: SceneViewportProps) {
    this.host = host;
    this.props = props;
    this.renderer = new WebGLRenderer({ antialias: true });
    const canvas = this.renderer.domElement;
    canvas.className = 'block h-full w-full outline-none focus-visible:ring-1 focus-visible:ring-active-border';
    canvas.tabIndex = 0;
    canvas.dataset.testid = 'three-d-viewport';
    host.append(canvas);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // Shadow maps are drawn again only when a display value changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.environment = createSceneEnvironment(this.renderer);
    this.scene.environment = this.environment.texture;
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.camera.layers.enable(DISPLAY_PICK_LAYER);
    this.camera.layers.enable(DISPLAY_LINE_LAYER);
    this.camera.position.fromArray(props.view.position);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.fromArray(props.view.target);
    this.orbit.enableDamping = true;
    this.orbit.update();
    this.controls = new SceneTransformControls173(this.camera, canvas, props.scaleSensitivity, this.onCancel);
    this.scene.add(this.controls.getHelper(), this.pivot, this.grid, this.markers);
    this.keyLight.position.set(5, 10, 4);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ambient, this.keyLight, this.ground);
    this.resources = new ModelResourceCache((source, signal) => loadSceneModel(source, signal, this.props.resolveAsset, this.token('--color-muted-foreground'), this.props.importLimits, this.renderer));
    this.controls.addEventListener('mouseDown', this.onGestureStart);
    this.controls.addEventListener('objectChange', this.onGestureChange);
    this.controls.addEventListener('mouseUp', this.onGestureCommit);
    this.controls.addEventListener('dragging-changed', this.onDraggingChanged);
    this.orbit.addEventListener('change', this.onViewChange);
    this.orbit.addEventListener('start', this.userMove.start);
    this.orbit.addEventListener('change', this.userMove.change);
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointerup', this.onPointerUpCapture, true);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize = new ResizeObserver(this.onResize);
    this.resize.observe(host);
    this.theme = new MutationObserver(this.onThemeChange);
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    this.cardVisibility = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(this.onCardVisibility);
    this.cardSize = new ResizeObserver(this.onCardResize);
    this.pilot = new ScenePilot({
      canvas,
      active: () => this.view !== null,
      live: () => {
        const view = this.view;
        if (view?.kind !== 'live') return null;
        return { id: view.id, canPilot: view.canPilot, locked: this.cameraRecord(view.id)?.locked ?? false };
      },
      recordPose: () => {
        const record = this.view?.kind === 'live' ? this.cameraRecord(this.view.id) : null;
        return record ? { position: new Vector3().fromArray(record.position), quaternion: new Quaternion().fromArray(record.rotation) } : null;
      },
      objectGesture: () => this.dragging || this.controls.dragging,
      modelBoxCentre: () => {
        const box = this.modelBounds();
        return box.isEmpty() ? null : box.getCenter(new Vector3());
      },
      viewSize: () => ({ height: this.host.clientHeight, fov: this.camera.fov * Math.PI / 180 }),
      wheelCommitMs: () => this.props.director?.wheelCommitMs,
      show: () => this.showCameraView(),
      preview: (id, pose) => {
        this.props.onPilotPreview?.(id, pose.position.toArray(), pose.quaternion.toArray());
        this.monitorEvent({ type: 'changed', ids: [id] });
      },
      end: (commit) => this.props.onPilotEnd?.(commit),
      notifyLocked: () => this.props.onPilotLocked?.(),
    });
    this.onResize();
    this.update(props);
    this.onFrame();
    // The opening view is reported too, so a camera nobody has moved is still published (#920).
    this.onViewChange();
    props.onCapture?.(this.capture);
    props.onPilotControl?.({ flush: () => this.pilot.flush('undo'), escape: () => this.pilot.escape(), lightAnchor: () => this.lightAnchor() });
  }

  /**
   * Render one viewport rectangle into an offscreen sRGB target at the capture
   * size, with the grid, transform handles, selection outlines and joint dots
   * hidden for that one synchronous render, and read its pixels back.
   * @param frame - The rectangle, in viewport pixels.
   * @param size - The capture size.
   * @returns The pixels, rows bottom-up.
   * @throws {Error} When the pixels cannot be read back.
   */
  private readonly capture: SceneFrameCapture = async (frame, size): Promise<CapturedPixels> => {
    const looked = this.view?.kind === 'live' ? this.view.id : null;
    // A wheel step still pending is written first; the still shows where the camera ended up.
    const draft = looked === null ? null : this.pilot.poseOf(looked);
    this.pilot.flush('confirm');
    const target = new WebGLRenderTarget(size.width, size.height, { samples: 4 });
    target.texture.colorSpace = SRGBColorSpace;
    const previous = this.renderer.getRenderTarget();
    const live = this.view?.kind === 'live' ? this.cameraRecord(this.view.id) : null;
    // Through a camera the still is the camera's own projection; the main view and its offset stay as they are.
    const camera = live ? this.monitorCamera : this.camera;
    const layers = camera.layers.mask;
    let pose: CapturedPixels['pose'];
    try {
      if (live) {
        applyCameraRecord(camera, live, size.width / size.height);
        if (draft) { camera.position.copy(draft.position); camera.quaternion.copy(draft.quaternion); camera.updateMatrixWorld(true); }
        updateSceneCameraRange(camera, this.modelBounds());
      } else {
        const offset = captureViewOffset(frame, { width: this.host.clientWidth, height: this.host.clientHeight }, size);
        camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
      }
      camera.layers.set(0);
      this.renderer.setRenderTarget(target);
      this.withoutHelpers(() => this.renderer.render(this.scene, camera));
      // Read now: the monitors reuse this camera on the frames that run during the readback.
      pose = live ? { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, aspect: camera.aspect } : undefined;
    } finally {
      camera.layers.mask = layers;
      if (!live) camera.clearViewOffset();
      this.renderer.setRenderTarget(previous);
    }
    try {
      const pixels = new Uint8Array(size.width * size.height * 4);
      await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, size.width, size.height, pixels);
      return { width: size.width, height: size.height, pixels, ...(pose ? { pose } : {}) };
    } finally {
      target.dispose();
    }
  };

  /**
   * Render with the grid, transform handles, selection outlines and joint dots hidden.
   * @param render - The render to run.
   */
  private withoutHelpers(render: () => void): void {
    const helpers: Object3D[] = [this.grid, this.controls.getHelper(), this.markers, ...this.outlines, ...this.looks.overlays()];
    const shown = helpers.map((helper) => helper.visible);
    try {
      for (const helper of helpers) helper.visible = false;
      render();
    } finally {
      helpers.forEach((helper, index) => { helper.visible = shown[index] ?? true; });
    }
  }

  /**
   * A camera record as currently displayed, a collaborator's drag included.
   * @param id - The camera.
   * @returns The record, or null when it is not a camera in the scene.
   */
  private cameraRecord(id: string): SceneCameraObject | null {
    const object = this.displayed.find((candidate) => candidate.id === id);
    return object && isSceneCamera(object) ? object : null;
  }

  /**
   * Where a new light goes from the camera on screen (design 3.6): its pose is the record's while live and the still's
   * when frozen; the light aims at the pivot ahead of it, at the pilot's pivot distance, and sits above that pivot, offset toward the camera and to its left.
   * @returns The pivot and the viewer, or null outside a camera view.
   */
  private lightAnchor(): { centre: [number, number, number]; viewer: [number, number, number] } | null {
    const view = this.view;
    const record = view?.kind === 'live' ? this.cameraRecord(view.id) : null;
    const pose = record ? { position: record.position, rotation: record.rotation } : view?.kind === 'frozen' ? { position: view.position, rotation: view.quaternion } : null;
    if (!pose) return null;
    const position = new Vector3().fromArray(pose.position);
    const box = this.modelBounds();
    const distance = pilotPivotDistance(position, box.isEmpty() ? null : box.getCenter(new Vector3()));
    const centre = position.clone().addScaledVector(new Vector3(0, 0, -1).applyQuaternion(new Quaternion().fromArray(pose.rotation)), distance);
    return { centre: centre.toArray(), viewer: position.toArray() };
  }


  /**
   * The bounding box of the loaded models, without camera and light figures.
   * @returns The box, empty when there is no loaded model.
   */
  private modelBounds(): Box3 {
    const box = new Box3();
    for (const [id, item] of this.items) {
      if (item.root && !this.figures.has(id)) box.expandByObject(item.root);
    }
    return box;
  }

  /**
   * Keep the overview tied to the current host and main-ready resource identities.
   * @throws {never} Renderer failures use the existing scene error path.
   */
  private syncOverview(): void {
    const host = this.props.overviewHost ?? null;
    if (host !== this.overviewHost) {
      this.overview?.dispose(); this.overview = null; this.overviewHost = host;
      if (host) {
        try { this.overview = new SceneMiniMapRuntime(host, this.resources, this.onOverviewNavigate, (error) => this.props.onError(error)); }
        catch (error: unknown) { this.props.onError(sceneError(error)); }
      }
    }
    const ready = new Set([...this.items].filter(([, item]) => item.state === 'ready').map(([id]) => id));
    this.overview?.update(this.displayed, ready, this.orbit.target, this.previewed);
  }

  /**
   * Translate the personal view while preserving its camera-to-target offset.
   * @param x - World horizontal coordinate selected in the overview.
   * @param z - World depth coordinate selected in the overview.
   * @throws {never} Never directly.
   */
  private onOverviewNavigate = (x: number, z: number): void => {
    if (this.dragging || this.view !== null) return;
    const delta = new Vector3(x - this.orbit.target.x, 0, z - this.orbit.target.z);
    this.camera.position.add(delta); this.orbit.target.add(delta); this.orbit.update(); this.onViewChange();
    this.props.onUserCameraMove?.();
  };

  /**
   * Read resolved semantic colours rather than freezing demo palette values.
   * @param name - The CSS custom property to read from the viewport host's computed style.
   * @returns The trimmed computed property value, or an empty string when the property is absent.
   * @throws {never} Never directly.
   */
  private token(name: string): string {
    return getComputedStyle(this.host).getPropertyValue(name).trim();
  }

  /**
   * Resolve collaborator identity references against this host's active theme.
   * @param value - A literal Three-compatible colour or a single CSS var reference supplied by the shell.
   * @returns The referenced host token value, or the unchanged literal colour.
   * @throws {never} Never directly.
   */
  private colorReference(value: string): string {
    const variable = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    return variable ? this.token(variable[1]) : value;
  }

  /**
   * Reconcile snapshots without writing the collaborative document.
   * @param props - The latest scene content, selection, permissions, revisions and session callbacks.
   * @throws {Error} When the installed controls differ from the r173 adapter.
   */
  update(props: SceneViewportProps): void {
    if (this.disposed) return;
    this.syncing = true;
    try {
      this.updateNow(props);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Apply new props to the scene.
   * @param props - The latest scene content, selection, permissions, revisions and session callbacks.
   */
  private updateNow(props: SceneViewportProps): void {
    const previous = this.props;
    this.leaveCameraView(previous, props);
    this.props = props;
    if (this.gesture && (
      props.readOnly || props.mode !== previous.mode || props.cancelRevision !== previous.cancelRevision
      || !sameSelection(props.selectedIds, [...this.gesture.matrices.keys()])
      || [...this.gesture.matrices.keys()].some((id) => !props.objects.some((object) => object.id === id && !object.locked))
    )) this.endGesture(false);
    const joint = this.joint;
    if (joint && (
      props.readOnly || !props.jointMode || props.selectedJoint !== joint.key || props.cancelRevision !== previous.cancelRevision
      || !sameSelection(props.selectedIds, [joint.id]) || !props.objects.some((object) => object.id === joint.id && !object.locked)
    )) this.endGesture(false);
    this.controls.setSensitivity(props.scaleSensitivity);
    if (!this.dragging && !this.controls.dragging) this.orbit.enabled = this.orbitEnabled();
    const visible = new Set(props.objects.map((object) => object.id));
    for (const [id, item] of this.items) {
      if (!visible.has(id)) {
        this.overview?.remove(id);
        this.looks.remove(id);
        item.lease.release();
        this.items.delete(id);
        this.figures.delete(id);
      }
    }
    const local = this.localGestureIds();
    this.displayed = displayedObjects(props.objects, local, props.remotePeers);
    this.previewed = previewedObjectIds(local, props.remotePeers);
    for (const object of this.displayed) {
      if (!isSceneModelFile(object.model)) {
        this.syncFigure(object);
        continue;
      }
      const source = JSON.stringify(object.model);
      let item = this.items.get(object.id);
      if (item && (item.source !== source || (item.state === 'failed' && props.modelRetryRevision !== previous.modelRetryRevision))) {
        if (this.gesture?.matrices.has(object.id) || this.joint?.id === object.id) this.endGesture(false);
        this.overview?.remove(object.id);
        this.looks.remove(object.id);
        item.lease.release();
        this.items.delete(object.id);
        item = undefined;
      }
      if (!item) this.loadObject(object, object.model, source);
      else if (item.root && !local.has(object.id)) {
        applyObject(item.root, object);
        applyPose(item.root, object.pose, !this.previewed.has(object.id));
      }
      // A look drag is a local gesture too, and its preview shows here.
      if (item?.root) this.looks.sync(object, item.root);
    }
    if (props.modelRetryRevision !== previous.modelRetryRevision) this.looks.retry();
    this.syncHighlight();
    this.enterCameraView(props.cameraView ?? null);
    if (this.view === null && !this.dragging && !this.sameView(props.view)) {
      this.userMove.applying(() => {
        this.camera.position.fromArray(props.view.position);
        this.orbit.target.fromArray(props.view.target);
        this.orbit.update();
      });
    }
    this.syncControls();
    // A focus request during a camera view is dropped; the view returns to where it was before.
    if (props.focusRevision !== previous.focusRevision && this.view === null) this.focus();
    this.syncLights();
    this.syncMonitors();
    this.markShadows();
    this.monitorEvent({ type: 'changed' });
    this.showCameraView();
    this.restyle();
    this.inspect();
  }

  /**
   * Whether OrbitControls may move the main camera: only in the user's own view, unlocked, and not during a drag.
   * @returns True when orbiting is allowed.
   */
  private orbitEnabled(): boolean {
    return this.view === null && !this.props.viewLocked && !this.dragging && !this.controls.dragging;
  }

  /**
   * Tell the pilot what the next props do to the camera it may be piloting (design 6.2).
   * @param previous - The props in force.
   * @param next - The props about to apply.
   */
  private leaveCameraView(previous: SceneViewportProps, next: SceneViewportProps): void {
    const before = previous.cameraView;
    const after = next.cameraView ?? null;
    if (before?.kind !== 'live') return;
    if (after?.kind !== 'live') { this.pilot.flush('exit'); return; }
    if (after.id !== before.id) { this.pilot.flush('switch'); return; }
    const record = next.objects.find((object) => object.id === after.id);
    if (!record) { this.pilot.dispatch({ type: 'deleted' }); return; }
    if (before.canPilot && !after.canPilot) { this.pilot.dispatch({ type: record.locked ? 'locked' : 'permissionLost' }); return; }
    const old = previous.objects.find((object) => object.id === after.id);
    if (old && JSON.stringify([old.position, old.rotation]) !== JSON.stringify([record.position, record.rotation])) {
      this.pilot.dispatch({ type: 'recordChanged' });
    }
  }

  /**
   * Follow the camera view value: entering stops orbiting and its damping and drops a pending focus;
   * leaving restores the user's own projection and view (design 3.4.2).
   * @param next - The new value.
   */
  private enterCameraView(next: SceneCameraView | null): void {
    const before = this.view;
    this.view = next;
    if (before === null && next !== null) {
      this.pendingFocus = false;
      this.orbit.enabled = false;
      const damping = this.orbit.enableDamping;
      // One undamped update spends the damping still owed, while the view change it reports is ignored.
      this.orbit.enableDamping = false;
      this.orbit.update();
      this.orbit.enableDamping = damping;
    } else if (before !== null && next === null) {
      this.camera.up.set(0, 1, 0);
      this.camera.fov = SCENE_VIEW_FOV;
      this.camera.aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
      this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
      this.camera.position.fromArray(this.props.view.position);
      this.orbit.target.fromArray(this.props.view.target);
      this.orbit.update();
      this.orbit.enabled = this.orbitEnabled();
    }
    const hidden = this.hiddenCamera();
    for (const [id, figure] of this.figures) figure.root.visible = id !== hidden;
  }

  /**
   * Set the main camera from the camera view: the record or the pilot's draft while live, the still's pose when frozen,
   * with the frame cut out of the viewport by a view offset.
   */
  private showCameraView(): void {
    const view = this.view;
    if (view === null) return;
    if (view.kind === 'live') {
      const record = this.cameraRecord(view.id);
      if (!record) return;
      const draft = this.pilot.poseOf(view.id);
      const frame = this.props.viewFrame;
      // A Free camera follows the frame being dragged, so the view previews the new ratio before it is written.
      const aspect = record.frame === 'Free' && frame && frame.height > 0 ? frame.width / frame.height : cameraFrameRatio(record);
      applyCameraRecord(this.camera, record, aspect);
      if (draft) { this.camera.position.copy(draft.position); this.camera.quaternion.copy(draft.quaternion); }
    } else {
      this.camera.position.fromArray(view.position);
      this.camera.quaternion.fromArray(view.quaternion);
      this.camera.fov = view.fov;
      this.camera.aspect = view.aspect;
    }
    const frame = this.props.viewFrame;
    if (frame) this.camera.setViewOffset(frame.width, frame.height, -frame.x, -frame.y, this.host.clientWidth, this.host.clientHeight);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  /**
   * Build or refresh a camera or light figure; its root joins `items` like a loaded model.
   * @param object - The camera or light record as displayed.
   */
  private syncFigure(object: SceneObject): void {
    const source = JSON.stringify(object.model);
    let figure = this.figures.get(object.id);
    const item = this.items.get(object.id);
    if (!figure || item?.source !== source) {
      item?.lease.release();
      figure = new DirectorFigure(object);
      this.figures.set(object.id, figure);
      this.items.set(object.id, { source, lease: figureLease(figure), root: figure.root, state: 'ready' });
      this.scene.add(figure.root);
    }
    if (this.localGestureIds().has(object.id)) return;
    figure.update(object, { ink: this.token('--color-muted-foreground'), director: this.props.director }, this.lightPlan.lights[object.id]);
  }

  /**
   * Highlight the single selected object's selected part, or nothing (inner#1693 design 5.5).
   */
  private syncHighlight(): void {
    const ids = this.props.selectedIds;
    const id = ids.length === 1 ? ids[0] ?? null : null;
    const root = id === null ? null : this.items.get(id)?.root ?? null;
    this.looks.setHighlight(id, root, this.props.selectedPart ?? null);
  }

  /**
   * Decide which lights shine and cast (design 6.4), light the scene accordingly and report the plan when it changes.
   */
  private syncLights(): void {
    const lights = this.displayed.filter(isSceneLight);
    const director = this.props.director;
    const slots = shadowSlots(this.renderer.capabilities.maxTextures, programSamplers(this.renderer.info.programs ?? []));
    // Until the configuration arrives, the default key light stays on and no user light shines.
    this.lightPlan = director
      ? planLights(lights.map((light) => ({ id: light.id, number: light.number, castShadow: light.castShadow })), { maxLights: director.maxLights, shadowSlots: slots })
      : { defaultKey: true, lights: {} };
    this.keyLight.visible = this.lightPlan.defaultKey;
    const environment = this.props.environment;
    this.ambient.color.setStyle(environment?.ambientColor ?? SCENE_AMBIENT_COLOR_DEFAULT);
    this.ambient.intensity = environment?.ambientIntensity ?? SCENE_AMBIENT_INTENSITY_DEFAULT;
    this.scene.environmentIntensity = SCENE_ENVIRONMENT_INTENSITY * this.ambient.intensity / SCENE_AMBIENT_INTENSITY_DEFAULT;
    const style = { ink: this.token('--color-muted-foreground'), director };
    for (const light of lights) {
      if (!this.localGestureIds().has(light.id)) this.figures.get(light.id)?.update(light, style, this.lightPlan.lights[light.id]);
    }
    const report = JSON.stringify(this.lightPlan);
    if (report !== this.reportedPlan) {
      this.reportedPlan = report;
      this.props.onLightPlan?.(this.lightPlan);
    }
  }

  /**
   * Ask for new shadow maps when what casts or lights them changed.
   * @param force - Redraw even when the displayed values are the same, as after a model loads.
   */
  private markShadows(force = false): void {
    const key = JSON.stringify([this.displayed, this.lightPlan]);
    if (!force && key === this.shadowKey) return;
    this.shadowKey = key;
    this.shadowsDirty = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Fit each casting light's shadow camera to the models and their ground shadows (design 3.6).
   */
  private fitShadows(): void {
    this.shadowsDirty = false;
    const box = this.modelBounds();
    const reach = this.props.director?.shadowGroundReach;
    if (box.isEmpty() || reach === undefined) return;
    for (const figure of this.figures.values()) {
      const light = figure.light;
      if (!light?.castShadow) continue;
      figure.root.updateMatrixWorld(true);
      const position = new Vector3().setFromMatrixPosition(light.matrixWorld);
      const camera = light.shadow.camera;
      if (light instanceof DirectionalLight && camera instanceof OrthographicCamera) {
        // three r173 places the shadow camera at the light, aimed at its target, before each shadow render.
        const target = new Vector3().setFromMatrixPosition(light.target.matrixWorld);
        camera.position.copy(position);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        Object.assign(camera, directionalShadowRange(camera, target.sub(position).normalize(), box, reach));
      } else if (camera instanceof PerspectiveCamera) {
        camera.far = localShadowFar(position, box, reach);
      }
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Advance the monitor cards.
   * @param event - What happened to them.
   */
  private monitorEvent(event: MonitorEvent): void {
    this.cards = monitorReducer(this.cards, event);
  }

  /**
   * Follow the card canvases the director console has mounted.
   */
  private syncMonitors(): void {
    const next = this.props.monitors ?? new Map<string, HTMLCanvasElement>();
    for (const [id, canvas] of this.monitorCanvases) {
      if (next.get(id) === canvas) continue;
      this.cardVisibility?.unobserve(canvas);
      this.cardSize.unobserve(canvas);
      this.monitorCanvases.delete(id);
      this.monitorEvent({ type: 'removed', id });
    }
    for (const [id, canvas] of next) {
      if (this.monitorCanvases.has(id)) continue;
      this.monitorCanvases.set(id, canvas);
      this.monitorEvent({ type: 'mount', id });
      // Without IntersectionObserver every mounted card counts as on screen.
      if (this.cardVisibility) this.cardVisibility.observe(canvas);
      else this.monitorEvent({ type: 'visible', id, visible: true });
      this.cardSize.observe(canvas);
    }
  }

  /**
   * The card a canvas belongs to.
   * @param canvas - A card canvas.
   * @returns Its camera id, or undefined.
   */
  private cardOf(canvas: Element): string | undefined {
    for (const [id, owned] of this.monitorCanvases) if (owned === canvas) return id;
    return undefined;
  }

  /**
   * Follow which cards are on screen.
   * @param entries - The visibility changes.
   */
  private onCardVisibility = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const id = this.cardOf(entry.target);
      if (id !== undefined) this.monitorEvent({ type: 'visible', id, visible: entry.isIntersecting });
    }
  };

  /**
   * Redraw cards whose size changed.
   * @param entries - The size changes.
   */
  private onCardResize = (entries: ResizeObserverEntry[]): void => {
    const ids = entries.flatMap((entry) => this.cardOf(entry.target) ?? []);
    if (ids.length > 0) this.monitorEvent({ type: 'changed', ids });
  };

  /**
   * Draw the cards that are due: each camera into a corner of the main canvas, copied straight into its card (DD selection 2).
   */
  private drawMonitors(): void {
    const refresh = this.props.director?.monitorRefreshMs;
    const now = performance.now();
    if (refresh === undefined || now - this.monitorDrawnAt < refresh) return;
    const due = monitorsDue(this.cards);
    if (due.length === 0) return;
    this.monitorDrawnAt = now;
    const canvas = this.renderer.domElement;
    const ratio = this.renderer.getPixelRatio();
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const bounds = this.modelBounds();
    const painted: string[] = [];
    this.withoutHelpers(() => {
      this.renderer.setScissorTest(true);
      for (const id of due) {
        const card = this.monitorCanvases.get(id);
        const record = this.cameraRecord(id);
        const context = card?.getContext('2d');
        if (!card || !record || !context) continue;
        const cssWidth = Math.min(card.clientWidth, width);
        const cssHeight = Math.min(card.clientHeight, height);
        if (cssWidth === 0 || cssHeight === 0) continue;
        applyCameraRecord(this.monitorCamera, record, cameraFrameRatio(record));
        const draft = this.pilot.poseOf(id);
        if (draft) { this.monitorCamera.position.copy(draft.position); this.monitorCamera.quaternion.copy(draft.quaternion); }
        updateSceneCameraRange(this.monitorCamera, bounds);
        this.renderer.setViewport(0, 0, cssWidth, cssHeight);
        this.renderer.setScissor(0, 0, cssWidth, cssHeight);
        this.renderer.render(this.scene, this.monitorCamera);
        const pixelWidth = Math.round(cssWidth * ratio);
        const pixelHeight = Math.round(cssHeight * ratio);
        if (card.width !== pixelWidth || card.height !== pixelHeight) { card.width = pixelWidth; card.height = pixelHeight; }
        context.drawImage(canvas, 0, canvas.height - pixelHeight, pixelWidth, pixelHeight, 0, 0, pixelWidth, pixelHeight);
        // The card shows its placeholder until its first picture.
        card.dataset.drawn = 'true';
        painted.push(id);
      }
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, width, height);
    });
    this.monitorEvent({ type: 'painted', ids: painted });
  }

  /**
   * Whether this page is dragging an object or a joint.
   * @returns True while either drag lasts.
   * @throws {never} Never.
   */
  private get dragging(): boolean {
    return this.gesture !== null || this.joint !== null;
  }

  /**
   * Objects this page is dragging, drawn from its own draft rather than the document.
   * @returns Their IDs.
   * @throws {never} Never.
   */
  private localGestureIds(): ReadonlySet<string> {
    if (this.gesture) return new Set(this.gesture.matrices.keys());
    return new Set(this.joint ? [this.joint.id] : []);
  }

  /**
   * Attach a token-owned instance; an old completion cannot attach to a new view.
   * @param object - The visible scene object whose model needs an instance in this viewport.
   * @param model - Its model file.
   * @param source - The serialized immutable model reference used to detect replacement of this object's source.
   * @throws {never} Load failures are reported through the resource-state callback.
   */
  private loadObject(object: SceneObject, model: SceneModelFile, source: string): void {
    const item: RenderedObject = { source, lease: this.resources.acquire(model), root: null, state: 'loading' };
    this.items.set(object.id, item);
    this.props.onModelStateChange?.(object.id, 'loading');
    this.props.onLookReport?.(object.id, 'loading');
    void item.lease.ready.then((root) => {
      if (this.disposed || this.items.get(object.id) !== item) {
        item.lease.release();
        return;
      }
      const latest = this.displayed.find((candidate) => candidate.id === object.id);
      if (!latest) {
        item.lease.release();
        return;
      }
      item.root = root;
      item.state = 'ready';
      root.userData.sceneObjectId = object.id;
      root.traverse((child) => { if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; } });
      // The rig is measured first, while the fresh instance is still at rest.
      const rig = poseRigOf(root);
      applyObject(root, latest);
      applyPose(root, latest.pose, !this.previewed.has(object.id));
      this.syncing = true;
      try {
        this.looks.sync(latest, root);
      } finally {
        this.syncing = false;
      }
      // Its programs, look included, are compiled before it joins the scene, so the shadow budget counts its samplers
      // first (design 3.6).
      this.renderer.compile(root, this.camera, this.scene);
      this.scene.add(root);
      this.syncLights();
      this.markShadows(true);
      this.monitorEvent({ type: 'changed' });
      this.props.onModelStateChange?.(object.id, 'ready');
      this.props.onSkeletonState(object.id, rig === null ? 'none' : rig.kind);
      this.props.onLookReport?.(object.id, lookReportOf(root, this.renderer.capabilities.maxTextureSize, this.token('--color-muted-foreground')) ?? 'failed');
      this.syncHighlight();
      this.syncControls();
      if (this.pendingFocus) this.focus();
      this.restyle();
      this.inspect();
    }).catch((error: unknown) => {
      if (this.disposed || this.items.get(object.id) !== item) return;
      item.lease.release();
      item.state = 'failed';
      this.props.onModelStateChange?.(object.id, 'failed', sceneError(error));
      this.props.onLookReport?.(object.id, 'failed');
      this.inspect();
    });
  }

  /**
   * Check a view tuple exactly; the owning editor echoes this camera's own snapshot.
   * @param view - The personal camera position and orbit target received from the editor.
   * @returns Whether every camera-position and orbit-target coordinate exactly matches the current view.
   * @throws {never} Never.
   */
  private sameView(view: SceneView): boolean {
    return this.camera.position.toArray().every((value, index) => value === view.position[index])
      && this.orbit.target.toArray().every((value, index) => value === view.target[index]);
  }

  /**
   * The camera whose icon, frustum, selection box and handles the main view hides: the one looked through or whose
   * still is shown (design 3.4 item 1).
   * @returns Its id, or null.
   */
  private hiddenCamera(): string | null {
    return this.view?.id ?? null;
  }

  /**
   * Return the whole eligible selection, or none while one item cannot mutate.
   * @returns The selected objects in selection order, or an empty array when editing is denied or any selected object is locked, absent or not loaded.
   * @throws {never} Never.
   */
  private mutableObjects(): SceneObject[] {
    if (this.props.readOnly || this.props.selectedIds.length === 0) return [];
    const hidden = this.hiddenCamera();
    // The camera being looked through moves only by piloting or by its fields.
    if (hidden !== null && this.props.selectedIds.includes(hidden)) return [];
    const objects = this.props.selectedIds.map((id) => this.props.objects.find((object) => object.id === id));
    if (objects.some((object) => !object || object.locked || !this.items.get(object.id)?.root)) return [];
    return objects.filter((object): object is SceneObject => object !== undefined);
  }

  /**
   * Present one official native target for single and multi-object gestures.
   * @throws {Error} When the installed helper is not the approved r173 gizmo.
   */
  private syncControls(): void {
    if (this.dragging) return;
    this.controls.detach();
    const target = this.jointTarget();
    this.syncMarkers(target);
    if (this.props.jointMode) {
      const joint = target?.rig.joints.find((candidate) => candidate.key === this.props.selectedJoint);
      this.controls.enabled = joint !== undefined;
      if (!joint) return;
      this.controls.setMode('rotate');
      this.controls.setSpace('local');
      this.controls.setMultipleSelection(false);
      this.controls.attach(joint.bone);
      return;
    }
    this.controls.setSpace('world');
    const selected = this.mutableObjects();
    this.controls.enabled = selected.length > 0;
    if (selected.length === 0) return;
    const initial = createTransformGesture(selected, this.props.mode);
    initial.pivot.decompose(this.pivot.position, this.pivot.quaternion, this.pivot.scale);
    this.pivot.updateMatrixWorld(true);
    this.controls.setMode(this.props.mode);
    this.controls.setMultipleSelection(selected.length > 1);
    this.controls.attach(this.pivot);
  }

  /**
   * The character joint mode works on: one selected, editable, loaded object with bones.
   * @returns It with its rig, or null.
   * @throws {never} Never.
   */
  private jointTarget(): JointTarget | null {
    if (!this.props.jointMode) return null;
    const [object, ...rest] = this.mutableObjects();
    const root = object ? this.items.get(object.id)?.root : null;
    if (!object || rest.length > 0 || !root) return null;
    const rig = poseRigOf(root);
    return rig ? { object, root, rig } : null;
  }

  /**
   * Show the joint target's joints as dots drawn over everything, the selected one highlighted.
   * @param target - The joint target, or null to show none.
   * @throws {never} Never.
   */
  private syncMarkers(target: JointTarget | null): void {
    if (target?.root !== this.markerOwner) {
      for (const marker of this.markerItems) { marker.mesh.material.dispose(); marker.rim.material.dispose(); }
      this.markers.clear();
      this.markerItems = [];
      this.markerOwner = target?.root ?? null;
      if (target) {
        // Measured on the rig at rest, so the dots do not depend on the pose joint mode opens in.
        const { joints, restSize } = target.rig;
        const full = restSize * 0.012;
        joints.forEach(({ key, bone, rest }, index) => {
          // Close joints such as finger knuckles get dots under half their spacing, so unselected neighbours do not
          // touch; no dot shrinks below 30% of full, so joints closer than that (joints at one point included) and
          // the enlarged selected dot overlap, and a click there picks the dot whose centre is nearest the ray.
          const nearest = Math.min(...joints.filter((_, other) => other !== index).map((joint) => joint.rest.distanceTo(rest)));
          const mesh = new Mesh(this.markerGeometry, new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true }));
          mesh.renderOrder = 1000;
          const rim = new Mesh(this.markerGeometry, new MeshBasicMaterial({ depthTest: false, depthWrite: false }));
          rim.renderOrder = 999;
          rim.scale.setScalar(1.3);
          mesh.add(rim);
          this.markerItems.push({ key, bone, mesh, rim, unit: Math.max(full * 0.3, Math.min(full, nearest * 0.45)) });
          this.markers.add(mesh);
        });
      }
    }
    // Sized from the current scale on every sync, so a character scaled in joint mode keeps dots that fit it.
    const scale = target ? largestScale(target.root) : 0;
    const normal = this.token('--color-status-selected');
    const selected = this.token('--color-foreground');
    const edge = this.token('--color-background');
    for (const { key, mesh, rim, unit } of this.markerItems) {
      rim.material.color.setStyle(edge);
      const chosen = key === this.props.selectedJoint;
      mesh.material.color.setStyle(chosen ? selected : normal);
      mesh.material.opacity = chosen ? 1 : 0.85;
      mesh.scale.setScalar(unit * scale * (chosen ? 1.5 : 1));
    }
    this.placeMarkers();
  }

  /**
   * Keep each joint dot on its bone as the bone moves.
   * @throws {never} Never.
   */
  private placeMarkers(): void {
    for (const { bone, mesh } of this.markerItems) bone.getWorldPosition(mesh.position);
  }

  /**
   * Begin a joint drag on the selected joint, or an object drag.
   * @throws {never} Never directly.
   */
  private onGestureStart = (): void => {
    if (this.props.jointMode) {
      this.onJointStart();
      return;
    }
    this.onObjectStart();
  };

  /**
   * Begin a joint drag only after the session admits it, remembering the committed pose.
   * @throws {never} Never directly.
   */
  private onJointStart(): void {
    const target = this.jointTarget();
    const joint = target?.rig.joints.find((candidate) => candidate.key === this.props.selectedJoint);
    if (!target || !joint || !this.props.onGestureStart()) {
      this.controls.cancelInteraction();
      return;
    }
    this.suppressClick = true;
    this.changed = false;
    this.joint = { id: target.object.id, key: joint.key, root: target.root, rig: target.rig, start: target.object.pose ?? {} };
    this.orbit.enabled = false;
    this.inspect();
  }

  /**
   * Begin a local draft only after the session admits this mutation.
   * @throws {never} Never directly.
   */
  private onObjectStart(): void {
    const selected = this.mutableObjects();
    if (selected.length === 0 || !this.props.onGestureStart()) {
      this.controls.cancelInteraction();
      return;
    }
    this.suppressClick = true;
    this.changed = false;
    this.gesture = createTransformGesture(selected, this.props.mode);
    this.orbit.enabled = false;
    this.inspect();
  }

  /**
   * Publish field-specific drafts, leaving final Yjs transactions to the session.
   * @throws {never} Never directly.
   */
  private onGestureChange = (): void => {
    const joint = this.joint;
    if (joint) {
      const value = joint.rig.keyValue(joint.key);
      if (!value?.every(Number.isFinite)) {
        this.endGesture(false);
        return;
      }
      // The drag-start pose with this bone's new value; the rest of the pose is set again, so children follow.
      const pose = { ...joint.start, [joint.key]: value };
      joint.rig.apply(pose, false);
      this.changed = true;
      this.props.onGestureChange([{ id: joint.id, pose }]);
      this.rebuildOutlines();
      this.inspect();
      return;
    }
    if (!this.gesture) return;
    this.pivot.updateMatrixWorld(true);
    const patches = transformPatches(this.gesture, this.pivot.matrixWorld);
    if (patches.length === 0) {
      this.endGesture(false);
      return;
    }
    this.changed = true;
    for (const patch of patches) this.applyPatch(patch);
    this.markShadows(true);
    this.monitorEvent({ type: 'changed' });
    this.props.onGestureChange(patches);
    this.rebuildOutlines();
    this.inspect();
  };

  /**
   * Apply only fields owned by this gesture to the rendered instance.
   * @param patch - The stable object ID and complete transform tuples changed by the active gesture.
   * @throws {never} Never.
   */
  private applyPatch(patch: SceneTransformPatch): void {
    const root = this.items.get(patch.id)?.root;
    if (!root) return;
    if (patch.position) root.position.fromArray(patch.position);
    if (patch.rotation) root.quaternion.fromArray(patch.rotation);
    if (patch.scale) root.scale.fromArray(patch.scale);
    root.updateMatrixWorld(true);
  }

  /**
   * End a normal pointer release after the final native objectChange.
   * @throws {never} Never directly.
   */
  private onGestureCommit = (): void => {
    this.endGesture(true);
  };

  /**
   * Release native/local state before notifying the session or repainting.
   * @param commit - Whether a changed gesture should commit its final draft; false restores its starting rendered transforms.
   * @throws {never} Never directly.
   */
  private endGesture(commit: boolean): void {
    const gesture = this.gesture;
    const joint = this.joint;
    const pointer = this.down;
    this.gesture = null;
    this.joint = null;
    this.down = null;
    this.controls.cancelInteraction(!commit);
    this.orbit.enabled = this.orbitEnabled();
    if (!commit && pointer) {
      const canvas = this.renderer.domElement;
      if (canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id);
      // Orbit's official cancellation clears its pointer bookkeeping too.
      canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: pointer.id, pointerType: 'mouse' }));
    }
    if (joint) {
      // The bones were moved by hand; the next pose shown sets every bone again.
      joint.rig.invalidate();
      if (!commit) applyPose(joint.root, joint.start);
    }
    if (!gesture && !joint) return;
    if (!commit && gesture) {
      for (const [id, matrix] of gesture.matrices) {
        const root = this.items.get(id)?.root;
        if (root) {
          matrix.decompose(root.position, root.quaternion, root.scale);
          root.updateMatrixWorld(true);
        }
      }
    }
    const changed = this.changed;
    this.changed = false;
    this.props.onGestureEnd(commit && changed);
    if (!this.disposed) {
      this.syncControls();
      this.rebuildOutlines();
      this.inspect();
    }
  }

  /**
   * Disable Orbit navigation while native object manipulation is active.
   * @param event - The official TransformControls dragging-state notification.
   * @param event.value - The reported dragging flag; non-boolean values leave Orbit navigation unchanged.
   * @throws {never} Never.
   */
  private onDraggingChanged = (event: { value: unknown }): void => {
    if (typeof event.value === 'boolean') this.orbit.enabled = this.orbitEnabled();
  };

  /**
   * Record a pointer origin so navigation cannot turn into an object click.
   * @param event - The pointer press supplying its capture ID and client-space starting position.
   * @throws {never} Never.
   */
  private onPointerDown = (event: PointerEvent): void => {
    this.suppressClick = false;
    this.releasingPointer = null;
    this.down = { x: event.clientX, y: event.clientY, id: event.pointerId };
    // A press on another joint's dot belongs to that dot, as it is drawn over the rings: the rings and the orbit
    // never see it, and the release selects the joint.
    const dot = this.props.jointMode ? this.dotAt(event) : null;
    if (dot !== null && dot !== this.props.selectedJoint) event.stopImmediatePropagation();
    this.renderer.domElement.focus({ preventScroll: true });
  };

  /**
   * The ray under a pointer event.
   * @param event - A pointer event on the canvas.
   * @returns The ray, or null while the canvas has no size.
   * @throws {never} Never.
   */
  private rayAt(event: PointerEvent): Raycaster | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const point = new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const ray = new Raycaster();
    ray.layers.enable(DISPLAY_PICK_LAYER);
    ray.setFromCamera(point, this.camera);
    this.scene.updateMatrixWorld(true);
    return ray;
  }

  /**
   * The joint whose dot is under a pointer event: of the dots the ray crosses, the one whose centre is nearest
   * the ray, so a press on a dot's centre finds it through a larger dot in front.
   * @param event - A pointer event on the canvas.
   * @returns The joint's key, or null when no dot is under it.
   * @throws {never} Never.
   */
  private dotAt(event: PointerEvent): string | null {
    const ray = this.rayAt(event);
    if (!ray || this.markerItems.length === 0) return null;
    const dot = ray.intersectObjects(this.markerItems.map((marker) => marker.mesh), false)
      .sort((a, b) => ray.ray.distanceSqToPoint(a.object.position) - ray.ray.distanceSqToPoint(b.object.position))[0];
    return (dot && this.markerItems.find((marker) => marker.mesh === dot.object)?.key) ?? null;
  }

  /**
   * Mark a normal release before native controls release pointer capture.
   * @param event - The normal pointer-up event whose capture loss must not cancel this release.
   * @throws {never} Never.
   */
  private onPointerUpCapture = (event: PointerEvent): void => {
    this.releasingPointer = event.pointerId;
  };

  /**
   * Pick actual loaded descendants and map them back to stable object identity.
   * @param event - The pointer release supplying the picking position, button and additive-selection modifier.
   * @throws {never} Never directly.
   */
  private onPointerUp = (event: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    const suppressed = this.suppressClick;
    this.suppressClick = false;
    if (!down || suppressed || down.id !== event.pointerId || event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const ray = this.rayAt(event);
    if (!ray) return;
    // Joint dots are drawn over everything, so they are picked first.
    const dotKey = this.dotAt(event);
    if (dotKey !== null) {
      this.props.onJointSelect(dotKey);
      return;
    }
    const roots = [...this.items.values()].flatMap((item) => item.root ? [item.root] : []);
    const hit = ray.intersectObjects(roots, true)[0];
    if (!hit) {
      this.props.onSelect(null, event.shiftKey);
      return;
    }
    let root = hit.object;
    while (root.parent && typeof root.userData.sceneObjectId !== 'string') root = root.parent;
    if (this.markerOwner !== null && root === this.markerOwner) {
      const key = jointAt(hit, new Map(this.markerItems.map((marker) => [marker.bone, marker.key])));
      if (key !== null) this.props.onJointSelect(key);
      return;
    }
    if (typeof root.userData.sceneObjectId !== 'string') return;
    const selected = this.props.selectedIds;
    const pick = decideScenePick({ shift: event.shiftKey, hitId: root.userData.sceneObjectId,
      onlySelected: selected.length === 1 ? selected[0] ?? null : null, part: partAtHit(hit) });
    if (pick.kind === 'part') this.props.onSelectPart?.(pick.part);
    else this.props.onSelect(pick.id, pick.additive);
  };

  /**
   * Cancel without a commit when the browser or session interrupts input.
   * @throws {never} Never directly.
   */
  private onCancel = (): void => {
    this.endGesture(false);
  };

  /**
   * Losing the window ends an object drag and the pilot's draft.
   */
  private onBlur = (): void => {
    this.endGesture(false);
    this.pilot.flush('blur');
  };

  /**
   * Losing capture during a gesture is a cancellation; normal release is idle.
   * @param event - The capture-loss notification used to distinguish an interruption from normal pointer release.
   * @throws {never} Never directly.
   */
  private onLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.releasingPointer && this.dragging) this.endGesture(false);
  };

  /**
   * Withdraw immediately when hidden; hidden documents receive no RAF callbacks.
   * @throws {never} Never directly.
   */
  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.endGesture(false);
      this.pilot.flush('hide');
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else if (this.frame === 0 && !this.disposed) this.onFrame();
  };

  /**
   * Keep the user's personal navigation outside scene content.
   * @throws {never} Never directly.
   */
  private onViewChange = (): void => {
    if (this.disposed || this.dragging || this.view !== null) return;
    this.props.onViewChange({ position: this.camera.position.toArray(), target: this.orbit.target.toArray() }, this.camera.fov);
    this.syncOverview();
    this.inspect();
  };

  /**
   * Rebuild independently owned outlines from current local and remote snapshots.
   * @throws {never} Never directly.
   */
  private rebuildOutlines(): void {
    for (const outline of this.outlines) {
      outline.geometry.dispose();
      outline.material.dispose();
      this.scene.remove(outline);
    }
    this.outlines = [];
    const hidden = this.hiddenCamera();
    for (const id of this.props.selectedIds) {
      const root = id === hidden ? undefined : this.items.get(id)?.root;
      if (root) this.addOutline(root, this.token('--color-status-selected'));
    }
    for (const peer of this.props.remotePeers) {
      for (const id of peer.selectedIds) {
        const root = id === hidden ? undefined : this.items.get(id)?.root;
        if (root) this.addOutline(root, peer.color);
      }
    }
  }

  /**
   * Outline a selected instance.
   * @param root - The loaded instance whose world-space bounds will be outlined.
   * @param color - The semantic or collaborator colour, optionally expressed as a CSS token reference.
   * @throws {never} Never directly.
   */
  private addOutline(root: Group, color: string): void {
    root.updateMatrixWorld(true);
    const outline = new BoxHelper(root, this.colorReference(color));
    this.outlines.push(outline);
    this.scene.add(outline);
  }

  /**
   * Show selected content, or all ready content, in this user's camera.
   * @throws {never} Never directly.
   */
  private focus(): void {
    const ids = this.props.selectedIds.length > 0 ? this.props.selectedIds : [...this.items.keys()];
    const box = new Box3();
    this.pendingFocus = ids.some((id) => !this.items.get(id)?.root);
    for (const id of ids) {
      const root = this.items.get(id)?.root;
      if (root) box.expandByObject(root);
    }
    if (box.isEmpty()) return;
    focusSceneBounds(this.camera, this.orbit.target, box);
    this.orbit.update();
    this.onViewChange();
  }

  /**
   * Match WebGL dimensions to the visible host without interpreting CSS transforms.
   * @throws {never} Never directly.
   */
  private onResize = (): void => {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    if (this.view !== null) { this.showCameraView(); return; }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  /**
   * Repaint after a theme change: the restyle, plus the camera and light figures and every monitor card, which props
   * updates and model loads refresh on their own.
   * @throws {never} Never directly.
   */
  private onThemeChange = (): void => {
    this.restyle();
    for (const object of this.displayed) if (!isSceneModelFile(object.model)) this.syncFigure(object);
    this.monitorEvent({ type: 'changed' });
  };

  /**
   * Report every loaded object's parts again once the theme colour changed, so a built-in part's swatch shows the colour
   * on screen (inner#1693 design 5.1).
   */
  private reportThemeColor(): void {
    const theme = this.token('--color-muted-foreground');
    if (theme === this.reportedTheme) return;
    this.reportedTheme = theme;
    for (const [id, item] of this.items) {
      const report = item.root ? lookReportOf(item.root, this.renderer.capabilities.maxTextureSize, theme) : null;
      if (report) this.props.onLookReport?.(id, report);
    }
  }

  /**
   * Resolve theme tokens for canvas content as well as surrounding React chrome.
   * @throws {never} Never directly.
   */
  private restyle = (): void => {
    this.scene.background = new Color(this.token('--color-background'));
    applySceneGridTheme(this.grid, this.token('--color-muted-foreground'));
    // Built-in models take the theme colour through their look (inner#1693 design 5.2), and the panel shows it.
    this.looks.restyle();
    this.reportThemeColor();
    this.looks.restyleHighlight();
    this.syncMarkers(this.jointTarget());
    this.rebuildOutlines();
    this.syncOverview();
  };

  /**
   * Render while visible, pausing Orbit damping during an object gesture.
   * @throws {never} Never directly.
   */
  private onFrame = (): void => {
    this.frame = 0;
    if (this.disposed || document.visibilityState === 'hidden') return;
    if (this.view === null && !this.dragging && !this.controls.dragging) this.orbit.update();
    this.placeMarkers();
    const bounds = new Box3();
    for (const item of this.items.values()) {
      if (item.root) bounds.expandByObject(item.root);
    }
    updateSceneCameraRange(this.camera, bounds);
    for (const outline of this.outlines) outline.update();
    if (this.shadowsDirty) this.fitShadows();
    this.drawMonitors();
    this.renderer.render(this.scene, this.camera);
    if (import.meta.env.DEV) this.inspectNativeControls();
    this.frame = requestAnimationFrame(this.onFrame);
  };

  /**
   * Observe the official helper only after its real rendered matrices are current.
   * This development-only projection never supplies input to the scene or controls.
   * @throws {never} Never directly.
   */
  private inspectNativeControls(): void {
    const gizmo = this.controls.getHelper().children.find((child) => child instanceof TransformControlsGizmo);
    const target = this.controls.object;
    const worldCenter = target ? new Vector3().setFromMatrixPosition(target.matrixWorld) : null;
    /**
     * Project the actual native geometry's world bounds for browser pointer targeting.
     * @param child - An official scale gizmo or picker object already updated by Three.
     * @returns Its native visibility, layer masks and projected bounds centre.
     * @throws {never} Never directly.
     */
    const observeHandle = (child: Object3D): NativeHandleObservation => {
      const centre = new Box3().setFromObject(child).getCenter(new Vector3()).project(this.camera);
      return {
        name: child.name,
        visible: child.visible,
        layer: child.layers.mask,
        cameraLayer: this.camera.layers.test(child.layers),
        rayLayer: this.controls.getRaycaster().layers.test(child.layers),
        center: centre.toArray(),
      };
    };
    const gl = this.renderer.getContext();
    this.renderer.domElement.dataset.nativeControls = JSON.stringify({
      mode: this.controls.mode,
      axis: this.controls.axis,
      dragging: this.controls.dragging,
      enabled: this.controls.enabled,
      center: worldCenter?.clone().project(this.camera).toArray() ?? null,
      worldCenter: worldCenter?.toArray() ?? null,
      scaleVisible: gizmo instanceof TransformControlsGizmo && gizmo.gizmo.scale.visible,
      scaleHandles: gizmo instanceof TransformControlsGizmo ? gizmo.gizmo.scale.children.map(observeHandle) : [],
      scalePickers: gizmo instanceof TransformControlsGizmo ? gizmo.picker.scale.children.map(observeHandle) : [],
      projectionMatrix: this.camera.projectionMatrix.toArray(),
      matrixWorldInverse: this.camera.matrixWorldInverse.toArray(),
      background: this.scene.background instanceof Color ? this.scene.background.getStyle() : null,
      render: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures,
        programs: this.renderer.info.programs?.length ?? 0, contextLost: gl.isContextLost(),
        renderer: String(gl.getParameter(gl.RENDERER)), version: String(gl.getParameter(gl.VERSION)) },
    });
    this.renderer.domElement.dataset.joints = JSON.stringify(this.markerItems.map(({ key, mesh }) => ({ key,
      center: mesh.position.clone().project(this.camera).toArray(), selected: key === this.props.selectedJoint })));
  }

  /**
   * A restored context keeps image textures but empties what the GPU drew: the environment and the shadow maps are made
   * again (model-viewer regenerates its environment the same way).
   */
  private readonly onContextRestored = (): void => {
    this.environment.dispose();
    this.environment = createSceneEnvironment(this.renderer);
    this.scene.environment = this.environment.texture;
    this.renderer.shadowMap.needsUpdate = true;
  };

  /**
   * Expose actual rendered tuples for browser assertions without a second scene model; an object's drawn parts are read
   * again only after a look applied to it cleared them.
   * @throws {never} Never.
   */
  private inspect(): void {
    const canvas = this.renderer.domElement;
    canvas.dataset.gestureActive = String(this.dragging);
    canvas.dataset.view = JSON.stringify({ position: this.camera.position.toArray(), target: this.orbit.target.toArray() });
    for (const item of this.items.values()) if (item.root && !item.parts) item.parts = renderedParts(item.root);
    canvas.dataset.objects = JSON.stringify([...this.items].flatMap(([id, item]) => item.root ? [{ id, position: item.root.position.toArray(), rotation: item.root.quaternion.toArray(), scale: item.root.scale.toArray(),
      parts: item.parts }] : []));
    canvas.dataset.partHighlight = String(this.looks.overlays().length);
  }

  /**
   * Withdraw gestures and release everything owned by this visible view.
   * @throws {never} Never directly.
   */
  dispose(): void {
    if (this.disposed) return;
    this.props.onCapture?.(null);
    this.props.onPilotControl?.(null);
    // Hiding the scene writes a wheel step still pausing, as leaving the camera does (design 3.4.1).
    this.pilot.flush('hide');
    this.pilot.dispose();
    this.disposed = true;
    this.endGesture(false);
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.theme.disconnect();
    this.cardVisibility?.disconnect();
    this.cardSize.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointerup', this.onPointerUpCapture, true);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onCancel);
    canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.controls.removeEventListener('mouseDown', this.onGestureStart);
    this.controls.removeEventListener('objectChange', this.onGestureChange);
    this.controls.removeEventListener('mouseUp', this.onGestureCommit);
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.orbit.removeEventListener('change', this.onViewChange);
    this.orbit.removeEventListener('start', this.userMove.start);
    this.orbit.removeEventListener('change', this.userMove.change);
    this.controls.dispose();
    this.orbit.dispose();
    this.overview?.dispose();
    this.overview = null;
    this.looks.dispose();
    this.resources.dispose();
    for (const figure of this.figures.values()) figure.dispose();
    this.figures.clear();
    this.items.clear();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.environment.dispose();
    for (const outline of this.outlines) {
      outline.geometry.dispose();
      outline.material.dispose();
    }
    this.outlines = [];
    for (const marker of this.markerItems) { marker.mesh.material.dispose(); marker.rim.material.dispose(); }
    this.markerItems = [];
    this.markerGeometry.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}
