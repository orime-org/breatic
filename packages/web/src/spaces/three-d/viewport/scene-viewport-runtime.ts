// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Box3, BoxHelper, Color, DirectionalLight, GridHelper, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, SkinnedMesh, SphereGeometry, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControlsGizmo } from 'three/addons/controls/TransformControls.js';
import type { Bone, Intersection, Object3D } from 'three';
import type { SceneObject, ScenePose } from '@breatic/shared';
import { displayedObjects, previewedObjectIds } from '@web/spaces/three-d/viewport/scene-display';
import { applyPose, poseRigOf, type PoseRig } from '@web/spaces/three-d/viewport/pose-rig';
import { SceneMiniMapRuntime } from '@web/spaces/three-d/viewport/scene-mini-map';
import { applySceneGridTheme } from '@web/spaces/three-d/viewport/scene-grid-theme';
import { ModelResourceCache, acquireMeasured, loadSceneModel, type MeasuredSceneModelLease } from '@web/spaces/three-d/viewport/model-resources';
import type { SceneModelLease } from '@web/spaces/three-d/viewport/model-resources';
import { createTransformGesture, transformPatches } from '@web/spaces/three-d/viewport/scene-transform';
import type { SceneTransformGesture } from '@web/spaces/three-d/viewport/scene-transform';
import { SceneTransformControls173 } from '@web/spaces/three-d/viewport/transform-controls-173';
import { focusSceneBounds, updateSceneCameraRange } from '@web/spaces/three-d/viewport/scene-camera';
import type { SceneTransformPatch, SceneViewportProps, SceneView } from '@web/spaces/three-d/viewport/scene-viewport-props';

interface NativeHandleObservation {
  name: string;
  visible: boolean;
  layer: number;
  cameraLayer: boolean;
  rayLayer: boolean;
  center: [number, number, number];
}

interface RenderedObject {
  source: string;
  lease: SceneModelLease;
  root: Group | null;
  state: 'loading' | 'ready' | 'failed';
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
  private readonly camera = new PerspectiveCamera(45, 1, 0.05, 5000);
  private readonly renderer: WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly controls: SceneTransformControls173;
  private readonly pivot = new Group();
  private readonly grid = new GridHelper(200, 200);
  private readonly resources: ModelResourceCache;
  /**
   * Hold one model through this view's cache, measured for placing it; the
   * view's own hold on the placed object then reuses the same template.
   * @param source - The model to place.
   * @returns The bounds and this holder's release.
   * @throws {Error} The bounds reject when the model cannot load.
   */
  readonly acquireModel = (source: SceneObject['model']): MeasuredSceneModelLease => acquireMeasured(this.resources, source);
  private readonly items = new Map<string, RenderedObject>();
  private overview: SceneMiniMapRuntime | null = null;
  private overviewHost: HTMLDivElement | null = null;
  private outlines: BoxHelper[] = [];
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
    this.camera.position.fromArray(props.view.position);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.fromArray(props.view.target);
    this.orbit.enableDamping = true;
    this.orbit.update();
    this.controls = new SceneTransformControls173(this.camera, canvas, props.scaleSensitivity, this.onCancel);
    this.scene.add(this.controls.getHelper(), this.pivot, this.grid, this.markers);
    this.scene.add(new HemisphereLight(0xffffff, 0x666666, 2.7));
    const light = new DirectionalLight(0xffffff, 3);
    light.position.set(5, 10, 4);
    this.scene.add(light);
    this.resources = new ModelResourceCache((source, signal) => loadSceneModel(source, signal, this.props.resolveAsset, this.token('--color-muted-foreground'), this.props.importLimits, this.renderer));
    this.controls.addEventListener('mouseDown', this.onGestureStart);
    this.controls.addEventListener('objectChange', this.onGestureChange);
    this.controls.addEventListener('mouseUp', this.onGestureCommit);
    this.controls.addEventListener('dragging-changed', this.onDraggingChanged);
    this.orbit.addEventListener('change', this.onViewChange);
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointerup', this.onPointerUpCapture, true);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
    window.addEventListener('blur', this.onCancel);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize = new ResizeObserver(this.onResize);
    this.resize.observe(host);
    this.theme = new MutationObserver(this.onThemeChange);
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    this.onResize();
    this.update(props);
    this.onFrame();
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
    if (this.dragging) return;
    const delta = new Vector3(x - this.orbit.target.x, 0, z - this.orbit.target.z);
    this.camera.position.add(delta); this.orbit.target.add(delta); this.orbit.update(); this.onViewChange();
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
    const previous = this.props;
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
    const visible = new Set(props.objects.map((object) => object.id));
    for (const [id, item] of this.items) {
      if (!visible.has(id)) {
        this.overview?.remove(id);
        item.lease.release();
        this.items.delete(id);
      }
    }
    const local = this.localGestureIds();
    this.displayed = displayedObjects(props.objects, local, props.remotePeers);
    this.previewed = previewedObjectIds(local, props.remotePeers);
    for (const object of this.displayed) {
      const source = JSON.stringify(object.model);
      let item = this.items.get(object.id);
      if (item && (item.source !== source || (item.state === 'failed' && props.modelRetryRevision !== previous.modelRetryRevision))) {
        if (this.gesture?.matrices.has(object.id) || this.joint?.id === object.id) this.endGesture(false);
        this.overview?.remove(object.id);
        item.lease.release();
        this.items.delete(object.id);
        item = undefined;
      }
      if (!item) this.loadObject(object, source);
      else if (item.root && !local.has(object.id)) {
        applyObject(item.root, object);
        applyPose(item.root, object.pose, !this.previewed.has(object.id));
      }
    }
    if (!this.dragging && !this.sameView(props.view)) {
      this.camera.position.fromArray(props.view.position);
      this.orbit.target.fromArray(props.view.target);
      this.orbit.update();
    }
    this.syncControls();
    if (props.focusRevision !== previous.focusRevision) this.focus();
    this.onThemeChange();
    this.inspect();
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
   * @param source - The serialized immutable model reference used to detect replacement of this object's source.
   * @throws {never} Load failures are reported through the resource-state callback.
   */
  private loadObject(object: SceneObject, source: string): void {
    const item: RenderedObject = { source, lease: this.resources.acquire(object.model), root: null, state: 'loading' };
    this.items.set(object.id, item);
    this.props.onModelStateChange?.(object.id, 'loading');
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
      // The rig is measured first, while the fresh instance is still at rest.
      const rig = poseRigOf(root);
      applyObject(root, latest);
      applyPose(root, latest.pose, !this.previewed.has(object.id));
      this.scene.add(root);
      this.props.onModelStateChange?.(object.id, 'ready');
      this.props.onSkeletonState(object.id, rig === null ? 'none' : rig.kind);
      this.syncControls();
      if (this.pendingFocus) this.focus();
      this.onThemeChange();
      this.inspect();
    }).catch((error: unknown) => {
      if (this.disposed || this.items.get(object.id) !== item) return;
      item.lease.release();
      item.state = 'failed';
      this.props.onModelStateChange?.(object.id, 'failed', sceneError(error));
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
   * Return the whole eligible selection, or none while one item cannot mutate.
   * @returns The selected objects in selection order, or an empty array when editing is denied or any selected object is locked, absent or not loaded.
   * @throws {never} Never.
   */
  private mutableObjects(): SceneObject[] {
    if (this.props.readOnly || this.props.selectedIds.length === 0) return [];
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
      for (const marker of this.markerItems) marker.mesh.material.dispose();
      this.markers.clear();
      this.markerItems = [];
      this.markerOwner = target?.root ?? null;
      if (target) {
        // Measured on the rig at rest, so the dots do not depend on the pose joint mode opens in.
        const { joints, restSize } = target.rig;
        const full = restSize * 0.012;
        joints.forEach(({ key, bone, rest }, index) => {
          // Close joints such as finger knuckles get dots under half their spacing, so neighbouring dots never
          // touch; joints at one point keep a visible dot, a click on it picks the first of them and the skin the rest.
          const nearest = Math.min(...joints.filter((_, other) => other !== index).map((joint) => joint.rest.distanceTo(rest)));
          const mesh = new Mesh(this.markerGeometry, new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true }));
          mesh.renderOrder = 1000;
          this.markerItems.push({ key, bone, mesh, unit: Math.max(full * 0.3, Math.min(full, nearest * 0.45)) });
          this.markers.add(mesh);
        });
      }
    }
    // Sized from the current scale on every sync, so a character scaled in joint mode keeps dots that fit it.
    const scale = target ? largestScale(target.root) : 0;
    const normal = this.token('--color-status-selected');
    const selected = this.token('--color-foreground');
    for (const { key, mesh, unit } of this.markerItems) {
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
    this.orbit.enabled = true;
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
    if (typeof event.value === 'boolean') this.orbit.enabled = !event.value;
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
    this.renderer.domElement.focus({ preventScroll: true });
  };

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
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const point = new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(point, this.camera);
    this.scene.updateMatrixWorld(true);
    // Joint dots are drawn over everything, so they are picked first; of the dots the ray crosses, the one whose
    // centre is nearest the ray wins, so a click on a dot's centre picks it through a larger dot in front.
    const dot = ray.intersectObjects(this.markerItems.map((marker) => marker.mesh), false)
      .sort((a, b) => ray.ray.distanceSqToPoint(a.object.position) - ray.ray.distanceSqToPoint(b.object.position))[0];
    const dotKey = dot && this.markerItems.find((marker) => marker.mesh === dot.object)?.key;
    if (dotKey) {
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
    if (typeof root.userData.sceneObjectId === 'string') this.props.onSelect(root.userData.sceneObjectId, event.shiftKey);
  };

  /**
   * Cancel without a commit when the browser or session interrupts input.
   * @throws {never} Never directly.
   */
  private onCancel = (): void => {
    this.endGesture(false);
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
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else if (this.frame === 0 && !this.disposed) this.onFrame();
  };

  /**
   * Keep the user's personal navigation outside scene content.
   * @throws {never} Never directly.
   */
  private onViewChange = (): void => {
    if (this.disposed || this.dragging) return;
    this.props.onViewChange({ position: this.camera.position.toArray(), target: this.orbit.target.toArray() });
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
    for (const id of this.props.selectedIds) {
      const root = this.items.get(id)?.root;
      if (root) this.addOutline(root, this.token('--color-status-selected'));
    }
    for (const peer of this.props.remotePeers) {
      for (const id of peer.selectedIds) {
        const root = this.items.get(id)?.root;
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  /**
   * Resolve theme tokens for canvas content as well as surrounding React chrome.
   * @throws {never} Never directly.
   */
  private onThemeChange = (): void => {
    this.scene.background = new Color(this.token('--color-background'));
    applySceneGridTheme(this.grid, this.token('--color-muted-foreground'));
    const color = this.token('--color-muted-foreground');
    for (const object of this.props.objects) {
      if (object.model.kind !== 'builtin') continue;
      this.items.get(object.id)?.root?.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          if (material instanceof MeshStandardMaterial) material.color.setStyle(color);
        }
      });
    }
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
    if (!this.dragging && !this.controls.dragging) this.orbit.update();
    this.placeMarkers();
    const bounds = new Box3();
    for (const item of this.items.values()) {
      if (item.root) bounds.expandByObject(item.root);
    }
    updateSceneCameraRange(this.camera, bounds);
    for (const outline of this.outlines) outline.update();
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
   * Expose actual rendered tuples for browser assertions without a second scene model.
   * @throws {never} Never.
   */
  private inspect(): void {
    const canvas = this.renderer.domElement;
    canvas.dataset.gestureActive = String(this.dragging);
    canvas.dataset.view = JSON.stringify({ position: this.camera.position.toArray(), target: this.orbit.target.toArray() });
    canvas.dataset.objects = JSON.stringify([...this.items].flatMap(([id, item]) => item.root ? [{ id, position: item.root.position.toArray(), rotation: item.root.quaternion.toArray(), scale: item.root.scale.toArray() }] : []));
  }

  /**
   * Withdraw gestures and release everything owned by this visible view.
   * @throws {never} Never directly.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endGesture(false);
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.theme.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointerup', this.onPointerUpCapture, true);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onCancel);
    canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    window.removeEventListener('blur', this.onCancel);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.controls.removeEventListener('mouseDown', this.onGestureStart);
    this.controls.removeEventListener('objectChange', this.onGestureChange);
    this.controls.removeEventListener('mouseUp', this.onGestureCommit);
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.orbit.removeEventListener('change', this.onViewChange);
    this.controls.dispose();
    this.orbit.dispose();
    this.overview?.dispose();
    this.overview = null;
    this.resources.dispose();
    this.items.clear();
    for (const outline of this.outlines) {
      outline.geometry.dispose();
      outline.material.dispose();
    }
    this.outlines = [];
    for (const marker of this.markerItems) marker.mesh.material.dispose();
    this.markerItems = [];
    this.markerGeometry.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}
