// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Group, Object3D, Texture } from 'three';

import type { SceneLook, SceneObject } from '@breatic/shared';

import { checkLookTextures, fittedLookSize, lookPartRank, type LookTextureInput, type LookTextureVerdict } from '@web/spaces/three-d/look-texture-budget';
import { addPartHighlight, type PartHighlight } from '@web/spaces/three-d/viewport/look-highlight';
import { applyLook, releaseLook, type LookPartTable } from '@web/spaces/three-d/viewport/look-materials';
import type { LookTextureCache } from '@web/spaces/three-d/viewport/look-texture-cache';
import { lookModelOf } from '@web/spaces/three-d/viewport/model-resources';

/** One part as the appearance section lists it. */
export interface SceneLookPartReport {
  key: string;
  name: string | null;
  color: string;
  hasMap: boolean;
  unlit: boolean;
  line: boolean;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  transmission?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** The own picture's tiling, offset and rotation in degrees, when it has one. */
  mapRepeat?: [number, number];
  mapOffset?: [number, number];
  mapRotation?: number;
}

/** What the editor needs to show and change an object's look. */
export interface SceneLookReport {
  parts: SceneLookPartReport[];
  ownBytes: number;
  clampBytes: Record<string, number>;
  /** This device's largest texture edge. */
  deviceMaxEdge: number;
}

/** How an object's part pictures stand: which are shown, and why the others are not. */
export interface SceneLookPictures {
  /** A download, decode or size read failed; a retry can help. */
  retry: boolean;
  /** A picture is over the object's texture budget. */
  over: boolean;
  /** The user pictures the scene shows now. */
  shown: readonly string[];
}

export interface SceneLookRuntimeDeps {
  textures: () => LookTextureCache | null;
  /** The scene's texture limits, the edge capped by this device. */
  limits: () => { maxTextureEdge: number; maxTextureBytes: number };
  /** The built-in models' colour in the current theme. */
  themeColor: () => string;
  /** The tint of a highlighted part. */
  highlightColor: () => string;
  /** A material's shader inputs changed: compile it before it draws, then recount lights and shadows. */
  onProgramChanged: (root: Group) => void;
  /** Something on screen changed. */
  onChanged: () => void;
  onPictures: (id: string, pictures: SceneLookPictures | null) => void;
}

type PictureState = 'loading' | 'ready' | 'failed' | 'over';

interface ObjectLook {
  root: Group;
  look: SceneLook;
  lookKey: string;
  appliedKey: string;
  /** Bumped by every picture check, so a stale one leaves no trace. */
  run: number;
  held: Map<string, Texture>;
  states: Map<string, PictureState>;
}

/**
 * The asset ids a look shows as pictures.
 * @param look - The look.
 * @returns Distinct picture ids.
 */
function picturesOf(look: SceneLook): string[] {
  return [...new Set(Object.values(look).flatMap((fields) => (fields.map && fields.map !== 'none' ? [fields.map] : [])))];
}

/**
 * The part rows a part table shows, in panel order: built-in parts are named by number and take the current theme
 * colour (design 3.1, 5.1).
 * @param table - The model's part table.
 * @param themeColor - The current theme's built-in model colour.
 * @returns The rows.
 */
function partRows(table: LookPartTable, themeColor: string): SceneLookPartReport[] {
  return [...table].sort(([a], [b]) => lookPartRank(a) - lookPartRank(b)).map(([key, entry]) => ({
    key, name: entry.builtin ? null : entry.name, color: entry.builtin ? themeColor : entry.color, hasMap: entry.hasMap,
    unlit: entry.unlit, line: entry.line, roughness: entry.roughness, metalness: entry.metalness, opacity: entry.opacity,
    transmission: entry.transmission, emissive: entry.emissive, emissiveIntensity: entry.emissiveIntensity,
    mapRepeat: entry.mapRepeat, mapOffset: entry.mapOffset, mapRotation: entry.mapRotation,
  }));
}

/**
 * What an object's model reports for its look.
 * @param root - The loaded instance.
 * @param deviceMaxEdge - This device's largest texture edge.
 * @param themeColor - The current theme's built-in model colour.
 * @returns The part rows and byte counts, or null when the model has no look model.
 */
export function lookReportOf(root: Group, deviceMaxEdge: number, themeColor: string): SceneLookReport | null {
  const model = lookModelOf(root);
  if (!model) return null;
  return { parts: partRows(model.table, themeColor), ownBytes: model.ownBytes, deviceMaxEdge,
    clampBytes: Object.fromEntries([...model.table].map(([key, entry]) => [key, entry.clampBytes])) };
}

/**
 * The looks of one viewport's loaded objects (inner#1693 design 5.2-5.5): each object's look is applied to its own
 * materials, its pictures are judged from file headers as a whole and decoded only when usable, and the selected part
 * is highlighted.
 */
export class SceneLookRuntime {
  private readonly deps: SceneLookRuntimeDeps;
  private readonly objects = new Map<string, ObjectLook>();
  private highlight: { key: string; shown: PartHighlight } | null = null;

  /**
   * Take the viewport's hooks.
   * @param deps - Textures, limits, colours and notices.
   */
  constructor(deps: SceneLookRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * Bring one loaded object's look up to date: its pictures when the look changed, its materials when anything it
   * shows changed.
   * @param object - The displayed record.
   * @param root - Its loaded instance.
   */
  sync(object: SceneObject, root: Group): void {
    let state = this.objects.get(object.id);
    if (state && state.root !== root) {
      this.remove(object.id);
      state = undefined;
    }
    if (!state) {
      state = { root, look: {}, lookKey: '', appliedKey: '', run: 0, held: new Map(), states: new Map() };
      this.objects.set(object.id, state);
    }
    const look = object.look ?? {};
    const lookKey = JSON.stringify(look);
    if (lookKey !== state.lookKey) {
      state.look = look;
      state.lookKey = lookKey;
      void this.checkPictures(object.id, state);
    }
    this.apply(object.id, state);
  }

  /**
   * Forget an object: its clones and pictures are released and its highlight removed.
   * @param id - The object.
   */
  remove(id: string): void {
    const state = this.objects.get(id);
    if (!state) return;
    this.objects.delete(id);
    state.run += 1;
    if (this.highlight?.key.startsWith(`${id}:`)) this.setHighlight(null, null, null);
    releaseLook(state.root);
    const textures = this.deps.textures();
    for (const [assetId, texture] of state.held) textures?.release(assetId, texture);
    this.deps.onPictures(id, null);
  }

  /** Check again every object whose pictures failed to load. */
  retry(): void {
    for (const [id, state] of this.objects) {
      if ([...state.states.values()].includes('failed')) void this.checkPictures(id, state, true);
    }
  }

  /** Re-apply every look, after the theme changed the built-in colour. */
  restyle(): void {
    for (const [id, state] of this.objects) this.apply(id, state);
  }

  /**
   * Show one part of one object highlighted, or none.
   * @param id - The object, or null.
   * @param root - Its loaded instance, or null.
   * @param part - The part, or null.
   */
  setHighlight(id: string | null, root: Group | null, part: string | null): void {
    const key = id !== null && root && part !== null ? `${id}:${part}:${root.uuid}` : null;
    if ((this.highlight?.key ?? null) === key) return;
    this.highlight?.shown.remove();
    this.highlight = key !== null && root && part !== null ? { key, shown: addPartHighlight(root, part, this.deps.highlightColor()) } : null;
    this.deps.onChanged();
  }

  /** Recolour the highlight after a theme change. */
  restyleHighlight(): void {
    const current = this.highlight;
    if (!current) return;
    for (const overlay of current.shown.overlays) {
      const material = overlay.material;
      for (const slot of Array.isArray(material) ? material : [material]) {
        if ('color' in slot && slot.visible) (slot as { color: { setStyle: (value: string) => void } }).color.setStyle(this.deps.highlightColor());
      }
    }
  }

  /**
   * The highlight overlays, which stills and monitors leave out.
   * @returns The overlay meshes.
   */
  overlays(): Object3D[] {
    return this.highlight?.shown.overlays ?? [];
  }

  /** Release everything. */
  dispose(): void {
    this.highlight?.shown.remove();
    this.highlight = null;
    for (const id of [...this.objects.keys()]) this.remove(id);
  }

  /**
   * Write the look onto the object's materials when what it shows changed.
   * @param id - The object.
   * @param state - Its look state.
   */
  private apply(id: string, state: ObjectLook): void {
    const model = lookModelOf(state.root);
    if (!model) return;
    const themeColor = this.deps.themeColor();
    const key = JSON.stringify([state.lookKey, themeColor, [...state.states]]);
    if (key === state.appliedKey) return;
    state.appliedKey = key;
    const { programChanged } = applyLook(state.root, model.table, state.look, {
      themeColor,
      picture: (assetId) => (state.states.get(assetId) === 'ready' ? state.held.get(assetId) ?? null : null),
    });
    if (programChanged) this.deps.onProgramChanged(state.root);
    const states = [...state.states];
    this.deps.onPictures(id, states.length === 0 ? null : {
      retry: states.some(([, status]) => status === 'failed'), over: states.some(([, status]) => status === 'over'),
      shown: states.filter(([, status]) => status === 'ready').map(([assetId]) => assetId),
    });
    this.deps.onChanged();
  }

  /**
   * Judge the object's pictures together from their headers, then hold the usable ones and drop the rest (design 5.3).
   * A picture that failed to load stays failed until the user retries (design 6.2).
   * @param id - The object.
   * @param state - Its look state.
   * @param retrying - Whether the user asked to load failed pictures again.
   */
  private async checkPictures(id: string, state: ObjectLook, retrying = false): Promise<void> {
    const run = ++state.run;
    const textures = this.deps.textures();
    const model = lookModelOf(state.root);
    const wanted = picturesOf(state.look);
    for (const [assetId, texture] of [...state.held]) {
      if (!wanted.includes(assetId)) {
        state.held.delete(assetId);
        textures?.release(assetId, texture);
      }
    }
    for (const assetId of [...state.states.keys()]) if (!wanted.includes(assetId)) state.states.delete(assetId);
    if (!textures || !model || wanted.length === 0) {
      this.apply(id, state);
      return;
    }
    /**
     * Whether a picture keeps its failure without a new request.
     * @param assetId - The picture.
     * @returns True for a failed picture outside a retry.
     */
    const stillFailed = (assetId: string): boolean => !retrying && state.states.get(assetId) === 'failed';
    for (const assetId of wanted) if (!state.held.has(assetId) && !stillFailed(assetId)) state.states.set(assetId, 'loading');
    this.apply(id, state);
    const sizes = new Map(await Promise.all(wanted.map(async (assetId) => [assetId, stillFailed(assetId) ? null : await textures.size(assetId)] as const)));
    if (run !== state.run || this.objects.get(id) !== state) return;
    const limits = this.deps.limits();
    const input: LookTextureInput = { ownBytes: model.ownBytes, look: state.look, sizes, limits,
      clampBytes: Object.fromEntries([...model.table].map(([key, entry]) => [key, entry.clampBytes])) };
    const verdicts = new Map<string, LookTextureVerdict>();
    for (const [part, verdict] of checkLookTextures(input)) {
      const map = state.look[part]?.map;
      if (map) verdicts.set(map, verdict);
    }
    // An unusable picture leaves its part first and is released after, so no material shows a closed image.
    const dropped: Array<[string, Texture]> = [];
    const toLoad: string[] = [];
    for (const assetId of wanted) {
      const verdict = verdicts.get(assetId);
      if (!verdict || !verdict.usable) {
        const held = state.held.get(assetId);
        if (held) {
          state.held.delete(assetId);
          dropped.push([assetId, held]);
        }
        state.states.set(assetId, verdict && !verdict.usable && verdict.reason !== 'unknown' ? 'over' : 'failed');
      } else if (state.held.has(assetId)) state.states.set(assetId, 'ready');
      else toLoad.push(assetId);
    }
    if (dropped.length > 0) {
      this.apply(id, state);
      for (const [assetId, held] of dropped) textures.release(assetId, held);
    }
    await Promise.all(toLoad.map(async (assetId) => {
      try {
        const size = sizes.get(assetId);
        const fitted = size ? fittedLookSize(size, limits.maxTextureEdge) : undefined;
        const texture = await textures.acquire(assetId, size && fitted && fitted.width !== size.width ? fitted : undefined);
        if (run !== state.run || this.objects.get(id) !== state) {
          textures.release(assetId, texture);
          return;
        }
        state.held.set(assetId, texture);
        state.states.set(assetId, 'ready');
      } catch {
        if (run === state.run) state.states.set(assetId, 'failed');
      }
      if (run === state.run) this.apply(id, state);
    }));
    if (run === state.run && this.objects.get(id) === state) this.apply(id, state);
  }
}
