// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as Y from 'yjs';
import { z } from 'zod';
import type { Awareness } from 'y-protocols/awareness';

import { SceneObjectSchema, type SceneObject } from '@breatic/shared';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { nextHistoryStep } from '@web/data/yjs/history-step';
import {
  applySceneCommand, createSceneHistory, readSceneDocument,
  type SceneCommand, type SceneCommandResult, type SceneDocumentSnapshot, type ScenePatch,
} from '@web/data/yjs/scene-document';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import { userPaletteColor } from '@web/lib/user-color';
import type { WriteAccess } from '@web/data/yjs/use-socket';

export interface SceneEnvironment {
  readOnly: boolean;
  connected: boolean;
  hasEverSynced: boolean;
  writeAccess: WriteAccess;
  refused: boolean;
  awareness: Awareness | null;
}
export interface ScenePeer {
  clientId: number;
  userId: string;
  color: string;
  selectedIds: readonly string[];
  gesture: readonly SceneObject[] | null;
}
export interface SceneSessionSnapshot extends SceneDocumentSnapshot {
  selectedIds: readonly string[];
  gestureActive: boolean;
  cancelRevision: number;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  remotePeers: readonly ScenePeer[];
  /** Other pages' whole-percent upload progress, by task row (inner#1690). */
  remoteUploads: Readonly<Record<string, number>>;
  commandError: Extract<SceneCommandResult, { ok: false }> | null;
}

const PEER_SCHEMA = z.object({
  user: z.object({ id: z.string() }),
  scenePresence: z.object({
    selectedIds: z.array(z.string()),
    gesture: z.array(SceneObjectSchema).nullable(),
  }),
});

/** Own document-level selection, command history and presence across hidden Space bodies. */
export class SceneSession {
  readonly history: Y.UndoManager;
  private readonly origin = Symbol('scene-local-command');
  private readonly listeners = new Set<() => void>();
  private environment: SceneEnvironment = { readOnly: true, connected: false, hasEverSynced: false,
    writeAccess: 'unknown', refused: false, awareness: null };
  private selectedIds: string[] = [];
  private gesture: ScenePatch[] | null = null;
  private cancelRevision = 0;
  private visible = false;
  private focused = false;
  private destroyed = false;
  private commandError: Extract<SceneCommandResult, { ok: false }> | null = null;
  private snapshot!: SceneSessionSnapshot;

  /**
   * Attach in-memory editing state to the same live document held by its provider.
   * @param doc - Live collaborative scene document.
   * @param name - Its canonical document name, whose size gates writes.
   */
  constructor(readonly doc: Y.Doc, readonly name: string) {
    this.history = createSceneHistory(doc, this.origin);
    doc.on('update', this.refresh);
    this.history.on('stack-item-added', this.refresh);
    this.history.on('stack-item-popped', this.refresh);
    this.history.on('stack-cleared', this.refresh);
    this.refresh();
  }

  /**
   * Read a referentially stable React snapshot.
   * @returns The same snapshot object until observable session facts change.
   */
  getSnapshot = (): SceneSessionSnapshot => this.snapshot;

  /**
   * Observe meaningful session changes until the caller unsubscribes.
   * @param listener - Observer called when the current snapshot changes.
   * @returns A function removing this observer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  };

  /** Recompute permission, projection and publication from their original facts. */
  private refresh = (): void => {
    if (this.destroyed) return;
    const scene = readSceneDocument(this.doc);
    const byId = new Map(scene.objects.map((object) => [object.id, object]));
    const nextSelection = this.selectedIds.filter((id) => byId.has(id));
    const canEdit = this.environment.hasEverSynced && scene.status === 'ready' && !this.environment.readOnly
      && (this.environment.refused || this.environment.writeAccess !== 'denied');
    this.replaceSelection(nextSelection);
    if (this.gesture && (!canEdit || this.selectedIds.some((id) => byId.get(id)?.locked))) this.clearGesture();
    const objects = scene.objects.map((object) => {
      const patch = this.gesture?.find((item) => item.id === object.id);
      return patch ? { ...object, ...patch } : object;
    });
    this.snapshot = { ...scene, objects, selectedIds: this.selectedIds,
      gestureActive: this.gesture !== null, cancelRevision: this.cancelRevision, canEdit,
      canUndo: this.history.undoStack.length > 0, canRedo: this.history.redoStack.length > 0,
      remotePeers: this.readPeers(byId), remoteUploads: this.stableUploads(), commandError: this.commandError };
    this.publishPresence();
    this.listeners.forEach((listener) => listener());
  };

  /**
   * Read validated temporary peer hints, whose identities were stamped by the server.
   * @param byId - Valid committed objects indexed by stable identity.
   * @returns Validated temporary hints for each other connection.
   */
  private readPeers(byId: ReadonlyMap<string, SceneObject>): ScenePeer[] {
    const awareness = this.environment.awareness;
    if (!awareness) return [];
    const peers: ScenePeer[] = [];
    awareness.getStates().forEach((state: Record<string, unknown>, clientId: number) => {
      if (clientId === awareness.clientID) return;
      const parsed = PEER_SCHEMA.safeParse(state);
      if (!parsed.success) return;
      const { user, scenePresence } = parsed.data;
      peers.push({ clientId, userId: user.id, color: userPaletteColor(user.id),
        selectedIds: scenePresence.selectedIds.filter((id) => byId.has(id)),
        gesture: scenePresence.gesture?.filter((object) => byId.has(object.id) && !byId.get(object.id)?.locked) ?? null });
    });
    return peers.sort((a, b) => a.userId.localeCompare(b.userId) || a.clientId - b.clientId);
  }

  /**
   * Read other pages' upload progress; an entry that is not a whole percent is ignored.
   * @returns Whole percent by task row.
   */
  private readUploads(): Record<string, number> {
    const awareness = this.environment.awareness;
    const uploads: Record<string, number> = {};
    if (!awareness) return uploads;
    awareness.getStates().forEach((state: Record<string, unknown>, clientId: number) => {
      if (clientId === awareness.clientID) return;
      const published = state.sceneUploads;
      if (typeof published !== 'object' || published === null) return;
      for (const [taskId, percent] of Object.entries(published)) {
        if (Number.isInteger(percent) && (percent as number) >= 0 && (percent as number) <= 100) uploads[taskId] = percent as number;
      }
    });
    return uploads;
  }

  /**
   * Read other pages' upload progress, keeping the previous object while nothing changed so memoized readers stay still.
   * @returns Whole percent by task row.
   */
  private stableUploads(): Readonly<Record<string, number>> {
    const next = this.readUploads();
    const previous = this.snapshot?.remoteUploads;
    return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  }

  /**
   * Follow a presence or progress change without reading the scene again: an
   * upload's progress ticks for as long as it sends, and no object changed.
   */
  private onAwareness = (): void => {
    if (this.destroyed) return;
    const byId = new Map(this.snapshot.objects.map((object) => [object.id, object]));
    const remotePeers = this.readPeers(byId);
    const remoteUploads = this.stableUploads();
    if (JSON.stringify(remotePeers) === JSON.stringify(this.snapshot.remotePeers)
      && remoteUploads === this.snapshot.remoteUploads) return;
    this.snapshot = { ...this.snapshot, remotePeers, remoteUploads };
    this.listeners.forEach((listener) => listener());
  };

  /**
   * Publish this page's progress for the uploads it is sending into this Space.
   * @param uploads - Whole percent by task row; an empty map withdraws the field.
   */
  setUploadProgress(uploads: Readonly<Record<string, number>>): void {
    const awareness = this.environment.awareness;
    const state = awareness?.getLocalState();
    if (!awareness || state === null || state === undefined) return;
    const { sceneUploads: previous, ...rest } = state;
    if (JSON.stringify(previous ?? {}) === JSON.stringify(uploads)) return;
    awareness.setLocalState(Object.keys(uploads).length === 0 ? rest : { ...rest, sceneUploads: uploads });
  }

  /** Publish one complete presence snapshot; ineligible views withdraw synchronously. */
  private publishPresence(): void {
    const awareness = this.environment.awareness;
    if (!awareness) return;
    const eligible = this.visible && this.focused && this.environment.connected && !this.destroyed;
    const scenePresence = eligible ? { selectedIds: this.selectedIds,
      gesture: this.gesture ? this.snapshot.objects.filter((object) => this.selectedIds.includes(object.id)) : null }
      : { selectedIds: [], gesture: null };
    const state = awareness.getLocalState();
    if (state !== null && JSON.stringify(state.scenePresence) !== JSON.stringify(scenePresence)) {
      awareness.setLocalState({ ...state, scenePresence });
    }
  }

  /**
   * Replace provider and permission facts without rebuilding document history.
   * @param environment - Current provider, role and connection facts.
   */
  setEnvironment(environment: SceneEnvironment): void {
    const previous = this.environment;
    if (previous.awareness !== environment.awareness) {
      this.clearGesture();
      const wasVisible = this.visible;
      this.visible = false;
      this.publishPresence();
      this.visible = wasVisible;
      previous.awareness?.off('change', this.onAwareness);
      environment.awareness?.on('change', this.onAwareness);
    }
    if (previous.connected && !environment.connected) this.clearGesture();
    this.environment = environment;
    this.refresh();
  }

  /**
   * Show or hide a body while retaining its personal selection and history.
   * @param visible - Whether this Space body is currently displayed.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.clearGesture();
    this.refresh();
  }

  /**
   * Re-enter with current selection; losing focus ends the current gesture.
   * @param focused - Whether the browser window and page may publish presence.
   */
  setFocused(focused: boolean): void {
    this.focused = focused;
    if (!focused) this.clearGesture();
    this.refresh();
  }

  /**
   * Change personal selection through the common gesture termination boundary.
   * @param id - Stable scene object identity.
   * @param additive - Whether to toggle this object within the existing selection.
   */
  select(id: string | null, additive: boolean): void {
    const next = id === null ? [] : additive
      ? this.selectedIds.includes(id) ? this.selectedIds.filter((item) => item !== id) : [...this.selectedIds, id]
      : [id];
    this.replaceSelection(next);
    this.refresh();
  }

  /**
   * End the old gesture before replacing any personal selection targets.
   * @param next - The complete next set of selected object identities.
   */
  private replaceSelection(next: readonly string[]): void {
    if (JSON.stringify(next) !== JSON.stringify(this.selectedIds)) this.clearGesture();
    this.selectedIds = [...next];
  }

  /**
   * Begin a locally owned gesture, allowing simultaneous peer editing.
   * @returns Whether a mutable selection established a gesture draft.
   */
  beginGesture(): boolean {
    this.clearGesture();
    if (!this.snapshot.canEdit || this.selectedIds.length === 0
      || this.snapshot.objects.some((object) => this.selectedIds.includes(object.id) && object.locked)) {
      this.refresh();
      return false;
    }
    this.gesture = this.selectedIds.map((id) => ({ id }));
    this.refresh();
    return true;
  }

  /**
   * Preview only fields supplied by the active control, keeping committed values independent.
   * @param patches - Complete transform fields previewed by the active local gesture.
   */
  previewGesture(patches: readonly ScenePatch[]): void {
    if (!this.gesture) return;
    if (patches.some((patch) => !this.selectedIds.includes(patch.id))) return;
    const committed = readSceneDocument(this.doc).objects;
    if (patches.some((patch) => !SceneObjectSchema.safeParse({ ...committed.find((object) => object.id === patch.id), ...patch }).success)) return;
    this.gesture = patches.map((patch) => structuredClone(patch));
    this.refresh();
  }

  /** Release local draft state before publication, rendering or a possible document commit. */
  private clearGesture(): void {
    if (this.gesture === null) return;
    this.gesture = null;
    this.cancelRevision += 1;
  }

  /**
   * Finish through one exit; cancellation never creates a document transaction.
   * @param commit - Whether to apply the completed draft as one command.
   */
  endGesture(commit: boolean): void {
    const gesture = this.gesture;
    this.clearGesture();
    this.refresh();
    if (commit && gesture) this.execute({ type: 'patch', patches: gesture });
  }

  /**
   * Validate against fresh permissions and committed values immediately before writing.
   * @param command - User operation to validate against current committed scene data.
   * @returns Affected identities or a refusal from the fresh command gate.
   */
  execute(command: SceneCommand): SceneCommandResult {
    const result = applySceneCommand(this.doc, command, this.origin, this.snapshot.canEdit, this.name);
    this.commandError = result.ok ? null : result;
    if (result.ok && (command.type === 'create' || command.type === 'duplicate')) this.replaceSelection(result.ids);
    this.refresh();
    return result;
  }

  /**
   * Undo or redo one personal operation even when the object has become explicitly locked.
   * @param direction - Personal undo or redo operation to invoke.
   * @returns The step's outcome; a size refusal (its toast shown once) leaves the history untouched.
   */
  historyStep(direction: 'undo' | 'redo'): SceneCommandResult {
    if (!this.snapshot.canEdit) return { ok: false, reason: 'readOnly' };
    this.endGesture(false);
    const written = writeSpaceDoc(this.name, nextHistoryStep(this.history, direction), () => { this.history[direction](); });
    this.commandError = written.ok ? null : written;
    this.refresh();
    return written.ok ? { ok: true, ids: [] } : written;
  }

  /** Detach all owned listeners once the manager releases this document. */
  destroy(): void {
    if (this.destroyed) return;
    this.clearGesture();
    this.visible = false;
    this.publishPresence();
    this.destroyed = true;
    this.doc.off('update', this.refresh);
    this.environment.awareness?.off('change', this.onAwareness);
    this.history.destroy();
    this.listeners.clear();
  }

}

const sessions = createDocScopedCache<SceneSession, string>(
  (doc, name) => new SceneSession(doc, name), (session) => session.destroy(),
);

/**
 * Reuse personal editing state for an open document across body mounts.
 * @param doc - The provider's live collaborative document.
 * @param name - Canonical content-document name.
 * @returns The document's existing session or its new in-memory owner.
 */
export function getSceneSession(doc: Y.Doc, name: string): SceneSession {
  return sessions.get(doc, name, name);
}

/**
 * Read a session without opening a document or creating editing resources.
 * @param name - Canonical content-document name.
 * @returns The existing document session, or undefined.
 */
export function peekSceneSession(name: string): SceneSession | undefined {
  return sessions.peek(name);
}

/**
 * Discard a closed tab's personal selection and command history.
 * @param name - Canonical content-document name.
 */
export function evictSceneSession(name: string): void {
  sessions.evict(name);
}
