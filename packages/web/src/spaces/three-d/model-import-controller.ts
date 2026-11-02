// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from 'yjs';
import type { Group } from 'three';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import type { SceneSession } from '@web/data/yjs/scene-session';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelSource } from '@web/spaces/three-d/model-source';

export interface ModelBounds {
  center: readonly [number, number, number];
  min: readonly [number, number, number];
}
export interface PreparedModel {
  file: File;
  entry: string;
  entries: readonly string[];
  bounds: ModelBounds;
  dispose: () => void;
  preview?: Group;
  paths?: readonly string[];
  meshCount?: number;
  skinned?: boolean;
  warnings?: readonly string[];
}
export interface ModelImportInputs {
  session: SceneSession;
  prepare: (files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal) => Promise<PreparedModel>;
  upload: (file: File, signal: AbortSignal, onProgress: (fraction: number) => void, onRegistering: () => void) => Promise<{ assetId: string }>;
  position: (bounds: ModelBounds) => [number, number, number];
}
export interface ModelImportSnapshot {
  phase: 'idle' | 'checking' | 'ready' | 'uploading' | 'registering' | 'placed' | 'failed' | 'disposed';
  name: string;
  progress: number;
  error: Error | null;
  prepared: PreparedModel | null;
  assetId: string | null;
  objectId: string | null;
  files: readonly ModelSource[];
  entry: string | undefined;
  entries: readonly string[];
  paths: readonly string[];
  missing: readonly string[];
}

/** Own a local import for the lifetime of one open collaborative document. */
export class ModelImportController {
  private snapshot: ModelImportSnapshot = { phase: 'idle', name: '', progress: 0, error: null, prepared: null, assetId: null,
    objectId: null, files: [], entry: undefined, entries: [], paths: [], missing: [] };
  private readonly listeners = new Set<() => void>();
  private operation = new AbortController();
  private inFlight: Promise<void> | null = null;
  /** Counts selection requests so a slow read is dropped once a newer selection was made. */
  private requests = 0;

  /**
   * Bind import work to the existing scene command owner.
   * @param inputs - Live document's command session and transport adapters.
   * @throws {never} Never.
   */
  constructor(private readonly inputs: ModelImportInputs) {}

  /**
   * Read a stable snapshot until the next state transition.
   * @returns Current local import state.
   * @throws {never} Never.
   */
  getSnapshot = (): ModelImportSnapshot => this.snapshot;

  /**
   * Subscribe without tying operation ownership to a React mount.
   * @param listener - Observer notified on state changes.
   * @returns Observer removal callback.
   * @throws {never} Never.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  };

  /**
   * Publish a complete referentially stable snapshot.
   * @param patch - State fields changed by this transition.
   * @throws {never} Never directly.
   */
  private publish(patch: Partial<ModelImportSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Replace the source selection and release superseded preview resources.
   * @param files - Original files under their paths in the user's collection.
   * @param entry - Explicit entry when several models are present.
   * @returns Completion of this inspection; obsolete completions are ignored.
   * @throws {never} Inspection failures are retained in the snapshot.
   */
  async select(files: readonly ModelSource[], entry?: string): Promise<void> {
    this.requests += 1;
    if (['disposed', 'uploading', 'registering'].includes(this.snapshot.phase)) return;
    this.operation.abort();
    this.snapshot.prepared?.dispose();
    const operation = new AbortController();
    this.operation = operation;
    this.publish({ phase: 'checking', prepared: null, assetId: null, objectId: null, error: null, progress: 0,
      files, entry, entries: [], paths: [], missing: [] });
    try {
      const prepared = await this.inputs.prepare(files, entry, operation.signal);
      if (operation.signal.aborted) { prepared.dispose(); return; }
      this.publish({ phase: 'ready', prepared, entry: prepared.entry, entries: prepared.entries, paths: prepared.paths ?? [],
        name: prepared.entry.slice(prepared.entry.lastIndexOf('/') + 1).replace(/\.(glb|gltf)$/i, '') });
    } catch (error) {
      if (!operation.signal.aborted) this.publish({ phase: 'failed', error: error instanceof Error ? error : new Error(String(error)),
        ...(error instanceof ModelImportError && error.info ? error.info : {}) });
    }
  }

  /**
   * Inspect a selection that is still being read, unless the user selects something else before it is ready.
   * @param read - The selection's sources once read, such as the files of a dropped folder.
   * @returns Completion of the read and, when still current, its inspection.
   * @throws {never} Inspection failures are retained in the snapshot.
   */
  async selectWhenRead(read: Promise<readonly ModelSource[]>): Promise<void> {
    const request = ++this.requests;
    const files = await read;
    if (request === this.requests) await this.select(files);
  }

  /**
   * Preserve exactly the name shown in the input.
   * @param name - User's current name draft.
   * @throws {never} Never.
   */
  setName(name: string): void {
    if (this.snapshot.phase !== 'disposed') this.publish({ name });
  }

  /**
   * Clear a completed or editable operation without ending its document owner.
   * @throws {never} Never directly.
   */
  reset(): void {
    if (['disposed', 'uploading', 'registering'].includes(this.snapshot.phase)) return;
    this.operation.abort();
    this.snapshot.prepared?.dispose();
    this.operation = new AbortController();
    this.publish({ phase: 'idle', prepared: null, files: [], entry: undefined, entries: [], paths: [], missing: [],
      name: '', assetId: null, objectId: null, progress: 0, error: null });
  }

  /**
   * Begin confirmation only after a local model is ready.
   * @returns Completion of the current confirmation.
   * @throws {never} Failures are retained in the snapshot.
   */
  async confirm(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.snapshot.prepared || !['ready', 'failed'].includes(this.snapshot.phase)) return;
    const pending = this.place(this.snapshot.prepared, this.operation.signal);
    this.inFlight = pending;
    try { await pending; } finally { if (this.inFlight === pending) this.inFlight = null; }
  }

  /**
   * Register original bytes before creating exactly one collaborative object.
   * @param prepared - Checked input owned by this operation.
   * @param signal - Cancelled when this operation loses its document owner.
   * @returns Completion of registration and the attempted scene command.
   * @throws {never} Failures are retained for retry without losing registered content.
   */
  private async place(prepared: PreparedModel, signal: AbortSignal): Promise<void> {
    try {
      let assetId = this.snapshot.assetId;
      if (!assetId) {
        this.publish({ phase: 'uploading', progress: 0, error: null });
        const result = await this.inputs.upload(prepared.file, signal, (progress) => {
          if (!signal.aborted) this.publish({ progress });
        }, () => {
          if (!signal.aborted) this.publish({ phase: 'registering' });
        });
        if (signal.aborted) return;
        assetId = result.assetId;
        this.publish({ assetId, progress: 1 });
      }
      if (signal.aborted) return;
      if (!this.inputs.session.getSnapshot().canEdit) { this.publish({ phase: 'ready' }); return; }
      const id = crypto.randomUUID();
      const result = this.inputs.session.execute({ type: 'create', objects: [{
        id, name: this.snapshot.name, model: { kind: 'asset', assetId }, position: this.inputs.position(prepared.bounds),
        rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false,
      }] });
      if (!result.ok) throw new ModelImportError('invalid', `Model placement refused: ${result.reason}`, { detail: '' });
      this.publish({ phase: 'placed', objectId: id, error: null });
    } catch (error) {
      if (!signal.aborted) this.publish({ phase: 'failed', error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  /**
   * End ownership synchronously when the Space closes or its document dies.
   * @throws {never} Never directly.
   */
  dispose(): void {
    if (this.snapshot.phase === 'disposed') return;
    this.operation.abort();
    this.snapshot.prepared?.dispose();
    this.publish({ phase: 'disposed', prepared: null, files: [] });
    this.listeners.clear();
  }
}

const controllers = createDocScopedCache<ModelImportController, ModelImportInputs>(
  (_doc, inputs) => new ModelImportController(inputs), (controller) => controller.dispose(),
);

/**
 * Reuse a document's import while its body is hidden or remounted.
 * @param doc - Live collaborative scene document.
 * @param name - Canonical document name.
 * @param inputs - Construction adapters used on the first request.
 * @returns Existing import owner or a new owner for this document.
 * @throws {never} Never directly.
 */
export function getModelImportController(doc: Y.Doc, name: string, inputs: ModelImportInputs): ModelImportController {
  return controllers.get(doc, name, inputs);
}

/**
 * End an explicitly closed Space's local import before releasing its session.
 * @param name - Canonical document name being closed.
 * @throws {never} Never directly.
 */
export function evictModelImportController(name: string): void {
  controllers.evict(name);
}
