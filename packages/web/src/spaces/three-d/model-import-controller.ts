// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as Y from 'yjs';
import type { Group } from 'three';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { UploadFailedError } from '@web/data/upload/media-upload';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import type { SceneUploadStart } from '@web/spaces/three-d/scene-uploads';

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
  prepare: (files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal) => Promise<PreparedModel>;
  /** Begin the page-held upload under the given name; answers once its task row exists or it was refused. */
  start: (file: File, name: string) => Promise<SceneUploadStart>;
}
export interface ModelImportSnapshot {
  phase: 'idle' | 'checking' | 'ready' | 'starting' | 'failed' | 'disposed';
  name: string;
  error: Error | null;
  prepared: PreparedModel | null;
  files: readonly ModelSource[];
  entry: string | undefined;
  entries: readonly string[];
  paths: readonly string[];
  missing: readonly string[];
}

const IDLE: ModelImportSnapshot = { phase: 'idle', name: '', error: null, prepared: null,
  files: [], entry: undefined, entries: [], paths: [], missing: [] };

/**
 * Own the import dialog's input for the lifetime of one open collaborative document.
 *
 * It checks the picked files and, on confirmation, starts their upload; once
 * the upload has a task row it returns to idle, because the upload itself is
 * held by the page (scene-uploads) and shown on the Space's task list.
 */
export class ModelImportController {
  private snapshot: ModelImportSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private operation = new AbortController();
  private inFlight: Promise<string | null> | null = null;
  /** Counts selection requests so a slow read is dropped once a newer selection was made. */
  private requests = 0;
  /** Whether the shown name was typed; otherwise it follows the main file. */
  private named = false;

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
    await this.inspect(files, entry, files === this.snapshot.files);
  }

  /**
   * Add accompanying files to the current collection and check it again around the same main file.
   * @param added - The added files at the missing paths they fill.
   * @returns Completion of this inspection; obsolete completions are ignored.
   * @throws {never} Inspection failures are retained in the snapshot.
   */
  async supplement(added: readonly ModelSource[]): Promise<void> {
    await this.inspect([...this.snapshot.files, ...added], this.snapshot.entry, true);
  }

  /**
   * Check a collection, keeping its entries and name when it is the current collection checked again.
   * @param files - Original files under their paths in the user's collection.
   * @param entry - Explicit entry when several models are present.
   * @param same - Whether this is the current collection, re-checked or supplemented.
   * @returns Completion of this inspection; obsolete completions are ignored.
   * @throws {never} Inspection failures are retained in the snapshot.
   */
  private async inspect(files: readonly ModelSource[], entry: string | undefined, same: boolean): Promise<void> {
    this.requests += 1;
    if (['disposed', 'starting'].includes(this.snapshot.phase)) return;
    this.operation.abort();
    this.snapshot.prepared?.dispose();
    const operation = new AbortController();
    this.operation = operation;
    if (!same) this.named = false;
    this.publish({ phase: 'checking', prepared: null, error: null,
      files, entry, entries: same ? this.snapshot.entries : [], paths: [], missing: [], name: same ? this.snapshot.name : '' });
    try {
      const prepared = await this.inputs.prepare(files, entry, operation.signal);
      if (operation.signal.aborted) { prepared.dispose(); return; }
      this.publish({ phase: 'ready', prepared, entry: prepared.entry, entries: prepared.entries, paths: prepared.paths ?? [],
        name: this.nameFor(prepared.entry) });
    } catch (error) {
      if (operation.signal.aborted) return;
      const info = error instanceof ModelImportError ? error.info : undefined;
      this.publish({ phase: 'failed', error: error instanceof Error ? error : new Error(String(error)),
        ...info, name: this.nameFor(info?.entry) });
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
    if (this.snapshot.phase === 'disposed' || this.snapshot.phase === 'starting') return;
    this.named = name.trim() !== '';
    this.publish({ name });
  }

  /**
   * Name the model after its main file unless a name was typed.
   * @param entry - The main file the check read, when it has one.
   * @returns The name to show.
   * @throws {never} Never.
   */
  private nameFor(entry: string | undefined): string {
    if (this.named || entry === undefined) return this.snapshot.name;
    return entry.slice(entry.lastIndexOf('/') + 1).replace(/\.(glb|gltf)$/i, '');
  }

  /**
   * Clear a completed or editable operation without ending its document owner.
   * @throws {never} Never directly.
   */
  reset(): void {
    if (['disposed', 'starting'].includes(this.snapshot.phase)) return;
    this.clear();
  }

  /**
   * Return to an empty dialog, releasing the preview.
   * @throws {never} Never directly.
   */
  private clear(): void {
    this.operation.abort();
    this.snapshot.prepared?.dispose();
    this.operation = new AbortController();
    this.named = false;
    this.publish(IDLE);
  }

  /**
   * Start the checked model's upload under the shown name.
   * @returns The new task row once the upload has one, or null when it did not start.
   * @throws {never} A refusal is retained in the snapshot.
   */
  async confirm(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    const { prepared, phase, name } = this.snapshot;
    if (!prepared || !['ready', 'failed'].includes(phase)) return null;
    const pending = this.begin(prepared, name, this.operation.signal);
    this.inFlight = pending;
    try { return await pending; } finally { if (this.inFlight === pending) this.inFlight = null; }
  }

  /**
   * Hand the file to the page's upload and wait for its task row.
   * @param prepared - Checked input owned by this operation.
   * @param name - The model's name.
   * @param signal - Cancelled when this operation loses its document owner.
   * @returns The new task row, or null when the upload did not start.
   * @throws {never} A refusal is retained in the snapshot.
   */
  private async begin(prepared: PreparedModel, name: string, signal: AbortSignal): Promise<string | null> {
    this.publish({ phase: 'starting', error: null });
    const answer = await this.inputs.start(prepared.file, name.trim());
    if (signal.aborted) return answer.kind === 'opened' ? answer.taskId : null;
    if (answer.kind === 'opened') {
      this.clear();
      return answer.taskId;
    }
    this.publish({ phase: 'failed', error: answer.kind === 'refused' ? new UploadFailedError(answer.reason) : new Error('Upload did not start') });
    return null;
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
